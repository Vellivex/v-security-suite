package com.vellivex.messenger

import android.os.Bundle
import android.os.SystemClock
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.ComposeTestRule
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.core.content.pm.PackageInfoCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class MessengerOnboardingFlowTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun signInVerifyAndExchangeMessagesThroughTheUi() = runBlocking<Unit> {
        val fixture = localFixture()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val alpha02Seed = InstrumentationRegistry.getArguments().getString("messengerAlpha02Seed") == "true"
        if (alpha02Seed) assertEquals("Seed the upgrade on the installed alpha02 app", 2L, installedVersionCode())
        val device = (context.applicationContext as MessengerApplication).repository
        val runId = UUID.randomUUID().toString().take(16)
        val peer = MatrixRepository(context, sessionNamespace = "onboarding-ui-$runId")
        val email = "ui-device-$runId@example.test"
        var deviceRecoveryKey: CharArray? = null
        var otherRecoveryKey: CharArray? = null
        var leaveSessionForRestart = false
        try {
            val firstRequestAt = compose.signInWithSyntheticMail(fixture, email, useIme = !alpha02Seed, tryWrongCode = true)
            if (!alpha02Seed) {
                deviceRecoveryKey = compose.createRecoveryThroughUi()
            }
            compose.waitForText("Messages")

            val deviceId = checkNotNull(device.state.value.userId)
            fixture.signIn(peer, "ui-peer-$runId@example.test")
            if (!alpha02Seed) otherRecoveryKey = fixture.createRecoveryFor(peer)
            val roomId = checkNotNull(peer.createDirectMessage(deviceId)) { "The test peer could not invite the UI account" }
            reportUiStage("Opening the second account's encrypted invitation")
            compose.waitForText("Conversation invitation")
            compose.onNodeWithText("Conversation invitation").performClick()
            compose.waitForText("Accept invitation")
            compose.onNodeWithText("Accept invitation").performClick()
            compose.waitForText("Compare a short code with your contact before your first message.")
            compose.onNodeWithContentDescription("Send message").assertDoesNotExist()

            awaitPeer(peer, "the UI account joining the room") { state ->
                state.rooms.any { it.id == roomId && it.peerId == deviceId }
            }
            assertTrue("Could not open the second account's conversation", peer.openRoom(roomId))
            peer.beginVerification()
            reportUiStage("Comparing verification values")
            compose.waitForText("Compare codes")
            compose.onNodeWithText("Compare codes").performClick()
            val sas = checkNotNull(awaitPeer(peer, "SAS comparison") {
                it.verification?.stage == MessengerVerificationStage.Compare
            }.verification)
            compose.waitForText("They match")
            val symbolsOrNumbers = (sas.symbols.takeIf { it.isNotEmpty() } ?: sas.numbers).joinToString("  ")
            assertTrue("The phones showed different SAS values", symbolsOrNumbers.isNotEmpty() &&
                compose.onAllNodes(hasText(symbolsOrNumbers)).fetchSemanticsNodes().size == 1)
            val peerConfirmation = async { peer.confirmVerification() }
            compose.onNodeWithText("They match").performClick()
            peerConfirmation.await()
            compose.waitForText("Contact verified. You can now send private messages.")
            compose.onNodeWithText("Done").performClick()
            compose.waitForText("Write a message")

            reportUiStage("Exchanging fictional messages between verified accounts")
            compose.field("Write a message").performTextReplacement(UI_MESSAGE)
            compose.onNodeWithContentDescription("Send message").assertIsEnabled().performClick()
            awaitPeer(peer, "the message sent through the UI") { state ->
                state.messages.any { it.text == UI_MESSAGE && it.delivery == MessengerDelivery.Received }
            }
            assertTrue("The verified peer could not reply", peer.sendMessage(PEER_REPLY))
            compose.waitForText(PEER_REPLY)
            compose.onNodeWithText(PEER_REPLY).assertIsDisplayed()

            if (!alpha02Seed) {
                val original = savedSession()
                reportUiStage("Waiting for the synthetic conversation backup")
                fixture.waitForRoomBackup(original.accessToken, roomId)
                reportUiStage("Signing out and requesting a new device session for the same email")
                compose.onNodeWithContentDescription("Back to messages").performClick()
                compose.signOutThroughUi()
                assertFalse("The old device token still works after sign-out", fixture.isAuthenticated(original.accessToken))

                val wait = firstRequestAt + 62_000 - SystemClock.elapsedRealtime()
                if (wait > 0) delay(wait)
                compose.signInWithSyntheticMail(fixture, email, useIme = true)
                compose.waitForText("Recover your messages")
                val returned = savedSession()
                assertTrue("The same email did not return to the same Matrix account", returned.userId == original.userId)
                assertTrue("Sign-in reused the signed-out Matrix device", returned.deviceId != original.deviceId)

                reportUiStage("Rejecting a different valid key, then recovering with the saved key")
                sensitiveUi("reject the unrelated synthetic recovery key") {
                    compose.enterRecoveryKey(checkNotNull(otherRecoveryKey))
                    val error = "Could not recover with that key. Check the key and your connection, then try again."
                    compose.waitForText(error)
                    compose.onNodeWithText("Recover your messages").assertIsDisplayed()
                    compose.onNodeWithText("Messages").assertDoesNotExist()
                    compose.waitForTextToClear(error)
                }
                assertTrue("An incorrect recovery key removed the OTP-authenticated session", savedSession().deviceId == returned.deviceId)
                sensitiveUi("recover the synthetic account with its saved key") {
                    compose.enterRecoveryKey(checkNotNull(deviceRecoveryKey))
                    compose.waitForText("Messages")
                }

                reportUiStage("Reading restored history and sending new encrypted messages")
                compose.waitForText("Verified conversation")
                compose.onNodeWithText("Verified conversation").performClick()
                compose.waitForText(UI_MESSAGE)
                compose.waitForText(PEER_REPLY)
                compose.waitForText("Write a message")
                compose.field("Write a message").performTextReplacement(RECOVERED_MESSAGE)
                compose.onNodeWithContentDescription("Send message").assertIsEnabled().performClick()
                awaitPeer(peer, "the recovered device's encrypted message") { state ->
                    state.messages.any { it.text == RECOVERED_MESSAGE && it.delivery == MessengerDelivery.Received }
                }
                assertTrue("The verified peer could not reply to the recovered device", peer.sendMessage(RECOVERED_REPLY))
                compose.waitForText(RECOVERED_REPLY)
                compose.onNodeWithText(RECOVERED_REPLY).assertIsDisplayed()
                // The process-restart case starts from the inbox and opens the same recovered room.
                compose.onNodeWithContentDescription("Back to messages").performClick()
                compose.waitForText("Messages")
            }
            leaveSessionForRestart = true
        } finally {
            deviceRecoveryKey?.fill('\u0000')
            otherRecoveryKey?.fill('\u0000')
            try {
                peer.close()
            } finally {
                if (!leaveSessionForRestart) device.signOut()
            }
        }
    }
}

/** The host runner stops the app process after the UI flow and before invoking this class. */
@RunWith(AndroidJUnit4::class)
class MessengerOnboardingRestartTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun restoresVerifiedConversationAfterRestartAndSignsOutThroughTheUi() {
        val args = InstrumentationRegistry.getArguments()
        assertTrue("Run the UI flow and force-stop the app before this test", args.getString("messengerUiRestart") == "true")
        if (args.getString("messengerAlpha02Upgrade") == "true") {
            assertEquals("Restore the alpha02 history on the installed alpha04 app", 4L, installedVersionCode())
            compose.createRecoveryThroughUi().fill('\u0000')
        }
        reportUiStage("Restoring the saved session and encrypted conversation")
        compose.waitForText("Messages")
        compose.waitForText("Verified conversation")
        compose.onNodeWithText("Verified conversation").performClick()
        compose.waitForText(UI_MESSAGE)
        compose.waitForText(PEER_REPLY)
        compose.onNodeWithText(PEER_REPLY).assertIsDisplayed()
        reportUiStage("Signing out from the restored account")
        compose.onNodeWithContentDescription("Back to messages").performClick()
        compose.signOutThroughUi()
    }
}

private const val UI_MESSAGE = "Fictional message sent through the Android interface."
private const val PEER_REPLY = "Fictional reply from the verified second account."
private const val RECOVERED_MESSAGE = "Fictional encrypted message from the recovered device."
private const val RECOVERED_REPLY = "Fictional encrypted reply to the recovered device."

private fun savedSession(): org.matrix.rustcomponents.sdk.Session {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val record = checkNotNull(MessengerSessionStore(context, "default").read()) { "The local Matrix session was missing" }
    record.storeKey.fill(0)
    return record.session
}

private suspend fun ComposeTestRule.signInWithSyntheticMail(
    fixture: LocalSynapseFixture,
    email: String,
    useIme: Boolean,
    tryWrongCode: Boolean = false,
): Long {
    waitForText("Email address")
    onNodeWithText("Test server settings").performScrollTo().performClick()
    field("Server address").performScrollTo().performTextReplacement(fixture.matrix)
    val existingCodes = fixture.challengeIds()
    field("Email address").performScrollTo().performTextReplacement(email)
    reportUiStage("Requesting the synthetic sign-in code")
    onNodeWithText("Continue with email").performScrollTo().assertIsEnabled().performClick()
    val validCode = fixture.nextCode(existingCodes)
    val requestedAt = SystemClock.elapsedRealtime()
    waitForText("Eight-digit email code")
    if (tryWrongCode) {
        val wrongCode = if (validCode == "00000000") "11111111" else "00000000"
        field("Eight-digit email code").performScrollTo().performTextReplacement(wrongCode)
        onNodeWithText("Open Vellivex").performScrollTo().performClick()
        waitForText("That code could not be verified.", substring = true)
    }
    val codeField = field("Eight-digit email code").performScrollTo().performClick()
    codeField.performTextReplacement(validCode)
    if (useIme) codeField.performImeAction() else onNodeWithText("Open Vellivex").performScrollTo().performClick()
    return requestedAt
}

private fun ComposeTestRule.createRecoveryThroughUi(): CharArray = sensitiveUi("save the synthetic recovery key") {
    reportUiStage("Creating and acknowledging a recovery key before opening messages")
    waitForText("Secure your account")
    onNodeWithText("Messages").assertDoesNotExist()
    onNodeWithText("Create recovery key").performScrollTo().performClick()
    waitUntil(45_000) { onAllNodes(hasTestTag("recovery-key")).fetchSemanticsNodes().size == 1 }
    val key = onAllNodes(hasTestTag("recovery-key")).fetchSemanticsNodes().single()
        .config[SemanticsProperties.Text].single().text.toCharArray()
    try {
        check(key.size > 12)
        onNodeWithText("Messages").assertDoesNotExist()
        val lastFour = key.filterNot(Char::isWhitespace).takeLast(4).joinToString("")
        val wrongLastFour = if (lastFour == "2222") "3333" else "2222"
        field("Last 4 characters").performScrollTo().performTextReplacement(wrongLastFour)
        onNodeWithText("I've saved my recovery key").performScrollTo().assertIsEnabled().performClick()
        val error = "Enter the last four characters of your recovery key exactly as shown."
        waitForText(error)
        onNodeWithText("Messages").assertDoesNotExist()
        waitForTextToClear(error)
        field("Last 4 characters").performScrollTo().performTextReplacement(lastFour)
        onNodeWithText("I've saved my recovery key").performScrollTo().assertIsEnabled().performClick()
        key
    } catch (failure: Throwable) {
        key.fill('\u0000')
        throw failure
    }
}

private fun ComposeTestRule.enterRecoveryKey(key: CharArray) = sensitiveUi("enter the synthetic recovery key") {
    field("Recovery key").performScrollTo().performTextReplacement(key.concatToString())
    onNodeWithText("Recover messages").performScrollTo().assertIsEnabled().performClick()
}

private inline fun <T> sensitiveUi(action: String, block: () -> T): T = try {
    block()
} catch (_: Throwable) {
    // Compose diagnostic trees can include visible field values. Keep key material out of logs.
    throw AssertionError("Could not $action")
}

private fun ComposeTestRule.signOutThroughUi() {
    waitForText("Messages")
    onNodeWithContentDescription("Your profile").performClick()
    waitForText("Your Vellivex ID")
    onNodeWithText("Sign out").performClick()
    waitForText("Sign out of this phone?")
    onNodeWithText("Sign out").performClick()
    waitForText("Email address")
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    assertFalse("Sign-out kept the saved session", MessengerSessionStore(context, "default").exists())
}

@Suppress("DEPRECATION")
private fun installedVersionCode(): Long {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    return PackageInfoCompat.getLongVersionCode(context.packageManager.getPackageInfo(context.packageName, 0))
}

private fun SemanticsNodeInteractionsProvider.field(label: String) = onNode(hasSetTextAction() and hasText(label))

private fun ComposeTestRule.waitForText(value: String, substring: Boolean = false) {
    try {
        waitUntil(30_000) { onAllNodes(hasText(value, substring = substring)).fetchSemanticsNodes().isNotEmpty() }
    } catch (error: ComposeTimeoutException) {
        throw AssertionError("Onboarding did not show '$value' within 30 seconds", error)
    }
}

private fun ComposeTestRule.waitForTextToClear(value: String) {
    waitUntil(15_000) { onAllNodes(hasText(value)).fetchSemanticsNodes().isEmpty() }
}

private fun reportUiStage(message: String) {
    val status = Bundle().apply { putString("stream", "\nVellivex UI: $message\n") }
    InstrumentationRegistry.getInstrumentation().sendStatus(2, status)
}

private suspend fun awaitPeer(
    peer: MatrixRepository,
    label: String,
    predicate: (MessengerState) -> Boolean,
): MessengerState = checkNotNull(withTimeoutOrNull(60_000) { peer.state.first(predicate) }) {
    "Timed out waiting for $label"
}
