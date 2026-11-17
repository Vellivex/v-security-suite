package com.vellivex.messenger

import android.os.Bundle
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasSetTextAction
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
        var leaveSessionForRestart = false
        try {
            compose.field("Email address").performScrollTo().assertIsDisplayed()
            compose.onNodeWithText("Test server settings").performScrollTo().performClick()
            compose.field("Server address").performScrollTo().performTextReplacement(fixture.matrix)
            val existingCodes = fixture.challengeIds()
            compose.field("Email address").performScrollTo().performTextReplacement("ui-device-$runId@example.test")
            reportUiStage("Requesting the synthetic sign-in code")
            compose.onNodeWithText("Continue with email").performScrollTo().assertIsEnabled().performClick()
            val validCode = fixture.nextCode(existingCodes)
            compose.waitForText("Eight-digit email code")
            val wrongCode = if (validCode == "00000000") "11111111" else "00000000"
            compose.field("Eight-digit email code").performScrollTo().performTextReplacement(wrongCode)
            compose.onNodeWithText("Open Vellivex").performScrollTo().performClick()
            compose.waitForText("That code could not be verified.", substring = true)
            val codeField = compose.field("Eight-digit email code").performScrollTo().performClick()
            codeField.performTextReplacement(validCode)
            if (alpha02Seed) {
                compose.onNodeWithText("Open Vellivex").performScrollTo().performClick()
            } else {
                codeField.performImeAction()
            }
            reportUiStage("Waiting for the signed-in inbox after the valid code")
            compose.waitForText("Messages")

            val deviceId = checkNotNull(device.state.value.userId)
            fixture.signIn(peer, "ui-peer-$runId@example.test")
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
            leaveSessionForRestart = true
        } finally {
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
            assertEquals("Restore the alpha02 history on the installed alpha03 app", 3L, installedVersionCode())
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
        compose.waitForText("Messages")
        compose.onNodeWithContentDescription("Your profile").performClick()
        compose.waitForText("Your Vellivex ID")
        compose.onNodeWithText("Sign out").performClick()
        compose.waitForText("Sign out of this phone?")
        compose.onNodeWithText("Sign out").performClick()
        compose.waitForText("Email address")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertFalse("Sign-out kept the saved session", MessengerSessionStore(context, "default").exists())
    }
}

private const val UI_MESSAGE = "Fictional message sent through the Android interface."
private const val PEER_REPLY = "Fictional reply from the verified second account."

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
