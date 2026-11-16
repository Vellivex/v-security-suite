package com.vellivex.messenger

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

class MessengerBackgroundSyncService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val repository get() = (application as MessengerApplication).repository
    private val notifications get() = requireNotNull(getSystemService(NotificationManager::class.java))
    private var foreground = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != ACTION_START || repository.state.value.userId == null || !canShowNotifications(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (foreground) return START_NOT_STICKY

        val connection = repository.state.value.connection
        val serviceType = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        try {
            ServiceCompat.startForeground(this, SYNC_STATUS_NOTIFICATION_ID, statusNotification(connection), serviceType)
        } catch (_: SecurityException) {
            stopSelf()
            return START_NOT_STICKY
        } catch (_: IllegalStateException) {
            stopSelf()
            return START_NOT_STICKY
        }
        foreground = true

        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            repository.backgroundMessageEvents.collect {
                if (!appVisible) publishIncomingMessage()
            }
        }
        var displayedPhase = connection
        scope.launch {
            repository.state.map { it.userId to it.connection }.distinctUntilChanged().collect { (userId, phase) ->
                if (userId == null || !notificationsAllowed(this@MessengerBackgroundSyncService)) {
                    stopSelf()
                } else if (phase != displayedPhase) {
                    postNotification(SYNC_STATUS_NOTIFICATION_ID, statusNotification(phase))
                    displayedPhase = phase
                }
            }
        }
        active.value = true
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        if (foreground) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
            notifications.cancel(INCOMING_MESSAGE_NOTIFICATION_ID)
        }
        active.value = false
        super.onDestroy()
    }

    private fun statusNotification(phase: MessengerConnection): Notification {
        val status = when (phase) {
            MessengerConnection.Synced -> "Connected"
            MessengerConnection.Offline -> "Waiting for a connection"
            else -> "Connecting"
        }
        val stop = PendingIntent.getService(
            this,
            SYNC_STATUS_NOTIFICATION_ID,
            Intent(this, MessengerBackgroundSyncService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, SYNC_STATUS_CHANNEL)
            .setSmallIcon(R.drawable.ic_messenger_notification)
            .setContentTitle("Vellivex background alerts")
            .setContentText(status)
            .setContentIntent(openAppIntent(SYNC_STATUS_NOTIFICATION_ID))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(true)
            .addAction(0, "Stop", stop)
            .build()
    }

    private fun publishIncomingMessage() {
        if (repository.state.value.userId == null) return
        val notification = NotificationCompat.Builder(this, INCOMING_MESSAGES_CHANNEL)
            .setSmallIcon(R.drawable.ic_messenger_notification)
            .setContentTitle("New Vellivex message")
            .setContentText("Open Vellivex to view it.")
            .setContentIntent(openAppIntent(INCOMING_MESSAGE_NOTIFICATION_ID))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setAutoCancel(true)
            .build()
        postNotification(INCOMING_MESSAGE_NOTIFICATION_ID, notification)
    }

    @SuppressLint("MissingPermission") // Checked below, including channel and app-level settings.
    private fun postNotification(id: Int, notification: Notification) {
        if (!notificationsAllowed(this)) {
            stopSelf()
            return
        }
        try {
            notifications.notify(id, notification)
        } catch (_: SecurityException) {
            // Permission can be withdrawn between the check and posting.
            stopSelf()
        }
    }

    private fun openAppIntent(requestCode: Int): PendingIntent = PendingIntent.getActivity(
        this,
        requestCode,
        Intent(this, MainActivity::class.java).setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    companion object {
        const val SYNC_STATUS_CHANNEL = "vellivex_sync_status"
        const val INCOMING_MESSAGES_CHANNEL = "vellivex_incoming_messages"
        const val SYNC_STATUS_NOTIFICATION_ID = 1001
        const val INCOMING_MESSAGE_NOTIFICATION_ID = 1002
        private const val ACTION_START = "com.vellivex.messenger.action.START_BACKGROUND_SYNC"
        private const val ACTION_STOP = "com.vellivex.messenger.action.STOP_BACKGROUND_SYNC"
        private val active = MutableStateFlow(false)
        val running: StateFlow<Boolean> = active.asStateFlow()
        @Volatile private var appVisible = false

        fun setAppVisible(visible: Boolean) {
            appVisible = visible
        }

        fun canShowNotifications(context: Context): Boolean {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return false
            manager.createNotificationChannels(listOf(
                NotificationChannel(SYNC_STATUS_CHANNEL, "Background connection", NotificationManager.IMPORTANCE_LOW),
                NotificationChannel(INCOMING_MESSAGES_CHANNEL, "Incoming messages", NotificationManager.IMPORTANCE_DEFAULT),
            ))
            return notificationsAllowed(context)
        }

        /** Call from a visible activity after the user enables background alerts. */
        fun start(context: Context): Boolean {
            if (!canShowNotifications(context)) return false
            return try {
                val intent = Intent(context, MessengerBackgroundSyncService::class.java).setAction(ACTION_START)
                ContextCompat.startForegroundService(context, intent)
                true
            } catch (_: SecurityException) {
                false
            } catch (_: IllegalStateException) {
                false
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MessengerBackgroundSyncService::class.java))
        }

        private fun notificationsAllowed(context: Context): Boolean {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return false
            return (Build.VERSION.SDK_INT < 33 ||
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
                manager.areNotificationsEnabled() &&
                manager.getNotificationChannel(SYNC_STATUS_CHANNEL)?.importance?.let { it > NotificationManager.IMPORTANCE_NONE } == true &&
                manager.getNotificationChannel(INCOMING_MESSAGES_CHANNEL)?.importance?.let { it > NotificationManager.IMPORTANCE_NONE } == true
        }
    }
}
