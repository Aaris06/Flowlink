package com.flowlink.app.service

import android.util.Log
import com.flowlink.app.MainActivity
import com.flowlink.app.model.Intent
import org.json.JSONArray
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import okhttp3.*
import okio.ByteString
import org.json.JSONObject
import android.util.Base64
import android.os.SystemClock
import java.util.concurrent.TimeUnit
import java.io.File
import java.io.FileOutputStream

/**
 * WebSocket Manager
 * 
 * Handles WebSocket connection to backend for signaling
 */
class WebSocketManager(private val mainActivity: MainActivity) {
    private val sessionManager: SessionManager = mainActivity.sessionManager
    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _connectionState = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connectionState: StateFlow<ConnectionState> = _connectionState

    private val _receivedIntents = MutableStateFlow<Intent?>(null)
    val receivedIntents: StateFlow<Intent?> = _receivedIntents

    private val _fileTransferProgress = MutableSharedFlow<FileTransferProgressEvent?>(
        replay = 1, extraBufferCapacity = 64,
        onBufferOverflow = kotlinx.coroutines.channels.BufferOverflow.DROP_OLDEST
    )
    val fileTransferProgress: SharedFlow<FileTransferProgressEvent?> = _fileTransferProgress

    private val fileTransferWriters = mutableMapOf<String, FileOutputStream>()
    private val fileTransferFiles = mutableMapOf<String, File>()
    private val fileTransferReceivedBytes = mutableMapOf<String, Long>()
    private val fileTransferMeta = mutableMapOf<String, FileTransferMeta>()
    private val transferStartedAt = mutableMapOf<String, Long>()
    private val fileTransferLastUiUpdateAt = mutableMapOf<String, Long>()
    private val fileTransferLastAckBytes = mutableMapOf<String, Long>()
    private val PROGRESS_UPDATE_INTERVAL_MS = 250L
    private val ACK_INTERVAL_BYTES = 512L * 1024L
    private val MAX_WS_QUEUE_BYTES = 4L * 1024L * 1024L

    private val _sessionCreated = MutableStateFlow<SessionCreatedEvent?>(null)
    val sessionCreated: StateFlow<SessionCreatedEvent?> = _sessionCreated

    private val _chatEvents = MutableSharedFlow<ChatEvent>(extraBufferCapacity = 64)
    val chatEvents: SharedFlow<ChatEvent> = _chatEvents
    private val _studyStore = MutableStateFlow<List<StudyFile>>(emptyList())
    val studyStore: StateFlow<List<StudyFile>> = _studyStore
    private val _studySyncEvents = MutableSharedFlow<StudySyncEvent>(extraBufferCapacity = 64)
    val studySyncEvents: SharedFlow<StudySyncEvent> = _studySyncEvents

    // Groups
    private val _groups = MutableStateFlow<List<GroupInfo>>(emptyList())
    val groups: StateFlow<List<GroupInfo>> = _groups

    // Browser sync events from other devices
    private val _browserSyncEvents = MutableSharedFlow<BrowserSyncEvent>(extraBufferCapacity = 32)
    val browserSyncEvents: SharedFlow<BrowserSyncEvent> = _browserSyncEvents

    // Friend request events
    private val _friendRequestEvents = MutableSharedFlow<FriendRequestEvent>(extraBufferCapacity = 16)
    val friendRequestEvents: SharedFlow<FriendRequestEvent> = _friendRequestEvents

    // Call signaling events
    private val _callEvents = MutableSharedFlow<CallEvent>(extraBufferCapacity = 32)
    val callEvents: SharedFlow<CallEvent> = _callEvents

    // Emits info about devices that connect to the current session
    private val _deviceConnected = MutableStateFlow<DeviceInfo?>(null)
    val deviceConnected: StateFlow<DeviceInfo?> = _deviceConnected

    // Emits the full current device list for the active session
    private val _sessionDevices = MutableStateFlow<List<DeviceInfo>>(emptyList())
    val sessionDevices: StateFlow<List<DeviceInfo>> = _sessionDevices

    // One-shot event for host QR flow navigation
    private val _deviceConnectedEvents = MutableSharedFlow<DeviceInfo>(extraBufferCapacity = 16)
    val deviceConnectedEvents: SharedFlow<DeviceInfo> = _deviceConnectedEvents

    // Emits join-session state so the UI can react to success or failure
    private val _sessionJoinState = MutableStateFlow<SessionJoinState>(SessionJoinState.Idle)
    val sessionJoinState: StateFlow<SessionJoinState> = _sessionJoinState

    // Emits when session expires so UI can navigate back
    private val _sessionExpired = MutableStateFlow<Boolean>(false)
    val sessionExpired: StateFlow<Boolean> = _sessionExpired
    private var remoteDesktopManager: RemoteDesktopManager? = null

    private fun resetDeviceConnectedEvent() {
        // StateFlow replays the latest value to new collectors (like SessionCreatedFragment).
        // If we don't clear it, the QR screen can immediately auto-navigate to DeviceTiles
        // due to a stale "device_connected" from a previous session.
        _deviceConnected.value = null
    }

    private fun updateSessionDevices(devices: List<DeviceInfo>) {
        val selfId = sessionManager.getDeviceId()
        _sessionDevices.value = devices
            .filter { it.id.isNotBlank() && it.id != selfId }
            .distinctBy { it.id }
    }

    private fun upsertSessionDevice(deviceInfo: DeviceInfo) {
        if (deviceInfo.id.isBlank() || deviceInfo.id == sessionManager.getDeviceId()) {
            return
        }

        val updated = _sessionDevices.value.toMutableList()
        val index = updated.indexOfFirst { it.id == deviceInfo.id }
        if (index >= 0) {
            updated[index] = deviceInfo
        } else {
            updated.add(deviceInfo)
        }
        _sessionDevices.value = updated.distinctBy { it.id }
    }

    private fun removeSessionDevice(deviceId: String) {
        if (deviceId.isBlank()) return
        _sessionDevices.value = _sessionDevices.value.filterNot { it.id == deviceId }
    }

    private fun buildDeviceInfo(deviceJson: JSONObject): DeviceInfo {
        return DeviceInfo(
            id = deviceJson.optString("id", ""),
            name = deviceJson.optString("name", deviceJson.optString("deviceName", "Unknown Device")),
            type = deviceJson.optString("type", deviceJson.optString("deviceType", "device")),
            username = deviceJson.optString("username", "")
        )
    }

    private fun sendSessionJoin(sessionCode: String) {
        if (sessionCode.isEmpty()) {
            return
        }

        _sessionJoinState.value = SessionJoinState.InProgress
        val joinMessage = JSONObject().apply {
            put("type", "session_join")
            put("payload", JSONObject().apply {
                put("code", sessionCode)
                put("deviceId", sessionManager.getDeviceId())
                put("deviceName", sessionManager.getDeviceName())
                put("deviceType", sessionManager.getDeviceType())
                put("username", sessionManager.getUsername())
            })
            put("timestamp", System.currentTimeMillis())
        }
        Log.d("FlowLink", "Sending session_join: $joinMessage")
        sendMessage(joinMessage.toString())
    }

    data class SessionCreatedEvent(
        val sessionId: String,
        val code: String,
        val expiresAt: Long
    )

    data class DeviceInfo(
        val id: String,
        val name: String,
        val type: String,
        val username: String = ""
    )

    private val WS_URL = BackendConfig.WS_URL

    fun connect(sessionCode: String) {
        try {
            if (_connectionState.value == ConnectionState.Connected) {
                if (sessionCode.isNotEmpty()) {
                    sendSessionJoin(sessionCode)
                }
                return
            }

            // Clear any stale device_connected event from a previous session
            resetDeviceConnectedEvent()

            // Track join flow state when we are connecting with a code
            if (sessionCode.isNotEmpty()) {
                _sessionJoinState.value = SessionJoinState.InProgress
            } else {
                _sessionJoinState.value = SessionJoinState.Idle
            }

            val request = Request.Builder()
                .url(WS_URL)
                .build()

            webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d("FlowLink", "WebSocket connected")
                Log.d("FlowLink", "  Device ID: ${sessionManager.getDeviceId()}")
                Log.d("FlowLink", "  Device Name: ${sessionManager.getDeviceName()}")
                Log.d("FlowLink", "  Session Code: $sessionCode")
                _connectionState.value = ConnectionState.Connected

                // ALWAYS register device for invitation listening first
                val registerMessage = JSONObject().apply {
                    put("type", "device_register")
                    put("payload", JSONObject().apply {
                        put("deviceId", sessionManager.getDeviceId())
                        put("deviceName", sessionManager.getDeviceName())
                        put("deviceType", sessionManager.getDeviceType())
                        put("username", sessionManager.getUsername())
                    })
                    put("timestamp", System.currentTimeMillis())
                }
                Log.d("FlowLink", "Sending device_register: $registerMessage")
                sendMessage(registerMessage.toString())

                // Then send session_join if we have a code
                if (sessionCode.isNotEmpty()) {
                    sendSessionJoin(sessionCode)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                Log.d("FlowLink", "WebSocket message: $text")
                handleMessage(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                Log.d("FlowLink", "WebSocket binary message")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d("FlowLink", "WebSocket closing")
                Log.d("FlowLink", "  Code: $code")
                Log.d("FlowLink", "  Reason: $reason")
                Log.d("FlowLink", "  Device ID: ${sessionManager.getDeviceId()}")
                _connectionState.value = ConnectionState.Disconnected
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d("FlowLink", "WebSocket closed")
                Log.d("FlowLink", "  Code: $code")
                Log.d("FlowLink", "  Reason: $reason")
                Log.d("FlowLink", "  Device ID: ${sessionManager.getDeviceId()}")
                _connectionState.value = ConnectionState.Disconnected
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("FlowLink", "WebSocket failure", t)
                Log.e("FlowLink", "  Device ID: ${sessionManager.getDeviceId()}")
                Log.e("FlowLink", "  Response: $response")
                _connectionState.value = ConnectionState.Error(t.message ?: "Unknown error")
                // Treat connection failure during a join attempt as a join error
                if (_sessionJoinState.value is SessionJoinState.InProgress) {
                    _sessionJoinState.value = SessionJoinState.Error(t.message ?: "Unable to connect")
                }
            }
        })
        } catch (e: Exception) {
            Log.e("FlowLink", "Failed to connect WebSocket", e)
            _connectionState.value = ConnectionState.Error(e.message ?: "Connection failed")
        }
    }

    fun disconnect() {
        webSocket?.close(1000, "Normal closure")
        webSocket = null
        _connectionState.value = ConnectionState.Disconnected
        _sessionJoinState.value = SessionJoinState.Idle
        _sessionDevices.value = emptyList()
    }

    fun sendMessage(message: String) {
        webSocket?.send(message) ?: Log.w("FlowLink", "WebSocket not connected")
    }

    fun sendIntent(intent: Intent, targetDeviceId: String) {
        val currentSessionId = sessionManager.getCurrentSessionId()
        Log.d("FlowLink", "Sending intent ${intent.intentType} to $targetDeviceId with sessionId: $currentSessionId")
        
        val intentPayload = JSONObject()
        intent.payload?.forEach { (key, value) ->
            // Try to parse as JSON if it's a JSON string, otherwise use as-is
            try {
                val jsonValue = JSONObject(value)
                intentPayload.put(key, jsonValue) // Keep as nested JSON object
            } catch (e: Exception) {
                // Not JSON, use as string
                intentPayload.put(key, value)
            }
        }
        
        val message = JSONObject().apply {
            put("type", "intent_send")
            put("sessionId", currentSessionId)
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("intent", JSONObject().apply {
                    put("intent_type", intent.intentType)
                    put("payload", intentPayload)
                    put("target_device", targetDeviceId)
                    put("source_device", sessionManager.getDeviceId())
                    put("auto_open", intent.autoOpen)
                    put("timestamp", intent.timestamp)
                })
                put("targetDevice", targetDeviceId)
            })
            put("timestamp", System.currentTimeMillis())
        }.toString()

        Log.d("FlowLink", "Intent message: $message")
        sendMessage(message)
    }

    fun sendRawMessage(message: String) {
        sendMessage(message)
    }

    fun sendChatMessage(targetDeviceId: String, messageId: String, text: String,
                        replyToId: String? = null, replyToText: String? = null, replyToUsername: String? = null) {
        val currentSessionId = sessionManager.getCurrentSessionId()
        val payload = JSONObject().apply {
            put("targetDevice", targetDeviceId)
            put("chat", JSONObject().apply {
                put("messageId", messageId)
                put("text", text)
                put("username", sessionManager.getUsername())
                put("sentAt", System.currentTimeMillis())
                put("format", "plain")
                if (replyToId != null) {
                    put("replyToId", replyToId)
                    put("replyToText", replyToText ?: "")
                    put("replyToUsername", replyToUsername ?: "")
                }
            })
        }
        sendMessage(JSONObject().apply {
            put("type", "chat_message")
            put("sessionId", currentSessionId)
            put("deviceId", sessionManager.getDeviceId())
            put("payload", payload)
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    fun sendChatReceipt(type: String, messageId: String, targetDeviceId: String) {
        val currentSessionId = sessionManager.getCurrentSessionId()
        sendMessage(JSONObject().apply {
            put("type", type)
            put("sessionId", currentSessionId)
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("messageId", messageId)
                put("targetDevice", targetDeviceId)
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    fun sendChatTyping(targetDeviceId: String, isTyping: Boolean) {
        val currentSessionId = sessionManager.getCurrentSessionId()
        sendMessage(JSONObject().apply {
            put("type", "chat_typing")
            put("sessionId", currentSessionId)
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("targetDevice", targetDeviceId)
                put("isTyping", isTyping)
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    fun requestStudyStore() {
        sendMessage(JSONObject().apply {
            put("type", "study_store_list")
            put("sessionId", sessionManager.getCurrentSessionId())
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject())
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    fun sendStudySync(mode: String, value: Any) {
        sendMessage(JSONObject().apply {
            put("type", "study_sync")
            put("sessionId", sessionManager.getCurrentSessionId())
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("mode", mode)
                put("value", value)
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    fun uploadStudyFile(uri: android.net.Uri, fileName: String, fileType: String, fileSize: Long) {
        scope.launch {
            try {
                val ctx = mainActivity.applicationContext
                val bytes = ctx.contentResolver.openInputStream(uri)?.readBytes() ?: return@launch
                val base64Data = Base64.encodeToString(bytes, Base64.NO_WRAP)
                val fileId = "mob-file-${System.currentTimeMillis()}"
                sendMessage(JSONObject().apply {
                    put("type", "study_store_upload")
                    put("sessionId", sessionManager.getCurrentSessionId())
                    put("deviceId", sessionManager.getDeviceId())
                    put("payload", JSONObject().apply {
                        // Backend expects payload.file.{id, name, type, size, data}
                        put("file", JSONObject().apply {
                            put("id", fileId)
                            put("name", fileName)
                            put("type", fileType)
                            put("size", fileSize)
                            put("data", base64Data)
                        })
                    })
                    put("timestamp", System.currentTimeMillis())
                }.toString())
            } catch (e: Exception) {
                Log.e("FlowLink", "Failed to upload study file", e)
            }
        }
    }

    fun deleteStudyFile(fileId: String) {
        sendMessage(JSONObject().apply {
            put("type", "study_store_delete")
            put("sessionId", sessionManager.getCurrentSessionId())
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("fileId", fileId)
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    /** Send browser state (URL, scroll, zoom, selection) to all session devices */
    fun sendBrowserSync(mode: String, value: String) {
        sendMessage(JSONObject().apply {
            put("type", "browser_sync")
            put("sessionId", sessionManager.getCurrentSessionId())
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("mode", mode)
                put("value", value)
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    /** Send a friend request to a user by username (works outside session via global registry) */
    fun sendFriendRequest(toUsername: String) {
        sendMessage(JSONObject().apply {
            put("type", "friend_request")
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("fromUsername", sessionManager.getUsername())
                put("fromDeviceName", sessionManager.getDeviceName())
                put("toUsername", toUsername)
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    /** Accept or reject a friend request */
    fun respondFriendRequest(toDeviceId: String, toUsername: String, accepted: Boolean) {
        sendMessage(JSONObject().apply {
            put("type", "friend_request_response")
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("fromUsername", sessionManager.getUsername())
                put("fromDeviceName", sessionManager.getDeviceName())
                put("toDeviceId", toDeviceId)
                put("toUsername", toUsername)
                put("accepted", accepted)
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    /** Send SOS to specific device IDs (friends, works globally) */
    fun sendSosToDevices(deviceIds: List<String>, lat: Double, lng: Double, mapsUrl: String) {
        val username = sessionManager.getUsername()
        deviceIds.forEach { targetId ->
            sendMessage(JSONObject().apply {
                put("type", "sos_alert")
                put("deviceId", sessionManager.getDeviceId())
                put("payload", JSONObject().apply {
                    put("targetDeviceId", targetId)
                    put("username", username)
                    put("lat", lat)
                    put("lng", lng)
                    put("mapsUrl", mapsUrl)
                    put("message", "🆘 $username needs help!")
                })
                put("timestamp", System.currentTimeMillis())
            }.toString())
        }
    }

    fun createGroup(name: String, deviceIds: List<String>, color: String = "#6C63FF") {
        sendMessage(JSONObject().apply {
            put("type", "group_create")
            put("sessionId", sessionManager.getCurrentSessionId())
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("name", name)
                put("color", color)
                put("deviceIds", org.json.JSONArray(deviceIds))
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    fun deleteGroup(groupId: String) {
        sendMessage(JSONObject().apply {
            put("type", "group_delete")
            put("sessionId", sessionManager.getCurrentSessionId())
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply { put("groupId", groupId) })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    fun broadcastToGroup(groupId: String, text: String) {
        sendMessage(JSONObject().apply {
            put("type", "group_broadcast")
            put("sessionId", sessionManager.getCurrentSessionId())
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("groupId", groupId)
                put("intent", JSONObject().apply {
                    put("intent_type", "clipboard_sync")
                    put("payload", JSONObject().apply {
                        put("clipboard", JSONObject().apply { put("text", text) })
                    })
                    put("auto_open", false)
                    put("timestamp", System.currentTimeMillis())
                })
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    // Chat with file attachment
    fun sendChatFile(targetDeviceId: String, messageId: String, fileName: String,
                     fileType: String, fileSize: Long, base64Data: String,
                     replyToId: String? = null) {
        val currentSessionId = sessionManager.getCurrentSessionId()
        sendMessage(JSONObject().apply {
            put("type", "chat_message")
            put("sessionId", currentSessionId)
            put("deviceId", sessionManager.getDeviceId())
            put("payload", JSONObject().apply {
                put("targetDevice", targetDeviceId)
                put("chat", JSONObject().apply {
                    put("messageId", messageId)
                    put("text", "📎 $fileName")
                    put("username", sessionManager.getUsername())
                    put("sentAt", System.currentTimeMillis())
                    put("fileId", messageId)
                    put("fileName", fileName)
                    put("fileType", fileType)
                    put("fileSize", fileSize)
                    put("fileData", base64Data)
                    if (replyToId != null) put("replyToId", replyToId)
                })
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    fun sendFileUri(targetDeviceId: String, uri: android.net.Uri, fileName: String, fileType: String, fileSize: Long) {
        scope.launch {
            val transferId = "mob-${System.currentTimeMillis()}-${(1000..9999).random()}"
            try {
                sendMessageStrict(JSONObject().apply {
                    put("type", "file_transfer_start")
                    put("sessionId", sessionManager.getCurrentSessionId())
                    put("deviceId", sessionManager.getDeviceId())
                    put("payload", JSONObject().apply {
                        put("transferId", transferId)
                        put("fileName", fileName)
                        put("fileType", fileType)
                        put("totalBytes", fileSize)
                        put("targetDevice", targetDeviceId)
                    })
                    put("timestamp", System.currentTimeMillis())
                }.toString())

                val startAt = SystemClock.elapsedRealtime()
                val initialSessionId = sessionManager.getCurrentSessionId()
                var sentBytes = 0L
                val buffer = ByteArray(128 * 1024)
                mainActivity.contentResolver.openInputStream(uri)?.use { stream ->
                    var read = stream.read(buffer)
                    var chunkIndex = 0
                    while (read > 0) {
                        if (sessionManager.getCurrentSessionId() != initialSessionId || _connectionState.value !is ConnectionState.Connected) {
                            throw IllegalStateException("Transfer stopped: session changed or disconnected")
                        }
                        waitForWebSocketDrain()
                        val chunk = buffer.copyOfRange(0, read)
                        val base64 = Base64.encodeToString(chunk, Base64.NO_WRAP)
                        sendMessageStrict(JSONObject().apply {
                            put("type", "file_transfer_chunk")
                            put("sessionId", sessionManager.getCurrentSessionId())
                            put("deviceId", sessionManager.getDeviceId())
                            put("payload", JSONObject().apply {
                                put("transferId", transferId)
                                put("chunkIndex", chunkIndex)
                                put("data", base64)
                                put("fileName", fileName)
                                put("fileType", fileType)
                                put("totalBytes", fileSize)
                                put("targetDevice", targetDeviceId)
                            })
                            put("timestamp", System.currentTimeMillis())
                        }.toString())
                        sentBytes += read.toLong()
                        chunkIndex += 1
                        val elapsed = ((SystemClock.elapsedRealtime() - startAt) / 1000.0).coerceAtLeast(0.001)
                        val speed = (sentBytes / elapsed).toLong()
                        val progress = if (fileSize > 0) ((sentBytes * 100) / fileSize).toInt().coerceIn(0, 99) else 0
                        val eta = if (speed > 0 && fileSize > sentBytes) (((fileSize - sentBytes).toDouble() / speed.toDouble()).toInt()).coerceAtLeast(0) else 0
                        _fileTransferProgress.tryEmit(FileTransferProgressEvent(
                            deviceId = targetDeviceId,
                            fileName = fileName,
                            direction = "sending",
                            progress = progress,
                            totalBytes = fileSize,
                            transferredBytes = sentBytes,
                            speedBytesPerSec = speed,
                            etaSeconds = eta,
                            startedAt = startAt
                        ))
                        read = stream.read(buffer)
                    }
                }

                sendMessageStrict(JSONObject().apply {
                    put("type", "file_transfer_complete")
                    put("sessionId", sessionManager.getCurrentSessionId())
                    put("deviceId", sessionManager.getDeviceId())
                    put("payload", JSONObject().apply {
                        put("transferId", transferId)
                        put("fileName", fileName)
                        put("targetDevice", targetDeviceId)
                    })
                    put("timestamp", System.currentTimeMillis())
                }.toString())
                _fileTransferProgress.tryEmit(FileTransferProgressEvent(
                    deviceId = targetDeviceId,
                    fileName = fileName,
                    direction = "sending",
                    progress = 100,
                    totalBytes = fileSize,
                    transferredBytes = fileSize,
                    speedBytesPerSec = 0,
                    etaSeconds = 0,
                    startedAt = startAt
                ))
            } catch (e: Exception) {
                Log.e("FlowLink", "Failed to stream file", e)
                sendMessage(JSONObject().apply {
                    put("type", "file_transfer_cancel")
                    put("sessionId", sessionManager.getCurrentSessionId())
                    put("deviceId", sessionManager.getDeviceId())
                    put("payload", JSONObject().apply {
                        put("transferId", transferId)
                        put("targetDevice", targetDeviceId)
                    })
                    put("timestamp", System.currentTimeMillis())
                }.toString())
            }
        }
    }

    private suspend fun waitForWebSocketDrain() {
        while (webSocket != null && webSocket!!.queueSize() > MAX_WS_QUEUE_BYTES) {
            delay(16)
        }
    }

    private fun sendMessageStrict(message: String) {
        val ok = webSocket?.send(message) ?: false
        if (!ok) {
            throw IllegalStateException("WebSocket send failed")
        }
    }

    fun setRemoteDesktopManager(manager: RemoteDesktopManager?) {
        remoteDesktopManager = manager
    }

    private fun handleMessage(text: String) {
        try {
            val json = JSONObject(text)
            val type = json.getString("type")

            when (type) {
                "device_registered" -> {
                    Log.d("FlowLink", "📝 Device registered for invitation listening")
                    val payload = json.getJSONObject("payload")
                    val registered = payload.optBoolean("registered", false)
                    if (registered) {
                        Log.d("FlowLink", "✅ Ready to receive invitations")
                    }
                }
                "intent_received" -> {
                    val intentJson = json.getJSONObject("payload").getJSONObject("intent")
                    val payloadObj = intentJson.optJSONObject("payload")
                    
                    // Debug logging for batch files
                    val intentType = intentJson.getString("intent_type")
                    Log.d("FlowLink", "=== INTENT RECEIVED ===")
                    Log.d("FlowLink", "Intent type: $intentType")
                    Log.d("FlowLink", "Raw payload: ${payloadObj?.toString()}")
                    
                    // Enhanced payload parsing for batch files and other complex structures
                    val payloadMap = payloadObj?.let { obj ->
                        obj.keys().asSequence().associateWith { key ->
                            val value = obj.opt(key)
                            Log.d("FlowLink", "Payload key: $key, value type: ${value?.javaClass?.simpleName}")
                            when {
                                // For batch files, preserve the entire JSON structure
                                key == "files" && value is org.json.JSONObject -> {
                                    Log.d("FlowLink", "Found batch files payload: ${value.toString()}")
                                    value.toString()
                                }
                                // For other nested objects (media, link, etc.), preserve as JSON
                                value is org.json.JSONObject -> value.toString()
                                value is org.json.JSONArray -> value.toString()
                                // For simple values, convert to string
                                else -> value?.toString() ?: ""
                            }
                        }
                    }
                    
                    val intent = Intent(
                        intentType = intentJson.getString("intent_type"),
                        payload = payloadMap,
                        targetDevice = intentJson.getString("target_device"),
                        sourceDevice = intentJson.getString("source_device"),
                        autoOpen = intentJson.getBoolean("auto_open"),
                        timestamp = intentJson.getLong("timestamp")
                    )
                    _receivedIntents.value = intent
                }
                "chat_message" -> {
                    val payload = json.getJSONObject("payload")
                    val chat = payload.optJSONObject("chat") ?: return
                    val messageId = chat.optString("messageId", "")
                    val title = chat.optString("username", "Chat")
                    val sourceDevice = payload.optString("sourceDevice", "")
                    val sentAt = chat.optLong("sentAt", System.currentTimeMillis())

                    // Normalize: laptop sends attachment:{name,type,size,data}
                    // Mobile sends flat: fileId,fileName,fileType,fileSize,fileData
                    val attachment = chat.optJSONObject("attachment")
                    val fileId   = chat.optString("fileId").ifEmpty { null }
                        ?: attachment?.let { messageId }
                    val fileName = chat.optString("fileName").ifEmpty { null }
                        ?: attachment?.optString("name")?.ifEmpty { null }
                    val fileType = chat.optString("fileType").ifEmpty { null }
                        ?: attachment?.optString("type")?.ifEmpty { null }
                    val fileSize = if (chat.has("fileSize")) chat.optLong("fileSize", 0L)
                        else attachment?.optLong("size", 0L) ?: 0L
                    val fileData = chat.optString("fileData").ifEmpty { null }
                        ?: attachment?.optString("data")?.ifEmpty { null }

                    // Clean up text: remove "📎 filename" prefix if it's a file message
                    val rawText = chat.optString("text", "")
                    val text = if (fileName != null && rawText == "📎 $fileName") "" else rawText

                    if (text.startsWith("[[CALL_ACTIVITY]]") || text.startsWith("[[CALL_ROOM_ACTIVITY]]")) {
                        _chatEvents.tryEmit(
                            ChatEvent.Message(
                                messageId = messageId,
                                text = text,
                                username = title,
                                sourceDevice = sourceDevice,
                                targetDevice = sessionManager.getDeviceId(),
                                sentAt = sentAt,
                                fileId = null,
                                fileName = null,
                                fileType = null,
                                fileSize = 0L,
                                fileData = null,
                                replyToId = null,
                                replyToText = null,
                                replyToUsername = null
                            )
                        )
                        return
                    }

                    _chatEvents.tryEmit(
                        ChatEvent.Message(
                            messageId = messageId,
                            text = text,
                            username = title,
                            sourceDevice = sourceDevice,
                            targetDevice = sessionManager.getDeviceId(),
                            sentAt = sentAt,
                            fileId = fileId,
                            fileName = fileName,
                            fileType = fileType,
                            fileSize = fileSize,
                            fileData = fileData,
                            replyToId = chat.optString("replyToId").ifEmpty { null },
                            replyToText = chat.optString("replyToText").ifEmpty { null },
                            replyToUsername = chat.optString("replyToUsername").ifEmpty { null }
                        )
                    )
                    val notifText = if (fileName != null) "📎 $fileName" else text
                    mainActivity.notificationService.showNotification(title, notifText)
                }
                "chat_read" -> {
                    // Can be surfaced in UI later; keep the message flow alive.
                    Log.d("FlowLink", "Chat read receipt received")
                }
                "chat_delivered" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _chatEvents.tryEmit(
                        ChatEvent.Delivered(
                            messageId = payload.optString("messageId", ""),
                            sourceDevice = payload.optString("sourceDevice", "")
                        )
                    )
                }
                "chat_seen" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _chatEvents.tryEmit(
                        ChatEvent.Seen(
                            messageId = payload.optString("messageId", ""),
                            sourceDevice = payload.optString("sourceDevice", "")
                        )
                    )
                }
                "chat_typing" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _chatEvents.tryEmit(
                        ChatEvent.Typing(
                            sourceDevice = payload.optString("sourceDevice", ""),
                            isTyping = payload.optBoolean("isTyping", false)
                        )
                    )
                }
                "study_store_list" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val filesArr = payload.optJSONArray("files") ?: JSONArray()
                    val files = mutableListOf<StudyFile>()
                    for (i in 0 until filesArr.length()) {
                        val file = filesArr.optJSONObject(i) ?: continue
                        files.add(
                            StudyFile(
                                id = file.optString("id", ""),
                                name = file.optString("name", "Document"),
                                type = file.optString("type", "application/octet-stream"),
                                size = file.optLong("size", 0L),
                                data = file.optString("data", "")
                            )
                        )
                    }
                    _studyStore.value = files
                }
                "study_sync" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _studySyncEvents.tryEmit(
                        StudySyncEvent(
                            mode = payload.optString("mode", ""),
                            value = payload.opt("value"),
                            sourceDevice = payload.optString("sourceDevice", "")
                        )
                    )
                }
                "file_transfer_progress" -> {
                    val payload = json.getJSONObject("payload")
                    val fileName = payload.optString("fileName", "File")
                    val progress = payload.optInt("progress", 0)
                    val direction = payload.optString("direction", "receive")
                    val totalBytes = payload.optLong("totalBytes", 0L)
                    val transferredBytes = payload.optLong("transferredBytes", 0L)
                    val speedBytesPerSec = payload.optLong("speedBytesPerSec", 0L)
                    val etaSeconds = payload.optInt("etaSeconds", 0)
                    val deviceId = payload.optString("deviceId", "")
                    val startedAt = payload.optLong("startedAt", System.currentTimeMillis())

                    _fileTransferProgress.tryEmit(FileTransferProgressEvent(
                        deviceId = deviceId.ifBlank { null },
                        fileName = fileName,
                        direction = direction,
                        progress = progress,
                        totalBytes = totalBytes,
                        transferredBytes = transferredBytes,
                        speedBytesPerSec = speedBytesPerSec,
                        etaSeconds = etaSeconds,
                        startedAt = startedAt,
                    ))
                    if (progress >= 100) {
                        mainActivity.notificationService.clearTransferProgress()
                        // Delay null so UI can show 100% briefly
                        scope.launch {
                            kotlinx.coroutines.delay(1500)
                            _fileTransferProgress.tryEmit(null)
                        }
                    }
                }
                "file_transfer_start" -> {
                    val payload = json.getJSONObject("payload")
                    val transferId = payload.optString("transferId", "")
                    val fileName = payload.optString("fileName", "File")
                    val fileType = payload.optString("fileType", "application/octet-stream")
                    val totalBytes = payload.optLong("totalBytes", 0L)
                    val sourceDevice = payload.optString("sourceDevice", "")

                    if (transferId.isBlank()) return

                    fileTransferMeta[transferId] = FileTransferMeta(fileName, fileType, totalBytes, sourceDevice)
                    val targetFile = File(mainActivity.cacheDir, "flowlink-${System.currentTimeMillis()}-$fileName")
                    fileTransferFiles[transferId] = targetFile
                    fileTransferWriters[transferId] = FileOutputStream(targetFile)
                    fileTransferReceivedBytes[transferId] = 0L
                    transferStartedAt[transferId] = SystemClock.elapsedRealtime()
                    fileTransferLastUiUpdateAt[transferId] = 0L
                    fileTransferLastAckBytes[transferId] = 0L
                    _fileTransferProgress.tryEmit(FileTransferProgressEvent(
                        deviceId = sourceDevice.ifBlank { null },
                        fileName = fileName,
                        direction = "receiving",
                        progress = 0,
                        totalBytes = totalBytes,
                        transferredBytes = 0,
                        speedBytesPerSec = 0,
                        etaSeconds = 0,
                        startedAt = transferStartedAt[transferId] ?: SystemClock.elapsedRealtime(),
                    ))
                }
                "file_transfer_chunk" -> {
                    val payload = json.getJSONObject("payload")
                    val transferId = payload.optString("transferId", "")
                    val data = payload.optString("data", "")
                    val sourceDevice = payload.optString("sourceDevice", "")
                    val meta = fileTransferMeta[transferId] ?: return
                    val writer = fileTransferWriters[transferId] ?: return

                    if (data.isNotBlank()) {
                        val bytes = Base64.decode(data, Base64.DEFAULT)
                        writer.write(bytes)
                        val transferred = (fileTransferReceivedBytes[transferId] ?: 0L) + bytes.size.toLong()
                        fileTransferReceivedBytes[transferId] = transferred
                        val progress = if (meta.totalBytes > 0) ((transferred * 100) / meta.totalBytes).toInt().coerceIn(0, 99) else 0
                        val startedAt = transferStartedAt[transferId] ?: SystemClock.elapsedRealtime()
                        val elapsed = ((SystemClock.elapsedRealtime() - startedAt) / 1000.0).coerceAtLeast(0.001)
                        val speed = (transferred / elapsed).toLong()
                        val eta = if (speed > 0 && meta.totalBytes > transferred) (((meta.totalBytes - transferred).toDouble() / speed.toDouble()).toInt()).coerceAtLeast(0) else 0

                        val now = SystemClock.elapsedRealtime()
                        val lastUiAt = fileTransferLastUiUpdateAt[transferId] ?: 0L
                        if ((now - lastUiAt) >= PROGRESS_UPDATE_INTERVAL_MS || progress >= 99) {
                            fileTransferLastUiUpdateAt[transferId] = now
                            _fileTransferProgress.tryEmit(FileTransferProgressEvent(
                                deviceId = sourceDevice.ifBlank { meta.sourceDevice.ifBlank { null } },
                                fileName = meta.fileName,
                                direction = "receiving",
                                progress = progress,
                                totalBytes = meta.totalBytes,
                                transferredBytes = transferred,
                                speedBytesPerSec = speed,
                                etaSeconds = eta,
                                startedAt = startedAt,
                            ))
                        }

                        val lastAckBytes = fileTransferLastAckBytes[transferId] ?: 0L
                        if (transferred - lastAckBytes >= ACK_INTERVAL_BYTES) {
                            fileTransferLastAckBytes[transferId] = transferred
                            sendMessage(JSONObject().apply {
                                put("type", "file_transfer_ack")
                                put("sessionId", sessionManager.getCurrentSessionId())
                                put("deviceId", sessionManager.getDeviceId())
                                put("payload", JSONObject().apply {
                                    put("transferId", transferId)
                                    put("targetDevice", meta.sourceDevice)
                                    put("transferredBytes", transferred)
                                    put("totalBytes", meta.totalBytes)
                                    put("progress", progress)
                                })
                                put("timestamp", System.currentTimeMillis())
                            }.toString())
                        }
                    }
                }
                "file_transfer_complete" -> {
                    val payload = json.getJSONObject("payload")
                    val transferId = payload.optString("transferId", "")
                    val meta = fileTransferMeta.remove(transferId) ?: return
                    fileTransferWriters.remove(transferId)?.close()
                    val targetFile = fileTransferFiles.remove(transferId) ?: return
                    val transferredBytes = fileTransferReceivedBytes.remove(transferId) ?: targetFile.length()
                    val startedAt = transferStartedAt.remove(transferId) ?: SystemClock.elapsedRealtime()
                    fileTransferLastUiUpdateAt.remove(transferId)
                    fileTransferLastAckBytes.remove(transferId)

                    _fileTransferProgress.tryEmit(FileTransferProgressEvent(
                        deviceId = meta.sourceDevice.ifBlank { null },
                        fileName = meta.fileName,
                        direction = "receiving",
                        progress = 100,
                        totalBytes = meta.totalBytes,
                        transferredBytes = transferredBytes,
                        speedBytesPerSec = 0,
                        etaSeconds = 0,
                        startedAt = startedAt,
                    ))
                    mainActivity.notificationService.clearTransferProgress()
                    scope.launch {
                        kotlinx.coroutines.delay(1500)
                        _fileTransferProgress.tryEmit(null)
                    }
                    sendMessage(JSONObject().apply {
                        put("type", "file_transfer_ack")
                        put("sessionId", sessionManager.getCurrentSessionId())
                        put("deviceId", sessionManager.getDeviceId())
                        put("payload", JSONObject().apply {
                            put("transferId", transferId)
                            put("targetDevice", meta.sourceDevice)
                            put("transferredBytes", transferredBytes)
                            put("totalBytes", meta.totalBytes)
                            put("progress", 100)
                            put("completed", true)
                        })
                        put("timestamp", System.currentTimeMillis())
                    }.toString())

                    mainActivity.openReceivedTransferFile(targetFile, meta.fileName, meta.fileType, meta.sourceDevice)
                }
                "file_transfer_cancel" -> {
                    val payload = json.getJSONObject("payload")
                    val transferId = payload.optString("transferId", "")
                    fileTransferMeta.remove(transferId)
                    fileTransferWriters.remove(transferId)?.close()
                    fileTransferFiles.remove(transferId)?.delete()
                    fileTransferReceivedBytes.remove(transferId)
                    transferStartedAt.remove(transferId)
                    fileTransferLastUiUpdateAt.remove(transferId)
                    fileTransferLastAckBytes.remove(transferId)
                    _fileTransferProgress.tryEmit(null)
                    mainActivity.notificationService.clearTransferProgress()
                }
                "device_connected" -> {
                    val payload = json.getJSONObject("payload")
                    val deviceJson = payload.optJSONObject("device") ?: payload
                    val deviceInfo = buildDeviceInfo(deviceJson)
                    Log.d("FlowLink", "Received device_connected: ${deviceInfo.name} (${deviceInfo.id})")
                    Log.d("FlowLink", "  Current device ID: ${sessionManager.getDeviceId()}")
                    Log.d("FlowLink", "  Is self: ${deviceInfo.id == sessionManager.getDeviceId()}")

                    try {
                        mainActivity.notificationService.showDeviceConnected(deviceInfo.name, deviceInfo.type)
                    } catch (e: Exception) {
                        Log.e("FlowLink", "Failed to show device connected notification", e)
                    }
                    
                    // Only emit if it's not the current device
                    if (deviceInfo.id.isNotBlank() && deviceInfo.id != sessionManager.getDeviceId()) {
                        upsertSessionDevice(deviceInfo)
                        _deviceConnected.value = deviceInfo
                        _deviceConnectedEvents.tryEmit(deviceInfo)
                        Log.d("FlowLink", "  Emitted device_connected event")
                    } else {
                        Log.d("FlowLink", "  Skipped (self)")
                    }
                }
                "device_disconnected" -> {
                    Log.d("FlowLink", "Device disconnected")
                    val payload = json.optJSONObject("payload")
                    val deviceJson = payload?.optJSONObject("device")
                    val disconnectedDeviceId = deviceJson?.optString("id")
                        ?: payload?.optString("deviceId")
                        ?: ""
                    removeSessionDevice(disconnectedDeviceId)
                }
                "session_created" -> {
                    val payload = json.getJSONObject("payload")
                    val sessionId = payload.getString("sessionId")
                    val code = payload.getString("code")
                    val expiresAt = payload.getLong("expiresAt")
                    
                    // Clear stale device_connected so the QR screen doesn't immediately navigate
                    resetDeviceConnectedEvent()

                    // CRITICAL FIX: Update SessionManager with backend's sessionId immediately
                    // This ensures all future intent_send messages use the correct sessionId
                    scope.launch {
                        sessionManager.setSessionInfo(sessionId, code)
                        sessionManager.setSessionActive(true)
                        Log.d("FlowLink", "Updated session info from session_created: id=$sessionId, code=$code")
                    }
                    _sessionDevices.value = emptyList()
                    
                    _sessionCreated.value = SessionCreatedEvent(sessionId, code, expiresAt)
                    Log.d("FlowLink", "Session created: $code with sessionId: $sessionId")
                }
                "session_joined" -> {
                    val payload = json.getJSONObject("payload")

                    // Backend sends the canonical sessionId here. For devices that
                    // joined using only the 6-digit code, we initially stored a
                    // locally generated sessionId in SessionManager. That local ID
                    // does NOT exist on the backend, which breaks routing for
                    // intents (including link_open) originating from Android.
                    //
                    // Fix: as soon as we receive session_joined, overwrite the
                    // locally generated sessionId with the real backend sessionId
                    // while preserving the original code. All future intent_send
                    // messages will then contain a valid sessionId.
                    val backendSessionId = payload.optString("sessionId")
                    if (!backendSessionId.isNullOrEmpty()) {
                        scope.launch {
                            val currentCode = sessionManager.getCurrentSessionCode() ?: ""
                            sessionManager.setSessionInfo(backendSessionId, currentCode)
                            sessionManager.setSessionActive(true)
                            Log.d("FlowLink", "Updated session info from session_joined: id=$backendSessionId, code=$currentCode")
                        }
                    }

                    val devicesArray = payload.optJSONArray("devices")
                    if (devicesArray != null) {
                        Log.d("FlowLink", "Processing ${devicesArray.length()} devices from session_joined")
                        val devices = mutableListOf<DeviceInfo>()
                        for (i in 0 until devicesArray.length()) {
                            val deviceJson = devicesArray.getJSONObject(i)
                            val deviceInfo = buildDeviceInfo(deviceJson)
                            devices.add(deviceInfo)
                        }
                        updateSessionDevices(devices)
                    }
                    Log.d("FlowLink", "Session joined, devices updated")

                    // Mark join as successful so UI can navigate
                    val joinedSessionId = payload.optString("sessionId")
                    if (!joinedSessionId.isNullOrEmpty()) {
                        _sessionJoinState.value = SessionJoinState.Success(joinedSessionId)
                    } else {
                        _sessionJoinState.value = SessionJoinState.Success(sessionManager.getCurrentSessionId() ?: "")
                    }

                    if (devicesArray != null) {
                        _sessionDevices.value = mutableListOf<DeviceInfo>().apply {
                            val selfId = sessionManager.getDeviceId()
                            for (i in 0 until devicesArray.length()) {
                                val deviceJson = devicesArray.getJSONObject(i)
                                val deviceInfo = buildDeviceInfo(deviceJson)
                                if (deviceInfo.id.isNotBlank() && deviceInfo.id != selfId) add(deviceInfo)
                            }
                        }
                        _deviceConnected.value = _sessionDevices.value.firstOrNull()
                    }
                }
                "session_expired" -> {
                    val payload = json.optJSONObject("payload")
                    val reason = payload?.optString("reason", "unknown") ?: "unknown"
                    Log.d("FlowLink", "Session expired, reason: $reason")
                    
                    // Emit session expired event for UI to handle
                    _sessionExpired.value = true
                    
                    // Clear local session so user can start fresh
                    scope.launch {
                        sessionManager.setSessionActive(false)
                        sessionManager.leaveSession()
                    }
                    _sessionDevices.value = emptyList()
                    
                    // Don't set error state if we're not in a join flow
                    // This prevents crashes when session expires while app is active
                    if (_sessionJoinState.value is SessionJoinState.InProgress) {
                        _sessionJoinState.value = SessionJoinState.Error("Session expired")
                    }
                    
                    // Gracefully disconnect without forcing error state
                    // The UI will handle the session being cleared
                    disconnect()
                }
                "chat_message" -> {
                    val payload = json.getJSONObject("payload")
                    val chat = payload.optJSONObject("chat") ?: return
                    val messageId = chat.optString("messageId", "")
                    val title = chat.optString("username", "Chat")
                    val sourceDevice = payload.optString("sourceDevice", "")
                    val sentAt = chat.optLong("sentAt", System.currentTimeMillis())

                    val attachment = chat.optJSONObject("attachment")
                    val fileId = chat.optString("fileId").ifEmpty { null }
                        ?: attachment?.let { messageId }
                    val fileName = chat.optString("fileName").ifEmpty { null }
                        ?: attachment?.optString("name")?.ifEmpty { null }
                    val fileType = chat.optString("fileType").ifEmpty { null }
                        ?: attachment?.optString("type")?.ifEmpty { null }
                    val fileSize = if (chat.has("fileSize")) chat.optLong("fileSize", 0L)
                        else attachment?.optLong("size", 0L) ?: 0L
                    val fileData = chat.optString("fileData").ifEmpty { null }
                        ?: attachment?.optString("data")?.ifEmpty { null }

                    val rawText = chat.optString("text", "")
                    val text = if (fileName != null && rawText == "📎 $fileName") "" else rawText

                    _chatEvents.tryEmit(
                        ChatEvent.Message(
                            messageId = messageId,
                            text = text,
                            username = title,
                            sourceDevice = sourceDevice,
                            targetDevice = sessionManager.getDeviceId(),
                            sentAt = sentAt,
                            fileId = fileId,
                            fileName = fileName,
                            fileType = fileType,
                            fileSize = fileSize,
                            fileData = fileData,
                            replyToId = chat.optString("replyToId").ifEmpty { null },
                            replyToText = chat.optString("replyToText").ifEmpty { null },
                            replyToUsername = chat.optString("replyToUsername").ifEmpty { null }
                        )
                    )
                }
                "device_connected" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val deviceJson = payload.optJSONObject("device") ?: payload
                    val info = buildDeviceInfo(deviceJson)
                    if (info.id.isNotBlank() && info.id != sessionManager.getDeviceId()) {
                        upsertSessionDevice(info)
                        _deviceConnected.value = info
                        _deviceConnectedEvents.tryEmit(info)
                    }
                }
                "device_disconnected" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val deviceId = payload.optJSONObject("device")?.optString("id")
                        ?: payload.optString("deviceId", "")
                    removeSessionDevice(deviceId)
                }
                "clipboard_sync" -> {
                    val clipboardJson = json.getJSONObject("payload").optJSONObject("clipboard")
                    if (clipboardJson != null) {
                        val text = clipboardJson.optString("text", "").ifBlank { null }
                        val html = clipboardJson.optString("html", "").ifBlank { null }
                        val image = clipboardJson.optString("image", "").ifBlank { null }
                        val url = clipboardJson.optString("url", "").ifBlank { null }

                        if (text != null || html != null || image != null || url != null) {
                            Log.d("FlowLink", "📋 Received clipboard from remote")
                            try {
                                mainActivity.updateClipboardFromRemote(text, html, image, url)
                            } catch (e: Exception) {
                                Log.e("FlowLink", "Failed to update clipboard", e)
                            }
                        }
                    }
                }
                "webrtc_offer", "webrtc_answer", "webrtc_ice_candidate" -> {
                    remoteDesktopManager?.handleSignaling(json)
                        ?: Log.w("FlowLink", "Received $type but no RemoteDesktopManager is active")
                }
                "media_handoff_offer" -> {
                    Log.d("FlowLink", "🎬 Received media handoff offer")
                    val payload = json.getJSONObject("payload")
                    val title = payload.optString("title", "Unknown Video")
                    val url = payload.optString("url", "")
                    val timestamp = payload.optInt("timestamp", 0)
                    val platform = payload.optString("platform", "Unknown")
                    
                    Log.d("FlowLink", "Media: $title from $platform at ${timestamp}s")
                    
                    // Show notification
                    try {
                        mainActivity.notificationService.showMediaHandoff(title, url, timestamp, platform)
                    } catch (e: Exception) {
                        Log.e("FlowLink", "Failed to show media handoff notification", e)
                    }
                }
                "tab_handoff_offer" -> {
                    Log.d("FlowLink", "🪟 Received tab handoff offer")
                    val payload = json.getJSONObject("payload")
                    val tabs = payload.optJSONArray("tabs")
                    if (tabs != null && tabs.length() > 0) {
                        val sourceDeviceName = payload.optString("sourceDeviceName", "Browser Extension")
                        val collectionTitle = payload.optString("collectionTitle", "Tab handoff")
                        try {
                            mainActivity.notificationService.showTabHandoff(
                                collectionTitle,
                                payload.toString(),
                                sourceDeviceName,
                                tabs.length()
                            )
                        } catch (e: Exception) {
                            Log.e("FlowLink", "Failed to show tab handoff notification", e)
                        }
                    }
                }
                "target_connection_request" -> {
                    Log.d("FlowLink", "📨 Received target connection request")
                    val payload = json.getJSONObject("payload")
                    val sourceDeviceId = payload.optString("sourceDeviceId", "")
                    val sourceUsername = payload.optString("sourceUsername", "Unknown")
                    val sourceDeviceName = payload.optString("sourceDeviceName", "Unknown Device")
                    sessionManager.setPreferredTargetUsername(sourceUsername)

                    try {
                        mainActivity.notificationService.showReceiverConnected(sourceUsername, sourceDeviceName)
                    } catch (e: Exception) {
                        Log.e("FlowLink", "Failed to show receiver connected notification", e)
                    }

                    sendMessage(JSONObject().apply {
                        put("type", "target_connection_ack")
                        put("deviceId", sessionManager.getDeviceId())
                        put("sessionId", sessionManager.getCurrentSessionId())
                        put("payload", JSONObject().apply {
                            put("sourceDeviceId", sourceDeviceId)
                            put("sourceUsername", sourceUsername)
                            put("targetUsername", sessionManager.getUsername())
                            put("targetDeviceName", sessionManager.getDeviceName())
                        })
                        put("timestamp", System.currentTimeMillis())
                    }.toString())
                }
                "target_connection_result" -> {
                    Log.d("FlowLink", "📨 Received target connection result")
                }
                "session_invitation" -> {
                    Log.d("FlowLink", "📨 Received session invitation")
                    val invitation = json.getJSONObject("payload").optJSONObject("invitation")
                    if (invitation != null) {
                        val sessionId = invitation.optString("sessionId", "")
                        val sessionCode = invitation.optString("sessionCode", "")
                        val inviterUsername = invitation.optString("inviterUsername", "")
                        val inviterDeviceName = invitation.optString("inviterDeviceName", "")
                        val message = invitation.optString("message", "")
                        
                        // Show notification
                        try {
                            mainActivity.notificationService.showSessionInvitation(
                                sessionId, sessionCode, inviterUsername, inviterDeviceName, message
                            )
                        } catch (e: Exception) {
                            Log.e("FlowLink", "Failed to show invitation notification", e)
                        }
                    }
                }
                "nearby_session_broadcast" -> {
                    Log.d("FlowLink", "📨 Received nearby session broadcast")
                    val nearbySession = json.getJSONObject("payload").optJSONObject("nearbySession")
                    if (nearbySession != null) {
                        val sessionId = nearbySession.optString("sessionId", "")
                        val sessionCode = nearbySession.optString("sessionCode", "")
                        val creatorUsername = nearbySession.optString("creatorUsername", "")
                        val creatorDeviceName = nearbySession.optString("creatorDeviceName", "")
                        val deviceCount = nearbySession.optInt("deviceCount", 1)
                        
                        // Show notification
                        try {
                            mainActivity.notificationService.showNearbySession(
                                sessionId, sessionCode, creatorUsername, creatorDeviceName, deviceCount
                            )
                        } catch (e: Exception) {
                            Log.e("FlowLink", "Failed to show nearby session notification", e)
                        }
                    }
                }
                "invitation_response" -> {
                    Log.d("FlowLink", "📨 Received invitation response")
                    val response = json.getJSONObject("payload")
                    val accepted = response.optBoolean("accepted", false)
                    val inviteeUsername = response.optString("inviteeUsername", "")
                    val inviteeDeviceName = response.optString("inviteeDeviceName", "")
                    
                    val message = if (accepted) {
                        "$inviteeUsername accepted your invitation"
                    } else {
                        "$inviteeUsername declined your invitation"
                    }
                    
                    try {
                        mainActivity.notificationService.showNotification(
                            if (accepted) "Invitation Accepted" else "Invitation Declined",
                            message
                        )
                    } catch (e: Exception) {
                        Log.e("FlowLink", "Failed to show invitation response notification", e)
                    }
                }
                "invitation_sent" -> {
                    Log.d("FlowLink", "📨 Received invitation sent confirmation")
                    val response = json.getJSONObject("payload")
                    val targetUsername = response.optString("targetUsername", "")
                    val targetIdentifier = response.optString("targetIdentifier", "")
                    val displayName = targetUsername.ifEmpty { targetIdentifier }
                    
                    try {
                        mainActivity.notificationService.showNotification(
                            "Invitation Sent",
                            "Invitation sent to $displayName"
                        )
                    } catch (e: Exception) {
                        Log.e("FlowLink", "Failed to show invitation sent notification", e)
                    }
                }
                "group_created", "group_updated", "group_list" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    // Single group event
                    val groupJson = payload.optJSONObject("group")
                    if (groupJson != null) {
                        val newGroup = parseGroupInfo(groupJson)
                        val updated = _groups.value.toMutableList()
                        val idx = updated.indexOfFirst { it.id == newGroup.id }
                        if (idx >= 0) updated[idx] = newGroup else updated.add(newGroup)
                        _groups.value = updated
                    }
                    // Full list
                    val groupsArr = payload.optJSONArray("groups")
                    if (groupsArr != null) {
                        val list = mutableListOf<GroupInfo>()
                        for (i in 0 until groupsArr.length()) {
                            val g = groupsArr.optJSONObject(i) ?: continue
                            list.add(parseGroupInfo(g))
                        }
                        _groups.value = list
                    }
                }
                "group_deleted" -> {
                    val groupId = json.optJSONObject("payload")?.optString("groupId") ?: return
                    _groups.value = _groups.value.filterNot { it.id == groupId }
                }
                "sos_alert" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val username = payload.optString("username", "Someone")
                    val mapsUrl = payload.optString("mapsUrl", "")
                    val lat = payload.optDouble("lat", 0.0)
                    val lng = payload.optDouble("lng", 0.0)
                    Log.d("FlowLink", "🆘 SOS from $username at $lat,$lng")
                    try {
                        mainActivity.notificationService.showSosAlert(username, mapsUrl)
                    } catch (e: Exception) {
                        Log.e("FlowLink", "Failed to show SOS notification", e)
                    }
                }
                "browser_sync" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val mode = payload.optString("mode", "")
                    val value = payload.optString("value", "")
                    val sourceDevice = json.optString("deviceId", "")
                    if (mode.isNotEmpty()) {
                        _browserSyncEvents.tryEmit(BrowserSyncEvent(mode, value, sourceDevice))
                    }
                }
                "friend_request" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val fromUsername = payload.optString("fromUsername", "Someone")
                    val fromDeviceId = json.optString("deviceId", "")
                    val fromDeviceName = payload.optString("fromDeviceName", "")
                    // Ignore if I sent this request (echoed back from session broadcast)
                    val myUsername = sessionManager.getUsername()
                    if (fromUsername.equals(myUsername, ignoreCase = true)) return                    // Add to persistent inbox so it survives fragment recreation
                    com.flowlink.app.ui.InboxFragment.addItem(mainActivity, com.flowlink.app.ui.InboxItem(
                        id = "fr-${System.currentTimeMillis()}",
                        type = "friend_request",
                        title = "Friend Request",
                        body = "$fromUsername wants to be your friend",
                        fromUsername = fromUsername,
                        fromDeviceId = fromDeviceId,
                        fromDeviceName = fromDeviceName
                    ))
                    // Persist to DB
                    val requestId = payload.optString("requestId", "fr-${System.currentTimeMillis()}")
                    mainActivity.persistInboxToDb(fromUsername, fromDeviceId, requestId)
                    _friendRequestEvents.tryEmit(FriendRequestEvent(
                        type = "received",
                        fromUsername = fromUsername,
                        fromDeviceId = fromDeviceId,
                        fromDeviceName = fromDeviceName,
                        accepted = false
                    ))
                    mainActivity.notificationService.showNotification(
                        "Friend Request",
                        "$fromUsername wants to be your friend"
                    )
                }
                "friend_request_response" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val accepted = payload.optBoolean("accepted", false)
                    val fromUsername = payload.optString("fromUsername", "")
                    val fromDeviceId = json.optString("deviceId", "")
                    val fromDeviceName = payload.optString("fromDeviceName", "")

                    // Persist immediately — don't rely on FriendsFragment being open
                    if (accepted) {
                        com.flowlink.app.ui.FriendsFragment.saveFriend(
                            mainActivity,
                            com.flowlink.app.model.Friend(
                                username = fromUsername,
                                deviceName = fromDeviceName,
                                deviceId = fromDeviceId,
                                status = "accepted"
                            )
                        )
                    } else {
                        com.flowlink.app.ui.FriendsFragment.removeFriend(mainActivity, fromDeviceId)
                    }

                    _friendRequestEvents.tryEmit(FriendRequestEvent(
                        type = if (accepted) "accepted" else "rejected",
                        fromUsername = fromUsername,
                        fromDeviceId = fromDeviceId,
                        fromDeviceName = fromDeviceName,
                        accepted = accepted
                    ))
                    val msg = if (accepted) "$fromUsername accepted your friend request!"
                              else "$fromUsername declined your friend request"
                    mainActivity.notificationService.showNotification("Friend Request", msg)
                }
                "error" -> {
                    // Backend error (e.g., invalid session code). Surface this to the UI,
                    // especially during a join attempt.
                    val payload = json.optJSONObject("payload")
                    val message = payload?.optString("message", "Unknown error") ?: "Unknown error"
                    Log.e("FlowLink", "Backend error: $message")
                    if (_sessionJoinState.value is SessionJoinState.InProgress) {
                        _sessionJoinState.value = SessionJoinState.Error(message)
                    }
                }
                "admin_announcement" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val title = payload.optString("title", "FlowLink Update")
                    val msg = payload.optString("message", "")
                    val type = payload.optString("type", "info")
                    val icon = when (type) { "update" -> "🚀"; "warning" -> "⚠️"; else -> "ℹ️" }
                    mainActivity.notificationService.showNotification("$icon $title", msg)
                    // Also show as in-app toast via InboxFragment
                    com.flowlink.app.ui.InboxFragment.addItem(mainActivity, com.flowlink.app.ui.InboxItem(
                        id = "ann-${System.currentTimeMillis()}",
                        type = "info",
                        title = "$icon $title",
                        body = msg,
                        fromUsername = "FlowLink Admin"
                    ))
                }
                "session_terminated" -> {
                    val payload = json.optJSONObject("payload")
                    val reason = payload?.optString("reason", "Session terminated by admin") ?: "Session terminated by admin"
                    mainActivity.notificationService.showNotification("⚠️ Session Terminated", reason)
                    // Leave session gracefully
                    mainActivity.runOnUiThread {
                        android.widget.Toast.makeText(mainActivity, reason, android.widget.Toast.LENGTH_LONG).show()
                        mainActivity.leaveSession()
                    }
                }
                // ── Call signaling ────────────────────────────────────────────
                "call_invite" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val callId = payload.optString("callId", "")
                    val fromUsername = payload.optString("fromUsername", "Unknown")
                    val fromDevice = payload.optString("fromDevice", "")
                    val isVideo = payload.optBoolean("isVideo", false)
                    Log.d("FlowLink", "📞 Incoming ${if (isVideo) "video" else "audio"} call from $fromUsername")
                    _callEvents.tryEmit(CallEvent.Incoming(callId, fromUsername, fromDevice, isVideo))
                    // Notification is shown by MainActivity.showIncomingCall() which checks
                    // isAppInForeground — do NOT call notificationService directly here.
                }
                "call_accept" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val callId = payload.optString("callId", "")
                    val fromDevice = payload.optString("fromDevice", "")
                    Log.d("FlowLink", "✅ Call accepted by $fromDevice")
                    _callEvents.tryEmit(CallEvent.Accepted(callId, fromDevice))
                }
                "call_reject" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val callId = payload.optString("callId", "")
                    val reason = payload.optString("reason", "rejected")
                    Log.d("FlowLink", "❌ Call rejected: $reason")
                    _callEvents.tryEmit(CallEvent.Rejected(callId, reason))
                }
                "call_end" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val callId = payload.optString("callId", "")
                    Log.d("FlowLink", "📵 Call ended")
                    _callEvents.tryEmit(CallEvent.Ended(callId))
                }
                "call_offer" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.Offer(
                        callId = payload.optString("callId", ""),
                        fromDevice = payload.optString("fromDevice", ""),
                        sdp = payload.optJSONObject("data")?.toString() ?: ""
                    ))
                }
                "call_answer" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.Answer(
                        callId = payload.optString("callId", ""),
                        fromDevice = payload.optString("fromDevice", ""),
                        sdp = payload.optJSONObject("data")?.toString() ?: ""
                    ))
                }
                "call_ice" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.IceCandidate(
                        callId = payload.optString("callId", ""),
                        fromDevice = payload.optString("fromDevice", ""),
                        candidate = payload.optJSONObject("data")?.toString() ?: ""
                    ))
                }

                // ── Group call room signaling ──────────────────────────────────
                "call_room_invite" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.RoomInvite(
                        roomId       = payload.optString("roomId", ""),
                        callType     = payload.optString("callType", "audio"),
                        fromUsername = payload.optString("fromUsername", "Unknown"),
                        fromDevice   = payload.optString("fromDevice", ""),
                        sessionId    = payload.optString("sessionId", "")
                    ))
                }
                "call_room_created" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.RoomCreated(
                        roomId   = payload.optString("roomId", ""),
                        callType = payload.optString("callType", "audio")
                    ))
                }
                "call_room_joined" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    val peers = mutableListOf<RoomPeer>()
                    val arr = payload.optJSONArray("participants")
                    if (arr != null) {
                        for (i in 0 until arr.length()) {
                            val p = arr.optJSONObject(i) ?: continue
                            peers.add(RoomPeer(p.optString("deviceId", ""), p.optString("username", "")))
                        }
                    }
                    _callEvents.tryEmit(CallEvent.RoomJoined(
                        roomId       = payload.optString("roomId", ""),
                        callType     = payload.optString("callType", "audio"),
                        participants = peers,
                        sessionId    = payload.optString("sessionId", "")
                    ))
                }
                "call_room_peer_joined" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.RoomPeerJoined(
                        roomId       = payload.optString("roomId", ""),
                        peerId       = payload.optString("peerId", ""),
                        peerUsername = payload.optString("peerUsername", "")
                    ))
                }
                "call_room_peer_left" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.RoomPeerLeft(
                        roomId       = payload.optString("roomId", ""),
                        peerId       = payload.optString("peerId", ""),
                        peerUsername = payload.optString("peerUsername", "")
                    ))
                }
                "call_room_offer" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.RoomOffer(
                        roomId      = payload.optString("roomId", ""),
                        fromPeerId  = payload.optString("fromPeerId", ""),
                        peerUsername= payload.optString("peerUsername", ""),
                        sdp         = payload.optJSONObject("data")?.toString() ?: ""
                    ))
                }
                "call_room_answer" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.RoomAnswer(
                        roomId     = payload.optString("roomId", ""),
                        fromPeerId = payload.optString("fromPeerId", ""),
                        sdp        = payload.optJSONObject("data")?.toString() ?: ""
                    ))
                }
                "call_room_ice" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.RoomIce(
                        roomId     = payload.optString("roomId", ""),
                        fromPeerId = payload.optString("fromPeerId", ""),
                        candidate  = payload.optJSONObject("data")?.toString() ?: ""
                    ))
                }
                "call_room_error" -> {
                    val payload = json.optJSONObject("payload") ?: return
                    _callEvents.tryEmit(CallEvent.RoomError(
                        roomId = payload.optString("roomId", ""),
                        reason = payload.optString("reason", "unknown")
                    ))
                }
            }
        } catch (e: Exception) {
            Log.e("FlowLink", "Error handling message", e)
        }
    }

    data class FileTransferProgressEvent(
        val deviceId: String?,
        val fileName: String,
        val direction: String,
        val progress: Int,
        val totalBytes: Long,
        val transferredBytes: Long,
        val speedBytesPerSec: Long,
        val etaSeconds: Int,
        val startedAt: Long,
    )

    private data class FileTransferMeta(
        val fileName: String,
        val fileType: String,
        val totalBytes: Long,
        val sourceDevice: String,
    )

    sealed class ConnectionState {
        object Disconnected : ConnectionState()
        object Connecting : ConnectionState()
        object Connected : ConnectionState()
        data class Error(val message: String) : ConnectionState()
    }

    sealed class SessionJoinState {
        object Idle : SessionJoinState()
        object InProgress : SessionJoinState()
        data class Success(val sessionId: String) : SessionJoinState()
        data class Error(val message: String) : SessionJoinState()
    }

    sealed class ChatEvent {
        data class Message(
            val messageId: String,
            val text: String,
            val username: String,
            val sourceDevice: String,
            val targetDevice: String,
            val sentAt: Long,
            val fileId: String? = null,
            val fileName: String? = null,
            val fileType: String? = null,
            val fileSize: Long = 0L,
            val fileData: String? = null,
            val replyToId: String? = null,
            val replyToText: String? = null,
            val replyToUsername: String? = null
        ) : ChatEvent()

        data class Delivered(
            val messageId: String,
            val sourceDevice: String
        ) : ChatEvent()

        data class Seen(
            val messageId: String,
            val sourceDevice: String
        ) : ChatEvent()

        data class Typing(
            val sourceDevice: String,
            val isTyping: Boolean
        ) : ChatEvent()
    }

    data class StudyFile(
        val id: String,
        val name: String,
        val type: String,
        val size: Long,
        val data: String
    )

    data class StudySyncEvent(
        val mode: String,
        val value: Any?,
        val sourceDevice: String
    )

    data class GroupInfo(
        val id: String,
        val name: String,
        val deviceIds: List<String>,
        val color: String,
        val createdBy: String
    )

    data class BrowserSyncEvent(
        val mode: String,
        val value: String,
        val sourceDevice: String
    )

    data class FriendRequestEvent(
        val type: String,       // "received" | "accepted" | "rejected"
        val fromUsername: String,
        val fromDeviceId: String,
        val fromDeviceName: String,
        val accepted: Boolean
    )

    // ── Call signaling events ──────────────────────────────────────────────
    sealed class CallEvent {
        data class Incoming(val callId: String, val fromUsername: String, val fromDevice: String, val isVideo: Boolean) : CallEvent()
        data class Accepted(val callId: String, val fromDevice: String) : CallEvent()
        data class Rejected(val callId: String, val reason: String) : CallEvent()
        data class Ended(val callId: String) : CallEvent()
        data class Offer(val callId: String, val fromDevice: String, val sdp: String) : CallEvent()
        data class Answer(val callId: String, val fromDevice: String, val sdp: String) : CallEvent()
        data class IceCandidate(val callId: String, val fromDevice: String, val candidate: String) : CallEvent()

        // ── Group call room events ─────────────────────────────────────────
        /** Received when another device creates a room and invites us */
        data class RoomInvite(val roomId: String, val callType: String, val fromUsername: String, val fromDevice: String, val sessionId: String) : CallEvent()
        /** Room created confirmation (for initiator) */
        data class RoomCreated(val roomId: String, val callType: String) : CallEvent()
        /** We joined — server returns existing participants */
        data class RoomJoined(val roomId: String, val callType: String, val participants: List<RoomPeer>, val sessionId: String) : CallEvent()
        /** A new peer joined the room (we are already in it) */
        data class RoomPeerJoined(val roomId: String, val peerId: String, val peerUsername: String) : CallEvent()
        /** A peer left the room */
        data class RoomPeerLeft(val roomId: String, val peerId: String, val peerUsername: String) : CallEvent()
        /** WebRTC offer from a room peer */
        data class RoomOffer(val roomId: String, val fromPeerId: String, val peerUsername: String, val sdp: String) : CallEvent()
        /** WebRTC answer from a room peer */
        data class RoomAnswer(val roomId: String, val fromPeerId: String, val sdp: String) : CallEvent()
        /** ICE candidate from a room peer */
        data class RoomIce(val roomId: String, val fromPeerId: String, val candidate: String) : CallEvent()
        /** Room not found / error */
        data class RoomError(val roomId: String, val reason: String) : CallEvent()
    }

    data class RoomPeer(val deviceId: String, val username: String)

    /** Send a call signaling message to a target device */
    fun sendCallSignal(type: String, callId: String, toDevice: String, extraPayload: JSONObject = JSONObject()) {
        val payload = JSONObject().apply {
            put("callId", callId)
            put("toDevice", toDevice)
            put("fromUsername", sessionManager.getUsername())
            extraPayload.keys().forEach { key -> put(key, extraPayload[key]) }
        }
        sendMessage(JSONObject().apply {
            put("type", type)
            put("deviceId", sessionManager.getDeviceId())
            put("payload", payload)
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    /** Send a group call room message */
    fun sendRoomSignal(type: String, extraPayload: JSONObject = JSONObject()) {
        sendMessage(JSONObject().apply {
            put("type", type)
            put("deviceId", sessionManager.getDeviceId())
            put("payload", extraPayload.apply {
                put("fromUsername", sessionManager.getUsername())
            })
            put("timestamp", System.currentTimeMillis())
        }.toString())
    }

    /** Expose deviceId for consumers (delegates to SessionManager) */
    fun getDeviceId(): String = sessionManager.getDeviceId()

    private fun parseGroupInfo(json: JSONObject): GroupInfo {
        val ids = mutableListOf<String>()
        val arr = json.optJSONArray("deviceIds")
        if (arr != null) for (i in 0 until arr.length()) ids.add(arr.optString(i))
        return GroupInfo(
            id = json.optString("id"),
            name = json.optString("name"),
            deviceIds = ids,
            color = json.optString("color", "#6C63FF"),
            createdBy = json.optString("createdBy")
        )
    }
}
