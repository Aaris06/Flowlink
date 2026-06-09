package com.flowlink.app.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageButton
import android.widget.ProgressBar
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.flowlink.app.R
import com.flowlink.app.model.Device
import com.flowlink.app.model.TransferStatus

class DeviceTileAdapter(
    private val devices: MutableList<Device>,
    private val onDeviceClick: (Device) -> Unit,
    private val onBrowseFilesClick: (Device) -> Unit,
    private val onAddFriend: ((Device) -> Unit)? = null,
    private val onCallDevice: ((Device) -> Unit)? = null,
    private val transferStatuses: MutableMap<String, TransferStatus> = mutableMapOf()
) : RecyclerView.Adapter<DeviceTileAdapter.DeviceViewHolder>() {

    class DeviceViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        val deviceName: TextView = itemView.findViewById(R.id.device_name)
        val deviceType: TextView = itemView.findViewById(R.id.device_type)
        val deviceStatus: TextView = itemView.findViewById(R.id.device_status)
        val devicePermissions: TextView = itemView.findViewById(R.id.device_permissions)
        val onlineDot: View = itemView.findViewById(R.id.online_dot)
        val transferStatusContainer: View = itemView.findViewById(R.id.transfer_status_container)
        val transferStatusText: TextView = itemView.findViewById(R.id.tv_transfer_status)
        val transferStatusPercent: TextView = itemView.findViewById(R.id.tv_transfer_percent)
        val transferProgressBar: ProgressBar = itemView.findViewById(R.id.transfer_progress_bar)
        val transferMeta: TextView = itemView.findViewById(R.id.tv_transfer_meta)
        val btnBrowseFiles: Button = itemView.findViewById(R.id.btn_browse_files)
        val tvTapHint: TextView = itemView.findViewById(R.id.tv_tap_hint)
        val btnAddFriend: ImageButton = itemView.findViewById(R.id.btn_add_friend)
        val btnCall: ImageButton = itemView.findViewById(R.id.btn_call)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): DeviceViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_device_tile, parent, false)
        return DeviceViewHolder(view)
    }

    override fun onBindViewHolder(holder: DeviceViewHolder, position: Int) {
        val device = devices[position]
        holder.deviceName.text = device.name
        holder.deviceType.text = device.type

        val isOnline = device.online
        holder.deviceStatus.text = if (isOnline) "Online" else "Offline"
        holder.deviceStatus.setTextColor(
            if (isOnline) android.graphics.Color.parseColor("#22C55E")
            else android.graphics.Color.parseColor("#6B7280")
        )
        holder.onlineDot.setBackgroundResource(
            if (isOnline) R.drawable.online_dot else R.drawable.badge_bg
        )
        holder.onlineDot.background?.setTint(
            if (isOnline) android.graphics.Color.parseColor("#22C55E")
            else android.graphics.Color.parseColor("#6B7280")
        )

        val permissionList = device.permissions.filter { it.value }.keys
            .map { it.replace("_", " ").replaceFirstChar { c -> c.uppercaseChar() } }
        holder.devicePermissions.text = if (permissionList.isEmpty()) "No permissions"
        else permissionList.joinToString(", ")

        holder.btnBrowseFiles.isEnabled = isOnline
        holder.btnBrowseFiles.alpha = if (isOnline) 1.0f else 0.5f
        holder.tvTapHint.text = if (isOnline) "Tap to send clipboard" else "Device offline"

        val transferStatus = transferStatuses[device.id]
        if (transferStatus != null) {
            val isSending = transferStatus.direction.lowercase().let { it == "sending" || it == "send" }
            holder.transferStatusContainer.visibility = View.VISIBLE
            holder.transferStatusText.text = if (isSending) "Sending ${transferStatus.fileName}"
            else "Receiving ${transferStatus.fileName}"
            holder.transferStatusPercent.text = "${transferStatus.progress.coerceIn(0, 100)}%"
            holder.transferProgressBar.progress = transferStatus.progress.coerceIn(0, 100)
            holder.transferMeta.text = "${formatBytes(transferStatus.transferredBytes)} / ${formatBytes(transferStatus.totalBytes)} · ${formatBytes(transferStatus.speedBytesPerSec)}/s · ETA ${formatDuration(transferStatus.etaSeconds)}"
        } else {
            holder.transferStatusContainer.visibility = View.GONE
        }

        holder.itemView.setOnClickListener { if (isOnline) onDeviceClick(device) }
        holder.btnBrowseFiles.setOnClickListener { if (isOnline) onBrowseFilesClick(device) }
        if (onAddFriend != null) {
            // Hide + if already friend or pending
            val alreadyAdded = FriendsFragment.isFriendOrPending(holder.itemView.context, device.id)
            holder.btnAddFriend.visibility = if (alreadyAdded) View.GONE else View.VISIBLE
            holder.btnAddFriend.setOnClickListener {
                onAddFriend.invoke(device)
                holder.btnAddFriend.visibility = View.GONE  // hide immediately after tap
            }
        } else {
            holder.btnAddFriend.visibility = View.GONE
        }

        // Call button — only show when device is online and callback provided
        if (onCallDevice != null && device.online) {
            holder.btnCall.visibility = View.VISIBLE
            holder.btnCall.setOnClickListener { onCallDevice.invoke(device) }
        } else {
            holder.btnCall.visibility = View.GONE
        }
    }

    override fun getItemCount(): Int = devices.size

    fun updateData(nextDevices: List<Device>, nextTransferStatuses: Map<String, TransferStatus>) {
        devices.clear()
        devices.addAll(nextDevices)
        transferStatuses.clear()
        transferStatuses.putAll(nextTransferStatuses)
        notifyDataSetChanged()
    }

    private fun formatBytes(bytes: Long): String {
        if (bytes <= 0) return "0 B"
        val units = arrayOf("B", "KB", "MB", "GB")
        var size = bytes.toDouble()
        var unitIndex = 0
        while (size >= 1024 && unitIndex < units.lastIndex) { size /= 1024; unitIndex++ }
        val formatted = if (size >= 10 || unitIndex == 0) size.toInt().toString() else String.format("%.1f", size)
        return "$formatted ${units[unitIndex]}"
    }

    private fun formatDuration(seconds: Int): String {
        val total = seconds.coerceAtLeast(0)
        return String.format("%02d:%02d", total / 60, total % 60)
    }
}
