package com.vellivex.messenger

import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.matrix.rustcomponents.sdk.ShieldState
import uniffi.matrix_sdk_ui.TimelineEventShieldStateCode

class MessengerStateTest {
    private val verifiedRoom = MessengerRoom(
        id = "!direct:example.test",
        title = "Local test peer",
        peerId = "@peer:example.test",
        membership = MessengerMembership.Joined,
        encrypted = true,
        peerVerified = true,
    )

    @Test
    fun canSendRequiresSelectedJoinedEncryptedRoomWithVerifiedPeer() {
        val validState = MessengerState(
            recovery = MessengerRecovery.Ready,
            rooms = listOf(verifiedRoom),
            selectedRoomId = verifiedRoom.id,
        )

        assertTrue(validState.canSend)
        assertFalse(validState.copy(recovery = MessengerRecovery.KeyRequired).canSend)
        assertFalse(validState.copy(selectedRoomId = null).canSend)
        assertFalse(validState.copy(selectedRoomId = "!missing:example.test").canSend)
        assertFalse(validState.copy(rooms = listOf(verifiedRoom.copy(encrypted = false))).canSend)
        assertFalse(validState.copy(rooms = listOf(verifiedRoom.copy(peerVerified = false))).canSend)
        assertFalse(
            validState.copy(
                rooms = listOf(verifiedRoom.copy(membership = MessengerMembership.Invited)),
            ).canSend,
        )
    }

    @Test
    fun strictRenderingRejectsRemoteCleartextAndUntrustedEvents() {
        assertFalse(canRenderStrictTimelineText(true, ShieldState.Red(TimelineEventShieldStateCode.SENT_IN_CLEAR)))
        assertFalse(canRenderStrictTimelineText(true, ShieldState.Red(TimelineEventShieldStateCode.VERIFICATION_VIOLATION)))
        assertFalse(canRenderStrictTimelineText(true, ShieldState.Grey(TimelineEventShieldStateCode.UNKNOWN_DEVICE)))
        assertFalse(canRenderStrictTimelineText(true, null))
        assertTrue(canRenderStrictTimelineText(true, ShieldState.None))
        assertTrue(canRenderStrictTimelineText(false, null))
    }

    @Test
    fun serviceCapacityRequiresATypedMarkerAndNeverDisplaysRemoteText() {
        val body = JSONObject().put("error", "Untrusted remote text").put("vellivex_capacity_exhausted", true)
        assertEquals("Vellivex Messenger has reached its sign-in capacity. Try again later.", messengerRateLimitMessage(body, "60"))

        body.put("vellivex_capacity_exhausted", "true")
        assertEquals("Too many attempts. Try again in 1 minute.", messengerRateLimitMessage(body, "60"))
    }

    @Test
    fun rateLimitUsesNumericDelayOrHttpDateWithoutOverflow() {
        val body = JSONObject().put("retry_after_ms", 2_678_400_000L)
        val now = Instant.parse("2026-11-17T12:00:00Z")
        assertEquals("Too many attempts. Try again in 31 days.", messengerRateLimitMessage(body, "60"))
        assertEquals("Too many attempts. Try again in 2 minutes.", messengerRateLimitMessage(null, "Tue, 17 Nov 2026 12:02:00 GMT", now))

        body.put("retry_after_ms", Long.MAX_VALUE)
        assertEquals("Too many attempts. Wait before trying again.", messengerRateLimitMessage(body, "not a delay", now))
    }

    @Test
    fun onlyTypedHardLogoutConfirmsAnAlreadyEndedSession() {
        val body = JSONObject().put("errcode", "M_UNKNOWN_TOKEN")
        assertTrue(isHardMatrixLogout(401, body))
        assertTrue(isHardMatrixLogout(401, body.put("soft_logout", false)))
        assertFalse(isHardMatrixLogout(401, body.put("soft_logout", true)))
        assertFalse(isHardMatrixLogout(401, body.put("soft_logout", "false")))
        assertFalse(isHardMatrixLogout(401, body.put("soft_logout", JSONObject.NULL)))
        assertFalse(isHardMatrixLogout(403, body.put("soft_logout", false)))
        assertFalse(isHardMatrixLogout(401, body.put("errcode", "M_FORBIDDEN")))
        assertFalse(isHardMatrixLogout(401, null))
    }
}
