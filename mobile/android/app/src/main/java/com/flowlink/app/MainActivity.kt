package com.flowlink.app

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.lifecycleScope
import com.flowlink.app.BuildConfig
import com.flowlink.app.databinding.ActivityMainBinding
import com.flowlink.app.model.Intent as FlowIntent
import com.flowlink.app.model.ChatMessage
import com.flowlink.app.service.ClipboardSyncService
import com.flowlink.app.service.ScreenCaptureService
import com.flowlink.app.service.SessionManager
import com.flowlink.app.service.WebSocketManager
import com.flowlink.app.service.InvitationListenerService
import com.flowlink.app.ui.DeviceTilesFragment
import com.flowlink.app.ui.SessionCreatedFragment
import com.flowlink.app.ui.SessionManagerFragment
import com.flowlink.app.ui.InvitationDialogFragment
import com.flowlink.app.ui.UsernameDialogFragment
import com.flowlink.app.ui.HomeFragment
import com.flowlink.app.ui.ChatFragment
import com.flowlink.app.ui.ShareFragment
import com.flowlink.app.ui.FilesFragment
import com.flowlink.app.ui.MoreFragment
import com.flowlink.app.ui.BrowserFragment
import com.flowlink.app.service.NotificationService
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class MainActivity : AppCompatActivity(), UsernameDialogFragment.UsernameDialogListener, InvitationDialogFragment.InvitationDialogListener {
    private lateinit var binding: ActivityMainBinding
    lateinit var sessionManager: SessionManager
    lateinit var webSocketManager: WebSocketManager
    lateinit var notificationService: NotificationService
    private var clipboardSyncEnabled = false
    private var pendingScreenShareViewerDeviceId: String? = null
    
    // Persistent chat messages (survives fragment recreation and app restart)
    val chatMessages = mutableListOf<ChatMessage>()
    // Notify ChatFragment when a new message arrives while it's open
    val newMessageEvent = kotlinx.coroutines.flow.MutableSharedFlow<Int>(extraBufferCapacity = 32)
    
    // Load chat messages from SharedPreferences
    private fun loadChatMessages() {
        try {
            val prefs = getSharedPreferences("flowlink_chat", Context.MODE_PRIVATE)
            val sessionId = sessionManager.getCurrentSessionId() ?: return
            val json = prefs.getString("chat_$sessionId", null) ?: return
            
            val jsonArray = JSONArray(json)
            chatMessages.clear()
            for (i in 0 until jsonArray.length()) {
                val obj = jsonArray.getJSONObject(i)
                chatMessages.add(ChatMessage(
                    messageId = obj.getString("messageId"),
                    text = obj.optString("text", ""),
                    username = obj.getString("username"),
                    sourceDevice = obj.getString("sourceDevice"),
                    targetDevice = obj.getString("targetDevice"),
                    sentAt = obj.getLong("sentAt"),
                    delivered = obj.optBoolean("delivered", false),
                    seen = obj.optBoolean("seen", false),
                    fileId = if (obj.has("fileId")) obj.getString("fileId") else null,
                    fileName = if (obj.has("fileName")) obj.getString("fileName") else null,
                    fileType = if (obj.has("fileType")) obj.getString("fileType") else null,
                    fileSize = obj.optLong("fileSize", 0L),
                    fileData = if (obj.has("fileData")) obj.getString("fileData") else null,
                    replyToId = if (obj.has("replyToId")) obj.getString("replyToId") else null,
                    replyToText = if (obj.has("replyToText")) obj.getString("replyToText") else null,
                    replyToUsername = if (obj.has("replyToUsername")) obj.getString("replyToUsername") else null
                ))
            }
            android.util.Log.d("FlowLink", "Loaded ${chatMessages.size} chat messages from storage")
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to load chat messages", e)
        }
    }
    
    // Save chat messages to SharedPreferences
    fun saveChatMessages() {
        try {
            val prefs = getSharedPreferences("flowlink_chat", Context.MODE_PRIVATE)
            val sessionId = sessionManager.getCurrentSessionId() ?: return
            
            val jsonArray = JSONArray()
            chatMessages.takeLast(200).forEach { msg ->
                jsonArray.put(JSONObject().apply {
                    put("messageId", msg.messageId)
                    put("text", msg.text)
                    put("username", msg.username)
                    put("sourceDevice", msg.sourceDevice)
                    put("targetDevice", msg.targetDevice)
                    put("sentAt", msg.sentAt)
                    put("delivered", msg.delivered)
                    put("seen", msg.seen)
                    msg.fileId?.let { put("fileId", it) }
                    msg.fileName?.let { put("fileName", it) }
                    msg.fileType?.let { put("fileType", it) }
                    put("fileSize", msg.fileSize)
                    msg.fileData?.let { put("fileData", it) }
                    msg.replyToId?.let { put("replyToId", it) }
                    msg.replyToText?.let { put("replyToText", it) }
                    msg.replyToUsername?.let { put("replyToUsername", it) }
                })
            }
            
            prefs.edit().putString("chat_$sessionId", jsonArray.toString()).apply()
            android.util.Log.d("FlowLink", "Saved ${chatMessages.size} chat messages to storage")
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to save chat messages", e)
        }
    }
    
    private val clipboardReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            // Clipboard sync is handled by InvitationListenerService so it
            // continues working when the activity is not visible.
        }
    }

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted: Boolean ->
        if (isGranted) {
            // Permission granted
        } else {
            Toast.makeText(this, "Camera permission required for QR scanning", Toast.LENGTH_LONG).show()
        }
    }

    private val requestNotificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted: Boolean ->
        if (isGranted) {
            android.util.Log.d("FlowLink", "Notification permission granted")
        } else {
            Toast.makeText(this, "Notification permission is required to receive invitations", Toast.LENGTH_LONG).show()
        }
    }

    private val qrCodeLauncher = registerForActivityResult(ScanContract()) { result ->
        if (result.contents != null) {
            val sessionCode = result.contents
            joinSession(sessionCode)
        }
    }

    private val screenCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val viewerDeviceId = pendingScreenShareViewerDeviceId
        pendingScreenShareViewerDeviceId = null

        if (viewerDeviceId.isNullOrBlank()) {
            return@registerForActivityResult
        }

        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            Toast.makeText(this, "Screen sharing permission denied", Toast.LENGTH_SHORT).show()
            return@registerForActivityResult
        }

        val sessionId = sessionManager.getCurrentSessionId()
        if (sessionId.isNullOrBlank()) {
            Toast.makeText(this, "Not in a session", Toast.LENGTH_SHORT).show()
            return@registerForActivityResult
        }

        val foregroundIntent = Intent(this, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_START_FOREGROUND
        }
        ContextCompat.startForegroundService(this, foregroundIntent)

        val captureIntent = Intent(this, ScreenCaptureService::class.java).apply {
            action = ScreenCaptureService.ACTION_START_CAPTURE
            putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, result.resultCode)
            putExtra(ScreenCaptureService.EXTRA_DATA, result.data)
            putExtra(ScreenCaptureService.EXTRA_SESSION_ID, sessionId)
            putExtra(ScreenCaptureService.EXTRA_SOURCE_DEVICE_ID, sessionManager.getDeviceId())
            putExtra(ScreenCaptureService.EXTRA_VIEWER_DEVICE_ID, viewerDeviceId)
        }
        startService(captureIntent)

        Toast.makeText(this, "Screen sharing started", Toast.LENGTH_SHORT).show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Initialize managers
        sessionManager = SessionManager(this)
        webSocketManager = WebSocketManager(this)
        notificationService = NotificationService(this)
        (application as? FlowLinkApplication)?.initWebSocketManager(webSocketManager)

        // Check auth - redirect to AuthActivity if not logged in
        if (!com.flowlink.app.ui.AuthActivity.isLoggedIn(this)) {
            startActivity(android.content.Intent(this, com.flowlink.app.ui.AuthActivity::class.java))
            finish()
            return
        }

        // Sync username from auth token into SessionManager
        val authUsername = com.flowlink.app.ui.AuthActivity.getUsername(this)
        if (authUsername.isNotEmpty()) {
            sessionManager.setUsername(authUsername)
        }

        // Sync friends and inbox from DB on login
        lifecycleScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            syncFriendsFromDb()
            syncInboxFromDb()
        }

        initializeApp(savedInstanceState)
    }

    private fun showUsernameDialog() {
        // Legacy - no longer used, kept for interface compliance
    }

    override fun onUsernameSubmitted(username: String) {
        sessionManager.setUsername(username)
        initializeApp(null)
    }
    
    private fun initializeApp(savedInstanceState: Bundle?) {
        
        // Request notification permission for Android 13+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) 
                != PackageManager.PERMISSION_GRANTED) {
                requestNotificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        
        // Connect to WebSocket immediately to receive invitations
        // even when not in a session
        try {
            if (webSocketManager.connectionState.value !is WebSocketManager.ConnectionState.Connected) {
                android.util.Log.d("FlowLink", "Connecting WebSocket for invitation listening")
                webSocketManager.connect("") // Empty code - just for listening to invitations
            }
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to connect WebSocket", e)
        }
        
        val username = sessionManager.getUsername()
        val deviceId = sessionManager.getDeviceId()
        val deviceName = sessionManager.getDeviceName()
        
        if (username.isNotEmpty() && deviceId.isNotEmpty() && deviceName.isNotEmpty()) {
            InvitationListenerService.startService(this, username, deviceId, deviceName)
        } else {
            android.util.Log.w("FlowLink", "Cannot start InvitationListenerService: missing username, deviceId, or deviceName")
        }

        // Start clipboard sync service
        startClipboardSyncService()

        // Collect ALL incoming chat messages at app level so they persist
        // regardless of whether ChatFragment is currently visible
        lifecycleScope.launch {
            webSocketManager.chatEvents.collect { event ->
                if (event is WebSocketManager.ChatEvent.Message) {
                    val selfId = sessionManager.getDeviceId()
                    // Avoid duplicates (ChatFragment may also add the same message)
                    if (chatMessages.none { it.messageId == event.messageId }) {
                        chatMessages.add(
                            com.flowlink.app.model.ChatMessage(
                                messageId = event.messageId,
                                text = event.text,
                                username = event.username,
                                sourceDevice = event.sourceDevice,
                                targetDevice = event.targetDevice,
                                sentAt = event.sentAt,
                                delivered = true,
                                seen = false,
                                fileId = event.fileId,
                                fileName = event.fileName,
                                fileType = event.fileType,
                                fileSize = event.fileSize,
                                fileData = event.fileData,
                                replyToId = event.replyToId,
                                replyToText = event.replyToText,
                                replyToUsername = event.replyToUsername
                            )
                        )
                        newMessageEvent.tryEmit(chatMessages.size - 1)
                        saveChatMessages() // Save after adding new message
                    }
                }
                if (event is WebSocketManager.ChatEvent.Delivered) {
                    val idx = chatMessages.indexOfFirst { it.messageId == event.messageId }
                    if (idx >= 0) {
                        chatMessages[idx] = chatMessages[idx].copy(delivered = true)
                        saveChatMessages() // Save after status update
                    }
                }
                if (event is WebSocketManager.ChatEvent.Seen) {
                    val idx = chatMessages.indexOfFirst { it.messageId == event.messageId }
                    if (idx >= 0) {
                        chatMessages[idx] = chatMessages[idx].copy(delivered = true, seen = true)
                        saveChatMessages() // Save after status update
                    }
                }
            }
        }

        // React to intents received from backend (e.g., links, media, clipboard, files)
        lifecycleScope.launch {
            webSocketManager.receivedIntents.collectLatest { remoteIntent: FlowIntent? ->
                if (remoteIntent != null) {
                    handleRemoteIntent(remoteIntent)
                }
            }
        }

        // React to device connections to update UI
        lifecycleScope.launch {
            webSocketManager.deviceConnected.collectLatest { deviceInfo ->
                deviceInfo?.let {
                    // Update device tiles fragment if it's showing
                    val fragment = supportFragmentManager.findFragmentById(R.id.fragment_container)
                    if (fragment is DeviceTilesFragment) {
                        // Fragment will handle updating its UI
                        android.util.Log.d("FlowLink", "Device connected: ${it.name}")
                    }
                }
            }
        }

        // React to session creation
        lifecycleScope.launch {
            webSocketManager.sessionCreated.collectLatest { event ->
                event?.let {
                    showSessionCreated(it.code, it.sessionId)
                }
            }
        }

        // React to session expiry
        lifecycleScope.launch {
            webSocketManager.sessionExpired.collectLatest { expired ->
                if (expired) {
                    // Session expired, navigate back to session manager
                    runOnUiThread {
                        Toast.makeText(this@MainActivity, "Session ended", Toast.LENGTH_SHORT).show()
                        binding.bottomNav.visibility = View.GONE
                        supportFragmentManager.beginTransaction()
                            .replace(R.id.fragment_container, SessionManagerFragment())
                            .commitAllowingStateLoss()
                    }
                }
            }
        }

        // Check camera permission
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissionLauncher.launch(Manifest.permission.CAMERA)
        }

        // Setup bottom navigation
        binding.bottomNav.setOnItemSelectedListener { item ->
            showSessionTab(item.itemId)
            true
        }
        // Initially hide bottom nav (shown only when in session)
        binding.bottomNav.visibility = View.GONE

        // Show session manager fragment
        if (savedInstanceState == null) {
            supportFragmentManager.beginTransaction()
                .replace(R.id.fragment_container, SessionManagerFragment())
                .commit()
        }

        // Handle incoming intents (file shares, etc.)
        handleIntent(intent)

        // Start listening for incoming calls
        listenForIncomingCalls()
    }

    override fun onResume() {
        super.onResume()
        // Check if we have an active session and should show DeviceTiles
        val currentCode = sessionManager.getCurrentSessionCode()
        val currentSessionId = sessionManager.getCurrentSessionId()
        val hasActiveSession = sessionManager.hasActiveSession()
        val connectionState = webSocketManager.connectionState.value
        
        android.util.Log.d("FlowLink", "onResume: code=$currentCode, sessionId=$currentSessionId, active=$hasActiveSession, connectionState=$connectionState")
        
        // Load chat messages from storage when app resumes
        if (hasActiveSession && currentSessionId != null) {
            loadChatMessages()
        }
        
        // CRITICAL FIX #1: Always reconnect WebSocket when app comes to foreground
        // This ensures device stays connected even after backgrounding
        if (hasActiveSession && currentCode != null) {
            if (connectionState is WebSocketManager.ConnectionState.Disconnected || 
                connectionState is WebSocketManager.ConnectionState.Error) {
                android.util.Log.d("FlowLink", "Reconnecting WebSocket on resume with code: $currentCode")
                webSocketManager.connect(currentCode)
            } else if (connectionState is WebSocketManager.ConnectionState.Connected) {
                // Even if connected, re-register device to ensure backend knows we're active
                android.util.Log.d("FlowLink", "Re-registering device on resume")
                webSocketManager.sendMessage(org.json.JSONObject().apply {
                    put("type", "device_register")
                    put("payload", org.json.JSONObject().apply {
                        put("deviceId", sessionManager.getDeviceId())
                        put("deviceName", sessionManager.getDeviceName())
                        put("deviceType", sessionManager.getDeviceType())
                        put("username", sessionManager.getUsername())
                    })
                    put("timestamp", System.currentTimeMillis())
                }.toString())
            }
        }
        
        // If we have a session but are showing SessionManagerFragment, navigate to DeviceTiles
        val currentFragment = supportFragmentManager.findFragmentById(R.id.fragment_container)
        if (hasActiveSession && currentCode != null && currentSessionId != null && currentFragment is SessionManagerFragment) {
            android.util.Log.d("FlowLink", "Restoring DeviceTiles view for existing session")
            showDeviceTiles(currentSessionId)
        }
    }
    
    override fun onPause() {
        super.onPause()
        // Don't disconnect WebSocket when app goes to background
        // Let it maintain connection for receiving invitations and messages
        android.util.Log.d("FlowLink", "onPause: Keeping WebSocket connected in background")
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        intent?.let { handleIntent(it) }
    }

    private fun handleIntent(intent: Intent) {
        when (intent.action) {
            Intent.ACTION_VIEW -> {
                // Handle file/view intents from FlowLink
                val uri = intent.data
                if (uri != null) {
                    // Process file intent
                    lifecycleScope.launch {
                        sessionManager.handleIncomingFile(uri)
                    }
                }
            }
            NotificationService.ACTION_ACCEPT_INVITATION -> {
                // Handle invitation acceptance
                val sessionId = intent.getStringExtra(NotificationService.EXTRA_SESSION_ID)
                val sessionCode = intent.getStringExtra(NotificationService.EXTRA_SESSION_CODE)
                val inviterUsername = intent.getStringExtra(NotificationService.EXTRA_INVITER_USERNAME)
                
                if (sessionCode != null) {
                    // Send acceptance response
                    sendInvitationResponse(sessionId ?: "", true, inviterUsername ?: "")
                    // Join the session
                    joinSession(sessionCode)
                }
                // Clear the notification
                notificationService.clearNotification(NotificationService.NOTIFICATION_ID_INVITATION)
            }
            NotificationService.ACTION_REJECT_INVITATION -> {
                // Handle invitation rejection
                val sessionId = intent.getStringExtra(NotificationService.EXTRA_SESSION_ID)
                val inviterUsername = intent.getStringExtra(NotificationService.EXTRA_INVITER_USERNAME)
                
                // Send rejection response
                sendInvitationResponse(sessionId ?: "", false, inviterUsername ?: "")
                // Clear the notification
                notificationService.clearNotification(NotificationService.NOTIFICATION_ID_INVITATION)
                
                Toast.makeText(this, "Invitation declined", Toast.LENGTH_SHORT).show()
            }
            NotificationService.ACTION_JOIN_NEARBY -> {
                // Handle nearby session join
                val sessionCode = intent.getStringExtra(NotificationService.EXTRA_SESSION_CODE)
                
                if (sessionCode != null) {
                    joinSession(sessionCode)
                }
                // Clear the notification
                notificationService.clearNotification(NotificationService.NOTIFICATION_ID_NEARBY)
            }
            NotificationService.ACTION_OPEN_TAB_HANDOFF -> {
                val tabHandoffJson = intent.getStringExtra(NotificationService.EXTRA_TAB_HANDOFF)
                if (!tabHandoffJson.isNullOrBlank()) {
                    openTabHandoff(JSONObject(tabHandoffJson))
                }
            }
        }
    }

    fun createSession() {
        lifecycleScope.launch {
            try {
                // Connect to WebSocket first (with empty code, will send session_create after connection)
                if (webSocketManager.connectionState.value !is WebSocketManager.ConnectionState.Connected) {
                    webSocketManager.connect("") // Empty code for now
                    
                    // Wait a bit for connection to establish
                    kotlinx.coroutines.delay(500)
                }
                
                // Send session_create message to backend
                webSocketManager.sendMessage(org.json.JSONObject().apply {
                    put("type", "session_create")
                    put("payload", org.json.JSONObject().apply {
                        put("deviceId", sessionManager.getDeviceId())
                        put("deviceName", sessionManager.getDeviceName())
                        put("deviceType", sessionManager.getDeviceType())
                        put("username", sessionManager.getUsername())
                    })
                    put("timestamp", System.currentTimeMillis())
                }.toString())
                
                android.util.Log.d("FlowLink", "Sent session_create request")
                // Wait for session_created response (handled in WebSocketManager)
                // The response will trigger showing the QR code fragment
            } catch (e: Exception) {
                android.util.Log.e("FlowLink", "Failed to create session", e)
                Toast.makeText(this@MainActivity, "Failed to create session: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    fun joinSession(code: String) {
        lifecycleScope.launch {
            try {
                if (webSocketManager.connectionState.value is WebSocketManager.ConnectionState.Connected) {
                    webSocketManager.disconnect()
                    kotlinx.coroutines.delay(150)
                }

                // Persist the attempted code locally so intents (if join succeeds)
                // can be routed correctly once we know the real backend sessionId.
                val session = sessionManager.joinSession(code)

                // Connect to backend signaling using the scanned/entered code.
                // WebSocketManager will send session_join on open.
                webSocketManager.connect(code)

                // Wait for backend confirmation or error before navigating.
                webSocketManager.sessionJoinState.collectLatest { state ->
                    when (state) {
                        is WebSocketManager.SessionJoinState.Success -> {
                            // Ensure we have the real sessionId from backend. The
                            // WebSocketManager already updates SessionManager with the
                            // canonical id; we use the id from the event to show tiles.
                            val backendSessionId = state.sessionId.ifEmpty {
                                sessionManager.getCurrentSessionId() ?: session.sessionId
                            }
                            showDeviceTiles(backendSessionId)
                            // Once we navigate, stop collecting to avoid duplicate navigation
                            return@collectLatest
                        }
                        is WebSocketManager.SessionJoinState.Error -> {
                            // Show backend error (e.g., "Invalid session code") and
                            // clear the temporary local session so user can retry.
                            Toast.makeText(
                                this@MainActivity,
                                state.message,
                                Toast.LENGTH_LONG
                            ).show()
                            sessionManager.setSessionActive(false)
                            sessionManager.leaveSession()
                            webSocketManager.disconnect()
                            // Stop collecting after handling error
                            return@collectLatest
                        }
                        else -> {
                            // Idle / InProgress: just keep waiting
                        }
                    }
                }
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, "Failed to join session: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    fun scanQRCode() {
        val options = ScanOptions()
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        options.setPrompt("Scan FlowLink QR Code")
        options.setCameraId(0)
        options.setBeepEnabled(false)
        options.setBarcodeImageEnabled(true)
        qrCodeLauncher.launch(options)
    }

    fun showDeviceTiles(sessionId: String) {
        // Show bottom nav and navigate to Home tab
        runOnUiThread {
            binding.bottomNav.visibility = View.VISIBLE
            binding.bottomNav.animate().alpha(1f).translationY(0f).setDuration(300).start()
            showSessionTab(R.id.nav_home)
        }
    }

    fun navigateToSubFragment(fragment: androidx.fragment.app.Fragment) {
        runOnUiThread {
            try {
                supportFragmentManager.beginTransaction()
                    .replace(R.id.fragment_container, fragment)
                    .addToBackStack(null)
                    .commitAllowingStateLoss()
            } catch (e: Exception) {
                android.util.Log.e("FlowLink", "navigateToSubFragment failed", e)
            }
        }
    }

    // ── DB sync helpers ────────────────────────────────────────────────────
    private fun httpUrl() = com.flowlink.app.service.BackendConfig.WS_URL
        .replace("wss://", "https://").replace("ws://", "http://")

    private fun authToken() = com.flowlink.app.ui.AuthActivity.getToken(this) ?: ""

    fun syncFriendsFromDb() {
        try {
            val url = java.net.URL("${httpUrl()}/user/friends")
            val conn = url.openConnection() as java.net.HttpURLConnection
            conn.setRequestProperty("Authorization", "Bearer ${authToken()}")
            conn.connectTimeout = 8000; conn.readTimeout = 8000
            if (conn.responseCode !in 200..299) return
            val json = org.json.JSONObject(conn.inputStream.bufferedReader().readText())
            val arr = json.optJSONArray("friends") ?: return
            val list = mutableListOf<com.flowlink.app.model.Friend>()
            for (i in 0 until arr.length()) {
                val r = arr.getJSONObject(i)
                list.add(com.flowlink.app.model.Friend(
                    username = r.optString("friend_username"),
                    deviceName = "",
                    deviceId = r.optString("friend_device_id", ""),
                    status = "accepted"
                ))
            }
            // Save to SharedPreferences
            val prefs = getSharedPreferences(
                "flowlink_friends_${authToken().let { com.flowlink.app.ui.AuthActivity.getUsername(this).lowercase() }}",
                android.content.Context.MODE_PRIVATE
            )
            prefs.edit().putString("list", com.google.gson.Gson().toJson(list)).apply()
            android.util.Log.d("FlowLink", "Synced ${list.size} friends from DB")
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to sync friends from DB", e)
        }
    }

    fun syncInboxFromDb() {
        try {
            val url = java.net.URL("${httpUrl()}/user/inbox")
            val conn = url.openConnection() as java.net.HttpURLConnection
            conn.setRequestProperty("Authorization", "Bearer ${authToken()}")
            conn.connectTimeout = 8000; conn.readTimeout = 8000
            if (conn.responseCode !in 200..299) return
            val json = org.json.JSONObject(conn.inputStream.bufferedReader().readText())
            val arr = json.optJSONArray("inbox") ?: return
            val list = mutableListOf<com.flowlink.app.ui.InboxItem>()
            for (i in 0 until arr.length()) {
                val r = arr.getJSONObject(i)
                val status = r.optString("status", "pending")
                if (status == "pending") {
                    list.add(com.flowlink.app.ui.InboxItem(
                        id = r.optString("request_id"),
                        type = "friend_request",
                        title = "Friend Request",
                        body = "${r.optString("from_username")} wants to be your friend",
                        fromUsername = r.optString("from_username"),
                        fromDeviceId = r.optString("from_device_id", ""),
                        timestamp = try { java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.getDefault()).parse(r.optString("sent_at"))?.time ?: System.currentTimeMillis() } catch (_: Exception) { System.currentTimeMillis() }
                    ))
                }
            }
            // Save to SharedPreferences (merge with existing)
            val username = com.flowlink.app.ui.AuthActivity.getUsername(this).lowercase()
            val prefsKey = if (username.isNotEmpty()) "flowlink_inbox_$username" else "flowlink_inbox"
            val prefs = getSharedPreferences(prefsKey, android.content.Context.MODE_PRIVATE)
            val existing = com.flowlink.app.ui.InboxFragment.loadItems(this).toMutableList()
            // Add DB items that aren't already in local
            val existingIds = existing.map { it.id }.toSet()
            list.filter { it.id !in existingIds }.forEach { existing.add(0, it) }
            prefs.edit().putString("items", com.google.gson.Gson().toJson(existing.take(50))).apply()
            android.util.Log.d("FlowLink", "Synced ${list.size} inbox items from DB")
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to sync inbox from DB", e)
        }
    }

    fun persistFriendToDb(friendUsername: String, friendDeviceId: String) {
        lifecycleScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            try {
                val url = java.net.URL("${httpUrl()}/user/friends")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer ${authToken()}")
                conn.doOutput = true; conn.connectTimeout = 8000; conn.readTimeout = 8000
                conn.outputStream.write(org.json.JSONObject().apply {
                    put("friendUsername", friendUsername); put("friendDeviceId", friendDeviceId)
                }.toString().toByteArray())
                conn.responseCode // trigger request
            } catch (e: Exception) { android.util.Log.e("FlowLink", "Failed to persist friend to DB", e) }
        }
    }

    fun persistInboxToDb(fromUsername: String, fromDeviceId: String, requestId: String) {
        lifecycleScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            try {
                val url = java.net.URL("${httpUrl()}/user/inbox")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer ${authToken()}")
                conn.doOutput = true; conn.connectTimeout = 8000; conn.readTimeout = 8000
                conn.outputStream.write(org.json.JSONObject().apply {
                    put("fromUsername", fromUsername); put("fromDeviceId", fromDeviceId)
                    put("requestId", requestId); put("status", "pending")
                }.toString().toByteArray())
                conn.responseCode
            } catch (e: Exception) { android.util.Log.e("FlowLink", "Failed to persist inbox to DB", e) }
        }
    }

    fun updateInboxStatusInDb(requestId: String, status: String) {
        lifecycleScope.launch(kotlinx.coroutines.Dispatchers.IO) {
            try {
                val url = java.net.URL("${httpUrl()}/user/inbox/$requestId")
                val conn = url.openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "PATCH"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer ${authToken()}")
                conn.doOutput = true; conn.connectTimeout = 8000; conn.readTimeout = 8000
                conn.outputStream.write(org.json.JSONObject().apply { put("status", status) }.toString().toByteArray())
                conn.responseCode
            } catch (e: Exception) { android.util.Log.e("FlowLink", "Failed to update inbox in DB", e) }
        }
    }

    fun showSessionCreated(code: String, sessionId: String) {
        val currentFragment = supportFragmentManager.findFragmentById(R.id.fragment_container)
        if (currentFragment is SessionCreatedFragment) {
            return
        }

        supportFragmentManager.beginTransaction()
            .replace(R.id.fragment_container, SessionCreatedFragment.newInstance(code, sessionId))
            .addToBackStack(null)
            .commit()
    }

    private fun showSessionTab(tabId: Int) {
        val fragment = when (tabId) {
            R.id.nav_home -> HomeFragment.newInstance()
            R.id.nav_chat -> ChatFragment.newInstance()
            R.id.nav_share -> ShareFragment.newInstance()
            R.id.nav_files -> FilesFragment.newInstance()
            R.id.nav_more -> MoreFragment.newInstance()
            else -> HomeFragment.newInstance()
        }
        val tag = when (tabId) {
            R.id.nav_home -> "home"
            R.id.nav_chat -> "chat"
            R.id.nav_share -> "share"
            R.id.nav_files -> "files"
            R.id.nav_more -> "more"
            else -> "home"
        }
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragment_container, fragment, tag)
            .commit()
        if (binding.bottomNav.selectedItemId != tabId) {
            binding.bottomNav.menu.findItem(tabId)?.isChecked = true
        }
    }

    fun leaveSession() {
        // Run everything on Main to avoid IllegalStateException from fragment transactions
        lifecycleScope.launch(kotlinx.coroutines.Dispatchers.Main) {
            // Send leave message (best-effort)
            val sessionId = sessionManager.getCurrentSessionId()
            if (sessionId != null) {
                try {
                    webSocketManager.sendMessage(org.json.JSONObject().apply {
                        put("type", "session_leave")
                        put("sessionId", sessionId)
                        put("deviceId", sessionManager.getDeviceId())
                        put("timestamp", System.currentTimeMillis())
                    }.toString())
                } catch (_: Exception) {}
            }

            // Disconnect and clear state
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                try { webSocketManager.disconnect() } catch (_: Exception) {}
            }
            try { sessionManager.setSessionActive(false) } catch (_: Exception) {}
            try { sessionManager.leaveSession() } catch (_: Exception) {}
            chatMessages.clear()

            // Navigate back — single safe transaction, no popBackStack
            try {
                binding.bottomNav.visibility = View.GONE
                supportFragmentManager.beginTransaction()
                    .replace(R.id.fragment_container, SessionManagerFragment())
                    .commitAllowingStateLoss()
            } catch (e: Exception) {
                android.util.Log.e("FlowLink", "Error navigating after leave: ${e.message}", e)
            }
        }
    }

    /**
     * Handle intents coming from other devices via the backend.
     * This is where links/media are opened and clipboard/text or files are applied on the phone.
     */
    private fun handleRemoteIntent(intent: FlowIntent) {
        when (intent.intentType) {
            "tab_handoff", "tab_collection_handoff" -> {
                val payload = intent.payload ?: return
                val tabJson = payload["tab_handoff"] ?: payload["tabs"] ?: return
                try {
                    openTabHandoff(JSONObject(tabJson))
                } catch (e: Exception) {
                    Toast.makeText(this, "Failed to open tab handoff", Toast.LENGTH_SHORT).show()
                }
            }
            "link_open" -> {
                val payload = intent.payload ?: return
                val linkJson = payload["link"] ?: return
                try {
                    val url = JSONObject(linkJson).getString("url")
                    val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(browserIntent)
                } catch (e: Exception) {
                    Toast.makeText(this, "Failed to open link", Toast.LENGTH_SHORT).show()
                }
            }
            "media_continuation" -> {
                val payload = intent.payload ?: return
                val mediaJsonStr = payload["media"] ?: return
                try {
                    // Parse media JSON string
                    val media = JSONObject(mediaJsonStr)
                    val baseUrl = media.optString("url", "")
                    val timestamp = media.optInt("timestamp", 0)
                    val mediaType = media.optString("type", "video")
                    val fileJsonStr = payload["file"]

                    if (fileJsonStr != null) {
                        // Media sent with an attached file (binary data)
                        try {
                            val fileJson = JSONObject(fileJsonStr)
                            // Determine MIME type from media type or file extension
                            val mimeType = when (mediaType) {
                                "video" -> "video/*"
                                "audio" -> "audio/*"
                                else -> media.optString("type", "video/*")
                            }
                            openReceivedFile(fileJson, mimeType)
                        } catch (e: Exception) {
                            android.util.Log.e("FlowLink", "Failed to parse file JSON", e)
                            Toast.makeText(this, "Failed to open media file: ${e.message}", Toast.LENGTH_SHORT).show()
                        }
                        return
                    }
                    
                    // Check if URL is a blob URL (won't work on Android)
                    if (baseUrl.startsWith("blob:")) {
                        android.util.Log.e("FlowLink", "Blob URLs are not supported on Android")
                        Toast.makeText(this, "Media file must be sent as a file, not a URL. Please drag the file directly.", Toast.LENGTH_LONG).show()
                        return
                    }

                    if (baseUrl.isNotEmpty()) {
                        // Build URL with timestamp for media continuation
                        var finalUrl = baseUrl
                        
                        // Add timestamp parameter based on service type
                        when {
                            baseUrl.contains("youtube.com") || baseUrl.contains("youtu.be") -> {
                                // YouTube: use t= parameter (in seconds)
                                // Format: &t=120 or ?t=120 (YouTube accepts both with and without 's')
                                if (timestamp > 0) {
                                    val separator = if (baseUrl.contains("?")) "&" else "?"
                                    // Remove any existing t= parameter first
                                    val urlWithoutTimestamp = baseUrl.replace(Regex("[?&]t=\\d+[s]?"), "")
                                    finalUrl = "$urlWithoutTimestamp${separator}t=$timestamp"
                                    android.util.Log.d("FlowLink", "YouTube URL with timestamp: $finalUrl")
                                } else {
                                    finalUrl = baseUrl
                                }
                            }
                            baseUrl.contains("spotify.com") -> {
                                // Spotify: use #t= parameter (format: mm:ss)
                                if (timestamp > 0) {
                                    val minutes = timestamp / 60
                                    val seconds = timestamp % 60
                                    finalUrl = "$baseUrl#t=$minutes:$seconds"
                                }
                            }
                            else -> {
                                // Generic media URL: try t= or #t=
                                if (timestamp > 0) {
                                    val separator = if (baseUrl.contains("?")) "&" else if (baseUrl.contains("#")) "" else "?"
                                    finalUrl = "$baseUrl${separator}t=$timestamp"
                                }
                            }
                        }
                        
                        android.util.Log.d("FlowLink", "Opening media: $finalUrl (timestamp: ${timestamp}s)")
                        val mediaIntent = Intent(Intent.ACTION_VIEW, Uri.parse(finalUrl)).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        startActivity(mediaIntent)
                    }
                } catch (e: Exception) {
                    android.util.Log.e("FlowLink", "Failed to open media", e)
                    Toast.makeText(this, "Failed to open media: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
            "clipboard_sync" -> {
                val payload = intent.payload ?: return
                val clipboardJson = payload["clipboard"] ?: return
                try {
                    val clipboardObj = JSONObject(clipboardJson)
                    val text = clipboardObj.optString("text", "")
                    
                    // Check if this is a remote access permission request
                    if (text == "ENABLE_REMOTE_ACCESS" || text == "DISABLE_REMOTE_ACCESS") {
                        // This is handled by the frontend permission system
                        // Android doesn't need to do anything special, just acknowledge
                        android.util.Log.d("FlowLink", "Remote access permission: $text")
                        // The permission update is handled by the backend/frontend
                        return
                    }
                    
                    if (text.isNotEmpty()) {
                        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                        val clip = ClipData.newPlainText("FlowLink", text)
                        clipboard.setPrimaryClip(clip)
                        Toast.makeText(this, "Text copied to clipboard", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(this, "Failed to copy text", Toast.LENGTH_SHORT).show()
                }
            }
            "remote_access_request" -> {
                val payload = intent.payload ?: return
                val requestJson = payload["request"] ?: return
                try {
                    val requestObj = JSONObject(requestJson)
                    val action = requestObj.optString("action", "")
                    
                    if (action == "start_screen_share") {
                        // Show permission dialog for screen sharing
                        val sourceDeviceName = intent.sourceDevice ?: "Unknown Device"
                        android.app.AlertDialog.Builder(this)
                            .setTitle("Remote Access Request")
                            .setMessage("$sourceDeviceName wants to view your screen. Allow screen sharing?")
                            .setPositiveButton("Allow") { _, _ ->
                                // Start screen sharing
                                startScreenSharing(intent.sourceDevice ?: "")
                            }
                            .setNegativeButton("Deny") { _, _ ->
                                Toast.makeText(this, "Screen sharing denied", Toast.LENGTH_SHORT).show()
                            }
                            .show()
                    }
                } catch (e: Exception) {
                    android.util.Log.e("FlowLink", "Failed to handle remote access request", e)
                    Toast.makeText(this, "Failed to handle remote access request", Toast.LENGTH_SHORT).show()
                }
            }
            "prompt_injection" -> {
                val payload = intent.payload ?: return
                val promptJson = payload["prompt"] ?: return
                try {
                    val prompt = JSONObject(promptJson)
                    val text = prompt.optString("text", "")
                    if (text.isNotEmpty()) {
                        val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("FlowLink Prompt", text))
                        Toast.makeText(this, "Prompt copied to clipboard", Toast.LENGTH_SHORT).show()
                    }
                } catch (e: Exception) {
                    Toast.makeText(this, "Failed to handle prompt", Toast.LENGTH_SHORT).show()
                }
            }
            "file_handoff" -> {
                val payload = intent.payload ?: return
                val fileJson = payload["file"] ?: return
                try {
                    val fileObj = JSONObject(fileJson)
                    if (!fileObj.has("data") && !fileObj.has("dataBase64")) return
                    openReceivedFile(fileObj, null)
                } catch (e: Exception) {
                    Toast.makeText(this, "Failed to handle received file", Toast.LENGTH_SHORT).show()
                }
            }
            "batch_file_handoff" -> {
                val payload = intent.payload ?: return
                val filesJson = payload["files"] ?: return
                try {
                    handleBatchFileHandoff(filesJson)
                } catch (e: Exception) {
                    android.util.Log.e("FlowLink", "Failed to handle batch files", e)
                    Toast.makeText(this, "Failed to handle batch files: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    fun handleTabHandoffPayload(payload: JSONObject) {
        openTabHandoff(payload)
    }

    private fun openTabHandoff(payload: JSONObject) {
        val tabs = payload.optJSONArray("tabs") ?: return
        if (tabs.length() == 0) {
            return
        }

        val tabIntent = Intent(this, TabMirrorActivity::class.java).apply {
            putExtra(NotificationService.EXTRA_TAB_HANDOFF, payload.toString())
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        startActivity(tabIntent)
    }

    private fun openReceivedFile(fileObj: JSONObject, fallbackMimeType: String?) {
        if (!fileObj.has("data")) {
            return
        }

        val name = fileObj.optString("name", "flowlink-file")
        var type = fileObj.optString("type", fallbackMimeType ?: "*/*")
        
        // If type is generic or missing, try to detect from file extension
        if (type == "*/*" || type.isEmpty()) {
            type = when {
                name.endsWith(".mp4", ignoreCase = true) -> "video/mp4"
                name.endsWith(".mp3", ignoreCase = true) -> "audio/mpeg"
                name.endsWith(".avi", ignoreCase = true) -> "video/x-msvideo"
                name.endsWith(".mov", ignoreCase = true) -> "video/quicktime"
                name.endsWith(".wav", ignoreCase = true) -> "audio/wav"
                name.endsWith(".m4a", ignoreCase = true) -> "audio/mp4"
                name.endsWith(".webm", ignoreCase = true) -> "video/webm"
                name.endsWith(".ogg", ignoreCase = true) -> "audio/ogg"
                name.endsWith(".pdf", ignoreCase = true) -> "application/pdf"
                name.endsWith(".jpg", ignoreCase = true) || name.endsWith(".jpeg", ignoreCase = true) -> "image/jpeg"
                name.endsWith(".png", ignoreCase = true) -> "image/png"
                else -> "*/*"
            }
        }
        
        val bytes = when {
            fileObj.has("data") && fileObj.opt("data") is JSONArray -> {
                val dataArray = fileObj.getJSONArray("data")
                ByteArray(dataArray.length()).also { out ->
                    for (i in 0 until dataArray.length()) out[i] = dataArray.getInt(i).toByte()
                }
            }
            fileObj.has("dataBase64") -> {
                android.util.Base64.decode(fileObj.getString("dataBase64"), android.util.Base64.DEFAULT)
            }
            else -> return
        }

        // Write to cache directory
        val outFile = File(cacheDir, name)
        outFile.outputStream().use { it.write(bytes) }

        val uri = FileProvider.getUriForFile(this, "${BuildConfig.APPLICATION_ID}.fileprovider", outFile)

        android.util.Log.d("FlowLink", "Opening file: $name, type: $type, uri: $uri")

        // Create intent with proper MIME type
        val openIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, type)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            // Add category for better app selection
            addCategory(Intent.CATEGORY_DEFAULT)
        }

        try {
            // Check if there's an app that can handle this intent
            val resolveInfo = packageManager.queryIntentActivities(openIntent, PackageManager.MATCH_DEFAULT_ONLY)
            if (resolveInfo.isEmpty()) {
                // No app found, try with a more generic type
                android.util.Log.w("FlowLink", "No app found for type $type, trying generic")
                openIntent.setDataAndType(uri, "*/*")
                val genericResolveInfo = packageManager.queryIntentActivities(openIntent, PackageManager.MATCH_DEFAULT_ONLY)
                if (genericResolveInfo.isEmpty()) {
                    throw Exception("No activity found to handle intent")
                }
            }
            
            // Use chooser to let user pick the app
            val chooser = Intent.createChooser(openIntent, "Open $name with")
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            startActivity(chooser)
        } catch (e: android.content.ActivityNotFoundException) {
            android.util.Log.e("FlowLink", "No activity found to handle file", e)
            Toast.makeText(this, "No app found to open $name. Please install a media player app.", Toast.LENGTH_LONG).show()
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to open file", e)
            Toast.makeText(this, "Failed to open file: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    fun openReceivedTransferFile(file: File, fileName: String, fileType: String, sourceDevice: String) {
        try {
            val inferredType = if (fileType.isBlank()) "*/*" else fileType
            val isImage = inferredType.startsWith("image/")

            // Save to Downloads via MediaStore (no FileProvider needed)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                val collection = if (isImage)
                    android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                else
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                    put(android.provider.MediaStore.MediaColumns.MIME_TYPE, inferredType)
                    put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(collection, values)
                if (uri != null) {
                    contentResolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } }
                    values.clear()
                    values.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0)
                    contentResolver.update(uri, values, null, null)
                    // Open the file
                    val openIntent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, inferredType)
                        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                        addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    val chooser = android.content.Intent.createChooser(openIntent, "Open $fileName").apply {
                        addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    startActivity(chooser)
                    notificationService.showFileReceived(fileName, sourceDevice.ifBlank { "Device" }, uri.toString())
                    return
                }
            }

            // Fallback: save to cache and open via FileProvider
            val cacheFile = File(cacheDir, "flowlink_recv_${System.currentTimeMillis()}_$fileName")
            file.copyTo(cacheFile, overwrite = true)
            val uri = androidx.core.content.FileProvider.getUriForFile(this, "${BuildConfig.APPLICATION_ID}.fileprovider", cacheFile)
            val openIntent = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
                setDataAndType(uri, inferredType)
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = android.content.Intent.createChooser(openIntent, "Open $fileName").apply {
                addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(chooser)
            notificationService.showFileReceived(fileName, sourceDevice.ifBlank { "Device" }, cacheFile.absolutePath)
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to open received transfer file", e)
            Toast.makeText(this, "Received $fileName - saved to Downloads", Toast.LENGTH_LONG).show()
        }
    }

    private fun handleBatchFileHandoff(filesJsonString: String) {
        try {
            val filesJson = JSONObject(filesJsonString)
            val totalFiles = filesJson.getInt("totalFiles")
            val totalSize = filesJson.getLong("totalSize")
            val batchId = filesJson.getString("batchId")
            
            android.util.Log.d("FlowLink", "📦 Batch Transfer: $totalFiles files (${totalSize / 1024 / 1024}MB)")
            
            // Create batch folder with timestamp
            val timestamp = java.text.SimpleDateFormat("yyyy-MM-dd-HH-mm-ss", java.util.Locale.getDefault()).format(java.util.Date())
            val batchFolderName = "FlowLink-Batch-$timestamp"
            
            // Get Downloads directory
            val downloadsDir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
            val batchDir = File(downloadsDir, batchFolderName)
            
            // Create batch directory
            if (!batchDir.exists()) {
                batchDir.mkdirs()
            }
            
            val filesArray = filesJson.getJSONArray("files")
            var successCount = 0
            var errorCount = 0
            
            // Process each file in the batch
            for (i in 0 until filesArray.length()) {
                try {
                    val fileObj = filesArray.getJSONObject(i)
                    val fileName = fileObj.getString("name")
                    val fileSize = fileObj.getLong("size")
                    
                    // Get file data (it's stored as a number array in JSON)
                    val dataArray = fileObj.getJSONArray("data")
                    val byteArray = ByteArray(dataArray.length())
                    for (j in 0 until dataArray.length()) {
                        byteArray[j] = dataArray.getInt(j).toByte()
                    }
                    
                    // Save file to batch directory
                    val file = File(batchDir, fileName)
                    file.outputStream().use { it.write(byteArray) }
                    
                    successCount++
                    android.util.Log.d("FlowLink", "✅ Saved: $fileName (${byteArray.size} bytes)")
                    
                } catch (e: Exception) {
                    android.util.Log.e("FlowLink", "❌ Failed to save file ${i + 1}", e)
                    errorCount++
                }
            }
            
            // Show completion notification with action to open folder
            val message = if (errorCount == 0) {
                "✅ $successCount files saved to $batchFolderName"
            } else {
                "Batch complete: ✅ $successCount saved, ❌ $errorCount failed"
            }
            
            // Create notification with action to open Downloads folder
            showBatchTransferNotification(message, batchDir)
            
            android.util.Log.d("FlowLink", "📦 Batch transfer complete: $successCount/$totalFiles files saved to ${batchDir.absolutePath}")
            
        } catch (e: Exception) {
            android.util.Log.e("FlowLink", "Failed to handle batch file transfer", e)
            Toast.makeText(this, "Failed to process batch files: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun showBatchTransferNotification(message: String, batchDir: File) {
        // Show toast first
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        
        // Also try to open the Downloads folder directly
        try {
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(
                    androidx.core.content.FileProvider.getUriForFile(
                        this@MainActivity,
                        "${BuildConfig.APPLICATION_ID}.fileprovider",
                        batchDir
                    ),
                    "resource/folder"
                )
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            
            // Try to open with file manager
            val chooser = Intent.createChooser(intent, "Open folder with")
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(chooser)
            
        } catch (e: Exception) {
            android.util.Log.w("FlowLink", "Could not open folder directly, trying alternative method", e)
            
            // Fallback: try to open Downloads folder in general
            try {
                val downloadsIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(
                        Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADownload"),
                        "vnd.android.document/directory"
                    )
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                startActivity(downloadsIntent)
            } catch (e2: Exception) {
                android.util.Log.w("FlowLink", "Could not open Downloads folder", e2)
                // Final fallback: show a dialog with instructions
                android.app.AlertDialog.Builder(this)
                    .setTitle("Files Saved")
                    .setMessage("$message\n\nYou can find the files in Downloads/${batchDir.name}")
                    .setPositiveButton("OK", null)
                    .show()
            }
        }
    }

    private fun startScreenSharing(viewerDeviceId: String) {
        android.util.Log.d("FlowLink", "Starting screen sharing for viewer: $viewerDeviceId")

        val sessionId = sessionManager.getCurrentSessionId()
        if (sessionId == null) {
            Toast.makeText(this, "Not in a session", Toast.LENGTH_SHORT).show()
            return
        }

        pendingScreenShareViewerDeviceId = viewerDeviceId
        val mediaProjectionManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        screenCaptureLauncher.launch(mediaProjectionManager.createScreenCaptureIntent())
    }
    
    override fun onDestroy() {
        super.onDestroy()
    }
    
    private fun startClipboardSyncService() {
        val serviceIntent = Intent(this, ClipboardSyncService::class.java)
        startService(serviceIntent)
        enableClipboardSync()
    }
    
    private fun stopClipboardSyncService() {
        val serviceIntent = Intent(this, ClipboardSyncService::class.java)
        stopService(serviceIntent)
    }
    
    fun enableClipboardSync() {
        clipboardSyncEnabled = true
        val intent = Intent(this, ClipboardSyncService::class.java)
        intent.action = ClipboardSyncService.ACTION_ENABLE
        startService(intent)
        android.util.Log.d("FlowLink", "📋 Clipboard sync enabled")
    }
    
    fun disableClipboardSync() {
        clipboardSyncEnabled = false
        val intent = Intent(this, ClipboardSyncService::class.java)
        intent.action = ClipboardSyncService.ACTION_DISABLE
        startService(intent)
        android.util.Log.d("FlowLink", "📋 Clipboard sync disabled")
    }
    
    private fun sendClipboardToAllDevices(text: String) {
        android.util.Log.d("FlowLink", "📋 Sending clipboard to all devices: ${text.take(50)}...")
        
        lifecycleScope.launch {
            try {
                val clipboardJson = org.json.JSONObject().apply {
                    put("text", text)
                }
                
                webSocketManager.sendMessage(org.json.JSONObject().apply {
                    put("type", "clipboard_broadcast")
                    put("sessionId", sessionManager.getCurrentSessionId() ?: org.json.JSONObject.NULL)
                    put("deviceId", sessionManager.getDeviceId())
                    put("payload", org.json.JSONObject().apply {
                        put("clipboard", clipboardJson)
                        sessionManager.getPreferredTargetUsername()?.takeIf { it.isNotBlank() }?.let {
                            put("targetUsername", it)
                        }
                    })
                    put("timestamp", System.currentTimeMillis())
                }.toString())
            } catch (e: Exception) {
                android.util.Log.e("FlowLink", "Failed to send clipboard", e)
            }
        }
    }
    
    fun updateClipboardFromRemote(text: String?, html: String? = null, imageDataUrl: String? = null, url: String? = null) {
        val intent = Intent(this, ClipboardSyncService::class.java)
        intent.action = ClipboardSyncService.ACTION_UPDATE_CLIPBOARD
        intent.putExtra(ClipboardSyncService.EXTRA_TEXT, text)
        intent.putExtra(ClipboardSyncService.EXTRA_HTML, html)
        intent.putExtra(ClipboardSyncService.EXTRA_IMAGE_DATA_URL, imageDataUrl)
        intent.putExtra(ClipboardSyncService.EXTRA_URL, url)
        startService(intent)
    }

    // InvitationDialogListener implementation
    override fun sendInvitation(targetUser: String, message: String?) {
        lifecycleScope.launch {
            try {
                val sessionId = sessionManager.getCurrentSessionId()
                val sessionCode = sessionManager.getCurrentSessionCode()
                
                if (sessionId == null || sessionCode == null) {
                    Toast.makeText(this@MainActivity, "No active session", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                val invitationJson = org.json.JSONObject().apply {
                    put("sessionId", sessionId)
                    put("sessionCode", sessionCode)
                    put("inviterUsername", sessionManager.getUsername())
                    put("inviterDeviceName", sessionManager.getDeviceName())
                    if (message != null) {
                        put("message", message)
                    }
                }

                webSocketManager.sendMessage(org.json.JSONObject().apply {
                    put("type", "session_invitation")
                    put("sessionId", sessionId)
                    put("deviceId", sessionManager.getDeviceId())
                    put("payload", org.json.JSONObject().apply {
                        put("targetIdentifier", targetUser)
                        put("invitation", invitationJson)
                    })
                    put("timestamp", System.currentTimeMillis())
                }.toString())

                android.util.Log.d("FlowLink", "Sent invitation to: $targetUser")
            } catch (e: Exception) {
                android.util.Log.e("FlowLink", "Failed to send invitation", e)
                Toast.makeText(this@MainActivity, "Failed to send invitation", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun broadcastNearby() {
        lifecycleScope.launch {
            try {
                val sessionId = sessionManager.getCurrentSessionId()
                
                if (sessionId == null) {
                    Toast.makeText(this@MainActivity, "No active session", Toast.LENGTH_SHORT).show()
                    return@launch
                }

                webSocketManager.sendMessage(org.json.JSONObject().apply {
                    put("type", "nearby_session_broadcast")
                    put("sessionId", sessionId)
                    put("deviceId", sessionManager.getDeviceId())
                    put("payload", org.json.JSONObject())
                    put("timestamp", System.currentTimeMillis())
                }.toString())

                android.util.Log.d("FlowLink", "Broadcasted to nearby devices")
            } catch (e: Exception) {
                android.util.Log.e("FlowLink", "Failed to broadcast nearby", e)
                Toast.makeText(this@MainActivity, "Failed to broadcast to nearby devices", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun getSessionCode(): String {
        return sessionManager.getCurrentSessionCode() ?: ""
    }

    override fun getSessionId(): String {
        return sessionManager.getCurrentSessionId() ?: ""
    }

    private fun sendInvitationResponse(sessionId: String, accepted: Boolean, inviterUsername: String) {
        lifecycleScope.launch {
            try {
                webSocketManager.sendMessage(org.json.JSONObject().apply {
                    put("type", "invitation_response")
                    put("sessionId", sessionId)
                    put("deviceId", sessionManager.getDeviceId())
                    put("payload", org.json.JSONObject().apply {
                        put("accepted", accepted)
                        put("inviteeUsername", sessionManager.getUsername())
                        put("inviteeDeviceName", sessionManager.getDeviceName())
                    })
                    put("timestamp", System.currentTimeMillis())
                }.toString())

                android.util.Log.d("FlowLink", "Sent invitation response: $accepted to $inviterUsername")
            } catch (e: Exception) {
                android.util.Log.e("FlowLink", "Failed to send invitation response", e)
            }
        }
    }

    // ── Call handling ──────────────────────────────────────────────────────

    /** Start an outgoing call to a remote device */
    fun startOutgoingCall(toUsername: String, toDeviceId: String, isVideo: Boolean) {
        val callId = "call_${System.currentTimeMillis()}_${(1000..9999).random()}"
        val fragment = com.flowlink.app.ui.CallFragment.newOutgoing(callId, toUsername, toDeviceId, isVideo)
        runOnUiThread {
            supportFragmentManager.beginTransaction()
                .add(R.id.fragment_container, fragment, "call")
                .addToBackStack("call")
                .commitAllowingStateLoss()
        }
    }

    /** Called from WebSocketManager call event collector — shows incoming call UI */
    private fun showIncomingCall(callId: String, fromUsername: String, fromDevice: String, isVideo: Boolean) {
        val fragment = com.flowlink.app.ui.CallFragment.newIncoming(callId, fromUsername, fromDevice, isVideo)
        runOnUiThread {
            supportFragmentManager.beginTransaction()
                .add(R.id.fragment_container, fragment, "call")
                .addToBackStack("call")
                .commitAllowingStateLoss()
        }
    }

    private fun listenForIncomingCalls() {
        lifecycleScope.launch {
            webSocketManager.callEvents.collect { event ->
                if (event is com.flowlink.app.service.WebSocketManager.CallEvent.Incoming) {
                    showIncomingCall(event.callId, event.fromUsername, event.fromDevice, event.isVideo)
                }
            }
        }
    }

    // ── Floating call bubble ───────────────────────────────────────────────

    private var callBubbleView: android.view.View? = null

    /** Attach the floating minimized call bubble to the window decor */
    @android.annotation.SuppressLint("ClickableViewAccessibility")
    fun showCallBubble() {
        if (callBubbleView != null) return                        // already showing
        if (!com.flowlink.app.service.CallSession.isActive) return

        val decor = window.decorView as? android.widget.FrameLayout ?: return
        val bubble = layoutInflater.inflate(R.layout.overlay_call_minimized, decor, false)

        // Populate
        val avatarTv = bubble.findViewById<android.widget.TextView>(R.id.bubble_avatar)
        val timerTv  = bubble.findViewById<android.widget.TextView>(R.id.bubble_timer)
        val endBtn   = bubble.findViewById<android.view.View>(R.id.bubble_btn_end)
        val videoSv  = bubble.findViewById<org.webrtc.SurfaceViewRenderer?>(R.id.bubble_video)
        val audioBg  = bubble.findViewById<android.view.View?>(R.id.bubble_audio_bg)

        avatarTv.text = com.flowlink.app.service.CallSession.remoteUsername
            .firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        timerTv.text  = if (com.flowlink.app.service.CallSession.state ==
            com.flowlink.app.service.CallSession.State.ACTIVE)
            "%02d:%02d".format(com.flowlink.app.service.CallSession.durationSec / 60,
                com.flowlink.app.service.CallSession.durationSec % 60)
        else "Calling…"

        // Show local video preview inside bubble for video calls
        if (com.flowlink.app.service.CallSession.isVideo) {
            val egl    = com.flowlink.app.service.CallSession.eglBase
            val vTrack = com.flowlink.app.service.CallSession.localVideoTrack
            if (egl != null && vTrack != null && videoSv != null) {
                runCatching {
                    videoSv.init(egl.eglBaseContext, null)
                    videoSv.setMirror(com.flowlink.app.service.CallSession.usingFrontCamera)
                    videoSv.setEnableHardwareScaler(true)
                    vTrack.addSink(videoSv)
                    videoSv.visibility = android.view.View.VISIBLE
                    audioBg?.visibility = android.view.View.GONE
                }
            }
        }

        // End call button
        endBtn.setOnClickListener {
            webSocketManager.sendCallSignal(
                "call_end",
                com.flowlink.app.service.CallSession.callId,
                com.flowlink.app.service.CallSession.remoteDevice
            )
            hideBubbleAndRestoreIfNeeded()
            com.flowlink.app.service.CallSession.cleanup()
            runOnUiThread {
                val am = getSystemService(AUDIO_SERVICE) as android.media.AudioManager
                am.mode = android.media.AudioManager.MODE_NORMAL
                am.isSpeakerphoneOn = false
                volumeControlStream = android.media.AudioManager.USE_DEFAULT_STREAM_TYPE
            }
        }

        // Tap bubble body → restore call fragment
        bubble.setOnClickListener { restoreCallFromBubble() }

        // Draggable
        var startRawX = 0f; var startRawY = 0f
        var origX = 0f;     var origY = 0f
        var isDragging = false
        bubble.setOnTouchListener { v, event ->
            when (event.action) {
                android.view.MotionEvent.ACTION_DOWN -> {
                    startRawX = event.rawX; startRawY = event.rawY
                    origX = v.x; origY = v.y; isDragging = false; false
                }
                android.view.MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - startRawX
                    val dy = event.rawY - startRawY
                    if (!isDragging && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) isDragging = true
                    if (isDragging) { v.x = origX + dx; v.y = origY + dy; true }
                    else false
                }
                android.view.MotionEvent.ACTION_UP -> {
                    if (!isDragging) {
                        // Snap to nearest edge for a cleaner look
                        val parentW = decor.width
                        val midX = parentW / 2f
                        v.animate().x(if (v.x + v.width / 2f < midX) 16f
                                      else parentW - v.width - 16f)
                            .setDuration(200).start()
                    }
                    false
                }
                else -> false
            }
        }

        // Initial position — bottom-left, above bottom nav
        val params = android.widget.FrameLayout.LayoutParams(
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
            android.widget.FrameLayout.LayoutParams.WRAP_CONTENT)
        decor.addView(bubble, params)

        bubble.post {
            bubble.x = 24f
            bubble.y = (decor.height - bubble.height - 180).toFloat().coerceAtLeast(80f)
            // Pop-in animation
            bubble.scaleX = 0f; bubble.scaleY = 0f; bubble.alpha = 0f
            bubble.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(280)
                .setInterpolator(android.view.animation.OvershootInterpolator(1.4f)).start()
        }

        callBubbleView = bubble
    }

    /** Remove the bubble from the decor */
    fun hideBubbleAndRestoreIfNeeded() {
        val bubble = callBubbleView ?: return
        callBubbleView = null
        // Release bubble video sink
        runCatching {
            val sv = bubble.findViewById<org.webrtc.SurfaceViewRenderer?>(R.id.bubble_video)
            if (sv?.visibility == android.view.View.VISIBLE) {
                com.flowlink.app.service.CallSession.localVideoTrack?.removeSink(sv)
                sv.release()
            }
        }
        val decor = window.decorView as? android.widget.FrameLayout
        bubble.animate().scaleX(0f).scaleY(0f).alpha(0f).setDuration(200)
            .withEndAction { decor?.removeView(bubble) }.start()
    }

    /** Update the timer text shown on the bubble while call is minimized */
    fun updateBubbleTimer(text: String) {
        callBubbleView?.findViewById<android.widget.TextView>(R.id.bubble_timer)?.text = text
    }

    /** Re-add CallFragment on top of whatever is currently shown */
    private fun restoreCallFromBubble() {
        if (!com.flowlink.app.service.CallSession.isActive) {
            hideBubbleAndRestoreIfNeeded(); return
        }
        hideBubbleAndRestoreIfNeeded()
        val fragment = com.flowlink.app.ui.CallFragment.restore()
        runOnUiThread {
            supportFragmentManager.beginTransaction()
                .add(R.id.fragment_container, fragment, "call")
                .addToBackStack("call")
                .commitAllowingStateLoss()
        }
    }
}
