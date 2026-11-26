// SPDX-License-Identifier: GPL-3.0-or-later
package com.vellivex.messenger

import android.Manifest
import android.content.pm.PackageManager
import android.app.ActivityManager
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationManager
import android.os.ParcelFileDescriptor
import android.os.PowerManager
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID

/** Two disposable Android installations share only the ordinary Synapse API and a loopback QA rendezvous. */
@RunWith(AndroidJUnit4::class)
class MessengerNotificationPairTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val instrument = InstrumentationRegistry.getInstrumentation()
    private val args = InstrumentationRegistry.getArguments()
    private val context = instrument.targetContext
    private val repo = (context.applicationContext as MessengerApplication).repository
    private val nm = context.getSystemService(NotificationManager::class.java)!!
    private val lock = context.getSystemService(KeyguardManager::class.java)!!
    private val power = context.getSystemService(PowerManager::class.java)!!
    private val role = args.getString("pairRole")!!.also { require(it in listOf("A", "B")) }
    private val phase = args.getString("pairPhase")!!.also { require(it in listOf("fresh", "restart")) }
    private val key = args.getString("pairKey")!!
    private val incoming = "vellivex_incoming_messages"
    private val status = "vellivex_sync_status"

    private fun checkIn(path: String, value: JSONObject? = null): JSONObject {
        val http = URL("http://127.0.0.1:8030/v1/$role/$path").openConnection() as HttpURLConnection
        try {
            http.connectTimeout = 5000
            http.readTimeout = 5000
            http.setRequestProperty("Authorization", "Bearer $key")
            if (value != null) {
                http.requestMethod = "POST"
                http.doOutput = true
                http.outputStream.use { it.write(value.toString().toByteArray()) }
            }
            check(http.responseCode == 200) { "Fixture rendezvous failed" }
            return http.inputStream.bufferedReader().use { JSONObject(it.readText()) }
        } finally { http.disconnect() }
    }

    private suspend fun waitFor(seconds: Int = 40, predicate: () -> Boolean): Boolean =
        withTimeoutOrNull(seconds * 1000L) {
            while (!predicate()) delay(150)
            true
        } ?: false

    private suspend fun meet(name: String) {
        val path = "barrier/$phase-$name"
        checkIn(path, JSONObject())
        assertTrue("Pair did not meet at $name", waitFor(90) { checkIn(path).getInt("count") == 2 })
    }

    private suspend fun state(predicate: (MessengerState) -> Boolean) = withTimeout(60_000) { repo.state.first(predicate) }

    private fun shell(cmd: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrument.uiAutomation.executeShellCommand(cmd)).bufferedReader().use { it.readText() }

    private fun node(value: String): AccessibilityNodeInfo? {
        val root = instrument.uiAutomation.rootInActiveWindow ?: return null
        return root.findAccessibilityNodeInfosByText(value).firstOrNull { it.text?.toString() == value && it.isVisibleToUser }
    }

    private fun systemNode(): AccessibilityNodeInfo? {
        val a = instrument.uiAutomation
        val info = a.serviceInfo
        info.packageNames = null
        info.flags = info.flags or android.accessibilityservice.AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or
            android.accessibilityservice.AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
        a.serviceInfo = info
        val roots = a.windows.mapNotNull { it.root } + listOfNotNull(a.rootInActiveWindow)
        return roots.filter { root -> root.packageName?.toString() == "com.android.systemui" }
            .flatMap { root -> listOf("New Vellivex message", "Open Vellivex to view it.").flatMap { text ->
                root.findAccessibilityNodeInfosByText(text).filter { n -> n.text?.toString()?.trim() == text }
            } }.firstOrNull { n -> val bounds = android.graphics.Rect(); n.getBoundsInScreen(bounds); !bounds.isEmpty }
    }

    private suspend fun osRow(case: String, view: String): Boolean {
        val request = "$phase-$case-$view"
        val n = systemNode()
        if (n != null) {
            if (view == "tap") {
                val bounds = android.graphics.Rect()
                n.getBoundsInScreen(bounds)
                shell("input tap ${bounds.centerX()} ${bounds.centerY()}")
            }
            evidence("$case $view system-tree=true")
            return true
        }
        shell("touch /data/local/tmp/vx-probe-$request")
        var fields = emptyList<String>()
        val response = waitFor(15) {
            fields = shell("cat /data/local/tmp/vx-probe-result").trim().split(" ")
            fields.size == 5 && fields[0] == request && fields.drop(1).all { it.matches(Regex("[0-9]{1,3}")) }
        }
        if (!response) {
            evidence("$case $view os-frame-timeout=true")
            return false
        }
        evidence("$case $view frame-row=${fields[1]} frame-words=${fields[2]} system-focus=${fields[3]} sync-row=${fields[4]}")
        return fields[1] == "1"
    }

    private fun evidence(label: String) {
        require(label.matches(Regex("[a-z0-9 =-]+")))
        instrument.sendStatus(0, Bundle().apply { putString("pairEvidence", "$role $phase $label") })
    }

    private fun waitUi(text: String) = ui.waitUntil(30_000) {
        ui.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty()
    }

    private suspend fun setup() {
        val fixture = localFixture()
        waitUi("Email address")
        lateinit var model: MessengerViewModel
        ui.activityRule.scenario.onActivity { model = ViewModelProvider(it)[MessengerViewModel::class.java] }
        ui.waitUntil(30_000) { !model.authenticationPending && !repo.state.value.busy }
        if (role == "B") assertTrue(waitFor(90) { checkIn("barrier/a-signed-in").getBoolean("ready") })
        fixture.signIn(repo, "qa-alert-" + UUID.randomUUID().toString().take(12) + "@example.test")
        fixture.createRecoveryFor(repo).fill('\u0000')
        val own = checkNotNull(repo.state.value.userId)
        checkIn("value/public-id", JSONObject().put("value", own))
        if (role == "A") checkIn("barrier/a-signed-in", JSONObject())
        meet("signed-in")
        val peer = checkIn("peer/public-id").getString("value")
        assertNotEquals(own, peer)
        val room = if (role == "A") {
            checkNotNull(repo.createDirectMessage(peer))
        } else {
            val invitation = state { s -> s.rooms.any { it.membership == MessengerMembership.Invited && it.encrypted } }
                .rooms.single { it.membership == MessengerMembership.Invited && it.encrypted }
            assertTrue(repo.joinRoom(invitation.id))
            invitation.id
        }
        state { s -> s.rooms.any { it.id == room && it.peerId == peer && it.membership == MessengerMembership.Joined } }
        assertTrue(repo.openRoom(room))
        meet("opened")
        if (role == "A") repo.beginVerification() else {
            state { it.verification?.stage == MessengerVerificationStage.Incoming }
            repo.acceptVerification()
        }
        val sas = state { it.verification?.stage == MessengerVerificationStage.Compare }.verification!!
        val useEmoji = sas.symbols.size == 7
        val values = if (useEmoji) sas.symbols else sas.numbers.map { it.toString() }
        val hash = MessageDigest.getInstance("SHA-256").digest(values.joinToString("|").toByteArray())
            .joinToString("") { "%02x".format(it) }
        checkIn("sas/accepted", JSONObject().put("kind", if (useEmoji) "emoji" else "numbers")
            .put("count", values.size).put("sha256", hash))
        meet("compared")
        assertTrue(checkIn("sas/accepted").getBoolean("match"))
        repo.confirmVerification()
        state { it.canSend && it.selectedRoom?.peerVerified == true }
        waitUi("Contact verified. You can now send private messages.")
        ui.onNodeWithText("Done").performClick()
        state { it.verification == null }
        evidence("verification-dialog-closed=true")
        repo.closeRoom()
        waitUi("Messages")
        ui.onNodeWithContentDescription("Your profile").performClick()
        waitUi("Enable background alerts")
        val permission = Manifest.permission.POST_NOTIFICATIONS
        val preGranted = context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        if (!preGranted) instrument.uiAutomation.grantRuntimePermission(context.packageName, permission)
        assertTrue("Android notification permission did not take effect", waitFor {
            context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED && nm.areNotificationsEnabled()
        })
        evidence("os-granted-before=$preGranted os-granted-now=true")
        ui.onNodeWithText("Enable background alerts").performScrollTo().performClick()
        waitUi("Background alerts are on")
        ui.onNodeWithText("Done").performClick()
        assertTrue("OS sync status notification was missing", waitFor { hasStatus() })
        evidence("enabled-through-profile permission=true service=true")
        meet("alerts-enabled")
    }

    private fun hasStatus() = nm.activeNotifications.any { it.id == 1001 && it.notification.channelId == status }
    private fun alert() = nm.activeNotifications.singleOrNull { it.id == 1002 && it.notification.channelId == incoming }?.notification

    private suspend fun launch() {
        shell("am start -f 0x24000000 -n " + context.packageName + "/com.vellivex.messenger.MainActivity")
        assertTrue(waitFor { shell("dumpsys activity activities").lineSequence().any {
            it.contains("mResumedActivity") && it.contains(context.packageName) ||
                it.contains("topResumedActivity") && it.contains(context.packageName)
        } })
    }

    private suspend fun unlock() {
        shell("input keyevent KEYCODE_WAKEUP")
        shell("wm dismiss-keyguard")
        if (!waitFor(1) { !lock.isDeviceLocked }) {
            shell("input swipe 350 1100 350 200 200")
            delay(300)
            shell("input text 2468")
            shell("input keyevent KEYCODE_ENTER")
        }
        assertTrue("Dedicated device failed to unlock", waitFor(10) { !lock.isDeviceLocked })
    }

    private suspend fun expectOSAlert(case: String, receiver: String) {
        val marker = "Fictional private $phase $case $receiver."
        val receiving = role == receiver
        val room = repo.state.value.rooms.single { it.encrypted && it.peerVerified }.id
        if (receiving) {
            repo.closeRoom()
            waitUi("Messages")
            nm.cancel(1002)
            assertTrue(waitFor { alert() == null })
            when (case) {
                "home", "locked" -> {
                    shell("input keyevent KEYCODE_HOME")
                    assertTrue(waitFor { instrument.uiAutomation.rootInActiveWindow?.packageName?.toString()
                        ?.let { it != context.packageName } == true })
                    assertTrue(power.isInteractive)
                    if (case == "locked") {
                        shell("input keyevent KEYCODE_SLEEP")
                        assertTrue("The display and secure keyguard must both be locked", waitFor { !power.isInteractive && lock.isDeviceLocked })
                    }
                }
                "removed" -> {
                    val am = context.getSystemService(ActivityManager::class.java)!!
                    val tasks = am.appTasks
                    assertTrue(tasks.isNotEmpty())
                    tasks.forEach { it.finishAndRemoveTask() }
                    assertTrue(waitFor { am.appTasks.isEmpty() })
                }
                "inbox" -> waitUi("Messages")
            }
        } else assertTrue(repo.openRoom(room))
        evidence("$case prepared-for-" + receiver.lowercase())
        meet("$case-$receiver-ready".lowercase())
        if (!receiving) {
            assertTrue(repo.sendMessage(marker))
            state { s -> s.messages.any { it.text == marker && it.delivery == MessengerDelivery.Sent } }
        } else {
            val posted = waitFor(18) { alert() != null }
            evidence("$case observed-posted=$posted")
            val n = alert()
            val redacted = n?.publicVersion
            val privateValues = listOfNotNull(marker, room, repo.state.value.userId, repo.state.value.rooms.single { it.id == room }.peerId)
            val safe = n?.let { notification ->
                listOfNotNull(notification, redacted).all { item ->
                    val extras = item.extras
                    extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() == "New Vellivex message" &&
                        extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() == "Open Vellivex to view it." &&
                        !extras.containsKey(Notification.EXTRA_MESSAGES) &&
                        privateValues.none { value -> extras.keySet().any { extras.get(it)?.toString()?.contains(value) == true } }
                }
            } == true
            val importance = nm.getNotificationChannel(incoming)?.importance ?: -1
            val visibleWhileLocked = n != null && n.visibility != Notification.VISIBILITY_SECRET
            val service = hasStatus()
            val headsUp = case == "home" && posted && osRow(case, "banner")
            val channel = nm.getNotificationChannel(incoming)
            val dnd = nm.currentInterruptionFilter
            val showLock = android.provider.Settings.Secure.getInt(context.contentResolver, "lock_screen_show_notifications", -1)
            val allowPrivate = android.provider.Settings.Secure.getInt(context.contentResolver, "lock_screen_allow_private_notifications", -1)
            val headsSetting = android.provider.Settings.Global.getInt(context.contentResolver, "heads_up_notifications_enabled", -1)
            evidence("$case dnd=$dnd show-lock=$showLock private-lock=$allowPrivate heads-setting=$headsSetting channel-lock=${channel?.lockscreenVisibility ?: -1} grouped=${n?.group != null}")
            val record = shell("dumpsys notification").substringAfter("Notification List:", "").lineSequence().dropWhile {
                !it.contains("NotificationRecord(") || !it.contains("pkg=${context.packageName} ") || !it.contains("id=1002 ")
            }.take(95).joinToString(" ")
            val suppressed = Regex("mSuppressedVisualEffects=(\\d+)").find(record)?.groupValues?.get(1) ?: "unknown"
            val intercepted = Regex("mIntercept=(true|false)").find(record)?.groupValues?.get(1) ?: "unknown"
            evidence("$case suppressed=$suppressed intercepted=$intercepted")
            var onKeyguard = false
            if (case == "locked") {
                assertTrue(!power.isInteractive && lock.isDeviceLocked)
                shell("input keyevent KEYCODE_WAKEUP")
                assertTrue(waitFor { power.isInteractive && lock.isDeviceLocked })
                delay(800)
                onKeyguard = osRow(case, "lock")
                shell("input swipe 350 72 350 1030 400")
                delay(800)
                val inLockedShade = osRow(case, "lockshade")
                assertTrue("Keyguard authentication must remain engaged", lock.isDeviceLocked)
                evidence("$case immediate-lock-row=$onKeyguard locked-shade-row=$inLockedShade")
                onKeyguard = onKeyguard || inLockedShade
                shell("cmd statusbar collapse")
                unlock()
            }
            var tapped = false
            if (posted) {
                shell("cmd statusbar expand-notifications")
                delay(900)
                if (osRow(case, "tap")) {
                    tapped = waitFor(8) { alert() == null && shell("dumpsys activity activities").lineSequence().any {
                        (it.contains("topResumedActivity") || it.contains("mResumedActivity")) && it.contains(context.packageName)
                    } }
                }
                shell("cmd statusbar collapse")
            }
            evidence("$case service=$service posted=$posted safe=$safe importance=$importance lock-eligible=$visibleWhileLocked lock-row=$onKeyguard heads-up-observed=$headsUp tap=$tapped")
            if (posted) assertTrue("Notification exposed a private value or used unexpected text", safe)
            launch()
            assertTrue(repo.openRoom(room))
            state { s -> s.messages.any { it.text == marker && it.delivery == MessengerDelivery.Received } }
            evidence("$case delivered=true")
        }
        meet("$case-$receiver-finished".lowercase())
    }

    @Test fun pair() = runBlocking<Unit> {
        if (phase == "fresh") setup() else {
            waitUi("Messages")
            state { s -> s.rooms.any { it.peerVerified && it.encrypted } }
            val resumed = waitFor(6) { hasStatus() }
            evidence("restored-service=$resumed")
            meet("restored")
        }
        for (receiver in listOf("B", "A")) {
            expectOSAlert("home", receiver)
            if (phase == "fresh") expectOSAlert("locked", receiver)
        }
    }
}
