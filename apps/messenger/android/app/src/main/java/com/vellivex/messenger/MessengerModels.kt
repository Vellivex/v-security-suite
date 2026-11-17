package com.vellivex.messenger

enum class MessengerConnection {
    SignedOut,
    Connecting,
    Syncing,
    Synced,
    Offline,
}

enum class MessengerMembership { Invited, Joined }

enum class MessengerDelivery { Received, Queued, Sent, Failed }

data class MessengerRoom(
    val id: String,
    val title: String,
    val peerId: String?,
    val membership: MessengerMembership,
    val encrypted: Boolean,
    val peerVerified: Boolean,
)

data class MessengerMessage(
    val id: String,
    val sender: String,
    val text: String,
    val timestampMillis: Long,
    val own: Boolean,
    val delivery: MessengerDelivery,
)

enum class MessengerVerificationStage { Incoming, Waiting, Compare, Done, Failed }

data class MessengerVerification(
    val userId: String,
    val stage: MessengerVerificationStage,
    val symbols: List<String> = emptyList(),
    val numbers: List<Int> = emptyList(),
)

enum class MessengerRecovery { Checking, SetupRequired, KeyRequired, NoRecovery, OtherDevice, Ready }

data class MessengerState(
    val userId: String? = null,
    val pendingSignInEmail: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
    val connection: MessengerConnection = MessengerConnection.SignedOut,
    val recovery: MessengerRecovery = MessengerRecovery.Checking,
    val recoveredWithKey: Boolean = false,
    val rooms: List<MessengerRoom> = emptyList(),
    val selectedRoomId: String? = null,
    val messages: List<MessengerMessage> = emptyList(),
    val verification: MessengerVerification? = null,
) {
    val codeRequested: Boolean get() = pendingSignInEmail != null
    val selectedRoom: MessengerRoom? get() = rooms.firstOrNull { it.id == selectedRoomId }
    val canSend: Boolean
        get() = recovery == MessengerRecovery.Ready && selectedRoom?.let {
            it.membership == MessengerMembership.Joined && it.encrypted && it.peerVerified
        } == true
}
