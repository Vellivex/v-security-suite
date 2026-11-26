package com.vellivex.messenger

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.assertHasClickAction
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
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CancellationException
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
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientException
import org.matrix.rustcomponents.sdk.EncryptedMessage
import org.matrix.rustcomponents.sdk.MsgLikeKind
import org.matrix.rustcomponents.sdk.ShieldState
import org.matrix.rustcomponents.sdk.Timeline
import org.matrix.rustcomponents.sdk.TimelineItemContent
import java.util.UUID
import java.nio.ByteBuffer
import java.security.MessageDigest

@RunWith(AndroidJUnit4::class)
class MessengerOnboardingFlowTest {
    @get:Rule
    val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun signInVerifyAndExchangeMessagesThroughTheUi() = runBlocking<Unit> {
        val fixture = localFixture()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val seedVersion = upgradeSourceVersion("messengerUpgradeSeedVersion")
        val legacySeed = seedVersion == 2L
        if (seedVersion != null) {
            assertEquals("Seed the upgrade on the requested original app", seedVersion, installedVersionCode())
        }
        val device = (context.applicationContext as MessengerApplication).repository
        val runId = UUID.randomUUID().toString().take(16)
        val peer = MatrixRepository(context, sessionNamespace = "onboarding-ui-$runId")
        val email = "ui-device-$runId@example.test"
        var deviceRecoveryKey: CharArray? = null
        var otherRecoveryKey: CharArray? = null
        var leaveSessionForRestart = false
        try {
            val acceptsContactLinks = installedVersionCode() >= 10L
            val pendingContact = "@invite-$runId:example.test"
            if (acceptsContactLinks) {
                compose.activityRule.scenario.onActivity { activity ->
                    activity.startActivity(testInvitation(activity, pendingContact))
                }
                compose.waitForText("Email address")
                compose.onNodeWithText("Start a conversation").assertDoesNotExist()
            }
            val firstRequestAt = compose.signInWithSyntheticMail(fixture, email, compose.activity,
                useIme = !legacySeed, tryWrongCode = true)
            if (!legacySeed) {
                deviceRecoveryKey = compose.createRecoveryThroughUi(device, compose.activity)
            }
            if (acceptsContactLinks) {
                compose.waitForText("Start a conversation")
                compose.activityRule.scenario.recreate()
                compose.waitForText(pendingContact)
                compose.onNodeWithText("Continue").assertIsEnabled()
                compose.onNodeWithText("Cancel").performClick()
                compose.waitForTextToClear("Start a conversation")
                assertTrue(device.state.value.rooms.none { it.peerId == pendingContact })
                val secondContact = "@invite-again-$runId:example.test"
                compose.activityRule.scenario.onActivity { activity ->
                    activity.startActivity(testInvitation(activity, secondContact))
                }
                compose.waitForText(secondContact)
                compose.onNodeWithText("Cancel").performClick()
                compose.waitForTextToClear("Start a conversation")
                assertTrue(device.state.value.rooms.none { it.peerId == secondContact })
            }
            compose.waitForText("Messages")
            if (installedVersionCode() == 6L) {
                compose.onNodeWithContentDescription("New conversation")
                    .assertIsDisplayed().assertIsEnabled().assertHasClickAction()
            }

            val deviceId = checkNotNull(device.state.value.userId)
            fixture.signIn(peer, "ui-peer-$runId@example.test")
            if (!legacySeed) otherRecoveryKey = fixture.createRecoveryFor(peer)
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
            val sent = awaitPeer(peer, "the message sent through the UI") { state ->
                state.messages.any { it.text == UI_MESSAGE && it.delivery == MessengerDelivery.Received }
            }.messages.single { it.text == UI_MESSAGE }
            assertTrue("The verified peer could not reply", peer.sendMessage(PEER_REPLY))
            compose.waitForText(PEER_REPLY)
            compose.onNodeWithText(PEER_REPLY).assertIsDisplayed()

            // Upgrade seeds keep the original signed-in session and local message keys.
            // Fresh installs still exercise the complete sign-out and recovery flow.
            if (seedVersion == null) {
                val original = savedSession()
                val reply = awaitPeer(peer, "the original reply's server acknowledgement") { state ->
                    state.messages.any { it.text == PEER_REPLY && it.delivery == MessengerDelivery.Sent }
                }.messages.single { it.text == PEER_REPLY }
                reportUiStage("Checking backup coverage for both original encrypted events")
                fixture.waitForRoomBackup(original.accessToken, roomId, eventIds = setOf(sent.id, reply.id))
                reportUiStage("Signing out and requesting a new device session for the same email")
                compose.onNodeWithContentDescription("Back to messages").performClick()
                compose.signOutThroughUi()
                assertFalse("The old device token still works after sign-out", fixture.isAuthenticated(original.accessToken))

                val wait = firstRequestAt + 62_000 - SystemClock.elapsedRealtime()
                if (wait > 0) delay(wait)
                compose.signInWithSyntheticMail(fixture, email, compose.activity, useIme = true)
                compose.waitForText("Recover your account")
                val returned = savedSession()
                assertTrue("The same email did not return to the same Matrix account", returned.userId == original.userId)
                assertTrue("Sign-in reused the signed-out Matrix device", returned.deviceId != original.deviceId)

                reportUiStage("Rejecting a different valid key, then recovering with the saved key")
                sensitiveUi("reject the unrelated synthetic recovery key") {
                    compose.enterRecoveryKey(checkNotNull(otherRecoveryKey), device, compose.activity)
                    val error = "Could not recover with that key. Check the key and your connection, then try again."
                    compose.waitForText(error)
                    compose.onNodeWithText("Recover your account").assertIsDisplayed()
                    compose.onNodeWithText("Messages").assertDoesNotExist()
                    compose.waitForTextToClear(error)
                }
                assertTrue("An incorrect recovery key removed the OTP-authenticated session", savedSession().deviceId == returned.deviceId)
                sensitiveUi("recover the synthetic account with its saved key") {
                    compose.enterRecoveryKey(checkNotNull(deviceRecoveryKey), device, compose.activity, awaitReady = true)
                    compose.waitForText("Messages")
                }

                reportUiStage("Checking recovered account access and sending new encrypted messages")
                compose.waitForText("Verified conversation")
                compose.onNodeWithText("Verified conversation").performClick()
                try {
                    compose.waitForText(RECOVERED_HISTORY_NOTE)
                    compose.onNodeWithText(RECOVERED_HISTORY_NOTE).assertIsDisplayed()
                    requireUnavailableOriginalEvents(device, setOf(sent.id, reply.id))
                    compose.assertOriginalRecoveryHistoryHidden(device)
                    compose.waitForText("Write a message")
                    compose.field("Write a message").performTextReplacement(RECOVERED_MESSAGE)
                    compose.onNodeWithContentDescription("Send message").assertIsEnabled().performClick()
                    awaitPeer(peer, "the recovered device's encrypted message") { state ->
                        state.messages.any { it.text == RECOVERED_MESSAGE && it.delivery == MessengerDelivery.Received }
                    }
                    assertTrue("The verified peer could not reply to the recovered device", peer.sendMessage(RECOVERED_REPLY))
                    compose.waitForDisplayedText(RECOVERED_REPLY, compose.activity)
                    compose.onNodeWithText(RECOVERED_REPLY).assertIsDisplayed()
                    compose.assertOriginalRecoveryHistoryHidden(device)
                } catch (error: AssertionError) {
                    reportRestoredHistoryDiagnostics(device, activePeerEvent = reply.id, signedOutDeviceEvent = sent.id)
                    throw error
                } catch (error: Exception) {
                    if (error !is CancellationException) {
                        reportRestoredHistoryDiagnostics(device, activePeerEvent = reply.id, signedOutDeviceEvent = sent.id)
                    }
                    throw error
                }
                // The process-restart case starts from the inbox and opens the same recovered room.
                compose.onNodeWithContentDescription("Back to messages").performClick()
                compose.waitForText("Messages")
            }
            if (seedVersion == 5L) {
                val fingerprintFile = upgradeStateFile()
                assertFalse("Use a fresh Alpha05 upgrade fixture", fingerprintFile.exists())
                fingerprintFile.writeText(savedSessionFingerprint())
                reportUiStage("Retaining the original session, device and local key fingerprint for update")
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
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val device = (context.applicationContext as MessengerApplication).repository
        assertTrue("Run the UI flow and force-stop the app before this test", args.getString("messengerUiRestart") == "true")
        val upgradeFromVersion = upgradeSourceVersion("messengerUpgradeFromVersion")
        if (upgradeFromVersion != null) {
            val expectedVersion = when (args.getString("messengerUpgradeTargetVersion")) {
                "5" -> 5L
                "6" -> 6L
                else -> throw AssertionError("Name supported upgrade target version 5 or 6")
            }
            assertTrue("The upgrade must install a later version", expectedVersion > upgradeFromVersion)
            assertEquals("Restore original history on the exact selected update", expectedVersion, installedVersionCode())
            if (upgradeFromVersion == 2L) {
                compose.createRecoveryThroughUi(device, compose.activity).fill('\u0000')
            }
        }
        reportUiStage("Restoring the saved session and encrypted conversation")
        compose.waitForText("Messages")
        if (upgradeFromVersion == 4L || upgradeFromVersion == 5L) {
            assertEquals("The update did not retain its recovery-ready session",
                MessengerRecovery.Ready, device.state.value.recovery)
            compose.onNodeWithText("Secure your account").assertDoesNotExist()
            compose.onNodeWithText("Recover your account").assertDoesNotExist()
        }
        if (upgradeFromVersion == 5L) {
            val fingerprintFile = upgradeStateFile()
            assertTrue("The original Alpha05 session evidence is missing", fingerprintFile.isFile)
            assertTrue("The update replaced the original session, device or local store key",
                savedSessionFingerprint() == fingerprintFile.readText())
            assertTrue("Could not remove the completed synthetic upgrade fingerprint", fingerprintFile.delete())
            compose.onNodeWithContentDescription("New conversation")
                .assertIsDisplayed().assertIsEnabled().assertHasClickAction()
            reportUiStage("Confirmed the original session, device and local key survived the update")
        }
        compose.waitForText("Verified conversation")
        compose.onNodeWithText("Verified conversation").performClick()
        if (upgradeFromVersion != null) {
            compose.waitForText(PEER_REPLY)
            compose.onNodeWithText(PEER_REPLY).assertIsDisplayed()
            compose.waitForText(UI_MESSAGE)
            compose.onNodeWithText(UI_MESSAGE).assertIsDisplayed()
            compose.onNodeWithText(RECOVERED_HISTORY_NOTE).assertDoesNotExist()
        } else {
            compose.waitForText(RECOVERED_HISTORY_NOTE)
            compose.waitForText(RECOVERED_MESSAGE)
            compose.onNodeWithText(RECOVERED_MESSAGE).assertIsDisplayed()
            compose.waitForText(RECOVERED_REPLY)
            compose.onNodeWithText(RECOVERED_REPLY).assertIsDisplayed()
            compose.assertOriginalRecoveryHistoryHidden(device)
        }
        reportUiStage("Signing out from the restored account")
        compose.onNodeWithContentDescription("Back to messages").performClick()
        compose.signOutThroughUi()
    }
}

private const val UI_MESSAGE = "Fictional message sent through the Android interface."
private const val PEER_REPLY = "Fictional reply from the verified second account."
private const val RECOVERED_MESSAGE = "Fictional encrypted message from the recovered device."
private const val RECOVERED_REPLY = "Fictional encrypted reply to the recovered device."
private const val RECOVERED_HISTORY_NOTE =
    "Your recovery key restores your account’s encryption keys. In this alpha, it may not restore any earlier messages."
private const val RECOVERY_READY_TIMEOUT_MS = 55_000L

private fun savedSession(): org.matrix.rustcomponents.sdk.Session {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val record = checkNotNull(MessengerSessionStore(context, "default").read()) { "The local Matrix session was missing" }
    record.storeKey.fill(0)
    return record.session
}

/** Only a one-way fingerprint of synthetic test state crosses the update boundary. */
private fun upgradeStateFile() = InstrumentationRegistry.getInstrumentation()
    .context.filesDir.resolve("alpha05-upgrade-state.sha256")

private fun savedSessionFingerprint(): String {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val record = checkNotNull(MessengerSessionStore(context, "default").read()) { "The original session was missing" }
    val digest = MessageDigest.getInstance("SHA-256")
    try {
        for (value in listOf(record.session.userId, record.session.deviceId, record.session.accessToken)) {
            val bytes = value.toByteArray(Charsets.UTF_8)
            digest.update(ByteBuffer.allocate(4).putInt(bytes.size).array())
            digest.update(bytes)
            bytes.fill(0)
        }
        digest.update(record.storeKey)
        return digest.digest().joinToString("") { "%02x".format(it) }
    } finally {
        record.storeKey.fill(0)
    }
}

private suspend fun ComposeTestRule.signInWithSyntheticMail(
    fixture: LocalSynapseFixture,
    email: String,
    activity: MainActivity,
    useIme: Boolean,
    tryWrongCode: Boolean = false,
): Long {
    waitForText("Email address")
    onNodeWithText("Test server settings").performScrollTo().performClick()
    field("Server address").performScrollTo().performTextReplacement(fixture.matrix)
    val existingCodes = fixture.challengeIds()
    field("Email address").performScrollTo().performTextReplacement(email)
    reportUiStage("Requesting the synthetic sign-in code")
    val submit = onNodeWithText("Continue with email").performScrollTo()
    val requestStarted = SystemClock.elapsedRealtime()
    reportSignInRequestState(activity, email, fixture.matrix, requestStarted, SignInRequestPhase.BEFORE_CLICK)
    // Preserve one genuine UI click and the fixture's original mailbox wait.
    submit.assertIsEnabled().performClick()
    reportSignInRequestState(activity, email, fixture.matrix, requestStarted, SignInRequestPhase.AFTER_CLICK)
    val validCode = try {
        fixture.nextCode(existingCodes)
    } catch (failure: Throwable) {
        // Capture before the enclosing flow signs out and the activity is torn down.
        reportSignInRequestState(activity, email, fixture.matrix, requestStarted, SignInRequestPhase.MAILBOX_FAILURE)
        throw failure
    }
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

private enum class SignInRequestPhase { BEFORE_CLICK, AFTER_CLICK, MAILBOX_FAILURE }

private fun ComposeTestRule.reportSignInRequestState(
    activity: MainActivity,
    expectedEmail: String,
    expectedServer: String,
    started: Long,
    phase: SignInRequestPhase,
) {
    val snapshotStarted = SystemClock.elapsedRealtime()
    try {
        val buttons = onAllNodes(hasText("Continue with email")).fetchSemanticsNodes()
        val button = buttons.singleOrNull()
        val emailMatches = onAllNodes(hasSetTextAction() and hasText("Email address")).fetchSemanticsNodes()
            .singleOrNull()?.config?.getOrNull(SemanticsProperties.InputText)?.text == expectedEmail
        val serverMatches = onAllNodes(hasSetTextAction() and hasText("Server address")).fetchSemanticsNodes()
            .singleOrNull()?.config?.getOrNull(SemanticsProperties.InputText)?.text == expectedServer
        val displayed = try {
            onNodeWithText("Continue with email").assertIsDisplayed()
            true
        } catch (_: AssertionError) {
            false
        }
        val windowAndState = runOnUiThread {
            val root = activity.window.decorView
            val insets = ViewCompat.getRootWindowInsets(root)
            val ime = insets?.getInsets(WindowInsetsCompat.Type.ime())
            val model = try {
                ViewModelProvider(activity)[MessengerViewModel::class.java]
            } catch (_: Throwable) {
                null
            }
            // Older installed APKs may lack a getter. Keep their geometry and all other observations.
            val modelState = if (model == null) {
                "model-state=unavailable"
            } else {
                val error = try {
                    signInErrorCategory(model.signInInputError, model.repository.state.value.error)
                } catch (_: Throwable) {
                    SignInUiError.UNAVAILABLE
                }
                "model-email-matches=${safeSignInFlag { model.signInEmail == expectedEmail }}, " +
                    "model-server-matches=${safeSignInFlag { model.serverAddress == expectedServer }}, " +
                    "authentication-pending=${safeSignInFlag { model.authenticationPending }}, " +
                    "app-busy=${safeSignInFlag { model.repository.state.value.busy }}, " +
                    "code-requested=${safeSignInFlag { model.repository.state.value.codeRequested }}, " +
                    "user-present=${safeSignInFlag { model.repository.state.value.userId != null }}, " +
                    "error=${error.name}"
            }
            // Only fixed labels, booleans, geometry and an allowlisted error category leave this block.
            "ime-visible=${insets?.isVisible(WindowInsetsCompat.Type.ime())}, " +
                "ime-left=${ime?.left}, ime-top=${ime?.top}, ime-right=${ime?.right}, ime-bottom=${ime?.bottom}, " +
                "root-width=${root.width}, root-height=${root.height}, " +
                modelState
        }
        reportUiStage("Sign-in request ${phase.name}: elapsed-ms=${SystemClock.elapsedRealtime() - started}, " +
            "capture-ms=${SystemClock.elapsedRealtime() - snapshotStarted}, " +
            "email-field-matches=$emailMatches, server-field-matches=$serverMatches, " +
            "button-count=${buttons.size}, button-enabled=${button != null && button.config.getOrNull(SemanticsProperties.Disabled) == null}, " +
            "button-displayed=$displayed, button-bounds=${button?.boundsInRoot}, $windowAndState")
    } catch (_: Throwable) {
        // Neither a diagnostic exception nor its potentially sensitive message may replace the test result.
        try {
            reportUiStage("Sign-in request ${phase.name}: safe diagnostic unavailable")
        } catch (_: Throwable) {
            // Reporting is best-effort; retain the original click or mailbox outcome.
        }
    }
}

private inline fun safeSignInFlag(read: () -> Boolean): String = try {
    if (read()) "true" else "false"
} catch (_: Throwable) {
    "unavailable"
}

private enum class SignInUiError {
    NONE, EMAIL_INPUT, SERVICE_INPUT, CODE_INPUT, SAVED_SESSION, REQUEST_FAILED, SERVICE_FAILED,
    RATE_LIMIT, CAPACITY_LIMIT, OTHER, UNAVAILABLE,
}

private fun signInErrorCategory(input: SignInInputError?, message: String?): SignInUiError = when (input) {
    SignInInputError.Email -> SignInUiError.EMAIL_INPUT
    SignInInputError.Server -> SignInUiError.SERVICE_INPUT
    SignInInputError.Code -> SignInUiError.CODE_INPUT
    null -> when {
        message == null -> SignInUiError.NONE
        message == "Enter a valid email address." -> SignInUiError.EMAIL_INPUT
        message == "Enter a valid HTTPS service address." ||
            message == "Enter the HTTPS address of the Vellivex messaging service." -> SignInUiError.SERVICE_INPUT
        message == "Restore or sign out of the saved session before starting another sign-in." -> SignInUiError.SAVED_SESSION
        message == "Could not request a sign-in code. Check the service address and connection." -> SignInUiError.REQUEST_FAILED
        message == "The messaging service could not complete that request." -> SignInUiError.SERVICE_FAILED
        message == "Vellivex Messenger has reached its sign-in capacity. Try again later." -> SignInUiError.CAPACITY_LIMIT
        message.startsWith("Too many attempts.") -> SignInUiError.RATE_LIMIT
        else -> SignInUiError.OTHER
    }
}

private fun ComposeTestRule.createRecoveryThroughUi(repository: MatrixRepository, activity: MainActivity): CharArray = sensitiveUi("save the synthetic recovery key") {
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
        val submit = prepareRecoveryButton(activity, repository, "Last 4 characters", lastFour, "I've saved my recovery key")
        waitForRecoveryReady(repository, submit)
        key
    } catch (failure: Throwable) {
        key.fill('\u0000')
        throw failure
    }
}

private fun ComposeTestRule.enterRecoveryKey(
    key: CharArray,
    repository: MatrixRepository,
    activity: MainActivity,
    awaitReady: Boolean = false,
) = sensitiveUi("enter the synthetic recovery key") {
    val submit = prepareRecoveryButton(activity, repository, "Recovery key", key.concatToString(), "Recover account")
    if (awaitReady) waitForRecoveryReady(repository, submit) else submit()
}

private data class RecoveryClickSnapshot(
    val imeVisible: Boolean?,
    val rootHeight: Int,
    val bounds: Rect?,
    val displayedAndEnabled: Boolean,
    val fieldLength: Int?,
    val fieldMatchesExpected: Boolean,
    val authenticationPending: Boolean,
    val appBusy: Boolean,
    val userPresent: Boolean,
    val recovery: MessengerRecovery,
    val error: RecoveryUiError,
)

private fun ComposeTestRule.prepareRecoveryButton(
    activity: MainActivity,
    repository: MatrixRepository,
    fieldLabel: String,
    expectedValue: String,
    buttonLabel: String,
): () -> Unit {
    val model = runOnIdle { ViewModelProvider(activity)[MessengerViewModel::class.java] }
    assertTrue("Recovery UI and test used different repositories", model.repository === repository)
    val deadline = SystemClock.elapsedRealtime() + 10_000

    fun snapshot(): RecoveryClickSnapshot {
        val window = runOnIdle {
            val root = activity.window.decorView
            Triple(ViewCompat.getRootWindowInsets(root)?.isVisible(WindowInsetsCompat.Type.ime()),
                root.height, model.authenticationPending)
        }
        val button = onNodeWithText(buttonLabel)
        val displayedAndEnabled = try {
            button.assertIsDisplayed().assertIsEnabled()
            true
        } catch (_: AssertionError) {
            false
        }
        val bounds = onAllNodes(hasText(buttonLabel)).fetchSemanticsNodes().singleOrNull()?.boundsInRoot
        // InputText retains the exact value; EditableText is masked for recovery keys.
        val value = onAllNodes(hasSetTextAction() and hasText(fieldLabel)).fetchSemanticsNodes()
            .singleOrNull()?.config?.getOrNull(SemanticsProperties.InputText)?.text
        val state = repository.state.value
        return RecoveryClickSnapshot(window.first, window.second, bounds, displayedAndEnabled,
            value?.length, value == expectedValue, window.third, state.busy, state.userId != null,
            state.recovery, recoveryErrorCategory(state.error))
    }

    fun report(phase: String) {
        val evidence = try { snapshot().toString() } catch (_: Throwable) { "safe snapshot unavailable" }
        reportUiStage("Recovery tap $phase ($fieldLabel): $evidence")
    }

    try {
        // The snackbar can disappear before its asynchronous clearError action.
        // Wait for that natural clear so a repeated validation error is observable.
        waitUntil(10_000) {
            repository.state.value.let { it.error == null && !it.busy } &&
                runOnIdle { !model.authenticationPending }
        }
        field(fieldLabel).performScrollTo().performTextReplacement(expectedValue)
        val applied = field(fieldLabel).fetchSemanticsNode().config.getOrNull(SemanticsProperties.InputText)?.text
        assertTrue("Recovery confirmation input was not applied", applied == expectedValue)
        runOnIdle {
            checkNotNull(ViewCompat.getWindowInsetsController(activity.window.decorView))
                .hide(WindowInsetsCompat.Type.ime())
        }
        onNodeWithText(buttonLabel).performScrollTo()
        var geometry: Pair<Rect, Int>? = null
        var stableSince = SystemClock.elapsedRealtime()
        waitUntil((deadline - SystemClock.elapsedRealtime()).coerceAtLeast(1)) {
            val current = snapshot()
            val nextGeometry = current.bounds?.let { it to current.rootHeight }
            val ready = current.imeVisible == false && current.displayedAndEnabled && current.fieldMatchesExpected &&
                !current.authenticationPending && !current.appBusy && current.userPresent && current.error == RecoveryUiError.NONE
            if (!ready || nextGeometry == null || nextGeometry != geometry) {
                geometry = if (ready) nextGeometry else null
                stableSince = SystemClock.elapsedRealtime()
                false
            } else SystemClock.elapsedRealtime() - stableSince >= 300
        }
    } catch (_: Throwable) {
        report("preparation failed")
        throw AssertionError("Recovery button did not settle with the expected input within 10 seconds")
    }
    report("before")
    return {
        // Keep a single real touch. Do not retry or invoke the handler directly.
        onNodeWithText(buttonLabel).assertIsDisplayed().assertIsEnabled().performClick()
        report("after")
    }
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
    onNodeWithText(RECOVERED_HISTORY_NOTE, substring = true).assertIsDisplayed()
    onNodeWithText("Sign out").performClick()
    waitForText("Email address")
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    assertFalse("Sign-out kept the saved session", MessengerSessionStore(context, "default").exists())
}

@Suppress("DEPRECATION")
// This debug fixture exercises the app UI; the signed release check separately verifies OS resolution.
private fun testInvitation(activity: MainActivity, contact: String): Intent =
    Intent(Intent.ACTION_VIEW, Uri.parse("https://www.vellivex.com/invite#/$contact"), activity, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)

private fun installedVersionCode(): Long {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    return PackageInfoCompat.getLongVersionCode(context.packageManager.getPackageInfo(context.packageName, 0))
}

private fun upgradeSourceVersion(argument: String): Long? =
    when (InstrumentationRegistry.getArguments().getString(argument)) {
        null -> null
        "2" -> 2L
        "4" -> 4L
        "5" -> 5L
        else -> throw AssertionError("$argument must name supported source version 2, 4 or 5")
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

private fun ComposeTestRule.waitForDisplayedText(value: String, activity: MainActivity) {
    try {
        waitUntil(30_000) {
            try {
                onNodeWithText(value).assertIsDisplayed()
                true
            } catch (_: AssertionError) {
                false
            }
        }
    } catch (error: ComposeTimeoutException) {
        try {
            // One geometry-only snapshot, with no scrolling, retries, text, keys or semantics trees.
            val messageMatcher = hasText(value)
            val viewportMatcher = hasTestTag("conversation_messages")
            val composerMatcher = hasSetTextAction()
            val nodes = onAllNodes(messageMatcher or viewportMatcher or composerMatcher).fetchSemanticsNodes()
            val messages = nodes.filter { messageMatcher.matches(it) }
            val viewports = nodes.filter { viewportMatcher.matches(it) }
            val composers = nodes.filter { composerMatcher.matches(it) }
            val viewport = viewports.singleOrNull()
            val composer = composers.singleOrNull()
            val windowAndScroll = runOnUiThread {
                val root = activity.window.decorView
                val range = viewport?.config?.getOrNull(SemanticsProperties.VerticalScrollAxisRange)
                // Compose exposes estimated scroll units here, not pixel offsets.
                "ime-visible=${ViewCompat.getRootWindowInsets(root)?.isVisible(WindowInsetsCompat.Type.ime())}, " +
                    "root-width=${root.width}, root-height=${root.height}, " +
                    "scroll-value=${range?.value?.invoke()}, scroll-max=${range?.maxValue?.invoke()}, " +
                    "scroll-reversed=${range?.reverseScrolling}"
            }
            reportUiStage("Message visibility diagnostic: matching-nodes=${messages.size}, " +
                "message-bounds=${messages.firstOrNull()?.boundsInRoot}, viewport-nodes=${viewports.size}, " +
                "viewport-bounds=${viewport?.boundsInRoot}, composer-nodes=${composers.size}, " +
                "composer-bounds=${composer?.boundsInRoot}, " +
                "composer-focused=${composer?.config?.getOrNull(SemanticsProperties.Focused)}, $windowAndScroll")
        } catch (_: Throwable) {
            reportUiStage("Message visibility diagnostic unavailable")
        }
        throw AssertionError("The recovered reply did not become visible within 30 seconds", error)
    }
}

private fun ComposeTestRule.waitForRecoveryReady(repository: MatrixRepository, submit: () -> Unit) {
    val before = repository.state.value
    var observedBusy = false
    var failure: String? = null
    val started = SystemClock.elapsedRealtime()
    submit()
    try {
        // Both setup and recovery allow a 30-second SDK call followed by a
        // 20-second readiness check. This wait leaves those app limits intact.
        waitUntil(RECOVERY_READY_TIMEOUT_MS) {
            val state = repository.state.value
            if (state.busy) observedBusy = true
            val newError = state.error != null && (observedBusy || state.error != before.error)
            when {
                newError -> {
                    failure = "Recovery reported an error (${recoveryErrorCategory(state.error).name})"
                    true
                }
                state.recovery == MessengerRecovery.Ready && !state.busy -> true
                observedBusy && !state.busy -> {
                    failure = "Recovery finished without becoming ready"
                    true
                }
                else -> false
            }
        }
    } catch (error: ComposeTimeoutException) {
        reportRecoveryWaitState(repository, started, observedBusy, "timed out")
        throw AssertionError("Recovery did not become ready within 55 seconds", error)
    }
    failure?.let {
        reportRecoveryWaitState(repository, started, observedBusy, "failed")
        throw AssertionError(it)
    }
    reportRecoveryWaitState(repository, started, observedBusy, "completed")
}

private fun reportRecoveryWaitState(repository: MatrixRepository, started: Long, observedBusy: Boolean, outcome: String) {
    val state = repository.state.value
    reportUiStage("Recovery readiness $outcome: elapsed-ms=${SystemClock.elapsedRealtime() - started}, " +
        "observed-busy=$observedBusy, app=${state.recovery.name}, busy=${state.busy}, " +
        "sync=${state.connection.name}, error=${recoveryErrorCategory(state.error).name}")
    // Emit only safe state before sensitiveUi replaces a failure's message.
    reportRecoveryStateDiagnostics(repository)
}

private enum class RecoveryUiError {
    NONE, CONFIRMATION_MISMATCH, SETUP_TIMEOUT, RECOVERY_TIMEOUT, USABILITY_TIMEOUT, SETUP_FAILED,
    RECOVERY_FAILED, SETTINGS_CHANGED, OTHER_DEVICE, OTHER,
}

private fun recoveryErrorCategory(message: String?): RecoveryUiError = when (message) {
    null -> RecoveryUiError.NONE
    "Enter the last four characters of your recovery key exactly as shown." -> RecoveryUiError.CONFIRMATION_MISMATCH
    "Recovery setup timed out. Keep your recovery key and try again." -> RecoveryUiError.SETUP_TIMEOUT
    "Recovery timed out. Try again when you are connected." -> RecoveryUiError.RECOVERY_TIMEOUT
    "Your recovery key was accepted, but this phone is still waiting for encryption and backup. Keep your key and try again." -> RecoveryUiError.USABILITY_TIMEOUT
    "Could not finish setting up recovery. Keep your key and try again when connected." -> RecoveryUiError.SETUP_FAILED
    "Could not recover with that key. Check the key and your connection, then try again." -> RecoveryUiError.RECOVERY_FAILED
    "Recovery settings changed. If you already saved a recovery key, use it to recover this session." -> RecoveryUiError.SETTINGS_CHANGED
    "Sign out on your other phone before recovering this account here." -> RecoveryUiError.OTHER_DEVICE
    else -> RecoveryUiError.OTHER
}

private fun reportUiStage(message: String) {
    val status = Bundle().apply { putString("stream", "\nVellivex UI: $message\n") }
    InstrumentationRegistry.getInstrumentation().sendStatus(2, status)
}

private fun ComposeTestRule.assertOriginalRecoveryHistoryHidden(repository: MatrixRepository) {
    assertFalse("The recovered account rendered unverified historical text", repository.state.value.messages.any {
        it.text == UI_MESSAGE || it.text == PEER_REPLY
    })
    onNodeWithText(UI_MESSAGE).assertDoesNotExist()
    onNodeWithText(PEER_REPLY).assertDoesNotExist()
}

private suspend fun requireUnavailableOriginalEvents(repository: MatrixRepository, eventIds: Set<String>) {
    val observed = withTimeoutOrNull(15_000) {
        // Selecting a room renders its header before openRoom has attached its
        // SDK timeline. Keep timeline acquisition inside the same event budget.
        while (true) {
            val timeline = sdkTimeline(repository)
            if (timeline != null && !repository.state.value.busy &&
                eventIds.all { timeline.restoredEventCategory(it).unavailable }
            ) return@withTimeoutOrNull true
            delay(250)
        }
    }
    assertTrue("The original encrypted events were not present as unavailable SDK messages", observed == true)
}

private fun sdkTimeline(repository: MatrixRepository): Timeline? = try {
    val opened = MatrixRepository::class.java.getDeclaredField("opened").apply { isAccessible = true }.get(repository)
    opened?.javaClass?.getDeclaredField("timeline")?.apply { isAccessible = true }?.get(opened) as? Timeline
} catch (_: ReflectiveOperationException) {
    null
}

private suspend fun reportRestoredHistoryDiagnostics(
    repository: MatrixRepository,
    activePeerEvent: String,
    signedOutDeviceEvent: String,
) {
    // Read only the fixture's two event categories, with no app runtime diagnostic surface.
    reportRecoveryStateDiagnostics(repository)
    val timeline = sdkTimeline(repository)
    if (timeline == null) {
        reportUiStage("Restored-history diagnostic: no open SDK timeline")
        return
    }
    val activePeer = timeline.restoredEventCategory(activePeerEvent)
    val signedOutDevice = timeline.restoredEventCategory(signedOutDeviceEvent)
    reportUiStage("Restored-history diagnostic for active peer: ${activePeer.description}")
    reportUiStage("Restored-history diagnostic for signed-out device: ${signedOutDevice.description}")
}

private fun reportRecoveryStateDiagnostics(repository: MatrixRepository) {
    try {
        val connection = MatrixRepository::class.java.getDeclaredField("connection")
            .apply { isAccessible = true }.get(repository)
        val client = connection?.javaClass?.getDeclaredField("client")
            ?.apply { isAccessible = true }?.get(connection) as? Client
        val confirmed = connection?.javaClass?.getDeclaredField("recoveryConfirmed")
            ?.apply { isAccessible = true }?.getBoolean(connection)
        client?.encryption()?.use { encryption ->
            reportUiStage("Recovery state diagnostic: app=${repository.state.value.recovery.name}, " +
                "busy=${repository.state.value.busy}, confirmed=$confirmed, " +
                "saved-key=${repository.state.value.recoveredWithKey}, sync=${repository.state.value.connection.name}, " +
                "SDK recovery=${encryption.recoveryState().name}, backup=${encryption.backupState().name}, " +
                "device=${encryption.verificationState().name}")
        }
        val opened = MatrixRepository::class.java.getDeclaredField("opened").apply { isAccessible = true }.get(repository)
        val retryCount = if (opened == null) 0 else synchronized(opened) {
            (opened.javaClass.getDeclaredField("retriedDecryptionSessions")
                .apply { isAccessible = true }.get(opened) as? Collection<*>)?.size ?: 0
        }
        reportUiStage("Recovery retry diagnostic: distinct sessions=$retryCount")
    } catch (_: Exception) {
        reportUiStage("Recovery state diagnostic unavailable")
    }
}

private data class RestoredEventCategory(val description: String, val unavailable: Boolean = false)

private suspend fun Timeline.restoredEventCategory(eventId: String): RestoredEventCategory = withTimeoutOrNull(3_000) {
    val event = try {
        getEventTimelineItemByEventId(eventId)
    } catch (_: ClientException) {
        return@withTimeoutOrNull RestoredEventCategory("event absent from SDK timeline")
    }
    try {
        when (val kind = (event.content as? TimelineItemContent.MsgLike)?.content?.kind) {
            is MsgLikeKind.UnableToDecrypt -> {
                val cause = (kind.msg as? EncryptedMessage.MegolmV1AesSha2)?.cause
                RestoredEventCategory(
                    description = "unable to decrypt (${cause?.name ?: "unknown scheme"})",
                    unavailable = true,
                )
            }
            is MsgLikeKind.Message -> when (val shield = event.lazyProvider.getShields(true)) {
                is ShieldState.Red -> RestoredEventCategory("decrypted, strict red shield (${shield.code.name})", unavailable = true)
                is ShieldState.Grey -> RestoredEventCategory("decrypted, strict grey shield (${shield.code.name})", unavailable = true)
                ShieldState.None -> RestoredEventCategory("decrypted, no strict shield")
            }
            else -> RestoredEventCategory("event present without message content")
        }
    } finally {
        event.destroy()
    }
} ?: RestoredEventCategory("SDK lookup timed out")

private suspend fun awaitPeer(
    peer: MatrixRepository,
    label: String,
    predicate: (MessengerState) -> Boolean,
): MessengerState = checkNotNull(withTimeoutOrNull(60_000) { peer.state.first(predicate) }) {
    "Timed out waiting for $label"
}
