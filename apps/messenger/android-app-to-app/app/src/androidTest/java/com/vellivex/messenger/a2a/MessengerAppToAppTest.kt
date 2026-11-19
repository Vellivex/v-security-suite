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
            runCatching { coordinator.post("failure", JSONObject().put("phase", phase)) }
            // UIAutomator exceptions can include editable text. Never attach their raw causes.
            throw AssertionError("Two-app UI acceptance failed for role $role in $phase; last safe checkpoint: $lastStage")
        }
    }

    private var lastStage = "launch"

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
            for (invalid in listOf("not-a-contact", publicId, "@fictional:other.example.test")) {
                waitValue("previous input error to clear") {
                    if (!hasText("Enter another account ID on this messaging service.")) true else null
                }
                clickText("New conversation")
                setOnlyField(invalid)
                clickText("Continue")
                waitText("Enter another account ID on this messaging service.")
                waitText("Your people. Your space.")
                assertFalse("Invalid contact opened a composer", hasDescription("Send message"))
                assertFalse("Invalid contact created a room", hasText("Verify your contact to start chatting"))
                assertFalse("Invalid contact created an invitation", hasText("Conversation invitation"))
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
        val editor = waitValue("single visible editable field") { editableFields().singleOrNull() }
        editor.text = value
    }

    private fun waitText(value: String, substring: Boolean = false): UiObject2 = waitValue("visible expected screen text") {
        device.findObject(if (substring) By.pkg(APP).textContains(value) else By.pkg(APP).text(value))
            ?.takeIf { !it.visibleBounds.isEmpty }
    }

    private fun hasText(value: String): Boolean = device.hasObject(By.pkg(APP).text(value))
    private fun hasDescription(value: String): Boolean = device.hasObject(By.pkg(APP).desc(value))

    private fun clickText(value: String) {
        val node = device.findObject(By.pkg(APP).text(value))?.takeIf { !it.visibleBounds.isEmpty } ?: run {
            runCatching { UiScrollable(UiSelector().packageName(APP).scrollable(true)).scrollTextIntoView(value) }
            waitText(value)
        }
        assertTrue("Expected UI control is disabled", node.isEnabled)
        node.click()
    }

    private fun clickDescription(value: String) {
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
