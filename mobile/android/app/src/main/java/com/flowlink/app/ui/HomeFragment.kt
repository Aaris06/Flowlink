package com.flowlink.app.ui

import android.animation.ObjectAnimator
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.databinding.FragmentHomeBinding
import com.flowlink.app.model.Device
import com.flowlink.app.model.TransferStatus
import com.flowlink.app.service.SessionManager
import com.flowlink.app.service.WebSocketManager
import kotlinx.coroutines.launch

class HomeFragment : Fragment() {
    private var _binding: FragmentHomeBinding? = null
    private val binding get() = _binding!!
    private var sessionManager: SessionManager? = null
    private val connectedDevices = mutableMapOf<String, Device>()
    private val transferStatuses = mutableMapOf<String, TransferStatus>()
    private var deviceAdapter: DeviceTileAdapter? = null
    private var storeAdapter: HomeStoreAdapter? = null
    private var studyPage = 1
    private var isDrawerOpen = false
    private val transferClearRunnables = mutableMapOf<String, Runnable>()

    companion object {
        fun newInstance() = HomeFragment()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sessionManager = SessionManager(requireContext())
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentHomeBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        val mainActivity = activity as? MainActivity ?: return

        // Session code
        val code = sessionManager?.getCurrentSessionCode()
        binding.tvSessionCode.text = code ?: "------"

        // Reconnect button
        binding.btnReconnect.setOnClickListener {
            val sessionCode = sessionManager?.getCurrentSessionCode() ?: return@setOnClickListener
            binding.tvStatusBadge.text = "⏳ Reconnecting…"
            binding.tvStatusBadge.setTextColor(android.graphics.Color.parseColor("#F59E0B"))
            binding.btnReconnect.visibility = View.GONE
            mainActivity.webSocketManager.connect(sessionCode)
        }

        // Observe connection state to show/hide reconnect button
        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.connectionState.collect { state ->
                when (state) {
                    is com.flowlink.app.service.WebSocketManager.ConnectionState.Connected -> {
                        binding.tvStatusBadge.text = "● Connected"
                        binding.tvStatusBadge.setTextColor(android.graphics.Color.parseColor("#22C55E"))
                        binding.btnReconnect.visibility = View.GONE
                    }
                    is com.flowlink.app.service.WebSocketManager.ConnectionState.Disconnected,
                    is com.flowlink.app.service.WebSocketManager.ConnectionState.Error -> {
                        binding.tvStatusBadge.text = "● Disconnected"
                        binding.tvStatusBadge.setTextColor(android.graphics.Color.parseColor("#EF4444"))
                        binding.btnReconnect.visibility = View.VISIBLE
                    }
                    is com.flowlink.app.service.WebSocketManager.ConnectionState.Connecting -> {
                        binding.tvStatusBadge.text = "⏳ Connecting…"
                        binding.tvStatusBadge.setTextColor(android.graphics.Color.parseColor("#F59E0B"))
                        binding.btnReconnect.visibility = View.GONE
                    }
                }
            }
        }

        // Hamburger drawer
        binding.btnHamburger.setOnClickListener { toggleDrawer() }
        binding.drawerOverlay.setOnClickListener { closeDrawer() }
        binding.drawerLeaveSession.setOnClickListener {
            closeDrawer()
            (activity as? MainActivity)?.leaveSession()
        }
        binding.drawerSessionDetails.setOnClickListener {
            closeDrawer()
            openSubScreen { SessionDetailsFragment.newInstance() }
        }
        binding.drawerPermissions.setOnClickListener {
            closeDrawer()
            openSubScreen { PermissionsFragment.newInstance() }
        }
        binding.drawerSettings.setOnClickListener {
            closeDrawer()
            openSubScreen { SettingsFragment.newInstance() }
        }
        binding.drawerHelp.setOnClickListener {
            closeDrawer()
            openSubScreen { HelpFragment.newInstance() }
        }

        // Avatar initial
        val username = sessionManager?.getUsername() ?: "U"
        binding.tvAvatarInitial.text = username.firstOrNull()?.uppercaseChar()?.toString() ?: "U"
        binding.tvDrawerUsername.text = username

        // Invite others
        binding.btnInviteOthers.setOnClickListener {
            showInvitationDialog()
        }

        // Setup devices RecyclerView
        binding.rvDevices.layoutManager = LinearLayoutManager(requireContext())
        deviceAdapter = DeviceTileAdapter(
            devices = mutableListOf(),
            onDeviceClick = { device -> (activity as? MainActivity)?.let { handleDeviceTileClick(device, it) } },
            onBrowseFilesClick = { device -> (parentFragment as? ShareFragment)?.triggerFilePicker(device.id)
                ?: (activity as? MainActivity)?.let { /* fallback */ } },
            onCallDevice = { device ->
                (activity as? MainActivity)?.startOutgoingCall(
                    device.name.ifEmpty { "Unknown" }, device.id, false
                )
            },
            onVideoCallDevice = { device ->
                (activity as? MainActivity)?.startOutgoingCall(
                    device.name.ifEmpty { "Unknown" }, device.id, true
                )
            },
            transferStatuses = transferStatuses
        )
        binding.rvDevices.adapter = deviceAdapter

        // Setup store RecyclerView
        binding.rvStoreFiles.layoutManager = LinearLayoutManager(requireContext())
        storeAdapter = HomeStoreAdapter(
            files = mutableListOf(),
            onDownload = { file ->
                if (file.data.isEmpty()) { Toast.makeText(requireContext(), "No data", Toast.LENGTH_SHORT).show(); return@HomeStoreAdapter }
                try {
                    val bytes = android.util.Base64.decode(file.data, android.util.Base64.DEFAULT)
                    val dir = java.io.File(android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS), "FlowLink")
                    dir.mkdirs()
                    val outFile = java.io.File(dir, file.name)
                    outFile.writeBytes(bytes)
                    Toast.makeText(requireContext(), "Saved: ${file.name}", Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Toast.makeText(requireContext(), "Failed: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        )
        binding.rvStoreFiles.adapter = storeAdapter

        // Observe devices
        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.sessionDevices.collect { deviceInfos ->
                val selfId = sessionManager?.getDeviceId()
                connectedDevices.clear()
                deviceInfos.filter { it.id != selfId }.forEach { info ->
                    connectedDevices[info.id] = Device(
                        id = info.id, name = info.name, type = info.type, online = true,
                        permissions = emptyMap(), joinedAt = System.currentTimeMillis(),
                        lastSeen = System.currentTimeMillis()
                    )
                }
                updateDeviceList()
                updateStats()
            }
        }

        // Observe file transfer progress
        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.fileTransferProgress.collect { progress ->
                android.util.Log.d("FlowLink_Progress", "Progress event: deviceId=${progress?.deviceId}, progress=${progress?.progress}, direction=${progress?.direction}, fileName=${progress?.fileName}")
                android.util.Log.d("FlowLink_Progress", "Connected devices: ${connectedDevices.keys}")
                val targetId = progress?.deviceId ?: run {
                    // null means clear all
                    transferStatuses.clear()
                    updateDeviceList()
                    return@collect
                }
                transferStatuses[targetId] = TransferStatus(
                    fileName = progress.fileName, direction = progress.direction,
                    progress = progress.progress, totalBytes = progress.totalBytes,
                    transferredBytes = progress.transferredBytes, speedBytesPerSec = progress.speedBytesPerSec,
                    etaSeconds = progress.etaSeconds, startedAt = progress.startedAt,
                    completed = progress.progress >= 100
                )
                // Also try matching by any connected device if exact ID not found
                if (!connectedDevices.containsKey(targetId) && connectedDevices.isNotEmpty()) {
                    val fallbackId = connectedDevices.keys.first()
                    android.util.Log.d("FlowLink_Progress", "DeviceId $targetId not in connectedDevices, using fallback $fallbackId")
                    transferStatuses[fallbackId] = transferStatuses[targetId]!!
                    transferStatuses.remove(targetId)
                }
                updateDeviceList()
                if (progress.progress >= 100) {
                    val r = Runnable { transferStatuses.remove(targetId); updateDeviceList(); transferClearRunnables.remove(targetId) }
                    transferClearRunnables[targetId]?.let { binding.root.removeCallbacks(it) }
                    transferClearRunnables[targetId] = r
                    binding.root.postDelayed(r, 3000)
                }
            }
        }

        // Observe study store — show in home as "Store"
        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.studyStore.collect { files ->
                if (files.isEmpty()) {
                    binding.tvStudyStore.visibility = View.VISIBLE
                    binding.rvStoreFiles.visibility = View.GONE
                    binding.tvStoreCount.text = "0 files"
                } else {
                    binding.tvStudyStore.visibility = View.GONE
                    binding.rvStoreFiles.visibility = View.VISIBLE
                    binding.tvStoreCount.text = "${files.size} file(s)"
                    storeAdapter?.setFiles(files)
                }
                updateStats()
            }
        }

        // Observe study sync (page changes from Files tab)
        viewLifecycleOwner.lifecycleScope.launch {
            mainActivity.webSocketManager.studySyncEvents.collect { _ -> /* handled in FilesFragment */ }
        }

        mainActivity.webSocketManager.requestStudyStore()
        updateStats()
    }

    private fun updateDeviceList() {
        deviceAdapter?.updateData(connectedDevices.values.toList(), transferStatuses)
    }

    private fun updateStats() {
        binding.tvStatActive.text = connectedDevices.size.toString()
        binding.tvStatOnline.text = connectedDevices.values.count { it.online }.toString()
    }

    fun updateMessageCount(count: Int) {
        binding.tvStatMessages.text = count.toString()
    }

    fun updateFileCount(count: Int) {
        binding.tvStatFiles.text = count.toString()
    }

    private fun updateStudyStatus() {
        // Study status is now managed in FilesFragment
    }

    private fun toggleDrawer() {
        if (isDrawerOpen) closeDrawer() else openDrawer()
    }

    private fun openDrawer() {
        isDrawerOpen = true
        binding.drawerOverlay.visibility = View.VISIBLE
        binding.drawerOverlay.alpha = 0f
        binding.drawerOverlay.animate().alpha(1f).setDuration(200).start()
        binding.sideDrawer.animate().translationX(0f).setDuration(280).start()
    }

    private fun closeDrawer() {
        isDrawerOpen = false
        binding.drawerOverlay.animate().alpha(0f).setDuration(180)
            .withEndAction { _binding?.drawerOverlay?.visibility = View.GONE }.start()
        binding.sideDrawer.animate().translationX(-binding.sideDrawer.width.toFloat()).setDuration(250).start()
    }

    private fun showInvitationDialog() {
        val dialog = InvitationDialogFragment.newInstance()
        dialog.show(parentFragmentManager, InvitationDialogFragment.TAG)
    }

    private fun openSubScreen(factory: () -> androidx.fragment.app.Fragment) {
        val act = activity ?: return
        // Post to avoid IllegalStateException when called during drawer animation
        act.window.decorView.post {
            try {
                act.supportFragmentManager.beginTransaction()
                    .replace(com.flowlink.app.R.id.fragment_container, factory())
                    .addToBackStack(null)
                    .commitAllowingStateLoss()
            } catch (e: Exception) {
                android.util.Log.e("FlowLink", "openSubScreen failed: ${e.message}")
            }
        }
    }

    private fun navigateToFragment(fragment: androidx.fragment.app.Fragment) {
        openSubScreen { fragment }
    }

    private fun handleDeviceTileClick(device: Device, mainActivity: MainActivity) {
        val ctx = requireContext()
        try {
            val clipboard = ctx.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
            val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(ctx)?.toString()?.trim() ?: ""
            if (text.isNotEmpty()) {
                val normalized = normalizeUrl(text) ?: text
                val intentType = when {
                    isHttpUrl(normalized) -> "link_open"
                    else -> "clipboard_sync"
                }
                val payload = when (intentType) {
                    "link_open" -> mapOf("link" to org.json.JSONObject().apply { put("url", normalized) }.toString())
                    else -> mapOf("clipboard" to org.json.JSONObject().apply { put("text", text) }.toString())
                }
                val intent = com.flowlink.app.model.Intent(
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
                Toast.makeText(ctx, "Clipboard empty. Use Select Files to send files.", Toast.LENGTH_SHORT).show()
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
        // Cancel any running animations to prevent callbacks firing after binding is null
        _binding?.drawerOverlay?.animate()?.cancel()
        _binding?.sideDrawer?.animate()?.cancel()
        _binding = null
    }
}

// Compact store adapter for Home page
class HomeStoreAdapter(
    private val files: MutableList<WebSocketManager.StudyFile>,
    private val onDownload: (WebSocketManager.StudyFile) -> Unit
) : androidx.recyclerview.widget.RecyclerView.Adapter<HomeStoreAdapter.VH>() {

    class VH(v: View) : androidx.recyclerview.widget.RecyclerView.ViewHolder(v) {
        val tvIcon: android.widget.TextView = v.findViewById(R.id.tv_file_icon)
        val tvName: android.widget.TextView = v.findViewById(R.id.tv_file_name)
        val tvMeta: android.widget.TextView = v.findViewById(R.id.tv_file_meta)
        val btnDownload: android.widget.ImageButton = v.findViewById(R.id.btn_download_file)
        val btnOpen: android.widget.ImageButton = v.findViewById(R.id.btn_open_file)
        val btnDelete: android.widget.ImageButton = v.findViewById(R.id.btn_delete_file)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        VH(LayoutInflater.from(parent.context).inflate(R.layout.item_study_file, parent, false))

    override fun onBindViewHolder(holder: VH, position: Int) {
        val file = files[position]
        holder.tvName.text = file.name
        val ext = file.name.substringAfterLast('.', "").uppercase()
        holder.tvMeta.text = if (ext.isNotEmpty()) "$ext · ${maxOf(1, file.size / 1024)} KB" else "${maxOf(1, file.size / 1024)} KB"
        holder.tvIcon.text = when {
            file.name.endsWith(".pdf", true) -> "📄"
            file.name.endsWith(".jpg", true) || file.name.endsWith(".png", true) -> "🖼️"
            file.name.endsWith(".mp4", true) -> "🎬"
            file.name.endsWith(".mp3", true) -> "🎵"
            else -> "📁"
        }
        holder.btnDownload.setOnClickListener { onDownload(file) }
        holder.btnOpen.visibility = View.GONE
        holder.btnDelete.visibility = View.GONE
    }

    override fun getItemCount() = files.size

    fun setFiles(newFiles: List<WebSocketManager.StudyFile>) {
        files.clear(); files.addAll(newFiles); notifyDataSetChanged()
    }
}
