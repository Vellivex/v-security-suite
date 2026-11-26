// SPDX-License-Identifier: GPL-3.0-or-later
package com.vellivex.messenger.a2a

import android.os.Bundle
import android.os.SystemClock
import android.view.WindowManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.UiScrollable
import androidx.test.uiautomator.UiSelector
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URI
import java.security.MessageDigest
import java.util.regex.Pattern

/**
 * Runs in a separately signed harness package. Neither participant imports Messenger classes,
 * reads its session store, calls its repositories, nor impersonates a peer through Matrix APIs.
 * Both installed apps perform authentication, recovery setup, verification and messaging via UI.
 * The loopback coordinator provides synthetic email delivery and synchronises the two UIs.
 */
@RunWith(AndroidJUnit4::class)
class MessengerAppToAppTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val arguments = InstrumentationRegistry.getArguments()
    private val device = UiDevice.getInstance(instrumentation)
    private val role = requireNotNull(arguments.getString("messengerA2aRole")).also { require(it in setOf("A", "B")) }
    private val peerRole = if (role == "A") "B" else "A"
    private val phase = requireNotNull(arguments.getString("messengerA2aPhase")).also { require(it in setOf("fresh", "restart")) }
    private val appVersion = requireNotNull(arguments.getString("messengerA2aAppVersion"))
        .also { require(it in setOf("5", "6", "8")) }.toInt()
    private val coordinator = Coordinator(
        requireNotNull(arguments.getString("messengerA2aCoordinator")),
        requireNotNull(arguments.getString("messengerA2aKey")), role,
    )
    private val runId = requireNotNull(arguments.getString("messengerA2aRunId")).also { require(it.matches(Regex("[a-z0-9]{8,24}"))) }

    @Test
    fun twoInstalledAppsUseTheirVisibleInterfaces() {
        Configurator.getInstance().waitForIdleTimeout = 500
        try {
            launchMessenger()
            if (phase == "fresh") freshExchange() else restartExchange()
            assertSecureWindow()
            coordinator.post("finish", JSONObject().put("phase", phase))
            stage("$phase-complete")
        } catch (failure: Throwable) {
            runCatching { reportFailureDiagnostics(failure) }
            runCatching { coordinator.post("failure", JSONObject().put("phase", phase)) }
            // UIAutomator exceptions can include editable text. Never attach their raw causes.
            throw AssertionError("Two-app UI acceptance failed for role $role in $phase; last safe checkpoint: $lastStage")
        }
    }

    private var lastStage = "launch"
    private var lastAction = "launch"
    private var expectedControl = ExpectedControl.TextControl

    private enum class ExpectedControl(val token: String, val label: String? = null) {
        NewConversation("new-conversation", "New conversation"),
        ContactContinue("contact-continue", "Continue"),
        TextControl("text-control"),
        DescribedControl("described-control"),
        EditableField("editable-field"),
        LabelledField("labelled-field"),
    }

    private fun freshExchange() {
        waitText("Continue with email")
        assertSecureWindow()
        stage("secure-fresh-launch")

        // The mailbox fixture identifies a single new challenge. Serialise the two real UI clicks
        // so an OTP can never be attributed to the wrong account.
        if (role == "B") coordinator.awaitBarrier("a-signed-in")
        signInAndSaveRecovery()
        if (role == "A") coordinator.arrive("a-signed-in")
        coordinator.barrier("both-signed-in")

        clickDescription("Your profile")
        waitText("Your Vellivex ID")
        val publicId = waitValue("visible public contact ID") {
            device.findObjects(By.pkg(APP).text(Pattern.compile("@[A-Za-z0-9_.=+/\\-]+:[A-Za-z0-9.:\\[\\]\\-]+")))
                .mapNotNull { it.text }.distinct().singleOrNull()
        }
        coordinator.post("value/public-id", JSONObject().put("value", publicId))
        clickText("Done")
        val otherId = coordinator.awaitPeerValue("public-id")
        assertTrue("Fresh test accounts must be different", publicId != otherId)
        stage("public-contact-id-read-from-ui")

        if (role == "A") {
            // Invalid contacts must fail without opening a room or enabling the composer.
            for ((inputCase, invalid) in listOf("malformed" to "not-a-contact", "self" to publicId,
                "foreign" to "@fictional:other.example.test")) {
                stage("invalid-$inputCase-start")
                lastAction = "wait-contact-error-clear"
                waitValue("previous input error to clear") {
                    if (!hasText("Enter another account ID on this messaging service.")) true else null
                }
                stage("invalid-$inputCase-before-open")
                clickText("New conversation")
                stage("invalid-$inputCase-open-tapped")
                setOnlyField(invalid)
                stage("invalid-$inputCase-field-set")
                stage("invalid-$inputCase-before-submit")
                clickText("Continue")
                stage("invalid-$inputCase-submit-tapped")
                waitText("Enter another account ID on this messaging service.")
                stage("invalid-$inputCase-error-visible")
                waitText("Your people. Your space.")
                stage("invalid-$inputCase-empty-inbox-visible")
                lastAction = "assert-invalid-contact-blocked"
                assertFalse("Invalid contact opened a composer", hasDescription("Send message"))
                assertFalse("Invalid contact created a room", hasText("Verify your contact to start chatting"))
                assertFalse("Invalid contact created an invitation", hasText("Conversation invitation"))
                stage("invalid-$inputCase-blocked")
            }
            stage("invalid-self-and-foreign-contact-blocked")
            clickText("New conversation")
            setOnlyField(otherId)
            clickText("Continue")
            waitText("Verify your contact to start chatting")
            coordinator.arrive("invitation-created")
            coordinator.awaitBarrier("invitation-accepted")
            clickText("Verify your contact to start chatting")
        } else {
            coordinator.awaitBarrier("invitation-created")
            clickText("Conversation invitation")
            waitText("Accept invitation")
            assertFalse("An invitation must not enable sending", hasDescription("Send message"))
            clickText("Accept invitation")
            waitText(VERIFY_FIRST)
            coordinator.arrive("invitation-accepted")
        }
        waitText(VERIFY_FIRST)
        assertComposerBlocked()
        coordinator.barrier("both-opened-unverified-room")
        stage("ui-invitation-accepted-send-blocked")

        compareUiCodes("rejected", initiator = "A", reject = true)
        compareUiCodes("accepted", initiator = "B", reject = false)
        waitText("Write a message")
        stage("both-ui-codes-matched-and-confirmed")

        if (role == "A") {
            send(firstMessage("A"))
            waitMessage(firstMessage("B"))
        } else {
            waitMessage(firstMessage("A"))
            send(firstMessage("B"))
        }
        coordinator.barrier("first-bidirectional-exchange")
        stage("bidirectional-message-visible-on-peer")

        clickDescription("Back to messages")
        waitText("Messages")
        waitText("Verified conversation")
        clickText("Verified conversation")
        waitMessage(firstMessage(peerRole))
        assertTrue("Reopened verified conversation lost its composer", hasDescription("Send message"))
        stage("inbox-and-conversation-reopen")

        // Only B's Matrix network path is cut. The actual app and its sync engine remain running;
        // its coordinator connection stays available so reconnection is deterministic.
        if (role == "B") {
            coordinator.post("network", JSONObject().put("online", false))
            coordinator.arrive("b-network-off")
            coordinator.awaitBarrier("a-offline-message-submitted")
            SystemClock.sleep(1500)
            assertMessageAbsent(offlineMessage("A"))
            send(offlineMessage("B"))
            assertMessageAbsent(offlineMessage("A"))
            coordinator.awaitBlockedNetworkRequest()
            stage("offline-peer-does-not-receive-and-can-queue")
            coordinator.post("network", JSONObject().put("online", true))
            coordinator.arrive("b-network-restored")
            waitMessage(offlineMessage("A"))
        } else {
            coordinator.awaitBarrier("b-network-off")
            send(offlineMessage("A"))
            coordinator.arrive("a-offline-message-submitted")
            coordinator.awaitBarrier("b-network-restored")
            waitMessage(offlineMessage("B"))
        }
        coordinator.barrier("reconnected-bidirectional-exchange")
        stage("reconnected-message-visible-on-peer")

        // Leave both real app sessions intact. The host force-stops both app processes between
        // phases; the separately signed harness cannot fake a restoration by retaining app state.
        clickDescription("Back to messages")
        waitText("Messages")
        waitText("Verified conversation")
        coordinator.barrier("ready-for-cold-restart")
    }

    private fun restartExchange() {
        waitText("Messages")
        assertFalse("Cold restart unexpectedly requested email sign-in", hasText("Continue with email"))
        waitText("Verified conversation")
        clickText("Verified conversation")
        waitText("Contact verified")
        waitMessage(offlineMessage("A"))
        waitMessage(offlineMessage("B"))
        assertTrue("Cold restart did not retain verified sending", hasDescription("Send message"))
        stage("cold-restart-restored-trust-and-both-messages")
        coordinator.barrier("both-restored")
        if (role == "B") {
            send(restartMessage("B"))
            waitMessage(restartMessage("A"))
        } else {
            waitMessage(restartMessage("B"))
            send(restartMessage("A"))
        }
        coordinator.barrier("restart-bidirectional-exchange")
        stage("new-bidirectional-messages-after-cold-restart")
        clickDescription("Back to messages")
        waitText("Messages")
    }

    private fun signInAndSaveRecovery() {
        stage("sign-in-ui")
        setOnlyField("missing-domain@")
        clickText("Continue with email")
        waitText("Enter a valid email address.")
        stage("invalid-email-blocked")
        setOnlyField("ui-$role-$runId@example.test")
        clickText("Test server settings")
        labelledField("Server address").text = "http://127.0.0.1:8008"
        clickText("Test server settings")
        stage("test-server-set")
        coordinator.post("mail/begin")
        clickText("Continue with email")
        stage("email-request-clicked")
        waitText("Eight-digit email code")
        stage("code-screen-shown")
        val code = coordinator.awaitCode()
        val wrong = if (code == "00000000") "11111111" else "00000000"
        setOnlyField(wrong)
        clickText("Open Vellivex")
        waitText("That code could not be verified.", substring = true)
        stage("wrong-code-rejected")
        setOnlyField(code)
        clickText("Open Vellivex")
        waitText("Secure your account")
        stage("recovery-screen-shown")
        assertFalse("Recovery setup was skipped", hasText("Messages"))
        clickText("Create recovery key")
        val key = waitValue("visible recovery key") {
            device.findObjects(By.pkg(APP).text(Pattern.compile("[1-9A-HJ-NP-Za-km-z\\s]{40,192}")))
                .mapNotNull { it.text }
                .filter { value -> value.trim().split(Regex("\\s+")).let { parts -> parts.size >= 8 && parts.all { it.length in 1..4 } } }
                .singleOrNull()
        }.toCharArray()
        try {
            stage("key-created")
            assertSecureWindow()
            val suffix = key.filterNot(Char::isWhitespace).takeLast(4).joinToString("")
            setOnlyField("0000")
            clickText("I've saved my recovery key")
            waitText("Enter the last four characters of your recovery key exactly as shown.")
            assertFalse("Wrong recovery confirmation opened messages", hasText("Messages"))
            stage("wrong-suffix-rejected")
            setOnlyField(suffix)
            clickText("I've saved my recovery key")
            waitText("Messages")
            stage("setup-confirmed")
        } finally {
            key.fill('\u0000')
        }
        stage("email-code-and-recovery-setup-through-ui")
    }

    private fun compareUiCodes(round: String, initiator: String, reject: Boolean) {
        coordinator.barrier("$round-ready")
        if (role == initiator) clickDescription("Verify contact") else {
            waitText("Compare codes")
            clickText("Compare codes")
        }
        waitText("They match")
        assertSecureWindow()
        val code = waitValue("complete displayed verification code") {
            device.findObjects(By.pkg(APP).text(Pattern.compile(".+  .+")))
                .mapNotNull { it.text }
                .mapNotNull { value ->
                    val parts = value.split("  ")
                    when {
                        parts.size == 3 && parts.all { it.matches(Regex("[0-9]{4}")) } -> Triple("numbers", 3, value)
                        parts.size == 7 && parts.all { it.isNotBlank() && !it.any(Char::isWhitespace) } &&
                            !value.any { it in 'A'..'Z' || it in 'a'..'z' } -> Triple("emoji", 7, value)
                        else -> null
                    }
                }.singleOrNull()
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(code.third.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        coordinator.post("sas/$round", JSONObject().put("kind", code.first).put("count", code.second).put("sha256", digest))
        coordinator.awaitMatchingSas(round)
        stage("$round-full-ui-verification-values-match")
        if (reject) {
            if (role == "B") clickText("They don't match")
            waitText("Verification did not complete. Try again with your contact.")
            clickText("Done")
            waitText(VERIFY_FIRST)
            assertComposerBlocked()
            coordinator.barrier("rejected-send-blocked")
            stage("rejected-verification-keeps-sending-blocked")
        } else {
            // Both compare actual displayed values before either side can click confirmation.
            coordinator.barrier("accepted-ui-values-compared")
            clickText("They match")
            waitText("Contact verified. You can now send private messages.")
            clickText("Done")
            waitText("Write a message")
            coordinator.barrier("both-confirmed")
        }
    }

    private fun send(message: String) {
        waitText("Write a message")
        setOnlyField(message)
        val send = waitValue("enabled send control") {
            device.findObject(By.pkg(APP).desc("Send message"))?.takeIf { it.isEnabled }
        }
        send.click()
        waitMessage(message)
        waitValue("accepted message to clear from the draft") {
            if (editableFields().all { it.text.orEmpty() != message }) true else null
        }
    }

    private fun waitMessage(message: String) {
        waitValue("one visible exact message") {
            val nodes = device.findObjects(By.pkg(APP).text(message))
                .filter { it.className != EDIT_TEXT && !it.visibleBounds.isEmpty }
            if (nodes.size == 1) true else null
        }
        assertEquals("Message must render exactly once", 1,
            device.findObjects(By.pkg(APP).text(message)).count { it.className != EDIT_TEXT && !it.visibleBounds.isEmpty })
    }

    private fun assertMessageAbsent(message: String) = assertTrue(
        "Offline recipient displayed a message before reconnection",
        device.findObjects(By.pkg(APP).text(message)).none { it.className != EDIT_TEXT },
    )

    private fun assertComposerBlocked() {
        assertFalse("Unverified conversation exposed Send", hasDescription("Send message"))
        assertFalse("Unverified conversation exposed a draft", hasText("Write a message"))
    }

    private fun launchMessenger() {
        val result = device.executeShellCommand("am start -W -n $APP/com.vellivex.messenger.MainActivity")
        assertFalse("Could not launch the installed release app", result.contains("Error:"))
        waitValue("release app window") { device.findObject(By.pkg(APP)) }
    }

    private fun assertSecureWindow() {
        lastAction = "check-secure-window"
        val windows = device.executeShellCommand("dumpsys window")
        val focus = Regex("(?m)^\\s*mCurrentFocus=Window\\{([^\\r\\n]+)\\}").find(windows)?.groupValues?.get(1)
        assertTrue("The focused window must belong to the release app", focus?.contains(APP) == true)
        val headers = Regex("(?m)^\\s*Window #[0-9]+ Window\\{([^\\r\\n]+)\\}:?\\s*$").findAll(windows).toList()
        val index = headers.indexOfFirst { it.groupValues[1] == focus }
        assertTrue("The focused release window was not found in WindowManager", index >= 0)
        val block = windows.substring(headers[index].range.last + 1,
            headers.getOrNull(index + 1)?.range?.first ?: windows.length)
        val secure = Regex("\\bSECURE\\b").containsMatchIn(block) ||
            Regex("\\bfl=(?:0x)?([0-9a-fA-F]{4,})\\b").findAll(block).any { match ->
                (match.groupValues[1].toLongOrNull(16) ?: 0L) and WindowManager.LayoutParams.FLAG_SECURE.toLong() != 0L
        }
        assertTrue("The release activity did not retain FLAG_SECURE", secure)
        stage("secure-window-verified")
    }

    private fun editableFields(): List<UiObject2> = device.findObjects(By.pkg(APP).clazz(EDIT_TEXT))
        .filter { !it.visibleBounds.isEmpty }

    private fun labelledField(label: String): UiObject2 {
        lastAction = "find-labelled-field"
        expectedControl = ExpectedControl.LabelledField
        if (device.findObject(By.pkg(APP).text(label))?.visibleBounds?.isEmpty != false) {
            runCatching { UiScrollable(UiSelector().packageName(APP).scrollable(true)).scrollTextIntoView(label) }
        }
        val labelNode = waitText(label)
        val labelBounds = labelNode.visibleBounds
        return waitValue("uniquely labelled editable field") {
            editableFields().filter { editor ->
                editor.text == label || editor.contentDescription == label || editor.hasObject(By.text(label)) ||
                    editor.visibleBounds.contains(labelBounds.centerX(), labelBounds.centerY())
            }.singleOrNull()
        }
    }

    private fun setOnlyField(value: String) {
        lastAction = "set-single-editable-field"
        expectedControl = ExpectedControl.EditableField
        val editor = waitValue("single visible editable field") { editableFields().singleOrNull() }
        editor.text = value
    }

    private fun waitText(value: String, substring: Boolean = false): UiObject2 {
        lastAction = when (value) {
            "Enter another account ID on this messaging service." -> "wait-contact-error"
            "Your people. Your space." -> "wait-empty-inbox"
            else -> "wait-screen-text"
        }
        return waitValue("visible expected screen text") {
            device.findObject(if (substring) By.pkg(APP).textContains(value) else By.pkg(APP).text(value))
                ?.takeIf { !it.visibleBounds.isEmpty }
        }
    }

    private fun hasText(value: String): Boolean = device.hasObject(By.pkg(APP).text(value))
    private fun hasDescription(value: String): Boolean = device.hasObject(By.pkg(APP).desc(value))

    private fun clickText(value: String) {
        expectedControl = when (value) {
            "New conversation" -> ExpectedControl.NewConversation
            "Continue" -> ExpectedControl.ContactContinue
            else -> ExpectedControl.TextControl
        }
        lastAction = when (value) {
            "New conversation" -> "tap-new-conversation"
            "Continue" -> "tap-contact-continue"
            else -> "tap-text-control"
        }
        if (value == "New conversation") {
            clickNewConversation()
            return
        }
        val node = device.findObject(By.pkg(APP).text(value))?.takeIf { !it.visibleBounds.isEmpty } ?: run {
            runCatching { UiScrollable(UiSelector().packageName(APP).scrollable(true)).scrollTextIntoView(value) }
            waitText(value)
        }
        assertTrue("Expected UI control is disabled", node.isEnabled)
        node.click()
    }

    private fun clickNewConversation() {
        val described = if (appVersion >= 6) {
            lastAction = "find-accessible-new-conversation"
            waitValue("uniquely named new-conversation control") {
                val named = device.findObjects(By.pkg(APP).desc("New conversation")) +
                    device.findObjects(By.pkg(APP).text("New conversation"))
                val targets = named.filter { !it.visibleBounds.isEmpty }.mapNotNull { label ->
                    var candidate: UiObject2? = label
                    var depth = 0
                    while (candidate != null && !candidate.isClickable && depth++ < 4) candidate = candidate.parent
                    candidate?.takeIf { it.applicationPackage == APP && it.isEnabled &&
                        it.isClickable && !it.visibleBounds.isEmpty }
                }.distinctBy { listOf(it.className, it.visibleBounds.toShortString()) }
                targets.singleOrNull()
            }.also { stage("accessible-new-conversation-control-observed") }
        } else null
        val named = described ?: device.findObject(By.pkg(APP).text("New conversation"))?.takeIf { !it.visibleBounds.isEmpty }
        val node = named ?: run {
            assertEquals("Anonymous-control fallback is restricted to historical Alpha05", 5, appVersion)
            lastAction = "find-unnamed-new-conversation"
            // Alpha05 uses Material3 1.4.0's icon/text FAB overload. That overload clears the
            // text's semantics and the app supplied a null icon description. The visible FAB
            // therefore has Button role but no accessible name. Compose UI 1.9.4 can expose
            // the click action on a View parent and Button role on a nonclickable fake child.
            // Require that actual parent/child shape; never accept an arbitrary anonymous View.
            // Observe its actual UI node;
            // never substitute a hardcoded coordinate or an app-internal action.
            waitValue("unique unnamed new-conversation button in the empty inbox") {
                val candidates = unnamedNewConversationButtons()
                val candidate = candidates.singleOrNull() ?: return@waitValue null
                val content = device.findObject(By.pkg(APP).text("Share my ID")) ?: return@waitValue null
                val bounds = candidate.visibleBounds
                candidate.takeIf {
                    bounds.top >= content.visibleBounds.bottom && bounds.centerX() > device.displayWidth / 2 &&
                        bounds.centerY() > device.displayHeight / 2 && bounds.left >= 0 && bounds.top >= 0 &&
                        bounds.right <= device.displayWidth && bounds.bottom <= device.displayHeight
                }
            }.also {
                stage("unnamed-new-conversation-control-observed")
            }
        }
        assertTrue("Expected new-conversation control is disabled", node.isEnabled)
        assertTrue("Expected new-conversation control is not clickable", node.isClickable)
        reportObservedControl(node, if (described != null) "description" else if (named == null) "anonymous-button" else "text")
        lastAction = "tap-new-conversation"
        node.click()
        waitText("Start a conversation")
        waitText("Contact ID or link")
        waitText("Cancel")
        waitText("Continue")
        assertEquals("The new-conversation dialog must expose one contact editor", 1, editableFields().size)
        stage("new-conversation-dialog-observed")
    }

    private fun unnamedNewConversationButtons(): List<UiObject2> {
        fun visible(value: String) = device.findObject(By.pkg(APP).text(value))?.visibleBounds?.isEmpty == false
        if (!visible("Messages") || !visible("Your people. Your space.") || !visible("Share my ID") ||
            visible("Start a conversation") || visible("Your Vellivex ID") || visible("Conversation invitation") ||
            visible("Verify your contact to start chatting") || visible("Verified conversation") || hasDescription("Send message")
        ) return emptyList()
        return device.findObjects(By.pkg(APP).enabled(true).clickable(true))
            .filter { node -> !node.visibleBounds.isEmpty && isUnnamed(node) &&
                (node.className == "android.widget.Button" ||
                    (node.className == "android.view.View" && nonclickableButtonChildren(node).isNotEmpty())) }
    }

    private fun isUnnamed(node: UiObject2, depth: Int = 0): Boolean =
        node.text.isNullOrBlank() && node.contentDescription.isNullOrBlank() &&
            if (depth < 8) node.children.all { isUnnamed(it, depth + 1) } else node.children.isEmpty()

    private fun nonclickableButtonChildren(parent: UiObject2): List<UiObject2> {
        val result = mutableListOf<UiObject2>()
        val parentBounds = parent.visibleBounds
        fun visit(node: UiObject2, depth: Int) {
            if (depth > 8) return
            for (child in node.children) {
                if (child.className == "android.widget.Button" && !child.isClickable &&
                    !child.visibleBounds.isEmpty && parentBounds.contains(child.visibleBounds) && isUnnamed(child)
                ) result.add(child)
                visit(child, depth + 1)
            }
        }
        visit(parent, 0)
        return result
    }

    private fun reportObservedControl(node: UiObject2, channel: String) {
        require(channel in setOf("text", "description", "anonymous-button"))
        val bounds = node.visibleBounds
        val parentRole = if (node.className == "android.widget.Button") "button" else "view"
        val roleChild = nonclickableButtonChildren(node).firstOrNull()?.visibleBounds
        val message = "Two-app control $role $phase: expected=new-conversation channel=$channel role=$parentRole " +
            "enabled=${node.isEnabled} clickable=${node.isClickable} " +
            "bounds=${bounds.left},${bounds.top},${bounds.right},${bounds.bottom} " +
            "role-child=${roleChild != null} child-bounds=${roleChild?.left ?: 0},${roleChild?.top ?: 0},${roleChild?.right ?: 0},${roleChild?.bottom ?: 0} " +
            "screen=${device.displayWidth},${device.displayHeight}\n"
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", message) })
    }

    private fun clickDescription(value: String) {
        lastAction = "tap-described-control"
        expectedControl = ExpectedControl.DescribedControl
        val node = waitValue("visible described control") { device.findObject(By.pkg(APP).desc(value)) }
        assertTrue("Expected UI control is disabled", node.isEnabled)
        node.click()
    }

    private fun <T : Any> waitValue(description: String, read: () -> T?): T {
        val until = SystemClock.elapsedRealtime() + 60_000
        while (SystemClock.elapsedRealtime() < until) {
            runCatching(read).getOrNull()?.let { return it }
            SystemClock.sleep(200)
        }
        throw AssertionError("Timed out waiting for $description")
    }

    private fun stage(name: String) {
        lastStage = name
        coordinator.post("checkpoint", JSONObject().put("name", name).put("phase", phase))
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", "Two-app $role $phase: $name\n") })
    }

    private fun reportFailureDiagnostics(failure: Throwable) {
        val category = when (failure) {
            is androidx.test.uiautomator.StaleObjectException -> "stale-ui"
            is androidx.test.uiautomator.UiObjectNotFoundException -> "missing-ui"
            is java.net.SocketTimeoutException -> "network-timeout"
            is java.io.IOException -> "network-io"
            is AssertionError -> "assertion"
            is IllegalArgumentException -> "argument"
            is IllegalStateException -> "state"
            else -> "other"
        }
        val line = failure.stackTrace.firstOrNull {
            it.className.startsWith("com.vellivex.messenger.a2a.") && it.fileName == "MessengerAppToAppTest.kt"
        }?.lineNumber?.coerceAtLeast(0) ?: 0
        val flowNames = mapOf("freshExchange" to "fresh-exchange", "restartExchange" to "restart-exchange",
            "signInAndSaveRecovery" to "sign-in", "compareUiCodes" to "verification")
        val callerFrame = failure.stackTrace.firstOrNull {
            it.className == "com.vellivex.messenger.a2a.MessengerAppToAppTest" && it.methodName in flowNames
        }
        val caller = callerFrame?.methodName?.let(flowNames::get) ?: "unknown"
        val callerLine = callerFrame?.lineNumber?.coerceAtLeast(0) ?: 0
        fun flag(read: () -> Boolean): String = runCatching(read).fold({ it.toString() }, { "unavailable" })
        fun visible(value: String): Boolean = device.findObject(By.pkg(APP).text(value))
            ?.visibleBounds?.isEmpty == false
        val dialog = flag { visible("Start a conversation") }
        val error = flag { visible("Enter another account ID on this messaging service.") }
        val emptyInbox = flag { visible("Your people. Your space.") }
        val roomRow = flag { visible("Verify your contact to start chatting") || visible("Conversation invitation") || visible("Verified conversation") }
        val composer = flag { device.findObject(By.pkg(APP).desc("Send message"))?.visibleBounds?.isEmpty == false }
        val editableCount = runCatching { editableFields().size }.getOrDefault(-1)
        val safeAction = lastAction.takeIf { it.matches(Regex("[a-z0-9-]{1,80}")) } ?: "unknown"
        val message = "Two-app diagnostic $role $phase: category=$category action=$safeAction line=$line " +
            "expected=${expectedControl.token} caller=$caller caller-line=$callerLine " +
            "dialog=$dialog error=$error empty-inbox=$emptyInbox room-row=$roomRow composer=$composer editable-count=$editableCount\n"
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", message) })
        runCatching { reportTargetDiagnostics() }
        runCatching { reportEmptyInboxStructure() }
    }

    private fun reportTargetDiagnostics() {
        val texts = expectedControl.label?.let { device.findObjects(By.pkg(APP).text(it)) }.orEmpty()
        val descriptions = expectedControl.label?.let { device.findObjects(By.pkg(APP).desc(it)) }.orEmpty()
        val anonymous = if (expectedControl == ExpectedControl.NewConversation) unnamedNewConversationButtons() else emptyList()
        val candidate = (texts + descriptions + anonymous).firstOrNull { !it.visibleBounds.isEmpty }
        val bounds = candidate?.visibleBounds
        val roleName = when (candidate?.className) {
            "android.widget.Button" -> "button"
            "android.widget.EditText" -> "editor"
            "android.widget.TextView" -> "text"
            "android.view.View" -> "view"
            null -> "none"
            else -> "other"
        }
        val focus = runCatching { (device.currentPackageName == APP).toString() }.getOrDefault("unavailable")
        val ime = runCatching {
            Regex("\\bmInputShown=(true|false)\\b").find(device.executeShellCommand("dumpsys input_method"))?.groupValues?.get(1)
                ?: "unavailable"
        }.getOrDefault("unavailable")
        val message = "Two-app target $role $phase: expected=${expectedControl.token} text-count=${texts.size} " +
            "description-count=${descriptions.size} anonymous-count=${anonymous.size} " +
            "bounds=${bounds?.left ?: 0},${bounds?.top ?: 0},${bounds?.right ?: 0},${bounds?.bottom ?: 0} " +
            "role=$roleName focus-app=$focus ime=$ime\n"
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", message) })
    }

    private fun reportEmptyInboxStructure() {
        if (expectedControl != ExpectedControl.NewConversation) return
        fun visible(value: String) = device.findObject(By.pkg(APP).text(value))?.visibleBounds?.isEmpty == false
        val messages = visible("Messages")
        val empty = visible("Your people. Your space.")
        val profile = visible("Your Vellivex ID")
        val dialog = visible("Start a conversation")
        // This structural inventory is intentionally restricted to the known empty inbox.
        // It contains no node text, descriptions, IDs, editor values, or full hierarchy.
        if (!messages || !empty || profile || dialog) return
        val shareId = visible("Share my ID")
        val room = visible("Conversation invitation") || visible("Verify your contact to start chatting") || visible("Verified conversation")
        val composer = hasDescription("Send message")
        val clickable = device.findObjects(By.pkg(APP).clickable(true))
        val buttons = device.findObjects(By.pkg(APP).clazz("android.widget.Button"))
        val activeButtons = buttons.filter { it.isEnabled && it.isClickable && !it.visibleBounds.isEmpty }
        val activeViews = clickable.filter { it.className == "android.view.View" && it.isEnabled && !it.visibleBounds.isEmpty }
        val summary = "Two-app structure $role $phase: messages=$messages empty-inbox=$empty share-id=$shareId " +
            "profile-dialog=$profile new-chat-dialog=$dialog room-row=$room composer=$composer " +
            "app-clickable-count=${clickable.size} button-count=${buttons.size} " +
            "button-visible-count=${buttons.count { !it.visibleBounds.isEmpty }} button-clickable-count=${activeButtons.size} " +
            "view-clickable-count=${activeViews.size} anonymous-button-count=${activeButtons.count { isUnnamed(it) }} " +
            "anonymous-view-count=${activeViews.count { isUnnamed(it) }} " +
            "role-child-view-count=${activeViews.count { isUnnamed(it) && nonclickableButtonChildren(it).isNotEmpty() }} " +
            "truncated=${clickable.size > 20 || buttons.size > 20}\n"
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", summary) })
        for ((kind, nodes) in listOf("clickable" to clickable, "button" to buttons)) {
            nodes.take(20).forEachIndexed { index, node ->
                val bounds = node.visibleBounds
                val classRole = when (node.className) {
                    "android.widget.Button" -> "button"
                    "android.widget.ImageButton" -> "image-button"
                    "android.widget.EditText" -> "editor"
                    "android.widget.TextView" -> "text"
                    "android.view.View" -> "view"
                    else -> "other"
                }
                val record = "Two-app node $role $phase: kind=$kind index=$index role=$classRole " +
                    "enabled=${node.isEnabled} clickable=${node.isClickable} visible=${!bounds.isEmpty} " +
                    "text-present=${!node.text.isNullOrBlank()} description-present=${!node.contentDescription.isNullOrBlank()} " +
                    "named-descendants=${node.children.any { !isUnnamed(it) }} role-children=${nonclickableButtonChildren(node).size} " +
                    "bounds=${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}\n"
                instrumentation.sendStatus(0, Bundle().apply { putString("stream", record) })
            }
        }
    }

    private fun firstMessage(from: String) = "Fictional $from to peer $runId."
    private fun offlineMessage(from: String) = "Fictional offline $from $runId."
    private fun restartMessage(from: String) = "Fictional restart $from $runId."

    companion object {
        private const val APP = "com.vellivex.messenger.alpha"
        private const val EDIT_TEXT = "android.widget.EditText"
        private const val VERIFY_FIRST = "Compare a short code with your contact before your first message."
    }
}

private class Coordinator(baseUrl: String, private val key: String, private val role: String) {
    private val base = URI(baseUrl).also {
        require(it.scheme == "http" && it.host == "127.0.0.1" && it.port in 1..65535 &&
            it.rawPath in listOf("", "/") && it.userInfo == null && it.rawQuery == null && it.rawFragment == null)
    }.toString().trimEnd('/')

    fun post(path: String, value: JSONObject = JSONObject()): JSONObject = request(path, value)
    private fun get(path: String): JSONObject = request(path, null)

    fun arrive(name: String) { post("barrier/$name") }
    fun awaitBarrier(name: String) { poll("barrier/$name") { it.optBoolean("ready") } }
    fun barrier(name: String) { arrive(name); poll("barrier/$name") { it.optInt("count") == 2 } }
    fun awaitPeerValue(name: String): String = poll("peer/$name") { it.optBoolean("ready") }.getString("value")
    fun awaitCode(): String = poll("mail/code") { it.optBoolean("ready") }.getString("code").also {
        require(it.matches(Regex("[0-9]{8}")))
    }
    fun awaitMatchingSas(round: String) {
        val result = poll("sas/$round") { it.optBoolean("ready") }
        assertTrue("The two actual app screens displayed different verification values", result.getBoolean("match"))
    }
    fun awaitBlockedNetworkRequest() { poll("network") { it.optInt("blocked") > 0 } }

    private fun poll(path: String, done: (JSONObject) -> Boolean): JSONObject {
        // A peer barrier can encompass several UI steps (including recovery). Each UI action
        // still has its own independent 60-second limit; this is the bounded whole-phase wait.
        val until = SystemClock.elapsedRealtime() + 180_000
        while (SystemClock.elapsedRealtime() < until) {
            val result = get(path)
            if (result.optBoolean("peer_failed")) throw AssertionError("The other UI participant failed")
            if (done(result)) return result
            SystemClock.sleep(200)
        }
        throw AssertionError("Timed out waiting for the other installed app")
    }

    private fun request(path: String, value: JSONObject?): JSONObject {
        val connection = URI("$base/v1/$role/$path").toURL().openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 10_000
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Authorization", "Bearer $key")
            connection.setRequestProperty("Accept", "application/json")
            if (value != null) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(value.toString().toByteArray(Charsets.UTF_8)) }
            }
            check(connection.responseCode == 200) { "Loopback test coordinator request failed" }
            return JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally {
            connection.disconnect()
        }
    }
}
