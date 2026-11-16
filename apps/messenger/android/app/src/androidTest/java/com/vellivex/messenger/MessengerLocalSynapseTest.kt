package com.vellivex.messenger

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.pm.PackageManager
import android.os.Build
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import com.vellivex.messenger.MessengerBackgroundSyncService.Companion.INCOMING_MESSAGES_CHANNEL
import com.vellivex.messenger.MessengerBackgroundSyncService.Companion.SYNC_STATUS_CHANNEL
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.util.UUID

/**
 * Run using a fresh local Synapse test stack and its loopback mailbox fixture.
 * Configure `adb reverse` for TCP 8008 and 8025, then pass `messengerMailboxKey`
 * as an instrumentation argument. Optional fixtures URLs must be loopback HTTP.
 * The Matrix clients run in one emulator process with separate session namespaces.
 */
@RunWith(AndroidJUnit4::class)
class MessengerLocalSynapseTest {
    @Test
    fun verifiedConversationSurvivesOfflineRestoreAndRejectsPlaintext() = runBlocking {
        val fixture = localFixture()
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val runId = UUID.randomUUID().toString()
        val aliceEmail = "alice-$runId@example.test"
        val bobEmail = "bob-$runId@example.test"
        val aliceNamespace = "integration-${runId.take(16)}-alice"
        val bobNamespace = "integration-${runId.take(16)}-bob"
        val alice = MatrixRepository(context, sessionNamespace = aliceNamespace)
        var bob = MatrixRepository(context, sessionNamespace = bobNamespace)

        try {
            fixture.signIn(alice, aliceEmail)
            fixture.signIn(bob, bobEmail)
            val bobUserId = checkNotNull(bob.state.value.userId)
            val roomId = checkNotNull(alice.createDirectMessage(bobUserId)) {
                "Alice could not create the encrypted direct room"
            }
            awaitState(bob, "Bob's encrypted invitation") { state ->
                state.rooms.any { it.id == roomId && it.encrypted && it.membership == MessengerMembership.Invited }
            }
            assertTrue("Bob could not preview the encrypted invitation", bob.openRoom(roomId))
            assertEquals(roomId, bob.state.value.selectedRoomId)
            assertTrue("Invitation preview must not contain a timeline", bob.state.value.messages.isEmpty())
            assertFalse("Invitation preview unexpectedly enables sending", bob.state.value.canSend)
            assertTrue("Bob could not join the encrypted invitation", bob.joinRoom(roomId))
            awaitState(bob, "Bob's view of the accepted room") {
                it.rooms.any { room -> room.id == roomId && room.membership == MessengerMembership.Joined }
            }
            awaitState(alice, "Alice's view of Bob as a joined member") {
                it.rooms.any { room -> room.id == roomId && room.peerId == bobUserId }
            }
            assertTrue("Alice could not open the direct room", alice.openRoom(roomId))
            assertTrue("Bob could not open the direct room", bob.openRoom(roomId))
            val refusedMessage = "refused sample $runId"
            assertFalse("An unverified peer must not unlock sending", alice.sendMessage(refusedMessage))

            compareSas(alice, bob, "first attempt")
            // Model one participant reporting a mismatch after reaching the actual SDK comparison state.
            bob.rejectVerification()
            awaitState(alice, "Alice's rejected comparison") {
                it.verification?.stage == MessengerVerificationStage.Failed
            }
            assertFalse("Alice still trusts Bob after a rejected SAS", alice.state.value.selectedRoom?.peerVerified == true)
            assertFalse("Bob still trusts Alice after a rejected SAS", bob.state.value.selectedRoom?.peerVerified == true)
            val refusedAfterMismatch = "refused after rejected comparison $runId"
            assertFalse("Alice can send after a rejected SAS", alice.sendMessage(refusedAfterMismatch))
            assertFalse("Bob can send after a rejected SAS", bob.sendMessage(refusedAfterMismatch))

            compareSas(bob, alice, "fresh reverse-direction attempt after rejection")
            confirmSas(alice, bob)
            awaitState(alice, "Alice's verified room") { it.canSend && it.selectedRoom?.peerVerified == true }
            awaitState(bob, "Bob's verified room") { it.canSend && it.selectedRoom?.peerVerified == true }

            bob.close()
            bob = MatrixRepository(context, sessionNamespace = bobNamespace)
            val offlineMessage = "fictional encrypted message $runId"
            assertTrue("Alice's encrypted send was rejected", alice.sendMessage(offlineMessage))
            awaitState(alice, "Alice's server-acknowledged event") { state ->
                state.messages.any { it.text == offlineMessage && it.delivery == MessengerDelivery.Sent }
            }

            assertTrue("Bob's session could not be restored", bob.restore())
            awaitState(bob, "Bob's restored joined room") { state ->
                state.userId == bobUserId && state.rooms.any {
                    it.id == roomId && it.encrypted && it.membership == MessengerMembership.Joined
                }
            }
            assertTrue("The restored session could not reopen the encrypted room", bob.openRoom(roomId))
            val received = awaitState(bob, "Bob's decrypted offline event") { state ->
                state.messages.any { it.text == offlineMessage && it.delivery == MessengerDelivery.Received }
            }.messages.single { it.text == offlineMessage }

            bob.closeRoom()
            bob.refreshRooms()
            assertTrue("The restored room could not be reopened", bob.openRoom(roomId))
            val reopened = awaitState(bob, "Bob's repopulated timeline") {
                it.messages.any { message -> message.id == received.id }
            }
            assertEquals(listOf(received.id), reopened.messages.filter { it.text == offlineMessage }.map { it.id })
            assertFalse("A rejected pre-verification message was delivered", reopened.messages.any { it.text == refusedMessage })
            assertFalse("A message rejected after SAS mismatch was delivered", reopened.messages.any { it.text == refusedAfterMismatch })

            // A separate Matrix user creates a real plaintext invite through Synapse.
            fixture.withRawDevice("plain-$runId@example.test") { plainToken ->
                val plainRoom = fixture.createPlainRoom(plainToken, bobUserId)
                val syncMarker = "fictional sync checkpoint $runId"
                assertTrue("Alice could not send the post-invitation checkpoint", alice.sendMessage(syncMarker))
                awaitState(bob, "Bob's decrypted post-invitation checkpoint") { state ->
                    state.messages.any { it.text == syncMarker }
                }
                awaitState(bob, "Bob's unencrypted direct invitation") { state ->
                    state.rooms.any { room ->
                        room.id == plainRoom && room.membership == MessengerMembership.Invited && !room.encrypted
                    }
                }
                assertFalse("The app accepted a plaintext invite", bob.joinRoom(plainRoom))
                assertFalse("The app opened a plaintext room", bob.openRoom(plainRoom))
                assertFalse("The server unexpectedly joined Bob to the plaintext room", fixture.isJoined(plainToken, plainRoom, bobUserId))
            }

            // Plain Matrix HTTP reads show the server event without running any decryption code.
            val persisted = checkNotNull(MessengerSessionStore(context, bobNamespace).read())
            val auditToken = persisted.session.accessToken
            persisted.storeKey.fill(0)
            val event = fixture.readEvent(auditToken, roomId, received.id)
            assertEquals("m.room.encrypted", event.getString("type"))
            assertTrue(event.getJSONObject("content").getString("ciphertext").isNotBlank())
            assertFalse("Plaintext reached the homeserver", event.toString().contains(offlineMessage))
            bob.signOut()
            assertEquals(MessengerConnection.SignedOut, bob.state.value.connection)
            assertTrue("Signed-out state retained messages", bob.state.value.messages.isEmpty())
            assertTrue("Signed-out state retained rooms", bob.state.value.rooms.isEmpty())
            assertFalse("Signed-out state still enables sending", bob.state.value.canSend)
            assertFalse("The server still accepts the logged-out device token", fixture.isAuthenticated(auditToken))
            bob.close()
            bob = MatrixRepository(context, sessionNamespace = bobNamespace)
            assertFalse("A logged-out session could be restored", bob.restore())
        } finally {
            try {
                cleanUp(alice)
            } finally {
                cleanUp(bob)
            }
        }
    }

    @Test
    @SdkSuppress(minSdkVersion = Build.VERSION_CODES.TIRAMISU)
    fun backgroundSyncPostsPrivateAlertForVerifiedMessageAfterPermissionGrant() = runBlocking<Unit> {
        val fixture = localFixture()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val notifications = checkNotNull(context.getSystemService(NotificationManager::class.java))
        val permission = Manifest.permission.POST_NOTIFICATIONS
        assertEquals(
            "Install the test APK fresh or revoke POST_NOTIFICATIONS before running this test",
            PackageManager.PERMISSION_DENIED,
            context.checkSelfPermission(permission),
        )
        assertFalse("Android allowed notifications before permission was granted", notifications.areNotificationsEnabled())

        val runId = UUID.randomUUID().toString().take(16)
        val sender = MatrixRepository(context, sessionNamespace = "notification-$runId-sender")
        val receiver = (context.applicationContext as MessengerApplication).repository
        val otherPeer = MatrixRepository(context, sessionNamespace = "notification-$runId-other")
        val senderAddress = "notification-sender-$runId@example.test"
        val receiverAddress = "notification-receiver-$runId@example.test"
        val otherAddress = "notification-other-$runId@example.test"
        val deniedSample = "$runId fictional permission-denied message"
        val backgroundSample = "$runId fictional private notification body"
        try {
            fixture.signIn(sender, senderAddress)
            fixture.signIn(receiver, receiverAddress)
            val receiverId = checkNotNull(receiver.state.value.userId)
            val senderId = checkNotNull(sender.state.value.userId)
            val roomId = checkNotNull(sender.createDirectMessage(receiverId))
            awaitState(receiver, "encrypted invitation for notification recipient") { state ->
                state.rooms.any { it.id == roomId && it.encrypted && it.membership == MessengerMembership.Invited }
            }
            assertTrue("The notification recipient could not join the invitation", receiver.joinRoom(roomId))
            awaitState(receiver, "notification recipient's joined room") { state ->
                state.rooms.any { it.id == roomId && it.membership == MessengerMembership.Joined }
            }
            awaitState(sender, "notification sender's view of the joined recipient") { state ->
                state.rooms.any { it.id == roomId && it.peerId == receiverId }
            }
            assertTrue(sender.openRoom(roomId))
            assertTrue(receiver.openRoom(roomId))
            compareSas(sender, receiver, "notification fixture")
            confirmSas(sender, receiver)
            awaitState(sender, "verified notification sender") { it.canSend }
            awaitState(receiver, "verified notification recipient") { it.canSend }

            fixture.signIn(otherPeer, otherAddress)
            val otherPeerId = checkNotNull(otherPeer.state.value.userId)
            val otherRoomId = checkNotNull(otherPeer.createDirectMessage(receiverId))
            assertTrue("The second invitation must target a distinct room", otherRoomId != roomId)
            awaitState(receiver, "invitation to a second encrypted room") { state ->
                state.rooms.any { it.id == otherRoomId && it.encrypted && it.membership == MessengerMembership.Invited }
            }

            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                scenario.onActivity { activity ->
                    assertFalse(
                        "Background service accepted a start without notification permission",
                        MessengerBackgroundSyncService.start(activity),
                    )
                }
                assertFalse("Service ran without notification permission", MessengerBackgroundSyncService.running.value)
                assertTrue("Permission denial stopped normal messaging", sender.sendMessage(deniedSample))
                awaitState(receiver, "foreground message after notification permission denial") { state ->
                    state.messages.any { it.text == deniedSample && it.delivery == MessengerDelivery.Received }
                }
                assertEquals("Permission denial cleared the session", receiverId, receiver.state.value.userId)
                assertFalse("An alert appeared without permission", hasNotification(notifications, INCOMING_MESSAGES_CHANNEL))
                assertFalse("An ongoing notification appeared without permission", hasNotification(notifications, SYNC_STATUS_CHANNEL))

                assertTrue("The recipient could not join the second encrypted room", receiver.joinRoom(otherRoomId))
                awaitState(receiver, "the second encrypted room after joining") { state ->
                    state.rooms.any { it.id == otherRoomId && it.encrypted && it.membership == MessengerMembership.Joined }
                }
                assertTrue("The recipient could not select the second room", receiver.openRoom(otherRoomId))
                assertEquals(otherRoomId, receiver.state.value.selectedRoomId)

                instrumentation.uiAutomation.grantRuntimePermission(context.packageName, permission)
                assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(permission))
                assertTrue("Android did not enable notifications after granting permission", notifications.areNotificationsEnabled())
                scenario.onActivity { activity ->
                    assertTrue("The foreground Activity could not start background sync", MessengerBackgroundSyncService.start(activity))
                }
                checkNotNull(withTimeoutOrNull(15_000) { MessengerBackgroundSyncService.running.first { it } }) {
                    "The background service never entered its running state"
                }
            }

            val status = awaitNotification(notifications, SYNC_STATUS_CHANNEL)
            assertTrue(
                "Android did not mark the ongoing notification as a foreground service",
                (status.flags and Notification.FLAG_FOREGROUND_SERVICE) != 0,
            )
            assertTrue("The service stopped when its Activity went away", MessengerBackgroundSyncService.running.value)
            assertFalse("An old message was replayed as a new alert", hasNotification(notifications, INCOMING_MESSAGES_CHANNEL))
            assertEquals(
                "The recipient should still have the second room selected",
                otherRoomId,
                receiver.state.value.selectedRoomId,
            )
            assertEquals("The sender should still have the original room selected", roomId, sender.state.value.selectedRoomId)

            val eventId = coroutineScope {
                val incoming = async(start = CoroutineStart.UNDISPATCHED) {
                    checkNotNull(withTimeoutOrNull(60_000) { receiver.backgroundMessageEvents.first() }) {
                        "The verified incoming event did not reach the background observer"
                    }
                }
                assertTrue("Could not send the verified background message", sender.sendMessage(backgroundSample))
                incoming.await()
            }
            val alert = awaitNotification(notifications, INCOMING_MESSAGES_CHANNEL)
            assertEquals("The alert should be hidden from the lock screen", Notification.VISIBILITY_SECRET, alert.visibility)
            assertEquals("New Vellivex message", alert.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
            assertEquals("Open Vellivex to view it.", alert.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())
            assertEquals(
                "An alert from the first room must leave the second room selected",
                otherRoomId,
                receiver.state.value.selectedRoomId,
            )
            val privateValues = listOf(
                runId, deniedSample, backgroundSample, senderId, receiverId, otherPeerId,
                senderAddress, receiverAddress, otherAddress, roomId, otherRoomId,
            )
            assertPrivateNotification(status, privateValues)
            assertPrivateNotification(alert, privateValues)
            assertTrue("The background recipient could not reopen the room", receiver.openRoom(roomId))
            awaitState(receiver, "the same background event decrypted in its conversation") { state ->
                state.messages.any { it.id == eventId && it.text == backgroundSample && it.delivery == MessengerDelivery.Received }
            }
        } finally {
            MessengerBackgroundSyncService.stop(context)
            try {
                cleanUp(sender)
            } finally {
                try {
                    cleanUp(otherPeer)
                } finally {
                    receiver.signOut()
                }
            }
        }
    }

    private fun localFixture(): LocalSynapseFixture {
        val args = InstrumentationRegistry.getArguments()
        val mailboxKey = args.getString("messengerMailboxKey")
        assumeTrue("Local Synapse and mailbox fixture arguments are required", !mailboxKey.isNullOrBlank())
        return LocalSynapseFixture(
            matrixBase = args.getString("messengerSynapseUrl") ?: "http://127.0.0.1:8008",
            mailboxBase = args.getString("messengerMailboxUrl") ?: "http://127.0.0.1:8025",
            mailboxKey = checkNotNull(mailboxKey),
        )
    }

    private suspend fun confirmSas(first: MatrixRepository, second: MatrixRepository) = coroutineScope {
        val firstConfirm = async { first.confirmVerification() }
        val secondConfirm = async { second.confirmVerification() }
        firstConfirm.await()
        secondConfirm.await()
    }

    private fun hasNotification(notifications: NotificationManager, channel: String): Boolean =
        notifications.activeNotifications.any { it.notification.channelId == channel }

    private suspend fun awaitNotification(notifications: NotificationManager, channel: String): Notification {
        repeat(150) {
            notifications.activeNotifications.singleOrNull { it.notification.channelId == channel }?.let {
                return it.notification
            }
            delay(100)
        }
        error("Android did not post a notification to $channel")
    }

    private fun assertPrivateNotification(notification: Notification, privateValues: List<String>) {
        val extras = notification.extras
        assertFalse("The notification contained a conversation message history", extras.containsKey(Notification.EXTRA_MESSAGES))
        assertFalse("The notification published a separate lock-screen version", notification.publicVersion != null)
        assertTrue("Notification has no visible text", !extras.getCharSequence(Notification.EXTRA_TEXT).isNullOrBlank())
        val text = listOf(
            notification.tickerText,
            extras.getCharSequence(Notification.EXTRA_TITLE),
            extras.getCharSequence(Notification.EXTRA_TITLE_BIG),
            extras.getCharSequence(Notification.EXTRA_TEXT),
            extras.getCharSequence(Notification.EXTRA_BIG_TEXT),
            extras.getCharSequence(Notification.EXTRA_SUB_TEXT),
            extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT),
        ) + extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES).orEmpty()
        assertFalse("A notification exposed a private message or identity", text.filterNotNull().any { item ->
            privateValues.any { item.contains(it) }
        })
    }

    private suspend fun compareSas(alice: MatrixRepository, bob: MatrixRepository, attempt: String) {
        alice.beginVerification()
        awaitState(bob, "Bob's verification request ($attempt)") {
            it.verification?.stage == MessengerVerificationStage.Incoming
        }
        bob.acceptVerification()
        val aliceSas = checkNotNull(awaitState(alice, "Alice's comparison ($attempt)") {
            it.verification?.stage == MessengerVerificationStage.Compare
        }.verification)
        val bobSas = checkNotNull(awaitState(bob, "Bob's comparison ($attempt)") {
            it.verification?.stage == MessengerVerificationStage.Compare
        }.verification)
        assertEquals(bob.state.value.userId, aliceSas.userId)
        assertEquals(alice.state.value.userId, bobSas.userId)
        assertTrue("SAS must contain a challenge", aliceSas.symbols.isNotEmpty() || aliceSas.numbers.isNotEmpty())
        assertTrue("SAS symbols differ", aliceSas.symbols == bobSas.symbols)
        assertTrue("SAS numbers differ", aliceSas.numbers == bobSas.numbers)
    }

    private suspend fun awaitState(
        client: MatrixRepository,
        label: String,
        predicate: (MessengerState) -> Boolean,
    ): MessengerState = checkNotNull(withTimeoutOrNull(60_000) { client.state.first(predicate) }) {
        "Timed out waiting for $label (connection ${client.state.value.connection})"
    }

    private suspend fun cleanUp(client: MatrixRepository) {
        try {
            client.signOut()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Keep the original assertion failure if the test server is already down.
        } finally {
            client.close()
        }
    }

}

private class LocalSynapseFixture(matrixBase: String, mailboxBase: String, private val mailboxKey: String) {
    private val matrix = loopbackBase(matrixBase)
    private val mailbox = loopbackBase(mailboxBase)

    suspend fun signIn(client: MatrixRepository, email: String) {
        val challenge = checkNotNull(client.requestCode(matrix, email)) { "OTP request did not return a challenge" }
        assertTrue("OTP login failed", client.verifyCode(mailboxCode(challenge)))
        assertNotNull("OTP login did not establish a user ID", client.state.value.userId)
    }

    suspend fun withRawDevice(email: String, verify: suspend (String) -> Unit) {
        val challenge = post(matrix, "/_synapse/client/vellivex/email/request", JSONObject().put("email", email))
            .getString("challenge_id")
        val loginToken = post(
            matrix,
            "/_synapse/client/vellivex/email/verify",
            JSONObject().put("challenge_id", challenge).put("code", mailboxCode(challenge)),
        ).getString("login_token")
        val token = post(
            matrix,
            "/_matrix/client/v3/login",
            JSONObject().put("type", "m.login.token").put("token", loginToken),
        ).getString("access_token")
        try {
            verify(token)
        } finally {
            post(matrix, "/_matrix/client/v3/logout", JSONObject(), token)
        }
    }

    fun readEvent(token: String, roomId: String, eventId: String): JSONObject = request(
        matrix,
        "/_matrix/client/v3/rooms/${segment(roomId)}/event/${segment(eventId)}",
        bearer = token,
    )

    fun createPlainRoom(token: String, invitee: String): String = post(
        matrix,
        "/_matrix/client/v3/createRoom",
        JSONObject().put("preset", "private_chat").put("is_direct", true).put("invite", JSONArray().put(invitee)),
        token,
    ).getString("room_id")

    fun isJoined(token: String, roomId: String, userId: String): Boolean = request(
        matrix,
        "/_matrix/client/v3/rooms/${segment(roomId)}/state/m.room.member/${segment(userId)}",
        bearer = token,
    ).getString("membership") == "join"

    fun isAuthenticated(token: String): Boolean = try {
        request(matrix, "/_matrix/client/v3/account/whoami", bearer = token)
        true
    } catch (error: FixtureHttpFailure) {
        if (error.status != 401) throw error
        false
    }

    private suspend fun mailboxCode(challenge: String): String {
        repeat(20) {
            try {
                return request(mailbox, "/${segment(challenge)}", bearer = mailboxKey).getString("code")
            } catch (error: FixtureHttpFailure) {
                if (error.status != 404) throw error
                delay(250)
            }
        }
        error("Synthetic test mailbox did not receive an OTP")
    }

    private fun post(base: String, path: String, body: JSONObject, bearer: String? = null): JSONObject =
        request(base, path, body, bearer)

    private fun request(
        base: String,
        path: String,
        body: JSONObject? = null,
        bearer: String? = null,
    ): JSONObject {
        val connection = URI.create("$base$path").toURL().openConnection() as HttpURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 5_000
            connection.readTimeout = 10_000
            connection.setRequestProperty("Accept", "application/json")
            if (bearer != null) connection.setRequestProperty("Authorization", "Bearer $bearer")
            if (body != null) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            if (status !in 200..299) throw FixtureHttpFailure(status)
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { JSONObject(it.readText()) }
        } finally {
            connection.disconnect()
        }
    }

    private fun loopbackBase(value: String): String {
        val uri = URI.create(value)
        require(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port > 0 &&
            uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path.isEmpty()
        ) { "This fixture only accepts loopback HTTP addresses with explicit ports" }
        return uri.toString()
    }

    private fun segment(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

private class FixtureHttpFailure(val status: Int) : IllegalStateException("Local fixture returned HTTP $status")
