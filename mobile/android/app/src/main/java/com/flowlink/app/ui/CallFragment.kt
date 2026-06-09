package com.flowlink.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.service.WebSocketManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.webrtc.*

/**
 * CallFragment — handles audio/video calls via WebRTC.
 *
 * Fixes applied:
 * - cleanup() always runs on main thread via handler.post
 * - WebRTC init runs on IO dispatcher, never blocks main thread
 * - ICE candidates are buffered until remote description is set
 * - offer/answer races handled with pendingOffer + pendingCandidates queues
 */
class CallFragment : Fragment() {

    enum class CallState { RINGING_IN, RINGING_OUT, CONNECTING, ACTIVE, ENDED }

    companion object {
        private const val TAG = "CallFragment"
        const val ARG_CALL_ID = "callId"
        const val ARG_REMOTE_USERNAME = "remoteUsername"
        const val ARG_REMOTE_DEVICE = "remoteDevice"
        const val ARG_IS_VIDEO = "isVideo"
        const val ARG_DIRECTION = "direction"

        fun newIncoming(callId: String, fromUsername: String, fromDevice: String, isVideo: Boolean) =
            CallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_CALL_ID, callId)
                    putString(ARG_REMOTE_USERNAME, fromUsername)
                    putString(ARG_REMOTE_DEVICE, fromDevice)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "inbound")
                }
            }

        fun newOutgoing(callId: String, toUsername: String, toDevice: String, isVideo: Boolean) =
            CallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_CALL_ID, callId)
                    putString(ARG_REMOTE_USERNAME, toUsername)
                    putString(ARG_REMOTE_DEVICE, toDevice)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "outbound")
                }
            }
    }

    private lateinit var mainActivity: MainActivity
    private lateinit var wsManager: WebSocketManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private var callId = ""
    private var remoteUsername = ""
    private var remoteDevice = ""
    private var isVideo = false
    private var direction = "inbound"

    @Volatile private var callState = CallState.RINGING_IN

    // WebRTC — only accessed on main thread or with synchronization
    private var peerConnectionFactory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var localAudioTrack: AudioTrack? = null
    private var localVideoTrack: VideoTrack? = null
    private var videoCapturer: CameraVideoCapturer? = null
    private var remoteVideoView: SurfaceViewRenderer? = null
    private var localVideoView: SurfaceViewRenderer? = null
    private var eglBase: EglBase? = null

    // Queues to handle signaling races
    private var pendingOffer: String? = null          // raw JSON string
    private val pendingCandidates = mutableListOf<String>() // raw JSON strings
    private var remoteDescriptionSet = false

    private var isMuted = false
    private var isSpeakerOn = false

    // Duration timer
    private var durationSeconds = 0
    private val durationRunnable = object : Runnable {
        override fun run() {
            if (callState == CallState.ACTIVE && isAdded) {
                durationSeconds++
                view?.findViewById<TextView>(R.id.call_status)?.text = formatDuration(durationSeconds)
                mainHandler.postDelayed(this, 1000)
            }
        }
    }

    // Views
    private var btnAccept: ImageButton? = null
    private var btnEnd: ImageButton? = null
    private var btnMute: ImageButton? = null
    private var btnSpeaker: ImageButton? = null
    private var tvRemoteUsername: TextView? = null
    private var tvStatus: TextView? = null
    private var tvAvatar: TextView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mainActivity = activity as MainActivity
        wsManager = mainActivity.webSocketManager
        arguments?.let {
            callId = it.getString(ARG_CALL_ID, "")
            remoteUsername = it.getString(ARG_REMOTE_USERNAME, "Unknown")
            remoteDevice = it.getString(ARG_REMOTE_DEVICE, "")
            isVideo = it.getBoolean(ARG_IS_VIDEO, false)
            direction = it.getString(ARG_DIRECTION, "inbound")
        }
        callState = if (direction == "inbound") CallState.RINGING_IN else CallState.RINGING_OUT
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? =
        inflater.inflate(R.layout.fragment_call, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        remoteVideoView = view.findViewById(R.id.remote_video)
        localVideoView  = view.findViewById(R.id.local_video)
        btnAccept       = view.findViewById(R.id.btn_accept)
        btnEnd          = view.findViewById(R.id.btn_end)
        btnMute         = view.findViewById(R.id.btn_mute)
        btnSpeaker      = view.findViewById(R.id.btn_speaker)
        tvRemoteUsername = view.findViewById(R.id.remote_username)
        tvStatus        = view.findViewById(R.id.call_status)
        tvAvatar        = view.findViewById(R.id.avatar_text)

        tvRemoteUsername?.text = remoteUsername
        tvAvatar?.text = remoteUsername.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        updateUI()

        btnAccept?.setOnClickListener { acceptCall() }
        btnEnd?.setOnClickListener {
            if (callState == CallState.RINGING_IN) rejectCall() else endCall()
        }
        btnMute?.setOnClickListener { toggleMute() }
        btnSpeaker?.setOnClickListener { toggleSpeaker() }

        // Collect call signaling events
        lifecycleScope.launch {
            wsManager.callEvents.collect { event -> handleCallEvent(event) }
        }

        // Outbound: send invite right away
        if (direction == "outbound") {
            wsManager.sendCallSignal("call_invite", callId, remoteDevice,
                JSONObject().apply { put("isVideo", isVideo) })
            tvStatus?.text = "Calling…"
        }
    }

    // ── Signaling event dispatch ──────────────────────────────────────────

    private fun handleCallEvent(event: WebSocketManager.CallEvent) {
        // Always dispatch to main thread safely
        if (!isAdded) return
        mainHandler.post {
            if (!isAdded) return@post
            when (event) {
                is WebSocketManager.CallEvent.Accepted -> {
                    if (event.callId == callId && callState == CallState.RINGING_OUT) {
                        callState = CallState.CONNECTING
                        tvStatus?.text = "Connecting…"
                        initWebRTCAndSendOffer()
                    }
                }
                is WebSocketManager.CallEvent.Rejected -> {
                    if (event.callId == callId) {
                        tvStatus?.text = if (event.reason == "busy") "Line is busy" else "Call declined"
                        scheduleClose(1500)
                    }
                }
                is WebSocketManager.CallEvent.Ended -> {
                    if (event.callId == callId) {
                        tvStatus?.text = "Call ended"
                        scheduleClose(1500)
                    }
                }
                is WebSocketManager.CallEvent.Offer -> {
                    if (event.callId == callId) handleRemoteOffer(event.sdp)
                }
                is WebSocketManager.CallEvent.Answer -> {
                    if (event.callId == callId) handleRemoteAnswer(event.sdp)
                }
                is WebSocketManager.CallEvent.IceCandidate -> {
                    if (event.callId == callId) handleRemoteIce(event.candidate)
                }
                else -> {}
            }
        }
    }

    // ── Call control ──────────────────────────────────────────────────────

    private fun acceptCall() {
        if (callState != CallState.RINGING_IN) return
        callState = CallState.CONNECTING
        tvStatus?.text = "Connecting…"
        btnAccept?.visibility = View.GONE
        updateUI()

        // Send accept — caller will send offer upon receiving this
        wsManager.sendCallSignal("call_accept", callId, remoteDevice)

        // Initialise WebRTC in background so we're ready to handle the incoming offer
        lifecycleScope.launch { initWebRTCAsync() }
    }

    private fun rejectCall() {
        wsManager.sendCallSignal("call_reject", callId, remoteDevice,
            JSONObject().apply { put("reason", "rejected") })
        safeClose()
    }

    private fun endCall() {
        wsManager.sendCallSignal("call_end", callId, remoteDevice)
        safeCleanupAndClose()
    }

    // ── WebRTC init ───────────────────────────────────────────────────────

    /** Caller: init WebRTC then send offer */
    private fun initWebRTCAndSendOffer() {
        lifecycleScope.launch {
            initWebRTCAsync()
            if (!isAdded || peerConnection == null) return@launch

            val constraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", isVideo.toString()))
            }

            withContext(Dispatchers.IO) {
                peerConnection?.createOffer(object : SdpObserver {
                    override fun onCreateSuccess(sdp: SessionDescription) {
                        peerConnection?.setLocalDescription(object : SdpObserver {
                            override fun onSetSuccess() {
                                wsManager.sendCallSignal("call_offer", callId, remoteDevice,
                                    JSONObject().apply {
                                        put("data", JSONObject().apply {
                                            put("type", sdp.type.canonicalForm())
                                            put("sdp", sdp.description)
                                        })
                                    })
                            }
                            override fun onSetFailure(e: String?) { Log.e(TAG, "setLocalDesc failed: $e") }
                            override fun onCreateSuccess(p0: SessionDescription?) {}
                            override fun onCreateFailure(p0: String?) {}
                        }, sdp)
                    }
                    override fun onCreateFailure(e: String?) { Log.e(TAG, "createOffer failed: $e") }
                    override fun onSetSuccess() {}
                    override fun onSetFailure(p0: String?) {}
                }, constraints)
            }
        }
    }

    /** Runs WebRTC factory + PeerConnection init on IO, then returns to main */
    private suspend fun initWebRTCAsync() {
        if (!checkAudioPermission()) return

        withContext(Dispatchers.IO) {
            try {
                val ctx = requireContext().applicationContext

                // EglBase must be created before factory
                val egl = EglBase.create()

                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(ctx)
                        .createInitializationOptions()
                )

                val factory = PeerConnectionFactory.builder()
                    .setOptions(PeerConnectionFactory.Options())
                    .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
                    .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                    .createPeerConnectionFactory()

                val iceServers = listOf(
                    PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
                    PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
                    // TURN fallback for NAT traversal (open relay)
                    PeerConnection.IceServer.builder("turn:openrelay.metered.ca:80")
                        .setUsername("openrelayproject")
                        .setPassword("openrelayproject")
                        .createIceServer(),
                )

                val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
                    sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                    iceTransportsType = PeerConnection.IceTransportsType.ALL
                    bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                    rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
                    continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
                }

                val pc = factory.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
                    override fun onIceCandidate(candidate: IceCandidate) {
                        wsManager.sendCallSignal("call_ice", callId, remoteDevice,
                            JSONObject().apply {
                                put("data", JSONObject().apply {
                                    put("sdpMid", candidate.sdpMid)
                                    put("sdpMLineIndex", candidate.sdpMLineIndex)
                                    put("candidate", candidate.sdp)
                                })
                            })
                    }
                    override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
                        val track = receiver.track()
                        mainHandler.post {
                            if (!isAdded) return@post
                            if (track is VideoTrack) {
                                remoteVideoView?.visibility = View.VISIBLE
                                track.addSink(remoteVideoView)
                            }
                            if (callState != CallState.ACTIVE) {
                                callState = CallState.ACTIVE
                                updateUI()
                                mainHandler.post(durationRunnable)
                            }
                        }
                    }
                    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                        Log.d(TAG, "ICE state: $state")
                        mainHandler.post {
                            if (!isAdded) return@post
                            when (state) {
                                PeerConnection.IceConnectionState.CONNECTED,
                                PeerConnection.IceConnectionState.COMPLETED -> {
                                    if (callState != CallState.ACTIVE) {
                                        callState = CallState.ACTIVE
                                        updateUI()
                                        mainHandler.post(durationRunnable)
                                    }
                                }
                                PeerConnection.IceConnectionState.FAILED -> {
                                    tvStatus?.text = "Connection failed"
                                    scheduleClose(2000)
                                }
                                PeerConnection.IceConnectionState.DISCONNECTED -> {
                                    if (callState == CallState.ACTIVE) {
                                        tvStatus?.text = "Connection lost"
                                        scheduleClose(3000)
                                    }
                                }
                                else -> {}
                            }
                        }
                    }
                    override fun onSignalingChange(s: PeerConnection.SignalingState?) {}
                    override fun onIceConnectionReceivingChange(b: Boolean) {}
                    override fun onIceGatheringChange(s: PeerConnection.IceGatheringState?) {}
                    override fun onIceCandidatesRemoved(c: Array<out IceCandidate>?) {}
                    override fun onAddStream(s: MediaStream?) {}
                    override fun onRemoveStream(s: MediaStream?) {}
                    override fun onDataChannel(d: DataChannel?) {}
                    override fun onRenegotiationNeeded() {}
                })

                // Add audio track
                val audioSource = factory.createAudioSource(MediaConstraints())
                val audio = factory.createAudioTrack("audio0", audioSource)
                pc?.addTrack(audio)

                // Set audio mode for call
                mainHandler.post {
                    val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
                    am.mode = android.media.AudioManager.MODE_IN_COMMUNICATION
                    am.isSpeakerphoneOn = false
                }

                // Add video track
                var video: VideoTrack? = null
                if (isVideo) {
                    val cap = createCameraCapturer()
                    if (cap != null) {
                        val surfaceHelper = SurfaceTextureHelper.create("CaptureThread", egl.eglBaseContext)
                        val videoSource = factory.createVideoSource(cap.isScreencast)
                        cap.initialize(surfaceHelper, ctx, videoSource.capturerObserver)
                        cap.startCapture(640, 480, 30)
                        video = factory.createVideoTrack("video0", videoSource)
                        pc?.addTrack(video)
                        mainHandler.post {
                            if (!isAdded) return@post
                            localVideoView?.init(egl.eglBaseContext, null)
                            localVideoView?.setMirror(true)
                            localVideoView?.visibility = View.VISIBLE
                            video?.addSink(localVideoView)
                            remoteVideoView?.init(egl.eglBaseContext, null)
                        }
                        videoCapturer = cap
                    }
                }

                // Commit on main thread
                withContext(Dispatchers.Main) {
                    eglBase = egl
                    peerConnectionFactory = factory
                    peerConnection = pc
                    localAudioTrack = audio
                    localVideoTrack = video

                    // Process any signaling that arrived while we were initialising
                    pendingOffer?.let { offer ->
                        pendingOffer = null
                        handleRemoteOffer(offer)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "WebRTC init failed", e)
                mainHandler.post {
                    if (isAdded) {
                        tvStatus?.text = "Setup failed"
                        scheduleClose(1500)
                    }
                }
            }
        }
    }

    // ── Signaling handlers ────────────────────────────────────────────────

    /** Called on main thread */
    private fun handleRemoteOffer(sdpJson: String) {
        if (peerConnection == null) {
            // PC not ready yet — queue it
            pendingOffer = sdpJson
            return
        }
        val obj = runCatching { JSONObject(sdpJson) }.getOrNull() ?: return
        val sdp = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(obj.optString("type", "offer")),
            obj.optString("sdp", "")
        )
        peerConnection?.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
                remoteDescriptionSet = true
                // Drain buffered ICE candidates
                val candidates = synchronized(pendingCandidates) { pendingCandidates.toList().also { pendingCandidates.clear() } }
                candidates.forEach { applyCandidateJson(it) }

                val constraints = MediaConstraints()
                peerConnection?.createAnswer(object : SdpObserver {
                    override fun onCreateSuccess(answer: SessionDescription) {
                        peerConnection?.setLocalDescription(object : SdpObserver {
                            override fun onSetSuccess() {
                                wsManager.sendCallSignal("call_answer", callId, remoteDevice,
                                    JSONObject().apply {
                                        put("data", JSONObject().apply {
                                            put("type", answer.type.canonicalForm())
                                            put("sdp", answer.description)
                                        })
                                    })
                            }
                            override fun onSetFailure(e: String?) { Log.e(TAG, "setLocalDesc (answer) failed: $e") }
                            override fun onCreateSuccess(p0: SessionDescription?) {}
                            override fun onCreateFailure(p0: String?) {}
                        }, answer)
                    }
                    override fun onCreateFailure(e: String?) { Log.e(TAG, "createAnswer failed: $e") }
                    override fun onSetSuccess() {}
                    override fun onSetFailure(p0: String?) {}
                }, constraints)
            }
            override fun onSetFailure(e: String?) { Log.e(TAG, "setRemoteDesc (offer) failed: $e") }
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onCreateFailure(p0: String?) {}
        }, sdp)
    }

    /** Called on main thread */
    private fun handleRemoteAnswer(sdpJson: String) {
        if (peerConnection == null) return
        val obj = runCatching { JSONObject(sdpJson) }.getOrNull() ?: return
        val sdp = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(obj.optString("type", "answer")),
            obj.optString("sdp", "")
        )
        peerConnection?.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
                remoteDescriptionSet = true
                val candidates = synchronized(pendingCandidates) { pendingCandidates.toList().also { pendingCandidates.clear() } }
                candidates.forEach { applyCandidateJson(it) }
            }
            override fun onSetFailure(e: String?) { Log.e(TAG, "setRemoteDesc (answer) failed: $e") }
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onCreateFailure(p0: String?) {}
        }, sdp)
    }

    /** Called on main thread — buffer if remote desc not set yet */
    private fun handleRemoteIce(candidateJson: String) {
        if (remoteDescriptionSet) {
            applyCandidateJson(candidateJson)
        } else {
            synchronized(pendingCandidates) { pendingCandidates.add(candidateJson) }
        }
    }

    private fun applyCandidateJson(candidateJson: String) {
        try {
            val obj = JSONObject(candidateJson)
            val candidate = IceCandidate(
                obj.optString("sdpMid", ""),
                obj.optInt("sdpMLineIndex", 0),
                obj.optString("candidate", "")
            )
            peerConnection?.addIceCandidate(candidate)
        } catch (e: Exception) {
            Log.e(TAG, "addIceCandidate failed", e)
        }
    }

    // ── Controls ──────────────────────────────────────────────────────────

    private fun toggleMute() {
        isMuted = !isMuted
        localAudioTrack?.setEnabled(!isMuted)
        btnMute?.alpha = if (isMuted) 0.5f else 1.0f
        Toast.makeText(requireContext(), if (isMuted) "Muted" else "Unmuted", Toast.LENGTH_SHORT).show()
    }

    private fun toggleSpeaker() {
        isSpeakerOn = !isSpeakerOn
        val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
        am.isSpeakerphoneOn = isSpeakerOn
        btnSpeaker?.alpha = if (isSpeakerOn) 1.0f else 0.5f
    }

    private fun checkAudioPermission(): Boolean {
        if (ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            mainHandler.post {
                if (isAdded) {
                    tvStatus?.text = "Microphone permission required"
                    scheduleClose(2000)
                }
            }
            return false
        }
        return true
    }

    private fun createCameraCapturer(): CameraVideoCapturer? {
        return try {
            val enumerator = Camera2Enumerator(requireContext())
            enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }?.let { enumerator.createCapturer(it, null) }
                ?: enumerator.deviceNames.firstOrNull()?.let { enumerator.createCapturer(it, null) }
        } catch (e: Exception) {
            Log.e(TAG, "Camera capturer failed", e)
            null
        }
    }

    // ── UI ────────────────────────────────────────────────────────────────

    private fun updateUI() {
        when (callState) {
            CallState.RINGING_IN -> {
                tvStatus?.text = "Incoming ${if (isVideo) "video" else "audio"} call"
                btnAccept?.visibility = View.VISIBLE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
            }
            CallState.RINGING_OUT -> {
                tvStatus?.text = "Calling…"
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
            }
            CallState.CONNECTING -> {
                tvStatus?.text = "Connecting…"
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
            }
            CallState.ACTIVE -> {
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.VISIBLE
                btnSpeaker?.visibility = View.VISIBLE
            }
            CallState.ENDED -> {
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
            }
        }
    }

    private fun formatDuration(s: Int) = "%02d:%02d".format(s / 60, s % 60)

    // ── Lifecycle / cleanup ───────────────────────────────────────────────

    /** Schedule close — always safe, runs on main thread */
    private fun scheduleClose(delayMs: Long = 1500) {
        callState = CallState.ENDED
        updateUI()
        mainHandler.postDelayed({ safeCleanupAndClose() }, delayMs)
    }

    /** Cleanup resources then pop the fragment — always on main thread */
    private fun safeCleanupAndClose() {
        mainHandler.post {
            cleanup()
            safeClose()
        }
    }

    private fun safeClose() {
        if (!isAdded) return
        try { parentFragmentManager.popBackStack() } catch (e: Exception) { Log.e(TAG, "popBackStack failed", e) }
    }

    private fun cleanup() {
        mainHandler.removeCallbacks(durationRunnable)
        synchronized(pendingCandidates) { pendingCandidates.clear() }
        pendingOffer = null
        remoteDescriptionSet = false

        try { videoCapturer?.stopCapture() } catch (_: Exception) {}
        try { videoCapturer?.dispose() } catch (_: Exception) {}
        videoCapturer = null

        try { localAudioTrack?.dispose() } catch (_: Exception) {}
        try { localVideoTrack?.dispose() } catch (_: Exception) {}
        localAudioTrack = null
        localVideoTrack = null

        try { peerConnection?.close() } catch (_: Exception) {}
        peerConnection = null

        try { peerConnectionFactory?.dispose() } catch (_: Exception) {}
        peerConnectionFactory = null

        try { localVideoView?.release() } catch (_: Exception) {}
        try { remoteVideoView?.release() } catch (_: Exception) {}

        try { eglBase?.release() } catch (_: Exception) {}
        eglBase = null

        // Restore audio mode
        try {
            val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
            am.mode = android.media.AudioManager.MODE_NORMAL
            am.isSpeakerphoneOn = false
        } catch (_: Exception) {}
    }

    override fun onDestroyView() {
        super.onDestroyView()
        // Always clean up on destroy to prevent ANR when system kills the fragment
        cleanup()
        mainHandler.removeCallbacksAndMessages(null)
    }
}
