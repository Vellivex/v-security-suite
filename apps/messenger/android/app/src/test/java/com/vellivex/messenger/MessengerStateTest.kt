package com.vellivex.messenger

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
            rooms = listOf(verifiedRoom),
            selectedRoomId = verifiedRoom.id,
        )

        assertTrue(validState.canSend)
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
}
