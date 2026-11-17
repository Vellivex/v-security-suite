package com.vellivex.messenger

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONException
import org.json.JSONObject
import org.matrix.rustcomponents.sdk.BackupState
import org.matrix.rustcomponents.sdk.BackupSteadyStateListener
import org.matrix.rustcomponents.sdk.BackupUploadState
import org.matrix.rustcomponents.sdk.Client
import org.matrix.rustcomponents.sdk.ClientBuilder
import org.matrix.rustcomponents.sdk.ClientException
import org.matrix.rustcomponents.sdk.CreateRoomParameters
import org.matrix.rustcomponents.sdk.EnableRecoveryProgress
import org.matrix.rustcomponents.sdk.EnableRecoveryProgressListener
import org.matrix.rustcomponents.sdk.Encryption
import org.matrix.rustcomponents.sdk.ErrorKind
import org.matrix.rustcomponents.sdk.EventOrTransactionId
import org.matrix.rustcomponents.sdk.EventSendState
import org.matrix.rustcomponents.sdk.JoinRule
import org.matrix.rustcomponents.sdk.Membership
import org.matrix.rustcomponents.sdk.MessageType
import org.matrix.rustcomponents.sdk.MsgLikeKind
import org.matrix.rustcomponents.sdk.PowerLevels
import org.matrix.rustcomponents.sdk.RecoveryState
import org.matrix.rustcomponents.sdk.Room
import org.matrix.rustcomponents.sdk.RoomHistoryVisibility
import org.matrix.rustcomponents.sdk.RoomMessageLikeEvent
import org.matrix.rustcomponents.sdk.RoomMessageLikeEventsListener
import org.matrix.rustcomponents.sdk.RoomPreset
import org.matrix.rustcomponents.sdk.RoomVisibility
import org.matrix.rustcomponents.sdk.SecretStorageKey
import org.matrix.rustcomponents.sdk.SendTarget
import org.matrix.rustcomponents.sdk.SessionVerificationController
import org.matrix.rustcomponents.sdk.SessionVerificationControllerDelegate
import org.matrix.rustcomponents.sdk.SessionVerificationData
import org.matrix.rustcomponents.sdk.SessionVerificationRequestDetails
import org.matrix.rustcomponents.sdk.ShieldState
import org.matrix.rustcomponents.sdk.SlidingSyncVersionBuilder
import org.matrix.rustcomponents.sdk.SqliteStoreBuilder
import org.matrix.rustcomponents.sdk.SyncService
import org.matrix.rustcomponents.sdk.SyncServiceState
import org.matrix.rustcomponents.sdk.SyncServiceStateObserver
import org.matrix.rustcomponents.sdk.TaskHandle
import org.matrix.rustcomponents.sdk.TextMessageContent
import org.matrix.rustcomponents.sdk.Timeline
import org.matrix.rustcomponents.sdk.TimelineDiff
import org.matrix.rustcomponents.sdk.TimelineItem
import org.matrix.rustcomponents.sdk.TimelineItemContent
import org.matrix.rustcomponents.sdk.TimelineListener
import org.matrix.rustcomponents.sdk.VerificationState
import uniffi.matrix_sdk.BackupDownloadStrategy
import uniffi.matrix_sdk_base.EncryptionState
import uniffi.matrix_sdk_crypto.CollectStrategy
import uniffi.matrix_sdk_crypto.DecryptionSettings
import uniffi.matrix_sdk_crypto.TrustRequirement
import uniffi.ruma_events.MessageLikeEventType

class MatrixRepository(context: Context, sessionNamespace: String = "default") {
    private val auth = MessengerEmailAuth(context.applicationContext)
    private val sessionStore = MessengerSessionStore(context.applicationContext, sessionNamespace)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val gate = Mutex()
    private val mutableState = MutableStateFlow(MessengerState())
    val state: StateFlow<MessengerState> = mutableState.asStateFlow()
    private val mutableBackgroundMessageEvents =
        MutableSharedFlow<String>(extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Live IDs of newly synced, strictly verified messages across the account's private rooms. */
    val backgroundMessageEvents: SharedFlow<String> = mutableBackgroundMessageEvents.asSharedFlow()

    private var connection: Connection? = null
    private var opened: OpenTimeline? = null
    private var challenge: Challenge? = null
    private var closed = false

    suspend fun restore(): Boolean = operation(false, "Could not restore the saved session. Its local keys are still on this device.") {
        if (connection != null) return@operation true
        val saved = sessionStore.read() ?: return@operation false
        try {
            connect(saved)
        } finally {
            saved.storeKey.fill(0)
        }
        true
    }

    suspend fun requestCode(baseUrl: String, email: String): String? =
        operation(null, "Could not request a sign-in code. Check the service address and connection.") {
            sendSignInCode(baseUrl, email)
        }

    suspend fun resendCode(): String? = operation(null, "Could not send another sign-in code. Try again.") {
        val request = challenge ?: fail("Request a new email code first.")
        sendSignInCode(request.baseUrl, request.email)
    }

    private fun sendSignInCode(baseUrl: String, email: String): String {
        if (connection != null || sessionStore.exists()) {
            fail("Restore or sign out of the saved session before starting another sign-in.")
        }
        val base = auth.checkedBaseUrl(baseUrl)
        val address = email.trim()
        val id = auth.requestCode(base, address)
        challenge = Challenge(base, id, address)
        mutableState.update { it.copy(pendingSignInEmail = address) }
        return id
    }

    suspend fun discardSignInChallenge(): Boolean = operation(false, "Could not change the sign-in email.") {
        if (challenge == null) return@operation false
        challenge = null
        mutableState.update { it.copy(pendingSignInEmail = null) }
        true
    }

    suspend fun verifyCode(code: String): Boolean = operation(false, "Could not complete sign-in. If a session was saved, restore it.") {
        if (connection != null || sessionStore.exists()) fail("A saved session already exists.")
        val request = challenge ?: fail("Request a new email code first.")
        val session = auth.verifyCode(request.baseUrl, request.id, code.trim())
        challenge = null
        mutableState.update { it.copy(pendingSignInEmail = null) }
        val stored = sessionStore.newSession(session)
        try {
            sessionStore.write(stored)
            connect(stored, freshSignIn = true)
        } finally {
            stored.storeKey.fill(0)
        }
        true
    }

    suspend fun prepareRecoveryKey(): String? = operation(null, "Could not create a recovery key. Try again.") {
        val c = requireSessionConnection()
        requireRecoverySetup(c)
        val key = c.pendingRecoveryKey ?: SecretStorageKey().also { c.pendingRecoveryKey = it }
        key.toBase58()
    }

    suspend fun confirmRecoveryKeySaved(lastFour: String): Boolean =
        operation(false, "Could not finish setting up recovery. Keep your key and try again when connected.") {
            val c = requireSessionConnection()
            val key = c.pendingRecoveryKey ?: fail("Create a recovery key first.")
            if (lastFour != key.toBase58().filterNot(Char::isWhitespace).takeLast(4)) {
                fail("Enter the last four characters of your recovery key exactly as shown.")
            }
            requireRecoverySetup(c)
            c.client.encryption().use { encryption ->
                val backupReady = withTimeoutOrNull(RECOVERY_TIMEOUT_MS) {
                    // The supplied key is already saved by the user. Never display or log progress payloads.
                    encryption.enableRecovery(true, key, object : EnableRecoveryProgressListener {
                        override fun onUpdate(status: EnableRecoveryProgress) = Unit
                    })
                    true
                }
                if (backupReady != true) fail("Recovery setup timed out. Keep your recovery key and try again.")
                completeRecovery(c, encryption)
            }
            true
        }

    suspend fun recoverWithKey(key: String): Boolean =
        operation(false, "Could not recover with that key. Check the key and your connection, then try again.") {
            val c = requireSessionConnection()
            if (state.value.recovery != MessengerRecovery.KeyRequired) fail("This session is not waiting for a recovery key.")
            val value = key.trim()
            if (value.length !in 16..192) {
                fail("Could not recover with that key. Check the key and your connection, then try again.")
            }
            c.client.encryption().use { encryption ->
                if (encryption.hasDevicesToVerifyAgainst()) {
                    refreshStoredRooms(c)
                    fail("Sign out on your other phone before recovering this account here.")
                }
                val recovered = withTimeoutOrNull(RECOVERY_TIMEOUT_MS) {
                    encryption.recover(value)
                    true
                }
                if (recovered != true) fail("Recovery timed out. Try again when you are connected.")
                completeRecovery(c, encryption, recoveredWithKey = true)
            }
            true
        }

    suspend fun checkRecovery(): Unit = operation(Unit, "Could not check recovery. Connect and try again.") {
        val saved = sessionStore.read() ?: fail("Sign in to the messaging service first.")
        try {
            disconnect()
            connect(saved)
        } finally {
            saved.storeKey.fill(0)
        }
    }

    private fun requireRecoverySetup(c: Connection) {
        c.client.encryption().use { encryption ->
            if (encryption.recoveryState() != RecoveryState.DISABLED ||
                encryption.verificationState() != VerificationState.VERIFIED
            ) {
                fail("Recovery settings changed. If you already saved a recovery key, use it to recover this session.")
            }
        }
    }

    private suspend fun completeRecovery(c: Connection, encryption: Encryption, recoveredWithKey: Boolean = false) {
        val ready = withTimeoutOrNull(E2EE_SETUP_TIMEOUT_MS) {
            while (!encryption.recoveryIsUsable()) delay(250)
            true
        }
        if (ready != true) fail("Your recovery key was accepted, but this phone is still waiting for encryption and backup. Keep your key and try again.")
        sessionStore.updateRecoveryConfirmation(c.storeId, true, recoveredWithKey)
        c.recoveryConfirmed = true
        if (recoveredWithKey) mutableState.update { it.copy(recoveredWithKey = true) }
        c.pendingRecoveryKey?.close()
        c.pendingRecoveryKey = null
        refreshStoredRooms(c)
    }

    private fun Encryption.recoveryIsUsable(): Boolean =
        recoveryState() == RecoveryState.ENABLED && verificationState() == VerificationState.VERIFIED &&
            (backupState() == BackupState.ENABLED || backupState() == BackupState.DOWNLOADING)

    suspend fun refreshRooms(): Unit = operation(Unit, "Could not refresh conversations.") {
        refresh(requireConnection())
    }

    suspend fun createDirectMessage(userId: String): String? =
        operation(null, "Could not create the encrypted invitation.") {
            val c = requireConnection()
            val peer = matrixUserId(userId)?.takeIf { isOtherLocalUser(c, it) }
                ?: fail("Enter another account ID on this messaging service.")
            c.client.getDmRoom(peer)?.use { prior ->
                if (roomSnapshot(c, prior)?.encrypted == true) {
                    refresh(c)
                    return@operation prior.id()
                }
            }
            val id = c.client.createRoom(
                CreateRoomParameters(
                    name = null,
                    isEncrypted = true,
                    isDirect = true,
                    visibility = RoomVisibility.Private,
                    preset = RoomPreset.PRIVATE_CHAT,
                    invite = listOf(peer),
                    // Empty user maps are omitted by the SDK, retaining the homeserver's
                    // creator defaults on both older and newer Matrix room versions.
                    powerLevelContentOverride = PowerLevels(
                        usersDefault = null,
                        eventsDefault = null,
                        stateDefault = 100,
                        ban = null,
                        kick = null,
                        redact = null,
                        invite = 100,
                        notifications = null,
                        users = emptyMap(),
                        events = emptyMap(),
                    ),
                    joinRuleOverride = JoinRule.Invite,
                    historyVisibilityOverride = RoomHistoryVisibility.Joined,
                ),
            )
            refresh(c)
            id
        }

    suspend fun joinRoom(roomId: String): Boolean = operation(
        false,
        "Could not accept the encrypted invitation. Check your connection and try again.",
    ) {
        val c = requireConnection()
        val invite = requireRoom(c, roomId).use { roomSnapshot(c, it) }
        if (invite?.membership != MessengerMembership.Invited || invite.peerId == null || !invite.encrypted) {
            fail("An encrypted one-to-one invitation from this service is required.")
        }
        preparePeerIdentity(c, invite.peerId)
        requireRoom(c, roomId).use { it.join() }
        closeTimeline()
        mutableState.update { it.copy(selectedRoomId = roomId) }
        refresh(c)
        true
    }

    suspend fun openRoom(roomId: String): Boolean = operation(false, "Could not open the conversation.") {
        val c = requireConnection()
        val room = requireRoom(c, roomId)
        room.use {
            val info = roomSnapshot(c, it) ?: fail("This is not a one-to-one conversation on this service.")
            if (!info.encrypted) fail("This conversation is not confirmed encrypted.")
            val joined = info.membership == MessengerMembership.Joined
            if (joined) preparePeerIdentity(c, requireNotNull(info.peerId))
            updateSdkRoomSubscriptions(c, state.value.rooms, info.id.takeIf { joined })
            closeTimeline()
            mutableState.update { s -> s.copy(selectedRoomId = roomId, messages = emptyList()) }
            if (joined) attachTimeline(c, it, info)
        }
        true
    }

    suspend fun closeRoom(): Unit = operation(Unit, "Could not close the conversation.") {
        closeTimeline()
        connection?.let { updateSdkRoomSubscriptions(it, state.value.rooms) }
    }

    suspend fun sendMessage(text: String): Boolean =
        operation(false, "Could not queue that message. Check the conversation and connection.") {
            val c = requireConnection()
            val selected = opened ?: fail("Open a conversation first.")
            if (text.isBlank() || text.encodeToByteArray().size > MAX_TEXT_BYTES) {
                fail("Enter a message of at most 4,096 UTF-8 bytes.")
            }
            // Re-check the SDK's authoritative room and identity state at the send boundary.
            checkCanSend(c, selected)
            val content = selected.timeline.createMessageContent(MessageType.Text(TextMessageContent(text, null)))
                ?: fail("Could not prepare the text message.")
            content.use { message -> selected.timeline.send(message).use { } }
            true
        }

    suspend fun retryMessage(id: String): Boolean = operation(false, "Could not retry that message.") {
        val c = requireConnection()
        val selected = opened ?: fail("Open the conversation first.")
        val failed = synchronized(selected) {
            selected.items.any { it?.id == id && it.own && it.delivery == MessengerDelivery.Failed }
        }
        if (!failed) fail("This message is no longer waiting to retry.")
        checkCanSend(c, selected)
        selected.timeline.retrySend(EventOrTransactionId.TransactionId(id), SendTarget.Event)
    }

    suspend fun beginVerification(): Unit = operation(Unit, "Could not start verification.") {
        val c = requireConnection()
        val selected = state.value.selectedRoom
        val peer = selected?.peerId ?: fail("Open a conversation before verifying its contact.")
        if (!selected.encrypted || selected.membership != MessengerMembership.Joined) {
            fail("Open a joined encrypted conversation before verifying its contact.")
        }
        if (c.verificationPeer != null) fail("Finish or cancel the current verification first.")
        c.verificationPeer = peer
        mutableState.update { it.copy(verification = MessengerVerification(peer, MessengerVerificationStage.Waiting)) }
        try {
            c.verification.requestPeerDeviceVerification(peer)
        } catch (e: Exception) {
            finishVerification(c, MessengerVerificationStage.Failed)
            throw e
        }
    }

    suspend fun acceptVerification(): Unit = operation(Unit, "Could not accept the verification request.") {
        val c = requireConnection()
        val incoming = c.incoming ?: fail("No verification request is pending.")
        if (state.value.rooms.none { it.peerId == incoming.userId && it.encrypted && it.membership == MessengerMembership.Joined }) {
            fail("Open a joined encrypted conversation with this contact first.")
        }
        c.verificationPeer = incoming.userId
        c.incoming = null
        mutableState.update {
            it.copy(verification = MessengerVerification(incoming.userId, MessengerVerificationStage.Waiting))
        }
        try {
            c.verification.acknowledgeVerificationRequest(incoming.userId, incoming.flowId)
            c.verification.acceptVerificationRequest()
        } catch (e: Exception) {
            finishVerification(c, MessengerVerificationStage.Failed)
            throw e
        }
    }

    suspend fun confirmVerification(): Unit = operation(Unit, "Could not confirm verification.") {
        val c = requireConnection()
        val verification = state.value.verification
        if (verification?.stage != MessengerVerificationStage.Compare || c.verificationPeer != verification.userId) {
            fail("Compare the verification symbols on both devices first.")
        }
        mutableState.update {
            it.copy(verification = MessengerVerification(verification.userId, MessengerVerificationStage.Waiting))
        }
        try {
            c.verification.approveVerification()
        } catch (e: Exception) {
            finishVerification(c, MessengerVerificationStage.Failed)
            throw e
        }
    }

    suspend fun rejectVerification(): Unit = operation(Unit, "Could not reject the verification codes.") {
        val c = requireConnection()
        val verification = state.value.verification
        if (verification?.stage != MessengerVerificationStage.Compare || c.verificationPeer != verification.userId) {
            fail("There are no verification codes to compare.")
        }
        c.verification.declineVerification()
        finishVerification(c, MessengerVerificationStage.Failed)
    }

    suspend fun cancelVerification(): Unit = operation(Unit, "Could not cancel verification.") {
        val c = requireConnection()
        val pending = c.incoming
        if (pending != null) c.verification.acknowledgeVerificationRequest(pending.userId, pending.flowId)
        if (pending != null || c.verificationPeer != null) c.verification.cancelVerification()
        c.incoming = null
        c.verificationPeer = null
        mutableState.update { it.copy(verification = null) }
    }

    fun clearError() {
        mutableState.update { it.copy(error = null) }
    }

    suspend fun signOut(): Unit = operation(Unit, "Could not remove the local session.") {
        val active = connection
        var alreadyEnded = false
        if (active != null && active.recoveryConfirmed &&
            (state.value.recovery == MessengerRecovery.Ready || state.value.recovery == MessengerRecovery.OtherDevice)
        ) {
            val backedUp = try {
                withTimeoutOrNull(RECOVERY_TIMEOUT_MS) {
                    active.client.encryption().use { encryption ->
                        encryption.waitForBackupUploadSteadyState(object : BackupSteadyStateListener {
                            override fun onUpdate(state: BackupUploadState) = Unit
                        })
                    }
                    true
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                false
            }
            if (backedUp != true) {
                // The server may have committed a previous logout even when its response was lost.
                alreadyEnded = try {
                    auth.hasEndedSession(active.client.session())
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    false
                }
                if (!alreadyEnded) fail("Your messages are still backing up. Stay signed in and try again when connected.")
            }
        }
        val revoked = if (alreadyEnded) {
            true
        } else if (active != null) {
            withTimeoutOrNull(12_000) {
                try {
                    active.client.logout()
                    true
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ClientException.MatrixApi) {
                    (e.kind as? ErrorKind.UnknownToken)?.softLogout == false
                } catch (_: Exception) {
                    false
                }
            } == true
        } else if (sessionStore.exists()) {
            try {
                val saved = requireNotNull(sessionStore.read())
                try {
                    auth.revoke(saved.session)
                } finally {
                    saved.storeKey.fill(0)
                }
            } catch (_: Exception) {
                false
            }
        } else {
            true
        }
        if (!revoked) fail("Could not confirm sign-out. Your session and keys are still on this phone. Connect and try again.")
        disconnect()
        sessionStore.clear()
        challenge = null
        mutableState.value = MessengerState()
    }

    suspend fun close() = withContext(Dispatchers.IO) {
        gate.withLock {
            if (closed) return@withLock
            closed = true
            disconnect()
            challenge = null
            mutableState.value = MessengerState()
            scope.cancel()
        }
    }

    private suspend fun connect(saved: StoredMessengerSession, freshSignIn: Boolean = false) {
        val base = auth.checkedBaseUrl(saved.session.homeserverUrl)
        val recoveryConfirmed = saved.recoveryConfirmed && sessionStore.hasSdkStore(saved)
        if (saved.recoveryConfirmed && !recoveryConfirmed) {
            sessionStore.updateRecoveryConfirmation(saved.storeId, false)
        }
        val directory = sessionStore.sdkDirectory(saved)
        val client = SqliteStoreBuilder(directory.absolutePath, directory.absolutePath).use { plain ->
            plain.key(saved.storeKey).use { sqlite ->
                ClientBuilder().use { root ->
                    root.homeserverUrl(base)
                        .disableWellKnownLookup(true)
                        .sqliteStore(sqlite)
                        .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.NATIVE)
                        .autoEnableCrossSigning(true)
                        .autoEnableBackups(false)
                        .backupDownloadStrategy(BackupDownloadStrategy.ONE_SHOT)
                        .enableShareHistoryOnInvite(false)
                        .roomKeyRecipientStrategy(CollectStrategy.ONLY_TRUSTED_DEVICES)
                        .decryptionSettings(DecryptionSettings(TrustRequirement.CROSS_SIGNED))
                        .use { it.build() }
                }
            }
        }
        try {
            client.restoreSession(saved.session)
            val userId = client.userId()
            val identityReady = withTimeoutOrNull(E2EE_SETUP_TIMEOUT_MS) {
                client.encryption().use { encryption ->
                    // The SDK creates a fresh account's cross-signing identity in the
                    // background. An existing device can restore its cached identity offline.
                    val hasCachedIdentity = !freshSignIn &&
                        encryption.userIdentity(userId, false)?.use { true } == true
                    if (hasCachedIdentity) {
                        true
                    } else {
                        encryption.waitForE2eeInitializationTasks()
                        encryption.userIdentity(userId, false)?.use { true } ?: false
                    }
                }
            }
            if (identityReady != true) {
                fail("Could not finish encryption setup. Your session is saved. Reconnect and restore it.")
            }
            client.syncService().use { builder ->
                val sync = builder.withOfflineMode().withRoomListTimelineLimit(40u).use { it.finish() }
                try {
                    val c = Connection(client, sync, client.getSessionVerificationController(), saved.storeId, recoveryConfirmed)
                    connection = c
                    challenge = null
                    mutableState.update {
                        it.copy(userId = userId, connection = MessengerConnection.Syncing, pendingSignInEmail = null,
                            recovery = MessengerRecovery.Checking, recoveredWithKey = recoveryConfirmed && saved.recoveredWithKey)
                    }
                    c.verification.setDelegate(verificationDelegate(c))
                    c.syncObserver = sync.state(object : SyncServiceStateObserver {
                        override fun onUpdate(state: SyncServiceState) {
                            scope.launch {
                                gate.withLock {
                                    if (connection !== c) return@withLock
                                    val phase = when (state) {
                                        SyncServiceState.RUNNING -> MessengerConnection.Synced
                                        SyncServiceState.IDLE -> MessengerConnection.Syncing
                                        SyncServiceState.OFFLINE, SyncServiceState.ERROR, SyncServiceState.TERMINATED ->
                                            MessengerConnection.Offline
                                    }
                                    mutableState.update { it.copy(connection = phase) }
                                }
                            }
                        }
                    })
                    refreshStoredRooms(c)
                    sync.start()
                    c.roomWatch = scope.launch {
                        while (isActive) {
                            gate.withLock {
                                if (connection !== c) return@withLock
                                refreshStoredRooms(c)
                            }
                            delay(1_500)
                        }
                    }
                } catch (e: Exception) {
                    if (connection?.client === client) disconnect() else sync.close()
                    throw e
                }
            }
        } catch (e: Exception) {
            client.close()
            mutableState.update {
                it.copy(userId = null, connection = MessengerConnection.SignedOut, recovery = MessengerRecovery.Checking)
            }
            throw e
        } finally {
            saved.storeKey.fill(0)
        }
    }

    private suspend fun refreshStoredRooms(c: Connection) {
        try {
            val recovery = c.client.encryption().use { encryption ->
                val verified = encryption.verificationState()
                val sdkRecovery = encryption.recoveryState()
                val mode = when (sdkRecovery) {
                    RecoveryState.UNKNOWN -> if (c.recoveryConfirmed && verified == VerificationState.VERIFIED) {
                        if (state.value.recovery == MessengerRecovery.OtherDevice) MessengerRecovery.OtherDevice
                        else MessengerRecovery.Ready
                    } else MessengerRecovery.Checking
                    RecoveryState.DISABLED -> when (verified) {
                        VerificationState.VERIFIED -> MessengerRecovery.SetupRequired
                        VerificationState.UNVERIFIED -> MessengerRecovery.NoRecovery
                        VerificationState.UNKNOWN -> MessengerRecovery.Checking
                    }
                    RecoveryState.ENABLED, RecoveryState.INCOMPLETE ->
                        if (c.recoveryConfirmed && encryption.recoveryIsUsable()) MessengerRecovery.Ready
                        else MessengerRecovery.KeyRequired
                }
                if (sdkRecovery != RecoveryState.UNKNOWN &&
                    (mode == MessengerRecovery.Ready || mode == MessengerRecovery.KeyRequired) &&
                    encryption.hasDevicesToVerifyAgainst()
                ) MessengerRecovery.OtherDevice
                else mode
            }
            val previous = state.value.recovery
            if (recovery != previous) {
                mutableState.update {
                    if (recovery == MessengerRecovery.Ready) it.copy(recovery = recovery)
                    else it.copy(recovery = recovery, rooms = emptyList(), selectedRoomId = null,
                        messages = emptyList(), verification = null)
                }
                if (previous == MessengerRecovery.Ready) {
                    closeTimeline()
                    updateBackgroundSubscriptions(c, emptyList())
                }
            }
            if (recovery == MessengerRecovery.Ready) refresh(c)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep the previous snapshot and retry when the SDK has processed more sync data.
        }
    }

    private suspend fun refresh(c: Connection) {
        val all = c.client.rooms()
        val visible = try {
            all.mapNotNull { roomSnapshot(c, it) }.sortedBy { it.title.lowercase() }
        } finally {
            all.forEach(Room::close)
        }
        val current = opened
        val selectedRoom = visible.firstOrNull { it.id == state.value.selectedRoomId }
        if (current != null && (selectedRoom?.membership != MessengerMembership.Joined ||
                !selectedRoom.encrypted || selectedRoom.peerId != current.peerId)
        ) {
            closeTimeline()
        }
        val joinedSelection = selectedRoom?.takeIf {
            it.id == state.value.selectedRoomId && it.encrypted && it.membership == MessengerMembership.Joined
        }
        updateBackgroundSubscriptions(c, visible)
        updateSdkRoomSubscriptions(c, visible, joinedSelection?.id)
        if (opened == null && joinedSelection != null) {
            requireRoom(c, joinedSelection.id).use { attachTimeline(c, it, joinedSelection) }
        }
        mutableState.update { it.copy(rooms = visible) }
    }

    private suspend fun updateSdkRoomSubscriptions(c: Connection, rooms: List<MessengerRoom>, selectedRoomId: String? = null) {
        val roomIds = rooms.filter(::isNotificationRoom).mapTo(mutableSetOf()) { it.id }
        if (selectedRoomId != null) roomIds.add(selectedRoomId)
        if (roomIds == c.syncedRoomIds) return
        // The SDK replaces the complete set and can interrupt the current sync request.
        c.sync.roomListService().use { it.setRoomSubscriptions(roomIds.toList()) }
        c.syncedRoomIds = roomIds
    }

    private fun updateBackgroundSubscriptions(c: Connection, rooms: List<MessengerRoom>) {
        val eligibleIds = rooms.filter(::isNotificationRoom).mapTo(mutableSetOf()) { it.id }
        for (roomId in c.backgroundSubscriptions.keys - eligibleIds) {
            c.backgroundSubscriptions.remove(roomId)?.apply { cancel(); close() }
        }
        for (roomId in eligibleIds - c.backgroundSubscriptions.keys) {
            val room = c.client.getRoom(roomId) ?: continue
            c.backgroundSubscriptions[roomId] = room.use {
                it.subscribeToMessageLikeEvents(MessageLikeEventType.RoomMessage, object : RoomMessageLikeEventsListener {
                    override fun onEvent(event: RoomMessageLikeEvent) = onBackgroundMessage(c, roomId, event)
                })
            }
        }
    }

    private fun onBackgroundMessage(c: Connection, roomId: String, event: RoomMessageLikeEvent) {
        val sender = event.sender
        val encryption = event.encryptionInfo ?: return
        if (encryption.senderId != sender || encryption.shieldStateStrict != ShieldState.None) return

        val content = try {
            JSONObject(event.contentJson)
        } catch (_: JSONException) {
            return
        }
        if (content.optString("msgtype") != "m.text" || content.opt("body") !is String ||
            content.optJSONObject("m.relates_to")?.optString("rel_type") == "m.replace"
        ) return

        val eventId = event.eventId
        scope.launch {
            gate.withLock {
                if (connection !== c || state.value.recovery != MessengerRecovery.Ready || eventId in c.notifiedEvents) return@withLock
                val room = try {
                    c.client.getRoom(roomId)?.use { roomSnapshot(c, it) }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    return@withLock
                }
                if (room == null || !isNotificationRoom(room) || room.peerId != sender) return@withLock
                c.notifiedEvents += eventId
                if (c.notifiedEvents.size > MAX_NOTIFIED_EVENTS) c.notifiedEvents.remove(c.notifiedEvents.first())
                mutableBackgroundMessageEvents.tryEmit(eventId)
            }
        }
    }

    private fun isNotificationRoom(room: MessengerRoom): Boolean =
        room.membership == MessengerMembership.Joined && room.encrypted && room.peerVerified

    private suspend fun roomSnapshot(c: Connection, room: Room): MessengerRoom? {
        val info = room.roomInfo()
        if (info.isSpace || info.isPublic == true || (!info.isDirect && !info.isDm) || info.activeMembersCount > 2uL) {
            return null
        }
        val membership = when (info.membership) {
            Membership.INVITED -> MessengerMembership.Invited
            Membership.JOINED -> MessengerMembership.Joined
            else -> return null
        }
        val peer = when (membership) {
            MessengerMembership.Invited -> info.inviter?.userId
            MessengerMembership.Joined -> room.activeHumanMemberIdsNoSync()
                .filter { it != c.client.userId() }.distinct().singleOrNull()
        }?.takeIf { isOtherLocalUser(c, it) }
        if (peer == null) return null
        val verified = if (membership == MessengerMembership.Joined) {
            c.client.encryption().use { encryption ->
                encryption.userIdentity(peer, false)?.use {
                    it.isVerified() && !it.hasVerificationViolation()
                } ?: false
            }
        } else false
        return MessengerRoom(
            id = info.id,
            title = info.heroes.firstOrNull { it.userId == peer }?.displayName?.let { name ->
                name.filterNot { it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt() }
                    .trim().take(60).takeIf { it.isNotEmpty() }
            } ?: peer.substringBefore(':').removePrefix("@"),
            peerId = peer,
            membership = membership,
            encrypted = info.encryptionState == EncryptionState.ENCRYPTED,
            peerVerified = verified,
        )
    }

    private suspend fun preparePeerIdentity(c: Connection, peerId: String) {
        // The first key query caches the device records needed to receive verification requests.
        val identityReady = try {
            withTimeoutOrNull(E2EE_SETUP_TIMEOUT_MS) {
                c.client.encryption().use { encryption ->
                    encryption.userIdentity(peerId, true)?.use { true } ?: false
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        when (identityReady) {
            true -> Unit
            false -> fail("This contact's encryption identity is unavailable. Ask them to finish signing in, then try again.")
            null -> fail("Could not load this contact's encryption keys. Check your connection and try again.")
        }
    }

    private suspend fun checkCanSend(c: Connection, selected: OpenTimeline) {
        requireRoom(c, selected.roomId).use {
            val info = roomSnapshot(c, it)
            if (info?.membership != MessengerMembership.Joined || !info.encrypted ||
                !info.peerVerified || info.peerId != selected.peerId ||
                it.latestEncryptionState() != EncryptionState.ENCRYPTED
            ) fail("Only verified, encrypted one-to-one conversations can send messages.")
        }
    }

    private suspend fun attachTimeline(c: Connection, room: Room, info: MessengerRoom) {
        val timeline = room.timeline()
        val slot = OpenTimeline(info.id, requireNotNull(info.peerId), c.client.userId(), timeline)
        opened = slot
        try {
            slot.listener = timeline.addListener(object : TimelineListener {
                override fun onUpdate(diff: List<TimelineDiff>) = applyTimelineDiffs(slot, diff)
            })
        } catch (e: Exception) {
            closeTimeline()
            throw e
        }
    }

    private fun applyTimelineDiffs(slot: OpenTimeline, diffs: List<TimelineDiff>) {
        try {
            synchronized(slot) {
                if (slot.closed) return
                // Keep null placeholders so virtual/non-text entries do not shift SDK diff indices.
                for (diff in diffs) when (diff) {
                    is TimelineDiff.Append -> slot.items.addAll(diff.values.map { readMessage(slot, it) })
                    TimelineDiff.Clear -> slot.items.clear()
                    is TimelineDiff.PushFront -> slot.items.add(0, readMessage(slot, diff.value))
                    is TimelineDiff.PushBack -> slot.items.add(readMessage(slot, diff.value))
                    TimelineDiff.PopFront -> slot.items.removeAt(0)
                    TimelineDiff.PopBack -> slot.items.removeAt(slot.items.lastIndex)
                    is TimelineDiff.Insert -> slot.items.add(diff.index.toInt(), readMessage(slot, diff.value))
                    is TimelineDiff.Set -> slot.items[diff.index.toInt()] = readMessage(slot, diff.value)
                    is TimelineDiff.Remove -> slot.items.removeAt(diff.index.toInt())
                    is TimelineDiff.Truncate -> slot.items.subList(diff.length.toInt(), slot.items.size).clear()
                    is TimelineDiff.Reset -> {
                        slot.items.clear()
                        slot.items.addAll(diff.values.map { readMessage(slot, it) })
                    }
                }
                val rendered = slot.items.filterNotNull().takeLast(MAX_VISIBLE_MESSAGES)
                mutableState.update {
                    if (it.selectedRoomId == slot.roomId) it.copy(messages = rendered) else it
                }
            }
        } catch (_: Exception) {
            synchronized(slot) {
                if (!slot.closed && state.value.selectedRoomId == slot.roomId) {
                    mutableState.update {
                        it.copy(messages = emptyList(), error = "Conversation updates could not load. Reopen the conversation.")
                    }
                }
            }
        } finally {
            diffs.forEach(TimelineDiff::destroy)
        }
    }

    private fun readMessage(slot: OpenTimeline, item: TimelineItem): MessengerMessage? {
        val event = item.asEvent() ?: return null
        try {
            if (event.sender != slot.ownUserId && event.sender != slot.peerId) return null
            val kind = (event.content as? TimelineItemContent.MsgLike)?.content?.kind as? MsgLikeKind.Message
                ?: return null
            val content = (kind.content.msgType as? MessageType.Text)?.content ?: return null
            // The pinned SDK's strict shield reports SentInClear for plaintext in encrypted rooms.
            val shield = if (event.isRemote) event.lazyProvider.getShields(true) else null
            if (!canRenderStrictTimelineText(event.isRemote, shield)) return null
            val delivery = when {
                !event.isOwn -> MessengerDelivery.Received
                event.localSendState is EventSendState.SendingFailed -> MessengerDelivery.Failed
                !event.isRemote && event.localSendState !is EventSendState.Sent -> MessengerDelivery.Queued
                else -> MessengerDelivery.Sent
            }
            val id = (event.localSendState as? EventSendState.Sent)?.eventId ?: when (val value = event.eventOrTransactionId) {
                is EventOrTransactionId.EventId -> value.eventId
                is EventOrTransactionId.TransactionId -> value.transactionId
            }
            return MessengerMessage(id, event.sender, content.body.take(MAX_TEXT_BYTES), event.timestamp.toLong(), event.isOwn, delivery)
        } finally {
            event.destroy()
        }
    }

    private fun verificationDelegate(c: Connection) = object : SessionVerificationControllerDelegate {
        override fun didReceiveVerificationRequest(details: SessionVerificationRequestDetails) {
            val peer = details.senderProfile.userId
            val request = IncomingVerification(peer, details.flowId)
            then {
                if (c.verificationPeer == null && c.incoming == null && isOtherLocalUser(c, peer) &&
                    state.value.rooms.any { it.peerId == peer && it.encrypted && it.membership == MessengerMembership.Joined }
                ) {
                    c.incoming = request
                    mutableState.update { it.copy(verification = MessengerVerification(peer, MessengerVerificationStage.Incoming)) }
                }
            }
        }

        override fun didAcceptVerificationRequest() = then {
            if (c.verificationPeer != null) c.verification.startSasVerification()
        }

        override fun didStartSasVerification() = Unit

        override fun didReceiveVerificationData(data: SessionVerificationData) {
            val symbols: List<String>
            val numbers: List<Int>
            try {
                symbols = if (data is SessionVerificationData.Emojis) data.emojis.map { it.symbol() } else emptyList()
                numbers = if (data is SessionVerificationData.Decimals) data.values.map { it.toInt() } else emptyList()
            } finally {
                data.destroy()
            }
            then {
                c.verificationPeer?.let { peer ->
                    mutableState.update {
                        it.copy(verification = MessengerVerification(peer, MessengerVerificationStage.Compare, symbols, numbers))
                    }
                }
            }
        }

        override fun didFail() = then { finishVerification(c, MessengerVerificationStage.Failed) }
        override fun didCancel() = then {
            if (c.incoming == null && c.verificationPeer != null && c.verification.activeRequestIsCancelled()) {
                finishVerification(c, MessengerVerificationStage.Failed)
            }
        }
        override fun didFinish() = then {
            finishVerification(c, MessengerVerificationStage.Done)
            refresh(c)
        }

        private fun then(action: suspend () -> Unit) {
            scope.launch {
                gate.withLock {
                    if (connection !== c) return@withLock
                    try {
                        action()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        finishVerification(c, MessengerVerificationStage.Failed)
                    }
                }
            }
        }
    }

    private fun finishVerification(c: Connection, stage: MessengerVerificationStage) {
        val peer = c.verificationPeer ?: c.incoming?.userId ?: return
        c.verificationPeer = null
        c.incoming = null
        mutableState.update { it.copy(verification = MessengerVerification(peer, stage)) }
    }

    private fun closeTimeline() {
        val old = opened
        opened = null
        if (old != null) {
            synchronized(old) {
                old.closed = true
                old.items.clear()
            }
            old.listener?.apply { cancel(); close() }
            old.timeline.close()
        }
        mutableState.update { it.copy(selectedRoomId = null, messages = emptyList()) }
    }

    private suspend fun disconnect() = withContext(NonCancellable) {
        val old = connection
        connection = null
        closeTimeline()
        if (old != null) {
            old.pendingRecoveryKey?.close()
            old.roomWatch?.cancel()
            old.syncObserver?.apply { cancel(); close() }
            old.backgroundSubscriptions.values.forEach { it.cancel(); it.close() }
            old.backgroundSubscriptions.clear()
            runCatching { old.verification.setDelegate(null) }
            runCatching { withTimeoutOrNull(5_000) { old.sync.stop() } }
            old.verification.close()
            old.sync.close()
            old.client.close()
        }
    }

    private suspend fun <T> operation(failure: T, genericError: String, block: suspend () -> T): T =
        withContext(Dispatchers.IO) {
            gate.withLock {
                if (closed) return@withLock failure
                mutableState.update { it.copy(busy = true, error = null) }
                try {
                    block()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    mutableState.update { it.copy(error = (e as? MessengerFailure)?.message ?: genericError) }
                    failure
                } finally {
                    mutableState.update { it.copy(busy = false) }
                }
            }
        }

    private fun requireSessionConnection(): Connection = connection ?: fail("Sign in to the messaging service first.")

    private fun requireConnection(): Connection {
        val c = requireSessionConnection()
        if (state.value.recovery != MessengerRecovery.Ready) fail("Finish recovery before using messages.")
        return c
    }

    private fun requireRoom(c: Connection, roomId: String): Room =
        c.client.getRoom(roomId) ?: fail("This conversation has not synced yet.")

    private fun isOtherLocalUser(c: Connection, id: String): Boolean =
        matrixUserId(id) == id && id != c.client.userId() &&
            id.substringAfter(':') == c.client.userIdServerName()

    private fun fail(message: String): Nothing = throw MessengerFailure(message)

    private data class Challenge(val baseUrl: String, val id: String, val email: String)
    private data class IncomingVerification(val userId: String, val flowId: String)

    private class Connection(
        val client: Client,
        val sync: SyncService,
        val verification: SessionVerificationController,
        val storeId: String,
        var recoveryConfirmed: Boolean,
    ) {
        var pendingRecoveryKey: SecretStorageKey? = null
        val backgroundSubscriptions = mutableMapOf<String, TaskHandle>()
        val notifiedEvents = linkedSetOf<String>()
        var syncedRoomIds: Set<String>? = null
        var syncObserver: TaskHandle? = null
        var roomWatch: Job? = null
        var verificationPeer: String? = null
        var incoming: IncomingVerification? = null
    }

    private class OpenTimeline(val roomId: String, val peerId: String, val ownUserId: String, val timeline: Timeline) {
        var listener: TaskHandle? = null
        var closed = false
        val items = mutableListOf<MessengerMessage?>()
    }

    private companion object {
        const val E2EE_SETUP_TIMEOUT_MS = 20_000L
        const val RECOVERY_TIMEOUT_MS = 30_000L
        const val MAX_NOTIFIED_EVENTS = 256
        const val MAX_TEXT_BYTES = 4_096
        const val MAX_VISIBLE_MESSAGES = 200
    }
}

internal fun canRenderStrictTimelineText(isRemote: Boolean, shield: ShieldState?): Boolean =
    !isRemote || shield == ShieldState.None
