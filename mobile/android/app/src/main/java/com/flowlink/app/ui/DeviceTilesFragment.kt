package com.flowlink.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.text.Editable
import android.text.TextWatcher
import android.graphics.Color
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.flowlink.app.MainActivity
import com.flowlink.app.databinding.FragmentDeviceTilesBinding
import com.flowlink.app.model.ChatMessage
import com.flowlink.app.model.Device
import com.flowlink.app.model.TransferStatus
import com.flowlink.app.model.Intent as FlowIntent
import com.flowlink.app.service.SessionManager
import com.flowlink.app.service.WebSocketManager
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class DeviceTilesFragment : Fragment() {
    private var _binding: FragmentDeviceTilesBinding? = null
    private val binding get() = _binding!!
    private var sessionId: String? = null
    private var sessionManager: SessionManager? = null
    private val connectedDevices = mutableMapOf<String, Device>()
    private val transferStatuses = mutableMapOf<String, TransferStatus>()
    private val chatMessages = mutableListOf<ChatMessage>()
    private var deviceAdapter: DeviceTileAdapter? = null
    private var pendingFileTargetDeviceId: String? = null
    private var isChatOpen = true
    private var isStudyOpen = true
    private val transferClearRunnables = mutableMapOf<String, Runnable>()
    private val typingByDevice = mutableMapOf<String, Boolean>()
    private var chatTypingStopRunnable: Runnable? = null
    private var typingIndicatorRunnable: Runnable? = null
    private var studyPage = 1

    // Launcher to let the user pick a file/media to send when there is no
    // useful clipboard content available.
    private val pickFileLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        val targetDeviceId = pendingFileTargetDeviceId
        pendingFileTargetDeviceId = null

        if (uri == null || targetDeviceId == null) {
            return@registerForActivityResult
        }

        val mainActivity = activity as? MainActivity ?: return@registerForActivityResult
        val ctx = requireContext()

        try {
            val resolver = ctx.contentResolver
            val name = resolver.query(uri, null, null, null, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (nameIndex != -1 && cursor.moveToFirst()) {
                    cursor.getString(nameIndex)
                } else {
                    uri.lastPathSegment ?: "flowlink-file"
                }
            } ?: (uri.lastPathSegment ?: "flowlink-file")

            val type = resolver.getType(uri) ?: "application/octet-stream"
            val size = resolver.query(uri, null, null, null, null)?.use { cursor ->
                val sizeIndex = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                if (sizeIndex != -1 && cursor.moveToFirst()) cursor.getLong(sizeIndex) else 0L
            } ?: 0L
            mainActivity.webSocketManager.sendFileUri(targetDeviceId, uri, name, type, size)
            Toast.makeText(ctx, "Sent file to device", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to send file", e)
            Toast.makeText(ctx, "Failed to send file: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    companion object {
        fun newInstance(sessionId: String): DeviceTilesFragment {
            return DeviceTilesFragment().apply {
                arguments = Bundle().apply {
                    putString("session_id", sessionId)
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionId = arguments?.getString("session_id")
        sessionManager = SessionManager(requireContext())
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentDeviceTilesBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        // Match the new screen design: chat and study cards are shown by default.
        binding.chatPanel.visibility = View.VISIBLE
        binding.chatPanel.alpha = 1f
        binding.chatPanel.translationY = 0f
        binding.studyPanel.visibility = View.VISIBLE
        binding.studyPanel.alpha = 1f
        binding.studyPanel.translationY = 0f

        binding.btnLeaveSession.setOnClickListener {
            (activity as? MainActivity)?.leaveSession()
        }

        binding.btnInviteOthers.setOnClickListener {
            showInvitationDialog()
        }
        binding.btnChatFab.setOnClickListener {
            isChatOpen = !isChatOpen
            toggleChatPanel(isChatOpen)
            if (isChatOpen) {
                markIncomingAsSeen()
            }
            updateChatBadge()
        }
        binding.btnSendChat.setOnClickListener {
            sendChatMessage()
        }
        binding.btnStudyFab.setOnClickListener {
            isStudyOpen = !isStudyOpen
            toggleStudyPanel(isStudyOpen)
        }
        binding.btnStudyPrev.setOnClickListener {
            studyPage = maxOf(1, studyPage - 1)
            updateStudyStatus()
            (activity as? MainActivity)?.webSocketManager?.sendStudySync("page", studyPage)
        }
        binding.btnStudyNext.setOnClickListener {
            studyPage += 1
            updateStudyStatus()
            (activity as? MainActivity)?.webSocketManager?.sendStudySync("page", studyPage)
        }
        binding.etChatInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                sendTypingState(s?.toString().orEmpty().isNotBlank())
            }
        })

        // Setup RecyclerView
        binding.rvDevices.layoutManager = LinearLayoutManager(requireContext())
        deviceAdapter = DeviceTileAdapter(
            devices = mutableListOf(),
            onDeviceClick = { device -> handleDeviceTileClick(device) },
            onBrowseFilesClick = { device -> handleBrowseFilesClick(device) },
            onCallDevice = { device ->
                (activity as? MainActivity)?.startOutgoingCall(device.name, device.id, false)
            },
            onVideoCallDevice = { device ->
                (activity as? MainActivity)?.startOutgoingCall(device.name, device.id, true)
            },
            transferStatuses = transferStatuses
        )
        binding.rvDevices.adapter = deviceAdapter

        // Show session info
        val code = sessionManager?.getCurrentSessionCode() ?: sessionId
        updateStatus(code)

        // Listen for device connections
        val mainActivity = activity as? MainActivity
        val currentDeviceId = sessionManager?.getDeviceId()
        
        if (mainActivity != null && currentDeviceId != null) {
            viewLifecycleOwner.lifecycleScope.launch {
                mainActivity.webSocketManager.sessionDevices.collect { deviceInfos ->
                    connectedDevices.clear()
                    deviceInfos.forEach { info ->
                        if (info.id != currentDeviceId) {
                            connectedDevices[info.id] = Device(
                                id = info.id,
                                name = info.name,
                                type = info.type,
                                online = true,
                                permissions = mapOf(
                                    "files" to false,
                                    "media" to false,
                                    "prompts" to false,
                                    "clipboard" to false,
                                    "remote_browse" to false
                                ),
                                joinedAt = System.currentTimeMillis(),
                                lastSeen = System.currentTimeMillis()
                            )
                        }
                    }
                    updateDeviceList()
                    updateStatus(code)
                    android.util.Log.d("FlowLink", "Updated tile list: ${connectedDevices.keys}")
                }
            }

            viewLifecycleOwner.lifecycleScope.launch {
                mainActivity.webSocketManager.fileTransferProgress.collect { progress ->
                    if (progress == null) {
                        transferStatuses.clear()
                        updateDeviceList()
                        return@collect
                    }

                    val targetId = resolveTransferTileDeviceId(progress.deviceId) ?: return@collect
                    transferStatuses[targetId] = TransferStatus(
                        fileName = progress.fileName,
                        direction = progress.direction,
                        progress = progress.progress,
                        totalBytes = progress.totalBytes,
                        transferredBytes = progress.transferredBytes,
                        speedBytesPerSec = progress.speedBytesPerSec,
                        etaSeconds = progress.etaSeconds,
                        startedAt = progress.startedAt,
                        completed = progress.progress >= 100
                    )
                    updateDeviceList()
                    // CRITICAL FIX #7: Increased delay from 1200ms to 3000ms so user can see completion
                    if (progress.progress >= 100 || progress.transferredBytes >= progress.totalBytes) {
                        val clearRunnable = Runnable {
                            transferStatuses.remove(targetId)
                            updateDeviceList()
                            transferClearRunnables.remove(targetId)
                        }
                        transferClearRunnables[targetId]?.let { binding.root.removeCallbacks(it) }
                        transferClearRunnables[targetId] = clearRunnable
                        binding.root.postDelayed(clearRunnable, 3000)
                    }
                }
            }
            viewLifecycleOwner.lifecycleScope.launch {
                mainActivity.webSocketManager.chatEvents.collect { event ->
                    when (event) {
                        is WebSocketManager.ChatEvent.Message -> {
                            chatMessages.add(
                                ChatMessage(
                                    messageId = event.messageId,
                                    text = event.text,
                                    username = event.username,
                                    sourceDevice = event.sourceDevice,
                                    targetDevice = event.targetDevice,
                                    sentAt = event.sentAt,
                                    delivered = true,
                                    seen = isChatOpen
                                )
                            )
                            renderChat()
                            if (isChatOpen) {
                                mainActivity.webSocketManager.sendChatReceipt("chat_seen", event.messageId, event.sourceDevice)
                            } else {
                                mainActivity.webSocketManager.sendChatReceipt("chat_delivered", event.messageId, event.sourceDevice)
                            }
                            updateChatBadge()
                        }
                        is WebSocketManager.ChatEvent.Delivered -> {
                            val index = chatMessages.indexOfFirst { it.messageId == event.messageId }
                            if (index >= 0) {
                                chatMessages[index] = chatMessages[index].copy(delivered = true)
                                renderChat()
                            }
                        }
                        is WebSocketManager.ChatEvent.Seen -> {
                            val index = chatMessages.indexOfFirst { it.messageId == event.messageId }
                            if (index >= 0) {
                                chatMessages[index] = chatMessages[index].copy(delivered = true, seen = true)
                                renderChat()
                            }
                        }
                        is WebSocketManager.ChatEvent.Typing -> {
                            if (event.sourceDevice.isNotBlank()) {
                                typingByDevice[event.sourceDevice] = event.isTyping
                                renderTypingIndicator()
                            }
                        }
                    }
                }
            }
            viewLifecycleOwner.lifecycleScope.launch {
                mainActivity.webSocketManager.studyStore.collect { files ->
                    binding.tvStudyStore.text = if (files.isEmpty()) {
                        "No docs in store yet."
                    } else {
                        files.joinToString("\n\n") { file ->
                            "• ${file.name} (${maxOf(1, file.size / 1024)} KB)"
                        }
                    }
                }
            }
            viewLifecycleOwner.lifecycleScope.launch {
                mainActivity.webSocketManager.studySyncEvents.collect { event ->
                    if (event.mode == "page") {
                        val page = when (val value = event.value) {
                            is Number -> value.toInt()
                            is String -> value.toIntOrNull() ?: studyPage
                            else -> studyPage
                        }
                        studyPage = maxOf(1, page)
                        updateStudyStatus()
                    }
                }
            }
            
            // Ensure WebSocket is connected to receive device updates
            val connectionState = mainActivity.webSocketManager.connectionState.value
            val sessionCode = sessionManager?.getCurrentSessionCode()
            if (sessionCode != null) {
                if (connectionState !is WebSocketManager.ConnectionState.Connected) {
                    // Reconnect to get session state and device list
                    android.util.Log.d("FlowLink", "Reconnecting WebSocket to get device list")
                    mainActivity.webSocketManager.connect(sessionCode)
                } else {
                    android.util.Log.d("FlowLink", "WebSocket already connected, waiting for devices")
                }
                mainActivity.webSocketManager.requestStudyStore()
            }
        }
    }

    private fun updateStudyStatus() {
        binding.tvStudyStatus.text = "Study Room - Page $studyPage"
    }

    private fun updateStatus(code: String?) {
        val statusText = if (connectedDevices.isEmpty()) {
            "Session Code: $code | Waiting for other devices"
        } else {
            "Session Code: $code | ${connectedDevices.size} device(s) connected"
        }
        binding.tvStatus.text = statusText
    }

    private fun resolveTransferTileDeviceId(progressDeviceId: String?): String? {
        if (progressDeviceId.isNullOrBlank()) return null
        if (connectedDevices.containsKey(progressDeviceId)) return progressDeviceId

        // Incoming transfer progress should be shown on the sender's tile. If
        // older/bridged messages carry the local receiver id instead, keep the
        // progress visible by attaching it to the only connected peer.
        if (connectedDevices.size == 1) return connectedDevices.keys.first()

        return null
    }

    private fun updateDeviceList() {
        if (deviceAdapter == null) {
            deviceAdapter = DeviceTileAdapter(
                devices = connectedDevices.values.toMutableList(),
                onDeviceClick = { device -> handleDeviceTileClick(device) },
                onBrowseFilesClick = { device -> handleBrowseFilesClick(device) },
                onCallDevice = { device ->
                    (activity as? MainActivity)?.startOutgoingCall(device.name, device.id, false)
                },
                onVideoCallDevice = { device ->
                    (activity as? MainActivity)?.startOutgoingCall(device.name, device.id, true)
                },
                transferStatuses = transferStatuses
            )
            binding.rvDevices.adapter = deviceAdapter
        } else {
            deviceAdapter?.updateData(connectedDevices.values.toList(), transferStatuses)
        }
    }

    /**
     * When the user taps a device tile on the phone:
     * - If clipboard has a recent URL, send it as a link/media intent and auto-open on laptop.
     * - If clipboard has text, send it as clipboard_sync.
     * - If clipboard is empty, show a message to use the browse button instead.
     */
    private fun handleDeviceTileClick(device: Device) {
        val ctx = requireContext()
        val mainActivity = activity as? MainActivity

        if (mainActivity == null || sessionManager == null) {
            Toast.makeText(ctx, "Not ready to send yet. Try again.", Toast.LENGTH_SHORT).show()
            return
        }

        try {
            val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip: ClipData? = clipboard.primaryClip
            val text = if (clip != null && clip.itemCount > 0) {
                clip.getItemAt(0).coerceToText(ctx).toString()
            } else {
                ""
            }.trim()

            if (text.isNotEmpty()) {
                // Decide intent type based on clipboard content
                val normalized = normalizeUrl(text) ?: text

                val flowIntent: FlowIntent = when {
                    isMediaUrl(normalized) -> {
                        // Media URL (YouTube / Spotify / direct media) -> media_continuation
                        val mediaJson = JSONObject().apply {
                            put("url", normalized)
                            put("type", if (isVideoUrl(normalized)) "video" else "audio")
                            // We don't have precise playback time from Android apps,
                            // so start from the beginning on the laptop.
                            put("timestamp", 0)
                            put("state", "play")
                        }

                        FlowIntent(
                            intentType = "media_continuation",
                            payload = mapOf("media" to mediaJson.toString()),
                            targetDevice = device.id,
                            sourceDevice = sessionManager?.getDeviceId() ?: "",
                            autoOpen = true,
                            timestamp = System.currentTimeMillis()
                        )
                    }
                    isHttpUrl(normalized) -> {
                        // Regular web URL -> link_open
                        val linkJson = JSONObject().apply {
                            put("url", normalized)
                        }

                        FlowIntent(
                            intentType = "link_open",
                            payload = mapOf("link" to linkJson.toString()),
                            targetDevice = device.id,
                            sourceDevice = sessionManager?.getDeviceId() ?: "",
                            autoOpen = true,
                            timestamp = System.currentTimeMillis()
                        )
                    }
                    else -> {
                        // Plain text -> clipboard_sync
                        val clipboardJson = JSONObject().apply {
                            put("text", text)
                        }

                        FlowIntent(
                            intentType = "clipboard_sync",
                            payload = mapOf("clipboard" to clipboardJson.toString()),
                            targetDevice = device.id,
                            sourceDevice = sessionManager?.getDeviceId() ?: "",
                            autoOpen = true,
                            timestamp = System.currentTimeMillis()
                        )
                    }
                }

                mainActivity.webSocketManager.sendIntent(flowIntent, device.id)

                val preview = if (text.length > 50) text.substring(0, 50) + "..." else text
                Toast.makeText(
                    ctx,
                    "Sent from clipboard to ${device.name}: $preview",
                    Toast.LENGTH_SHORT
                ).show()
            } else {
                // No clipboard content: suggest using the browse button
                Toast.makeText(
                    ctx,
                    "Clipboard is empty. Use the 📁 Browse Files button to send files to ${device.name}",
                    Toast.LENGTH_LONG
                ).show()
            }
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to handle device tile click", e)
            Toast.makeText(ctx, "Failed to send: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    /**
     * When the user clicks the "Browse Files" button:
     * - Open file picker to choose any file/media to send to the device.
     */
    private fun handleBrowseFilesClick(device: Device) {
        val ctx = requireContext()
        
        if (sessionManager == null) {
            Toast.makeText(ctx, "Not ready to send yet. Try again.", Toast.LENGTH_SHORT).show()
            return
        }

        // Set the target device for the file picker result
        pendingFileTargetDeviceId = device.id
        
        Toast.makeText(
            ctx,
            "Choose a file or media to send to ${device.name}",
            Toast.LENGTH_SHORT
        ).show()
        
        // Open file picker - allow any type; laptop side will detect and open appropriately
        pickFileLauncher.launch(arrayOf("*/*"))
    }

    private fun startTransferStatus(deviceId: String, fileName: String, direction: String, totalBytes: Long) {
        val speedBytesPerSec = maxOf(256 * 1024L, 4 * 1024 * 1024L - minOf(3 * 1024 * 1024L, totalBytes / 8))
        val etaSeconds = maxOf(1, kotlin.math.ceil(totalBytes.toDouble() / speedBytesPerSec.toDouble()).toInt())
        transferStatuses[deviceId] = TransferStatus(
            fileName = fileName,
            direction = direction,
            progress = 0,
            totalBytes = totalBytes,
            transferredBytes = 0,
            speedBytesPerSec = speedBytesPerSec,
            etaSeconds = etaSeconds,
            startedAt = System.currentTimeMillis()
        )
        updateDeviceList()
    }

    private fun completeTransferStatus(deviceId: String) {
        val current = transferStatuses[deviceId] ?: return
        transferStatuses[deviceId] = current.copy(
            progress = 100,
            transferredBytes = current.totalBytes,
            etaSeconds = 0,
            completed = true
        )
        updateDeviceList()

        binding.root.postDelayed({
            transferStatuses.remove(deviceId)
            updateDeviceList()
        }, 1800)
    }

    private fun isHttpUrl(text: String): Boolean {
        return try {
            val uri = Uri.parse(text)
            val scheme = uri.scheme?.lowercase()
            scheme == "http" || scheme == "https"
        } catch (e: Exception) {
            false
        }
    }

    private fun isMediaUrl(text: String): Boolean {
        val lower = text.lowercase()
        val mediaExtensionRegex =
            Regex(""".*\.(mp4|mp3|webm|ogg|avi|mov|m4a|flac|wav|mkv)(\?.*)?$""", RegexOption.IGNORE_CASE)
        return lower.contains("youtube.com") ||
                lower.contains("youtu.be") ||
                lower.contains("spotify.com") ||
                mediaExtensionRegex.matches(lower)
    }

    private fun isVideoUrl(text: String): Boolean {
        val lower = text.lowercase()
        val videoRegex =
            Regex(""".*\.(mp4|webm|avi|mov|mkv)(\?.*)?$""", RegexOption.IGNORE_CASE)
        return lower.contains("youtube.com") ||
                lower.contains("youtu.be") ||
                videoRegex.matches(lower)
    }

    /**
     * Normalize common URL forms like "youtube.com/..." into a full https:// URL
     * so laptop-side handlers treat them correctly.
     */
    private fun normalizeUrl(text: String): String? {
        if (text.isBlank()) return null
        val trimmed = text.trim()

        // Already has a scheme
        val hasScheme = Regex("^[a-zA-Z][a-zA-Z\\d+\\-.]*://").containsMatchIn(trimmed)
        if (hasScheme) return trimmed

        // Looks like a bare domain or domain + path
        val domainLike =
            Regex("^(www\\.)?[a-z0-9.-]+\\.[a-z]{2,}([/?].*)?$", RegexOption.IGNORE_CASE)
        return if (domainLike.matches(trimmed)) {
            "https://$trimmed"
        } else {
            null
        }
    }

    private fun sendChatMessage() {
        val mainActivity = activity as? MainActivity ?: return
        val text = binding.etChatInput.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) return
        val target = connectedDevices.values.firstOrNull { it.online } ?: run {
            Toast.makeText(requireContext(), "No online device to chat with", Toast.LENGTH_SHORT).show()
            return
        }
        val messageId = "mob-chat-${System.currentTimeMillis()}"
        chatMessages.add(
            ChatMessage(
                messageId = messageId,
                text = text,
                username = sessionManager?.getUsername().orEmpty(),
                sourceDevice = sessionManager?.getDeviceId().orEmpty(),
                targetDevice = target.id,
                sentAt = System.currentTimeMillis(),
                delivered = false,
                seen = false
            )
        )
        binding.etChatInput.setText("")
        sendTypingState(false)
        renderChat()
        updateChatBadge()
        mainActivity.webSocketManager.sendChatMessage(target.id, messageId, text)
    }

    private fun sendTypingState(isTyping: Boolean) {
        val mainActivity = activity as? MainActivity ?: return
        val target = connectedDevices.values.firstOrNull { it.online } ?: return

        chatTypingStopRunnable?.let { binding.chatPanel.removeCallbacks(it) }
        mainActivity.webSocketManager.sendChatTyping(target.id, isTyping)

        if (isTyping) {
            val stopRunnable = Runnable {
                val current = binding.etChatInput.text?.toString()?.trim().orEmpty()
                if (current.isNotEmpty()) {
                    mainActivity.webSocketManager.sendChatTyping(target.id, false)
                }
            }
            chatTypingStopRunnable = stopRunnable
            binding.chatPanel.postDelayed(stopRunnable, 1400)
        }
    }

    private fun markIncomingAsSeen() {
        val selfId = sessionManager?.getDeviceId().orEmpty()
        val mainActivity = activity as? MainActivity
        for (i in chatMessages.indices) {
            val msg = chatMessages[i]
            if (msg.sourceDevice != selfId && !msg.seen) {
                mainActivity?.webSocketManager?.sendChatReceipt("chat_seen", msg.messageId, msg.sourceDevice)
                chatMessages[i] = msg.copy(delivered = true, seen = true)
            }
        }
        renderChat()
    }

    private fun updateChatBadge() {
        val selfId = sessionManager?.getDeviceId().orEmpty()
        val unread = chatMessages.count { it.sourceDevice != selfId && !it.seen }
        if (unread > 0 && !isChatOpen) {
            binding.btnChatFab.setColorFilter(Color.parseColor("#1D4ED8"))
            binding.btnChatFab.contentDescription = "Chat ($unread unread)"
        } else {
            binding.btnChatFab.setColorFilter(Color.WHITE)
            binding.btnChatFab.contentDescription = "Chat"
        }
    }

    private fun renderTypingIndicator() {
        val active = connectedDevices.values.firstOrNull { typingByDevice[it.id] == true }
        if (active == null) {
            binding.tvChatTyping.text = ""
            typingIndicatorRunnable?.let { binding.tvChatTyping.removeCallbacks(it) }
            typingIndicatorRunnable = null
            return
        }
        val dotCount = ((System.currentTimeMillis() / 350L) % 3L).toInt() + 1
        binding.tvChatTyping.text = "${active.name} is typing${".".repeat(dotCount)}"
        typingIndicatorRunnable?.let { binding.tvChatTyping.removeCallbacks(it) }
        val loop = Runnable { renderTypingIndicator() }
        typingIndicatorRunnable = loop
        binding.tvChatTyping.postDelayed(loop, 350)
    }

    private fun toggleChatPanel(open: Boolean) {
        if (open) {
            binding.chatPanel.visibility = View.VISIBLE
            binding.chatPanel.translationY = 18f
            binding.chatPanel.alpha = 0f
            binding.chatPanel.animate()
                .translationY(0f)
                .alpha(1f)
                .setDuration(220)
                .start()
        } else {
            binding.chatPanel.animate()
                .translationY(18f)
                .alpha(0f)
                .setDuration(180)
                .withEndAction {
                    binding.chatPanel.visibility = View.GONE
                }
                .start()
        }
    }

    private fun toggleStudyPanel(open: Boolean) {
        if (open) {
            binding.studyPanel.visibility = View.VISIBLE
            binding.studyPanel.translationY = 18f
            binding.studyPanel.alpha = 0f
            binding.studyPanel.animate()
                .translationY(0f)
                .alpha(1f)
                .setDuration(220)
                .start()
        } else {
            binding.studyPanel.animate()
                .translationY(18f)
                .alpha(0f)
                .setDuration(180)
                .withEndAction { binding.studyPanel.visibility = View.GONE }
                .start()
        }
    }

    private fun renderChat() {
        val selfId = sessionManager?.getDeviceId().orEmpty()
        val formatter = SimpleDateFormat("HH:mm", Locale.getDefault())
        binding.tvChatMessages.text = buildString {
            chatMessages.takeLast(200).forEach { msg ->
                val own = msg.sourceDevice == selfId
                val sender = if (own) "You" else msg.username
                val ticks = if (!own) "" else if (msg.seen) " ✓✓ seen" else if (msg.delivered) " ✓✓" else " ✓"
                append("[${formatter.format(Date(msg.sentAt))}] $sender$ticks\n")
                append("${msg.text}\n\n")
            }
        }
        binding.chatScroll.post { binding.chatScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun showInvitationDialog() {
        val dialog = InvitationDialogFragment.newInstance()
        dialog.show(parentFragmentManager, InvitationDialogFragment.TAG)
    }

    override fun onDestroyView() {
        super.onDestroyView()
        chatTypingStopRunnable?.let { binding.chatPanel.removeCallbacks(it) }
        chatTypingStopRunnable = null
        typingIndicatorRunnable?.let { binding.tvChatTyping.removeCallbacks(it) }
        typingIndicatorRunnable = null
        transferClearRunnables.values.forEach { binding.root.removeCallbacks(it) }
        transferClearRunnables.clear()
        _binding = null
        sessionManager = null
        deviceAdapter = null
    }
}
