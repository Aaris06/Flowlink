package com.flowlink.app.ui

import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.MediaPlayer
import android.util.Base64
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.RecyclerView
import com.flowlink.app.R
import com.flowlink.app.model.ChatMessage
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class ChatMessageAdapter(
    private val messages: MutableList<ChatMessage>,
    private val selfDeviceId: String,
    private val onReply: (ChatMessage) -> Unit = {},
    private val onFileDownload: (ChatMessage) -> Unit = {}
) : RecyclerView.Adapter<ChatMessageAdapter.MessageViewHolder>() {

    private val timeFormatter = SimpleDateFormat("HH:mm", Locale.getDefault())
    private val activePlayers = mutableMapOf<String, MediaPlayer>()

    class MessageViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        val tvSenderName: TextView = itemView.findViewById(R.id.tv_sender_name)
        val bubbleContainer: FrameLayout = itemView.findViewById(R.id.bubble_container)
        val bubble: LinearLayout = itemView.findViewById(R.id.bubble)
        val replyStrip: LinearLayout = itemView.findViewById(R.id.reply_strip)
        val tvReplyPreview: TextView = itemView.findViewById(R.id.tv_reply_preview)
        val fileCard: LinearLayout = itemView.findViewById(R.id.file_card)
        val ivImagePreview: ImageView = itemView.findViewById(R.id.iv_image_preview)
        val voiceRow: LinearLayout = itemView.findViewById(R.id.voice_row)
        val btnVoicePlay: FrameLayout = itemView.findViewById(R.id.btn_voice_play)
        val tvVoicePlayIcon: TextView = itemView.findViewById(R.id.tv_voice_play_icon)
        val tvVoiceDuration: TextView = itemView.findViewById(R.id.tv_voice_duration)
        val tvVoiceSize: TextView = itemView.findViewById(R.id.tv_voice_size)
        val voiceProgressBar: View = itemView.findViewById(R.id.voice_progress_bar)
        val fileRow: LinearLayout = itemView.findViewById(R.id.file_row)
        val fileIconBg: View = itemView.findViewById(R.id.file_icon_bg)
        val tvFileTypeBadge: TextView = itemView.findViewById(R.id.tv_file_type_badge)
        val tvFileNameBubble: TextView = itemView.findViewById(R.id.tv_file_name_bubble)
        val tvFileMetaBubble: TextView = itemView.findViewById(R.id.tv_file_meta_bubble)
        val btnFileDownload: FrameLayout = itemView.findViewById(R.id.btn_file_download)
        val tvMessageText: TextView = itemView.findViewById(R.id.tv_message_text)
        val callCard: LinearLayout = itemView.findViewById(R.id.call_card)
        val tvCallTitle: TextView = itemView.findViewById(R.id.tv_call_title)
        val tvCallSubtitle: TextView = itemView.findViewById(R.id.tv_call_subtitle)
        val btnJoinCall: View = itemView.findViewById(R.id.btn_join_call)
        val tvMessageTime: TextView = itemView.findViewById(R.id.tv_message_time)
        val tvTicks: TextView = itemView.findViewById(R.id.tv_ticks)
        val rootLayout: LinearLayout = itemView as LinearLayout
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): MessageViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_chat_message, parent, false)
        return MessageViewHolder(view)
    }

    override fun onBindViewHolder(holder: MessageViewHolder, position: Int) {
        val msg = messages[position]
        val isSelf = msg.sourceDevice == selfDeviceId

        if (msg.replyToId != null && msg.replyToText != null) {
            holder.replyStrip.visibility = View.VISIBLE
            holder.tvReplyPreview.text = "${msg.replyToUsername ?: "User"}: ${msg.replyToText.take(60)}"
        } else {
            holder.replyStrip.visibility = View.GONE
        }

        if (msg.fileId != null && msg.fileName != null) {
            holder.callCard.visibility = View.GONE
            holder.fileCard.visibility = View.VISIBLE
            holder.tvMessageText.visibility = View.GONE

            val ext = msg.fileName.substringAfterLast('.', "").lowercase()
            val isImage = msg.fileType?.startsWith("image") == true ||
                          ext in listOf("jpg", "jpeg", "png", "gif", "webp", "bmp")
            val isVoice = msg.fileType?.startsWith("audio") == true ||
                          ext in listOf("m4a", "mp3", "ogg", "wav", "webm") ||
                          msg.fileName.startsWith("voice_")

            when {
                isVoice && msg.fileData != null -> {
                    holder.ivImagePreview.visibility = View.GONE
                    holder.voiceRow.visibility = View.VISIBLE
                    holder.fileRow.visibility = View.GONE
                    holder.tvVoiceSize.text = if (msg.fileSize > 0) formatBytes(msg.fileSize) else ""
                    // Reset play icon
                    val isPlaying = activePlayers[msg.messageId]?.isPlaying == true
                    holder.tvVoicePlayIcon.text = if (isPlaying) "⏸" else "▶"
                    holder.btnVoicePlay.setOnClickListener { playOrPauseVoice(msg, holder) }
                }
                isImage && msg.fileData != null -> {
                    holder.ivImagePreview.visibility = View.VISIBLE
                    holder.voiceRow.visibility = View.GONE
                    holder.fileRow.visibility = View.VISIBLE
                    try {
                        val bytes = Base64.decode(msg.fileData, Base64.DEFAULT)
                        holder.ivImagePreview.setImageBitmap(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
                    } catch (_: Exception) { holder.ivImagePreview.visibility = View.GONE }
                    holder.tvFileTypeBadge.text = "🖼"
                    setIconColor(holder.fileIconBg, "#00BCD4")
                    holder.tvFileNameBubble.text = msg.fileName
                    holder.tvFileMetaBubble.text = "${ext.uppercase()} · ${formatBytes(msg.fileSize)}"
                    holder.btnFileDownload.setOnClickListener { onFileDownload(msg) }
                    holder.ivImagePreview.setOnClickListener { onFileDownload(msg) }
                }
                else -> {
                    holder.ivImagePreview.visibility = View.GONE
                    holder.voiceRow.visibility = View.GONE
                    holder.fileRow.visibility = View.VISIBLE
                    val (letter, color) = getFileIconInfo(ext)
                    holder.tvFileTypeBadge.text = letter
                    setIconColor(holder.fileIconBg, color)
                    holder.tvFileNameBubble.text = msg.fileName
                    val sizeStr = if (msg.fileSize > 0) " · ${formatBytes(msg.fileSize)}" else ""
                    holder.tvFileMetaBubble.text = "${ext.uppercase()}$sizeStr"
                    holder.btnFileDownload.setOnClickListener { onFileDownload(msg) }
                }
            }
        } else {
            holder.callCard.visibility = View.GONE
            holder.fileCard.visibility = View.GONE
            holder.tvMessageText.visibility = View.VISIBLE
            if (msg.text.startsWith("[[CALL_ACTIVITY]]")) {
                holder.tvMessageText.visibility = View.GONE
                holder.callCard.visibility = View.VISIBLE
                try {
                    val call = parseCallActivity(holder, msg.text)
                    holder.tvCallTitle.text = call.title
                    holder.tvCallSubtitle.text = call.subtitle
                    holder.btnJoinCall.visibility = if (call.joinable) View.VISIBLE else View.GONE
                    holder.btnJoinCall.setOnClickListener { call.onJoin() }
                } catch (_: Exception) {
                    holder.callCard.visibility = View.GONE
                    holder.tvMessageText.visibility = View.VISIBLE
                    holder.tvMessageText.text = msg.text
                }
            } else if (msg.text.startsWith("[[CALL_ROOM_ACTIVITY]]")) {
                holder.tvMessageText.visibility = View.GONE
                holder.callCard.visibility = View.VISIBLE
                try {
                    val call = parseCallRoomActivity(holder, msg.text)
                    holder.tvCallTitle.text = call.title
                    holder.tvCallSubtitle.text = call.subtitle
                    holder.btnJoinCall.visibility = if (call.joinable) View.VISIBLE else View.GONE
                    holder.btnJoinCall.setOnClickListener { call.onJoin() }
                } catch (_: Exception) {
                    holder.callCard.visibility = View.GONE
                    holder.tvMessageText.visibility = View.VISIBLE
                    holder.tvMessageText.text = msg.text
                }
            } else {
                holder.tvMessageText.text = msg.text
            }
        }

        holder.tvMessageTime.text = timeFormatter.format(Date(msg.sentAt))

        if (isSelf) {
            holder.rootLayout.gravity = Gravity.END
            holder.tvSenderName.visibility = View.GONE
            holder.bubble.setBackgroundResource(R.drawable.chat_bubble_self)
            holder.tvMessageText.setTextColor(Color.WHITE)
            holder.tvTicks.visibility = View.VISIBLE
            holder.tvTicks.text = when { msg.seen -> "✓✓"; msg.delivered -> "✓✓"; else -> "✓" }
            holder.tvTicks.setTextColor(if (msg.seen) Color.parseColor("#60A5FA") else Color.parseColor("#AAFFFFFF"))
        } else {
            holder.rootLayout.gravity = Gravity.START
            holder.tvSenderName.visibility = View.VISIBLE
            holder.tvSenderName.text = msg.username
            holder.bubble.setBackgroundResource(R.drawable.chat_bubble_other)
            holder.tvMessageText.setTextColor(Color.WHITE)
            holder.tvTicks.visibility = View.GONE
        }

        holder.bubble.setOnLongClickListener { onReply(msg); true }
    }

    private data class ParsedCallActivity(
        val title: String,
        val subtitle: String,
        val joinable: Boolean,
        val onJoin: () -> Unit
    )

    private fun parseCallActivity(holder: MessageViewHolder, text: String): ParsedCallActivity {
        val json = org.json.JSONObject(text.removePrefix("[[CALL_ACTIVITY]]"))
        val kind = json.optString("kind", "started")
            val callId = json.optString("callId", "")
        val callType = json.optString("callType", "audio")
        val sourceUsername = json.optString("sourceUsername", "Someone")
        val title = when (kind) {
            "started" -> "$sourceUsername started a $callType call"
            "joined" -> "$sourceUsername joined the call"
            else -> "$sourceUsername ended the call"
        }
        val subtitle = if (kind == "ended") "Call ended" else "Tap to join the ongoing call"
        return ParsedCallActivity(title, subtitle, kind != "ended") {
            val mainActivity = holder.itemView.context as? com.flowlink.app.MainActivity ?: return@ParsedCallActivity
            val sessionId = mainActivity.sessionManager.getCurrentSessionId() ?: return@ParsedCallActivity
            mainActivity.webSocketManager.sendMessage(org.json.JSONObject().apply {
                put("type", "call_accept")
                put("sessionId", sessionId)
                put("deviceId", mainActivity.sessionManager.getDeviceId())
                put("payload", org.json.JSONObject().apply {
                    put("callId", callId)
                    put("toDevice", json.optString("remoteDeviceId", ""))
                    put("fromUsername", sourceUsername)
                })
                put("timestamp", System.currentTimeMillis())
            }.toString())
        }
    }

    private fun parseCallRoomActivity(holder: MessageViewHolder, text: String): ParsedCallActivity {
        val json = org.json.JSONObject(text.removePrefix("[[CALL_ROOM_ACTIVITY]]"))
        val kind         = json.optString("kind", "started")
        val roomId       = json.optString("roomId", "")
        val callType     = json.optString("callType", "audio")
        val creatorUser  = json.optString("creatorUsername", json.optString("joinUsername", "Someone"))
        val sessionId    = json.optString("sessionId", "")

        val title = when (kind) {
            "started" -> "$creatorUser started a group $callType call"
            "joined"  -> "${json.optString("joinUsername", "Someone")} joined the group call"
            "left"    -> "${json.optString("leaveUsername", "Someone")} left the group call"
            else      -> "Group call ended"
        }
        val joinable = kind == "started" || kind == "joined"
        val subtitle = if (joinable) "Group call is ongoing — tap to join" else "Group call update"

        return ParsedCallActivity(title, subtitle, joinable) {
            val mainActivity = holder.itemView.context as? com.flowlink.app.MainActivity ?: return@ParsedCallActivity
            // Show GroupCallFragment in "join" mode
            val fragment = GroupCallFragment.newIncomingRoom(
                roomId       = roomId,
                fromUsername = creatorUser,
                isVideo      = callType == "video"
            )
            try {
                mainActivity.supportFragmentManager.beginTransaction()
                    .replace(com.flowlink.app.R.id.fragment_container, fragment, "group_call")
                    .addToBackStack("group_call")
                    .commitAllowingStateLoss()
                // Immediately accept (since user clicked Join Now)
                mainActivity.webSocketManager.sendRoomSignal("call_room_join", org.json.JSONObject().apply {
                    put("roomId", roomId)
                })
            } catch (e: Exception) {
                android.util.Log.e("ChatAdapter", "Failed to join room: ${e.message}")
            }
        }
    }

    private fun playOrPauseVoice(msg: ChatMessage, holder: MessageViewHolder) {
        val id = msg.messageId
        val existing = activePlayers[id]

        if (existing != null && existing.isPlaying) {
            existing.pause()
            holder.tvVoicePlayIcon.text = "▶"
            return
        }
        if (existing != null) {
            existing.start()
            holder.tvVoicePlayIcon.text = "⏸"
            updateVoiceProgress(existing, holder, id)
            return
        }

        // Stop any other playing
        activePlayers.values.forEach { try { it.stop(); it.release() } catch (_: Exception) {} }
        activePlayers.clear()

        try {
            val bytes = Base64.decode(msg.fileData!!, Base64.DEFAULT)
            val tmp = java.io.File.createTempFile("voice_", ".tmp", holder.itemView.context.cacheDir)
            tmp.writeBytes(bytes)
            val player = MediaPlayer().apply { setDataSource(tmp.absolutePath); prepare() }
            activePlayers[id] = player
            holder.tvVoicePlayIcon.text = "⏸"
            holder.tvVoiceDuration.text = formatDuration(player.duration / 1000)
            player.start()
            updateVoiceProgress(player, holder, id)
            player.setOnCompletionListener {
                holder.tvVoicePlayIcon.text = "▶"
                holder.tvVoiceDuration.text = formatDuration(player.duration / 1000)
                activePlayers.remove(id)
                tmp.delete()
            }
        } catch (e: Exception) {
            android.util.Log.e("ChatAdapter", "Voice play failed", e)
        }
    }

    private fun updateVoiceProgress(player: MediaPlayer, holder: MessageViewHolder, id: String) {
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        val r = object : Runnable {
            override fun run() {
                if (!activePlayers.containsKey(id)) return
                try {
                    if (player.isPlaying) {
                        val pos = player.currentPosition / 1000
                        val dur = player.duration / 1000
                        holder.tvVoiceDuration.text = "${formatDuration(pos)} / ${formatDuration(dur)}"
                        holder.voiceProgressBar.scaleX = if (dur > 0) player.currentPosition.toFloat() / player.duration else 0f
                        holder.voiceProgressBar.pivotX = 0f
                        handler.postDelayed(this, 200)
                    }
                } catch (_: Exception) {}
            }
        }
        handler.post(r)
    }

    private fun formatDuration(s: Int) = "${s.coerceAtLeast(0) / 60}:${(s.coerceAtLeast(0) % 60).toString().padStart(2, '0')}"

    private fun getFileIconInfo(ext: String): Pair<String, String> = when (ext) {
        "pdf" -> Pair("P", "#F44336"); "doc", "docx" -> Pair("W", "#2196F3")
        "xls", "xlsx" -> Pair("X", "#4CAF50"); "ppt", "pptx" -> Pair("P", "#FF5722")
        "txt" -> Pair("T", "#607D8B"); "zip", "rar", "7z" -> Pair("Z", "#795548")
        "mp4", "mkv", "avi" -> Pair("▶", "#9C27B0"); else -> Pair("F", "#607D8B")
    }

    private fun setIconColor(view: View, hexColor: String) {
        view.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE; cornerRadius = 10f
            setColor(Color.parseColor(hexColor))
        }
    }

    override fun getItemCount() = messages.size

    fun updateMessage(messageId: String, delivered: Boolean, seen: Boolean) {
        val i = messages.indexOfFirst { it.messageId == messageId }
        if (i >= 0) { messages[i] = messages[i].copy(delivered = delivered, seen = seen); notifyItemChanged(i) }
    }

    fun attachSwipeToReply(recyclerView: RecyclerView) {
        val cb = object : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.RIGHT) {
            override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, t: RecyclerView.ViewHolder) = false
            override fun onSwiped(vh: RecyclerView.ViewHolder, d: Int) {
                val pos = vh.adapterPosition
                if (pos != RecyclerView.NO_ID.toInt() && pos < messages.size) onReply(messages[pos])
                notifyItemChanged(pos)
            }
            override fun getSwipeThreshold(vh: RecyclerView.ViewHolder) = 0.3f
        }
        ItemTouchHelper(cb).attachToRecyclerView(recyclerView)
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB"); var s = bytes.toDouble(); var i = 0
        while (s >= 1024 && i < units.lastIndex) { s /= 1024; i++ }
        return "${if (s >= 10 || i == 0) s.toInt() else String.format("%.1f", s)} ${units[i]}"
    }
}
