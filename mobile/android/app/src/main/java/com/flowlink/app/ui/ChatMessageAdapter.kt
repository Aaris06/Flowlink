package com.flowlink.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
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

    class MessageViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        val tvSenderName: TextView = itemView.findViewById(R.id.tv_sender_name)
        val bubbleContainer: FrameLayout = itemView.findViewById(R.id.bubble_container)
        val bubble: LinearLayout = itemView.findViewById(R.id.bubble)
        val replyStrip: LinearLayout = itemView.findViewById(R.id.reply_strip)
        val tvReplyPreview: TextView = itemView.findViewById(R.id.tv_reply_preview)
        // File card
        val fileCard: LinearLayout = itemView.findViewById(R.id.file_card)
        val ivImagePreview: ImageView = itemView.findViewById(R.id.iv_image_preview)
        val fileRow: LinearLayout = itemView.findViewById(R.id.file_row)
        val fileIconBg: View = itemView.findViewById(R.id.file_icon_bg)
        val tvFileTypeBadge: TextView = itemView.findViewById(R.id.tv_file_type_badge)
        val tvFileNameBubble: TextView = itemView.findViewById(R.id.tv_file_name_bubble)
        val tvFileMetaBubble: TextView = itemView.findViewById(R.id.tv_file_meta_bubble)
        val btnFileDownload: FrameLayout = itemView.findViewById(R.id.btn_file_download)
        // Text
        val tvMessageText: TextView = itemView.findViewById(R.id.tv_message_text)
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

        // Reply strip
        if (msg.replyToId != null && msg.replyToText != null) {
            holder.replyStrip.visibility = View.VISIBLE
            holder.tvReplyPreview.text = "${msg.replyToUsername ?: "User"}: ${msg.replyToText.take(60)}"
        } else {
            holder.replyStrip.visibility = View.GONE
        }

        // File or text
        if (msg.fileId != null && msg.fileName != null) {
            holder.fileCard.visibility = View.VISIBLE
            holder.tvMessageText.visibility = View.GONE

            val ext = msg.fileName.substringAfterLast('.', "").lowercase()
            val isImage = msg.fileType?.startsWith("image") == true ||
                          ext in listOf("jpg", "jpeg", "png", "gif", "webp", "bmp")
            val isVoice = msg.fileType?.startsWith("audio") == true ||
                          ext in listOf("m4a", "mp3", "ogg", "wav") ||
                          msg.fileName.startsWith("voice_")

            if (isImage && msg.fileData != null) {
                // Show image preview inline (WhatsApp style)
                holder.ivImagePreview.visibility = View.VISIBLE
                holder.fileRow.visibility = View.VISIBLE
                try {
                    val bytes = Base64.decode(msg.fileData, Base64.DEFAULT)
                    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                    holder.ivImagePreview.setImageBitmap(bmp)
                } catch (e: Exception) {
                    holder.ivImagePreview.visibility = View.GONE
                }
                holder.tvFileTypeBadge.text = "🖼"
                setIconColor(holder.fileIconBg, "#00BCD4")
                holder.tvFileNameBubble.text = msg.fileName
                val sizeStr = if (msg.fileSize > 0) formatBytes(msg.fileSize) else ""
                holder.tvFileMetaBubble.text = "${ext.uppercase()} · $sizeStr"
            } else {
                holder.ivImagePreview.visibility = View.GONE
                holder.fileRow.visibility = View.VISIBLE

                if (isVoice) {
                    holder.tvFileTypeBadge.text = "🎙"
                    setIconColor(holder.fileIconBg, "#9C27B0")
                    holder.tvFileNameBubble.text = "Voice message"
                    val sizeStr = if (msg.fileSize > 0) formatBytes(msg.fileSize) else ""
                    holder.tvFileMetaBubble.text = "Audio · $sizeStr"
                } else {
                    val (letter, color) = getFileIconInfo(ext)
                    holder.tvFileTypeBadge.text = letter
                    setIconColor(holder.fileIconBg, color)
                    holder.tvFileNameBubble.text = msg.fileName
                    val sizeStr = if (msg.fileSize > 0) " · ${formatBytes(msg.fileSize)}" else ""
                    holder.tvFileMetaBubble.text = "${ext.uppercase()}$sizeStr"
                }
            }

            holder.btnFileDownload.setOnClickListener { onFileDownload(msg) }
            // Tap image to view full screen
            holder.ivImagePreview.setOnClickListener { onFileDownload(msg) }
        } else {
            holder.fileCard.visibility = View.GONE
            holder.tvMessageText.visibility = View.VISIBLE
            holder.tvMessageText.text = msg.text
        }

        holder.tvMessageTime.text = timeFormatter.format(Date(msg.sentAt))

        if (isSelf) {
            holder.rootLayout.gravity = Gravity.END
            holder.tvSenderName.visibility = View.GONE
            holder.bubble.setBackgroundResource(R.drawable.chat_bubble_self)
            holder.tvMessageText.setTextColor(Color.WHITE)
            holder.tvTicks.visibility = View.VISIBLE
            holder.tvTicks.text = when {
                msg.seen -> "✓✓"
                msg.delivered -> "✓✓"
                else -> "✓"
            }
            holder.tvTicks.setTextColor(
                if (msg.seen) Color.parseColor("#60A5FA")
                else Color.parseColor("#AAFFFFFF")
            )
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

    // Returns (letter, hex color) for file type icon - matches WhatsApp style
    private fun getFileIconInfo(ext: String): Pair<String, String> = when (ext) {
        "pdf"                       -> Pair("P", "#F44336") // red
        "doc", "docx"               -> Pair("W", "#2196F3") // blue (Word)
        "xls", "xlsx"               -> Pair("X", "#4CAF50") // green (Excel)
        "ppt", "pptx"               -> Pair("P", "#FF5722") // deep orange (PowerPoint)
        "txt"                       -> Pair("T", "#607D8B") // grey
        "zip", "rar", "7z", "tar"   -> Pair("Z", "#795548") // brown
        "mp4", "mkv", "avi", "mov"  -> Pair("▶", "#9C27B0") // purple (video)
        "mp3", "wav", "ogg", "m4a"  -> Pair("♪", "#009688") // teal (audio)
        "apk"                       -> Pair("A", "#4CAF50") // green
        else                        -> Pair("F", "#607D8B") // grey default
    }

    // Set rounded background color on the icon view
    private fun setIconColor(view: View, hexColor: String) {
        val drawable = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 10f
            setColor(Color.parseColor(hexColor))
        }
        view.background = drawable
    }

    override fun getItemCount(): Int = messages.size

    fun updateMessage(messageId: String, delivered: Boolean, seen: Boolean) {
        val index = messages.indexOfFirst { it.messageId == messageId }
        if (index >= 0) {
            messages[index] = messages[index].copy(delivered = delivered, seen = seen)
            notifyItemChanged(index)
        }
    }

    fun attachSwipeToReply(recyclerView: RecyclerView) {
        val callback = object : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.RIGHT) {
            override fun onMove(rv: RecyclerView, vh: RecyclerView.ViewHolder, t: RecyclerView.ViewHolder) = false
            override fun onSwiped(viewHolder: RecyclerView.ViewHolder, direction: Int) {
                val pos = viewHolder.adapterPosition
                if (pos != RecyclerView.NO_ID.toInt() && pos < messages.size) onReply(messages[pos])
                notifyItemChanged(pos)
            }
            override fun getSwipeThreshold(viewHolder: RecyclerView.ViewHolder) = 0.3f
        }
        ItemTouchHelper(callback).attachToRecyclerView(recyclerView)
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB")
        var size = bytes.toDouble(); var i = 0
        while (size >= 1024 && i < units.lastIndex) { size /= 1024; i++ }
        return "${if (size >= 10 || i == 0) size.toInt() else String.format("%.1f", size)} ${units[i]}"
    }
}
