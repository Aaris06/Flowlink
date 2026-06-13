package com.flowlink.app.model

/**
 * Data models for FlowLink Android app
 */

data class Session(
    val sessionId: String,
    val code: String,
    val createdBy: String,
    val createdAt: Long,
    val expiresAt: Long
)

data class Device(
    val id: String,
    val name: String,
    val type: String,
    val online: Boolean,
    val permissions: Map<String, Boolean> = emptyMap(),
    val joinedAt: Long = System.currentTimeMillis(),
    val lastSeen: Long = System.currentTimeMillis()
)

data class Intent(
    val intentType: String,
    val payload: Map<String, String>?,
    val targetDevice: String,
    val sourceDevice: String,
    val autoOpen: Boolean,
    val timestamp: Long
)

data class TransferStatus(
    val fileName: String,
    val direction: String,
    val progress: Int,
    val totalBytes: Long,
    val transferredBytes: Long,
    val speedBytesPerSec: Long,
    val etaSeconds: Int,
    val startedAt: Long,
    val completed: Boolean = false
)

data class ChatMessage(
    val messageId: String,
    val text: String,
    val username: String,
    val sourceDevice: String,
    val targetDevice: String,
    val sentAt: Long,
    val delivered: Boolean = false,
    val seen: Boolean = false,
    // file attachment (null = text message)
    val fileId: String? = null,
    val fileName: String? = null,
    val fileType: String? = null,
    val fileSize: Long = 0L,
    val fileData: String? = null,   // base64 for small files
    // reply/tag
    val replyToId: String? = null,
    val replyToText: String? = null,
    val replyToUsername: String? = null,
    val callActivityJson: String? = null
)

data class DeviceGroup(
    val id: String,
    val name: String,
    val deviceIds: List<String>,
    val color: String,
    val createdBy: String
)

data class Friend(
    val username: String,
    val deviceName: String,
    val deviceId: String,
    val addedAt: Long = System.currentTimeMillis(),
    val status: String = "accepted"  // "pending_sent" | "pending_received" | "accepted"
)

data class FriendRequest(
    val fromUsername: String,
    val fromDeviceId: String,
    val fromDeviceName: String,
    val toUsername: String,
    val timestamp: Long = System.currentTimeMillis()
)

data class AppSettings(
    val darkTheme: Boolean = true,
    val readReceiptsEnabled: Boolean = true,
    val showActiveStatus: Boolean = true,
    val chatBgImageUri: String? = null,
    val notificationsEnabled: Boolean = true
)

