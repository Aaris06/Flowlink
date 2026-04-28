package com.flowlink.app.service

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.flowlink.app.MainActivity
import com.flowlink.app.R

/**
 * Notification Service for Android
 * 
 * Handles session invitations, nearby device notifications, and general notifications
 */
class NotificationService(private val context: Context) {
    
    companion object {
        const val CHANNEL_ID_INVITATIONS = "session_invitations"
        const val CHANNEL_ID_NEARBY = "nearby_sessions"
        const val CHANNEL_ID_GENERAL = "general"
        const val CHANNEL_ID_MEDIA = "media_handoff"
        const val CHANNEL_ID_TRANSFERS = "file_transfers"
        const val CHANNEL_ID_SOS = "sos_alerts"
        
        const val NOTIFICATION_ID_INVITATION = 1001
        const val NOTIFICATION_ID_NEARBY = 1002
        const val NOTIFICATION_ID_GENERAL = 1003
        const val NOTIFICATION_ID_MEDIA = 1004
        const val NOTIFICATION_ID_TRANSFER = 1005
        
        const val ACTION_ACCEPT_INVITATION = "accept_invitation"
        const val ACTION_REJECT_INVITATION = "reject_invitation"
        const val ACTION_JOIN_NEARBY = "join_nearby"
        const val ACTION_DISMISS = "dismiss"
        const val ACTION_CONTINUE_MEDIA = "continue_media"
        const val ACTION_OPEN_TAB_HANDOFF = "open_tab_handoff"
        
        const val EXTRA_SESSION_ID = "session_id"
        const val EXTRA_SESSION_CODE = "session_code"
        const val EXTRA_INVITER_USERNAME = "inviter_username"
        const val EXTRA_INVITER_DEVICE_NAME = "inviter_device_name"
        const val EXTRA_MEDIA_URL = "media_url"
        const val EXTRA_MEDIA_TIMESTAMP = "media_timestamp"
        const val EXTRA_TAB_HANDOFF = "tab_handoff"
    }
    
    private val notificationManager = NotificationManagerCompat.from(context)
    
    init {
        createNotificationChannels()
    }
    
    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channels = listOf(
                NotificationChannel(
                    CHANNEL_ID_INVITATIONS,
                    "Session Invitations",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Notifications for session invitations from other users"
                },
                NotificationChannel(
                    CHANNEL_ID_NEARBY,
                    "Nearby Sessions",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "Notifications for nearby FlowLink sessions"
                },
                NotificationChannel(
                    CHANNEL_ID_MEDIA,
                    "Media Handoff",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Notifications for continuing media playback from other devices"
                },
                NotificationChannel(
                    CHANNEL_ID_TRANSFERS,
                    "File Transfers",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Progress notifications for file uploads and downloads"
                },
                NotificationChannel(
                    CHANNEL_ID_GENERAL,
                    "General",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "General FlowLink notifications"
                },
                NotificationChannel(
                    CHANNEL_ID_SOS,
                    "SOS Alerts",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = "Emergency SOS alerts from friends"
                    setSound(
                        android.provider.Settings.System.DEFAULT_ALARM_ALERT_URI,
                        android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_ALARM)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    )
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 200, 100, 200, 100, 200, 100, 600, 100, 600, 100, 600, 100, 200, 100, 200, 100, 200)
                    lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
                }
            )
            
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            channels.forEach { manager.createNotificationChannel(it) }
        }
    }
    
    /**
     * Show session invitation notification
     */
    fun showSessionInvitation(
        sessionId: String,
        sessionCode: String,
        inviterUsername: String,
        inviterDeviceName: String,
        message: String? = null
    ) {
        val acceptIntent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_ACCEPT_INVITATION
            putExtra(EXTRA_SESSION_ID, sessionId)
            putExtra(EXTRA_SESSION_CODE, sessionCode)
            putExtra(EXTRA_INVITER_USERNAME, inviterUsername)
            putExtra(EXTRA_INVITER_DEVICE_NAME, inviterDeviceName)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        
        val rejectIntent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_REJECT_INVITATION
            putExtra(EXTRA_SESSION_ID, sessionId)
            putExtra(EXTRA_INVITER_USERNAME, inviterUsername)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        
        val acceptPendingIntent = PendingIntent.getActivity(
            context, 0, acceptIntent, 
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        val rejectPendingIntent = PendingIntent.getActivity(
            context, 1, rejectIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_INVITATIONS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Session Invitation")
            .setContentText("$inviterUsername ($inviterDeviceName) invited you to join their session")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                message ?: "$inviterUsername ($inviterDeviceName) invited you to join their FlowLink session. Tap Accept to join or Reject to decline."
            ))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .addAction(R.drawable.ic_check, "Accept", acceptPendingIntent)
            .addAction(R.drawable.ic_close, "Reject", rejectPendingIntent)
            .build()
        
        notificationManager.notify(NOTIFICATION_ID_INVITATION, notification)
    }
    
    /**
     * Show nearby session notification
     */
    fun showNearbySession(
        sessionId: String,
        sessionCode: String,
        creatorUsername: String,
        creatorDeviceName: String,
        deviceCount: Int
    ) {
        val joinIntent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_JOIN_NEARBY
            putExtra(EXTRA_SESSION_ID, sessionId)
            putExtra(EXTRA_SESSION_CODE, sessionCode)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        
        val joinPendingIntent = PendingIntent.getActivity(
            context, 2, joinIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_NEARBY)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Nearby Session Found")
            .setContentText("$creatorUsername created a session with $deviceCount device(s)")
            .setStyle(NotificationCompat.BigTextStyle().bigText(
                "$creatorUsername ($creatorDeviceName) created a FlowLink session nearby with $deviceCount device(s). Would you like to join?"
            ))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(joinPendingIntent)
            .addAction(R.drawable.ic_group, "Join Session", joinPendingIntent)
            .build()
        
        notificationManager.notify(NOTIFICATION_ID_NEARBY, notification)
    }
    
    /**
     * Show device joined notification
     */
    fun showDeviceJoined(username: String, deviceName: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_GENERAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Device Joined")
            .setContentText("$username ($deviceName) joined the session")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        
        notificationManager.notify(NOTIFICATION_ID_GENERAL, notification)
    }
    
    /**
     * Show device connected notification
     */
    fun showDeviceConnected(deviceName: String, deviceType: String) {
        val deviceIcon = when (deviceType) {
            "browser" -> "🌐"
            "mobile" -> "📱"
            "desktop" -> "💻"
            else -> "📱"
        }
        
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_GENERAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("$deviceIcon Device Connected")
            .setContentText("$deviceName is now connected")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        
        notificationManager.notify(NOTIFICATION_ID_GENERAL, notification)
    }

    fun showReceiverConnected(sourceUsername: String, sourceDeviceName: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_GENERAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("FlowLink Receiver Connected")
            .setContentText("$sourceUsername connected to $sourceDeviceName")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()

        notificationManager.notify(NOTIFICATION_ID_GENERAL, notification)
    }
    
    /**
     * Show media handoff notification
     */
    fun showMediaHandoff(title: String, url: String, timestamp: Int, platform: String) {
        val finalUrl = buildTimestampedMediaUrl(url, timestamp)

        // Create intent to open the media URL
        val continueIntent = Intent(Intent.ACTION_VIEW).apply {
            data = android.net.Uri.parse(finalUrl)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        
        val continuePendingIntent = PendingIntent.getActivity(
            context,
            0,
            continueIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_MEDIA)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("🎬 Continue Watching?")
            .setContentText("$title\nFrom: $platform")
            .setStyle(NotificationCompat.BigTextStyle()
                .bigText("$title\nFrom: $platform\nAt: ${formatTimestamp(timestamp)}"))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(continuePendingIntent)
            .addAction(
                R.drawable.ic_notification,
                "Continue",
                continuePendingIntent
            )
            .build()
        
        notificationManager.notify(NOTIFICATION_ID_MEDIA, notification)
    }

    fun showFileTransferProgress(fileName: String, progress: Int, direction: String, transferredBytes: Long = 0L, totalBytes: Long = 0L) {
        val safeProgress = progress.coerceIn(0, 100)
        val label = if (direction == "send") "Sending" else "Receiving"
        val bytesText = if (totalBytes > 0) {
            " • ${formatBytes(transferredBytes)} / ${formatBytes(totalBytes)}"
        } else {
            ""
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID_TRANSFERS)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("$label file")
            .setContentText("$fileName • $safeProgress%$bytesText")
            .setProgress(100, safeProgress, false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(safeProgress < 100)
            .build()

        notificationManager.notify(NOTIFICATION_ID_TRANSFER, notification)
    }

    fun clearTransferProgress() {
        notificationManager.cancel(NOTIFICATION_ID_TRANSFER)
    }

    fun showTabHandoff(title: String, tabsJson: String, sourceLabel: String, tabCount: Int) {
        val openIntent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN_TAB_HANDOFF
            putExtra(EXTRA_TAB_HANDOFF, tabsJson)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }

        val openPendingIntent = PendingIntent.getActivity(
            context,
            200,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val message = if (tabCount > 1) {
            "$title from $sourceLabel"
        } else {
            sourceLabel
        }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID_GENERAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (tabCount > 1) "Tabs Ready to Resume" else "Tab Ready to Resume")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openPendingIntent)
            .addAction(R.drawable.ic_notification, if (tabCount > 1) "Open Tabs" else "Open Tab", openPendingIntent)
            .build()

        notificationManager.notify(NOTIFICATION_ID_GENERAL + 10, notification)
    }
    
    private fun formatTimestamp(seconds: Int): String {
        val minutes = seconds / 60
        val secs = seconds % 60
        return String.format("%d:%02d", minutes, secs)
    }

    private fun buildTimestampedMediaUrl(url: String, timestamp: Int): String {
        if (timestamp <= 0) {
            return url
        }

        return if (url.contains("youtube.com") || url.contains("youtu.be")) {
            val separator = if (url.contains("?")) "&" else "?"
            "$url${separator}t=$timestamp"
        } else {
            url
        }
    }
    
    /**
     * Show file received notification
     */
    fun showFileReceived(filename: String, senderUsername: String, filePath: String? = null) {
        val locationText = filePath?.let { "\nSaved at: $it" } ?: ""
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_GENERAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("File Received")
            .setContentText("Received \"$filename\" from $senderUsername")
            .setStyle(NotificationCompat.BigTextStyle().bigText("Received \"$filename\" from $senderUsername$locationText"))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        
        notificationManager.notify(NOTIFICATION_ID_GENERAL, notification)
    }
    
    /**
     * Show general notification
     */
    fun showNotification(title: String, message: String) {
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_GENERAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .build()
        
        notificationManager.notify(NOTIFICATION_ID_GENERAL, notification)
    }
    
    /**
     * Clear all notifications
     */
    fun clearAll() {
        notificationManager.cancelAll()
    }
    
    /**
     * Clear specific notification
     */
    fun clearNotification(notificationId: Int) {
        notificationManager.cancel(notificationId)
    }

    /**
     * Show SOS alert notification with dedicated alarm sound + immediate tone
     */
    fun showSosAlert(username: String, mapsUrl: String) {
        createNotificationChannels()

        // Play SOS tone immediately via ToneGenerator (works even if notification is delayed)
        try {
            val toneGen = android.media.ToneGenerator(android.media.AudioManager.STREAM_ALARM, 100)
            // SOS pattern: 3 short, 3 long, 3 short
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            val sosTones = listOf(
                Pair(android.media.ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 200L),
                Pair(android.media.ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 200L),
                Pair(android.media.ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 200L),
                Pair(android.media.ToneGenerator.TONE_CDMA_EMERGENCY_RINGBACK, 600L),
                Pair(android.media.ToneGenerator.TONE_CDMA_EMERGENCY_RINGBACK, 600L),
                Pair(android.media.ToneGenerator.TONE_CDMA_EMERGENCY_RINGBACK, 600L),
                Pair(android.media.ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 200L),
                Pair(android.media.ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 200L),
                Pair(android.media.ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD, 200L)
            )
            var delay = 0L
            sosTones.forEach { (tone, duration) ->
                handler.postDelayed({
                    try { toneGen.startTone(tone, duration.toInt()) } catch (_: Exception) {}
                }, delay)
                delay += duration + 100L
            }
            handler.postDelayed({ toneGen.release() }, delay + 200L)
        } catch (_: Exception) {}

        // Also vibrate in SOS pattern
        try {
            val vibrator = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                val vm = context.getSystemService(android.content.Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager
                vm.defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(android.content.Context.VIBRATOR_SERVICE) as android.os.Vibrator
            }
            // SOS: ... --- ...  (short short short, long long long, short short short)
            val pattern = longArrayOf(0, 200, 100, 200, 100, 200, 100, 600, 100, 600, 100, 600, 100, 200, 100, 200, 100, 200)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                vibrator.vibrate(android.os.VibrationEffect.createWaveform(pattern, -1))
            } else {
                @Suppress("DEPRECATION")
                vibrator.vibrate(pattern, -1)
            }
        } catch (_: Exception) {}

        // Show notification with alarm sound
        val safeUrl = if (mapsUrl.isNotBlank() && !mapsUrl.contains("?q=0.0,0.0")) mapsUrl
                      else "https://www.google.com/maps"
        val mapIntent = android.content.Intent(android.content.Intent.ACTION_VIEW,
            android.net.Uri.parse(safeUrl)).apply {
            addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            setPackage("com.google.android.apps.maps")  // prefer Google Maps
        }
        // Fallback if Google Maps not installed
        val chooserIntent = android.content.Intent.createChooser(mapIntent, "Open location").apply {
            addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        val pendingIntent = PendingIntent.getActivity(
            context, 9999, chooserIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID_SOS)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("🆘 SOS ALERT!")
            .setContentText("$username needs help! Tap to open location.")
            .setStyle(NotificationCompat.BigTextStyle()
                .bigText("🆘 $username has sent an SOS alert!\n\nTap to view their location on Google Maps."))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setColor(android.graphics.Color.RED)
            .setColorized(true)
            .setOngoing(false)
            .build()
        try {
            notificationManager.notify(9999, notification)
        } catch (_: SecurityException) {}
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0L) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB")
        var value = bytes.toDouble()
        var index = 0
        while (value >= 1024.0 && index < units.lastIndex) {
            value /= 1024.0
            index += 1
        }
        val text = if (value >= 10 || index == 0) value.toInt().toString() else String.format("%.1f", value)
        return "$text ${units[index]}"
    }
}
