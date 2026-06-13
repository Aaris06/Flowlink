package com.flowlink.app.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import com.flowlink.app.FlowLinkApplication
import com.flowlink.app.service.CallSession
import com.flowlink.app.service.NotificationService

/**
 * BroadcastReceiver for incoming-call notification actions.
 *
 * Accept flow:
 *  1. Send call_accept over WebSocket immediately (user is now "answered")
 *  2. Populate CallSession so CallFragment knows it was already accepted
 *  3. Launch MainActivity which opens CallFragment in CONNECTING state
 *
 * Reject flow:
 *  1. Send call_reject over WebSocket
 *  2. Dismiss notification — app never opens
 */
class CallActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_CALL_ACCEPT = "com.flowlink.app.CALL_ACCEPT"
        const val ACTION_CALL_REJECT = "com.flowlink.app.CALL_REJECT"
        const val EXTRA_CALL_ID      = "call_id"
        const val EXTRA_FROM_DEVICE  = "from_device"
        const val EXTRA_FROM_USER    = "from_username"
        const val EXTRA_IS_VIDEO     = "is_video"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val callId     = intent.getStringExtra(EXTRA_CALL_ID)     ?: return
        val fromDevice = intent.getStringExtra(EXTRA_FROM_DEVICE) ?: return
        val fromUser   = intent.getStringExtra(EXTRA_FROM_USER)   ?: "Unknown"
        val isVideo    = intent.getBooleanExtra(EXTRA_IS_VIDEO, false)

        // Dismiss the notification immediately
        NotificationManagerCompat.from(context).cancel(NotificationService.NOTIFICATION_ID_INCOMING_CALL)

        val app       = context.applicationContext as? FlowLinkApplication
        val wsManager = app?.webSocketManager

        when (intent.action) {
            ACTION_CALL_ACCEPT -> {
                Log.d("CallActionReceiver", "✅ Accepting call $callId from $fromUser")

                // 1. Pre-populate CallSession so CallFragment restores to CONNECTING state
                //    (not RINGING_IN) — skipping the manual Accept button press.
                CallSession.startNew(
                    callId         = callId,
                    remoteUsername = fromUser,
                    remoteDevice   = fromDevice,
                    isVideo        = isVideo,
                    direction      = "inbound"
                )
                // Mark as already accepted — CallFragment checks this flag
                CallSession.setState(CallSession.State.CONNECTING)
                NotificationService(context).showOngoingCall(
                    callId = callId,
                    callerName = fromUser,
                    fromDevice = fromDevice,
                    isVideo = isVideo,
                    status = "Connecting…"
                )

                // 2. Send call_accept signal immediately so the caller knows we answered
                wsManager?.sendCallSignal(
                    type         = "call_accept",
                    callId       = callId,
                    toDevice     = fromDevice,
                    extraPayload = org.json.JSONObject()
                )

                // 3. Launch MainActivity to show the call screen
                //    FLAG_ACTIVITY_SINGLE_TOP reuses the existing instance via onNewIntent,
                //    preserving the session back stack.
                val launchIntent = Intent(context, com.flowlink.app.MainActivity::class.java).apply {
                    action = com.flowlink.app.MainActivity.ACTION_SHOW_ACTIVE_CALL
                    putExtra(EXTRA_CALL_ID,     callId)
                    putExtra(EXTRA_FROM_DEVICE, fromDevice)
                    putExtra(EXTRA_FROM_USER,   fromUser)
                    putExtra(EXTRA_IS_VIDEO,    isVideo)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                context.startActivity(launchIntent)
            }

            ACTION_CALL_REJECT -> {
                Log.d("CallActionReceiver", "❌ Rejecting call $callId from $fromUser")
                wsManager?.sendCallSignal(
                    type         = "call_reject",
                    callId       = callId,
                    toDevice     = fromDevice,
                    extraPayload = org.json.JSONObject().apply { put("reason", "rejected") }
                )
                // Stop background ringtone if playing
                try {
                    (context.applicationContext as? FlowLinkApplication)
                        ?.let {
                            // Post to main thread to stop ringtone safely
                            android.os.Handler(android.os.Looper.getMainLooper()).post {
                                // MainActivity exposes stopBackgroundRingtone via a public method
                                // accessed through the app singleton isn't possible here,
                                // so we rely on the MainActivity clearing it in onNewIntent/onResume.
                            }
                        }
                } catch (_: Exception) {}
            }

        }
    }
}
