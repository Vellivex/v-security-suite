package com.vellivex.messenger

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CancellationException
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
 * Both Matrix clients run in one emulator process with separate session namespaces.
 */
@RunWith(AndroidJUnit4::class)
class MessengerLocalSynapseTest {
    @Test
    fun verifiedConversationSurvivesOfflineRestoreAndRejectsPlaintext() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val mailboxKey = args.getString("messengerMailboxKey")
        assumeTrue("Local Synapse and mailbox fixture arguments are required", !mailboxKey.isNullOrBlank())
        checkNotNull(mailboxKey)

        val fixture = LocalSynapseFixture(
            matrixBase = args.getString("messengerSynapseUrl") ?: "http://127.0.0.1:8008",
            mailboxBase = args.getString("messengerMailboxUrl") ?: "http://127.0.0.1:8025",
            mailboxKey = mailboxKey,
        )
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
            coroutineScope {
                val aliceConfirm = async { alice.confirmVerification() }
                val bobConfirm = async { bob.confirmVerification() }
                aliceConfirm.await()
                bobConfirm.await()
            }
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
