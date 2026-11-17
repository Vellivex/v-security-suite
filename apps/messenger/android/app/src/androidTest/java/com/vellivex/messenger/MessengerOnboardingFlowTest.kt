package com.vellivex.messenger

import android.os.Bundle
import android.os.SystemClock
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
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
                deviceRecoveryKey = compose.createRecoveryThroughUi(device, compose.activity)
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
            val sent = awaitPeer(peer, "the message sent through the UI") { state ->
                state.messages.any { it.text == UI_MESSAGE && it.delivery == MessengerDelivery.Received }
            }.messages.single { it.text == UI_MESSAGE }
            assertTrue("The verified peer could not reply", peer.sendMessage(PEER_REPLY))
            compose.waitForText(PEER_REPLY)
            compose.onNodeWithText(PEER_REPLY).assertIsDisplayed()

            if (!alpha02Seed) {
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
                compose.signInWithSyntheticMail(fixture, email, useIme = true)
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
                    compose.waitForDisplayedText(RECOVERED_REPLY)
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
        val upgraded = args.getString("messengerAlpha02Upgrade") == "true"
        if (upgraded) {
            assertEquals("Restore the alpha02 history on the installed alpha04 app", 4L, installedVersionCode())
            compose.createRecoveryThroughUi(device, compose.activity).fill('\u0000')
        }
        reportUiStage("Restoring the saved session and encrypted conversation")
        compose.waitForText("Messages")
        compose.waitForText("Verified conversation")
        compose.onNodeWithText("Verified conversation").performClick()
        if (upgraded) {
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

private fun ComposeTestRule.waitForDisplayedText(value: String) {
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
            val nodes = onAllNodes(hasText(value)).fetchSemanticsNodes()
            val bounds = nodes.firstOrNull()?.boundsInRoot
            reportUiStage("Message visibility diagnostic: matching-nodes=${nodes.size}, " +
                "left=${bounds?.left}, top=${bounds?.top}, right=${bounds?.right}, bottom=${bounds?.bottom}")
        } catch (_: Exception) {
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
