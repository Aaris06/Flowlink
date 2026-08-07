package com.flowlink.app.ui

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.flowlink.app.MainActivity
import com.flowlink.app.databinding.FragmentShareBinding
import com.flowlink.app.model.Device
import com.flowlink.app.model.Intent as FlowIntent
import com.flowlink.app.model.TransferStatus
import com.flowlink.app.service.SessionManager
import kotlinx.coroutines.launch
import org.json.JSONObject

class ShareFragment : Fragment() {
    private var _binding: FragmentShareBinding? = null
    private val binding get() = _binding!!
    private var sessionManager: SessionManager? = null
    private val connectedDevices = mutableMapOf<String, Device>()
    private val transferStatuses = mutableMapOf<String, TransferStatus>()
    private var deviceAdapter: DeviceTileAdapter? = null
    private var pendingFileTargetDeviceId: String? = null
    private val transferClearRunnables = mutableMapOf<String, Runnable>()

    private val pickFileLauncher = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        val targetId = pendingFileTargetDeviceId
        pendingFileTargetDeviceId = null
        uri ?: return@registerForActivityResult
        targetId ?: return@registerForActivityResult
        val mainActivity = activity as? MainActivity ?: return@registerForActivityResult
        val ctx = requireContext()
        try {
            val resolver = ctx.contentResolver
            val name = resolver.query(uri, null, null, null, null)?.use { cursor ->
                val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (idx != -1 && cursor.moveToFirst()) cursor.getString(idx) else uri.lastPathSegment ?: "file"
            } ?: (uri.lastPathSegment ?: "file")
            val type = resolver.getType(uri) ?: "application/octet-stream"
            val size = resolver.query(uri, null, null, null, null)?.use { cursor ->
                val idx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE)
                if (idx != -1 && cursor.moveToFirst()) cursor.getLong(idx) else 0L
            } ?: 0L
            mainActivity.webSocketManager.sendFileUri(targetId, uri, name, type, size)
            Toast.makeText(ctx, "Sending $name", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(ctx, "Failed: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    companion object {
        fun newInstance() = ShareFragment()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionManager = SessionManager(requireContext())
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentShareBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        val mainActivity = activity as? MainActivity ?: return

        binding.rvDevices.layoutManager = LinearLayoutManager(requireContext())
        deviceAdapter = DeviceTileAdapter(
            devices = mutableListOf(),
            onDeviceClick = { device -> handleDeviceTileClick(device) },
            onBrowseFilesClick = { device -> triggerFilePicker(device.id) },
            onAddFriend = { device ->
                val mainAct = activity as? MainActivity ?: return@DeviceTileAdapter
                // Get the actual username from DeviceInfo (not device name)
                val deviceInfo = mainAct.webSocketManager.sessionDevices.value
                    .firstOrNull { it.id == device.id }
                val targetUsername = deviceInfo?.username?.ifEmpty { null } ?: deviceInfo?.name ?: device.name
                val friend = com.flowlink.app.model.Friend(
                    username = targetUsername,
                    deviceName = device.name,
                    deviceId = device.id,
                    status = "pending_sent"
                )
                FriendsFragment.savePendingSent(requireContext(), friend)
                mainAct.webSocketManager.sendFriendRequest(targetUsername)
                android.widget.Toast.makeText(requireContext(), "Friend request sent to $targetUsername", android.widget.Toast.LENGTH_SHORT).show()
            },
            transferStatuses = transferStatuses
        )
        binding.rvDevices.adapter = deviceAdapter

        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.sessionDevices.collect { deviceInfos ->
                val selfId = sessionManager?.getDeviceId()
                connectedDevices.clear()
                deviceInfos.filter { it.id != selfId }.forEach { info ->
                    connectedDevices[info.id] = Device(
                        id = info.id, name = info.name, type = info.type, online = true,
                        permissions = emptyMap(), joinedAt = System.currentTimeMillis(),
                        lastSeen = System.currentTimeMillis(), username = info.username
                    )
                }
                deviceAdapter?.updateData(connectedDevices.values.toList(), transferStatuses)
            }
        }

        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.fileTransferProgress.collect { progress ->
                val targetId = progress?.deviceId ?: run {
                    transferStatuses.clear()
                    deviceAdapter?.updateData(connectedDevices.values.toList(), transferStatuses)
                    return@collect
                }
                val resolvedId = if (connectedDevices.containsKey(targetId)) targetId
                    else connectedDevices.keys.firstOrNull() ?: targetId
                transferStatuses[resolvedId] = TransferStatus(
                    fileName = progress.fileName, direction = progress.direction,
                    progress = progress.progress, totalBytes = progress.totalBytes,
                    transferredBytes = progress.transferredBytes, speedBytesPerSec = progress.speedBytesPerSec,
                    etaSeconds = progress.etaSeconds, startedAt = progress.startedAt,
                    completed = progress.progress >= 100
                )
                deviceAdapter?.updateData(connectedDevices.values.toList(), transferStatuses)
                if (progress.progress >= 100) {
                    val r = Runnable {
                        transferStatuses.remove(resolvedId)
                        deviceAdapter?.updateData(connectedDevices.values.toList(), transferStatuses)
                        transferClearRunnables.remove(resolvedId)
                    }
                    transferClearRunnables[resolvedId]?.let { binding.root.removeCallbacks(it) }
                    transferClearRunnables[resolvedId] = r
                    binding.root.postDelayed(r, 3000)
                }
            }
        }
    }

    fun triggerFilePicker(deviceId: String) {
        pendingFileTargetDeviceId = deviceId
        pickFileLauncher.launch(arrayOf("*/*"))
    }

    private fun handleDeviceTileClick(device: Device) {
        val ctx = requireContext()
        val mainActivity = activity as? MainActivity ?: return
        try {
            val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(ctx)?.toString()?.trim() ?: ""
            if (text.isNotEmpty()) {
                val normalized = normalizeUrl(text) ?: text
                val intentType = when {
                    isHttpUrl(normalized) -> "link_open"
                    else -> "clipboard_sync"
                }
                val payload = when (intentType) {
                    "link_open" -> mapOf("link" to JSONObject().apply { put("url", normalized) }.toString())
                    else -> mapOf("clipboard" to JSONObject().apply { put("text", text) }.toString())
                }
                val intent = FlowIntent(
                    intentType = intentType,
                    payload = payload,
                    targetDevice = device.id,
                    sourceDevice = sessionManager?.getDeviceId() ?: "",
                    autoOpen = true,
                    timestamp = System.currentTimeMillis()
                )
                mainActivity.webSocketManager.sendIntent(intent, device.id)
                val preview = if (text.length > 40) text.take(40) + "…" else text
                Toast.makeText(ctx, "Sent to ${device.name}: $preview", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(ctx, "Clipboard empty. Use Select Files.", Toast.LENGTH_SHORT).show()
            }
        } catch (e: Exception) {
            Toast.makeText(ctx, "Failed: ${e.message}", Toast.LENGTH_SHORT).show()
        }
    }

    private fun isHttpUrl(text: String): Boolean {
        return try {
            val uri = android.net.Uri.parse(text)
            val scheme = uri.scheme?.lowercase()
            scheme == "http" || scheme == "https"
        } catch (e: Exception) { false }
    }

    private fun normalizeUrl(text: String): String? {
        if (text.isBlank()) return null
        val trimmed = text.trim()
        val hasScheme = Regex("^[a-zA-Z][a-zA-Z\\d+\\-.]*://").containsMatchIn(trimmed)
        if (hasScheme) return trimmed
        val domainLike = Regex("^(www\\.)?[a-z0-9.-]+\\.[a-z]{2,}([/?].*)?$", RegexOption.IGNORE_CASE)
        return if (domainLike.matches(trimmed)) "https://$trimmed" else null
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
