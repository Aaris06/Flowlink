package com.flowlink.app.ui

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioManager
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

class CallFragment : Fragment() {

    enum class CallState { RINGING_IN, RINGING_OUT, CONNECTING, ACTIVE, ENDED }

    companion object {
        private const val TAG = "CallFragment"
        const val ARG_CALL_ID       = "callId"
        const val ARG_REMOTE_NAME   = "remoteUsername"
        const val ARG_REMOTE_DEVICE = "remoteDevice"
        const val ARG_IS_VIDEO      = "isVideo"
        const val ARG_DIRECTION     = "direction"

        fun newIncoming(callId: String, fromUsername: String, fromDevice: String, isVideo: Boolean) =
            CallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_CALL_ID, callId)
                    putString(ARG_REMOTE_NAME, fromUsername)
                    putString(ARG_REMOTE_DEVICE, fromDevice)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "inbound")
                }
            }

        fun newOutgoing(callId: String, toUsername: String, toDevice: String, isVideo: Boolean) =
            CallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_CALL_ID, callId)
                    putString(ARG_REMOTE_NAME, toUsername)
                    putString(ARG_REMOTE_DEVICE, toDevice)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "outbound")
                }
            }
    }

    private lateinit var mainActivity: MainActivity
    private lateinit var wsManager: WebSocketManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private var callId         = ""
    private var remoteUsername = ""
    private var remoteDevice   = ""
    private var isVideo        = false
    private var direction      = "inbound"
    @Volatile private var callState = CallState.RINGING_IN

    // WebRTC objects
    private var eglBase               : EglBase? = null
    private var peerConnectionFactory : PeerConnectionFactory? = null
    private var peerConnection        : PeerConnection? = null
    private var localAudioTrack       : AudioTrack? = null
    private var localVideoTrack       : VideoTrack? = null
    private var videoCapturer         : CameraVideoCapturer? = null
    private var surfaceTextureHelper  : SurfaceTextureHelper? = null

    // Signaling race queues
    private var pendingOffer      : String? = null
    private val pendingCandidates = mutableListOf<String>()
    @Volatile private var remoteDescSet = false

    // Camera state
    private var usingFrontCamera = true
    private var cameraEnabled    = true

    // Views (nullable — safe after onDestroyView)
    private var remoteVideoView : SurfaceViewRenderer? = null
    private var localVideoView  : SurfaceViewRenderer? = null
    private var btnAccept       : ImageButton? = null
    private var btnEnd          : ImageButton? = null
    private var btnMute         : ImageButton? = null
    private var btnSpeaker      : ImageButton? = null
    private var btnCameraOff    : ImageButton? = null
    private var btnSwitchCamera : ImageButton? = null
    private var btnMinimize     : ImageButton? = null
    private var tvUsername      : TextView? = null
    private var tvStatus        : TextView? = null
    private var tvAvatar        : TextView? = null

    private var isMuted     = false
    private var isSpeakerOn = false

    private var durationSec = 0
    private val durationTick = object : Runnable {
        override fun run() {
            if (callState == CallState.ACTIVE && isAdded) {
                durationSec++
                tvStatus?.text = formatDuration(durationSec)
                mainHandler.postDelayed(this, 1000)
            }
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mainActivity = activity as MainActivity
        wsManager    = mainActivity.webSocketManager
        arguments?.let {
            callId         = it.getString(ARG_CALL_ID, "")
            remoteUsername = it.getString(ARG_REMOTE_NAME, "Unknown")
            remoteDevice   = it.getString(ARG_REMOTE_DEVICE, "")
            isVideo        = it.getBoolean(ARG_IS_VIDEO, false)
            direction      = it.getString(ARG_DIRECTION, "inbound")
        }
        callState = if (direction == "inbound") CallState.RINGING_IN else CallState.RINGING_OUT
    }

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View? =
        i.inflate(R.layout.fragment_call, c, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        remoteVideoView = view.findViewById(R.id.remote_video)
        localVideoView  = view.findViewById(R.id.local_video)
        btnAccept       = view.findViewById(R.id.btn_accept)
        btnEnd          = view.findViewById(R.id.btn_end)
        btnMute         = view.findViewById(R.id.btn_mute)
        btnSpeaker      = view.findViewById(R.id.btn_speaker)
        btnCameraOff    = view.findViewById(R.id.btn_camera_off)
        btnSwitchCamera = view.findViewById(R.id.btn_switch_camera)
        btnMinimize     = view.findViewById(R.id.btn_minimize)
        tvUsername      = view.findViewById(R.id.remote_username)
        tvStatus        = view.findViewById(R.id.call_status)
        tvAvatar        = view.findViewById(R.id.avatar_text)

        tvUsername?.text = remoteUsername
        tvAvatar?.text   = remoteUsername.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        updateUI()

        btnAccept?.setOnClickListener       { acceptCall() }
        btnEnd?.setOnClickListener          { if (callState == CallState.RINGING_IN) rejectCall() else endCall() }
        btnMute?.setOnClickListener         { toggleMute() }
        btnSpeaker?.setOnClickListener      { toggleSpeaker() }
        btnCameraOff?.setOnClickListener    { toggleCamera() }
        btnSwitchCamera?.setOnClickListener { switchCamera() }
        btnMinimize?.setOnClickListener     { minimizeCall() }

        // Tap remote/local video to swap which is large vs PiP
        remoteVideoView?.setOnClickListener { swapVideoViews() }
        localVideoView?.setOnClickListener  { swapVideoViews() }

        lifecycleScope.launch { wsManager.callEvents.collect { handleCallEvent(it) } }

        if (direction == "outbound") {
            wsManager.sendCallSignal("call_invite", callId, remoteDevice,
                JSONObject().apply { put("isVideo", isVideo) })
            // Show local preview immediately for outbound video
            if (isVideo) lifecycleScope.launch { startLocalPreviewOnly() }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        mainHandler.removeCallbacksAndMessages(null)
        // Hide minimized bar if showing
        (activity as? MainActivity)?.hideCallMinimizedBar()
        cleanup()
        remoteVideoView = null
        localVideoView  = null
    }

    // ── Call signaling events ─────────────────────────────────────────────

    private fun handleCallEvent(event: WebSocketManager.CallEvent) {
        if (!isAdded) return
        mainHandler.post {
            if (!isAdded) return@post
            when (event) {
                is WebSocketManager.CallEvent.Accepted -> {
                    if (event.callId == callId && callState == CallState.RINGING_OUT) {
                        callState = CallState.CONNECTING
                        tvStatus?.text = "Connecting…"
                        setAudioModeForCall()
                        lifecycleScope.launch { initWebRTCAndSendOffer() }
                    }
                }
                is WebSocketManager.CallEvent.Rejected -> {
                    if (event.callId == callId) {
                        tvStatus?.text = if (event.reason == "busy") "Line is busy" else "Call declined"
                        scheduleClose(1500)
                    }
                }
                is WebSocketManager.CallEvent.Ended -> {
                    if (event.callId == callId) { tvStatus?.text = "Call ended"; scheduleClose(1500) }
                }
                is WebSocketManager.CallEvent.Offer        -> { if (event.callId == callId) handleRemoteOffer(event.sdp) }
                is WebSocketManager.CallEvent.Answer       -> { if (event.callId == callId) handleRemoteAnswer(event.sdp) }
                is WebSocketManager.CallEvent.IceCandidate -> { if (event.callId == callId) handleRemoteIce(event.candidate) }
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
        // Set audio mode BEFORE WebRTC init so AudioRecord gets the right session
        setAudioModeForCall()
        wsManager.sendCallSignal("call_accept", callId, remoteDevice)
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

    /** Set AudioManager to call mode — must be called on main thread before WebRTC init */
    private fun setAudioModeForCall() {
        try {
            val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            am.isSpeakerphoneOn = false
            // Request audio focus so other apps duck/stop
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                val focusRequest = android.media.AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(
                        android.media.AudioAttributes.Builder()
                            .setUsage(android.media.AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    )
                    .build()
                am.requestAudioFocus(focusRequest)
            } else {
                @Suppress("DEPRECATION")
                am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            }
        } catch (e: Exception) {
            Log.w(TAG, "setAudioModeForCall: ${e.message}")
        }
    }

    // ── WebRTC init ───────────────────────────────────────────────────────

    private suspend fun initWebRTCAndSendOffer() {
        initWebRTCAsync()
        if (!isAdded || peerConnection == null) return
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", isVideo.toString()))
        }
        peerConnection?.createOffer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                peerConnection?.setLocalDescription(makeSdpObserver(
                    onSuccess = {
                        wsManager.sendCallSignal("call_offer", callId, remoteDevice,
                            JSONObject().apply {
                                put("data", JSONObject().apply {
                                    put("type", sdp.type.canonicalForm())
                                    put("sdp", sdp.description)
                                })
                            })
                    },
                    onFail = { Log.e(TAG, "setLocalDesc(offer) failed: $it") }
                ), sdp)
            }
            override fun onCreateFailure(e: String?) { Log.e(TAG, "createOffer failed: $e") }
            override fun onSetSuccess() {}
            override fun onSetFailure(p0: String?) {}
        }, constraints)
    }

    private suspend fun initWebRTCAsync() = withContext(Dispatchers.IO) {
        if (!hasMicPermission()) {
            withContext(Dispatchers.Main) { if (isAdded) { tvStatus?.text = "Mic permission required"; scheduleClose(1500) } }
            return@withContext
        }
        val ctx = requireContext().applicationContext
        try {
            val egl = EglBase.create()
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions()
            )
            val factory = PeerConnectionFactory.builder()
                .setOptions(PeerConnectionFactory.Options())
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                .createPeerConnectionFactory()

            val iceServers = listOf(
                PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
                PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer(),
                PeerConnection.IceServer.builder("turn:openrelay.metered.ca:80")
                    .setUsername("openrelayproject").setPassword("openrelayproject").createIceServer(),
            )
            val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
                sdpSemantics             = PeerConnection.SdpSemantics.UNIFIED_PLAN
                iceTransportsType        = PeerConnection.IceTransportsType.ALL
                bundlePolicy             = PeerConnection.BundlePolicy.MAXBUNDLE
                rtcpMuxPolicy            = PeerConnection.RtcpMuxPolicy.REQUIRE
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            }

            val pc = factory.createPeerConnection(rtcConfig, makePcObserver())
                ?: run { Log.e(TAG, "createPeerConnection returned null"); return@withContext }

            val audioConstraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
            }
            val audioTrack = factory.createAudioTrack("audio0", factory.createAudioSource(audioConstraints))
            pc.addTrack(audioTrack)

            var videoTrack  : VideoTrack? = null
            var capturer    : CameraVideoCapturer? = null
            var stHelper    : SurfaceTextureHelper? = null

            if (isVideo && hasCameraPermission()) {
                capturer = makeCameraCapturer(usingFrontCamera)
                if (capturer != null) {
                    stHelper = SurfaceTextureHelper.create("CaptureThread", egl.eglBaseContext)
                    val videoSource = factory.createVideoSource(capturer.isScreencast)
                    capturer.initialize(stHelper, ctx, videoSource.capturerObserver)
                    capturer.startCapture(1280, 720, 30)
                    videoTrack = factory.createVideoTrack("video0", videoSource)
                    pc.addTrack(videoTrack)
                }
            }

            withContext(Dispatchers.Main) {
                if (!isAdded) return@withContext

                // If a preview capturer was already started, stop it cleanly
                if (videoCapturer != null && videoCapturer !== capturer) {
                    runCatching { videoCapturer?.stopCapture(); videoCapturer?.dispose() }
                    runCatching { surfaceTextureHelper?.dispose() }
                    runCatching { localVideoTrack?.dispose() }
                }

                eglBase               = egl
                peerConnectionFactory = factory
                peerConnection        = pc
                localAudioTrack       = audioTrack
                localVideoTrack       = videoTrack
                videoCapturer         = capturer
                surfaceTextureHelper  = stHelper

                // AudioManager already configured by setAudioModeForCall() before init
                if (isVideo && videoTrack != null) {
                    localVideoView?.apply {
                        // Re-init if needed (preview may have already initialised it)
                        runCatching { release() }
                        init(egl.eglBaseContext, null)
                        setMirror(usingFrontCamera)
                        setEnableHardwareScaler(true)
                        videoTrack.addSink(this)
                        visibility = View.VISIBLE
                    }
                    remoteVideoView?.apply {
                        runCatching { release() }
                        init(egl.eglBaseContext, null)
                        setEnableHardwareScaler(true)
                    }
                }

                // Drain any queued signaling
                pendingOffer?.let { o -> pendingOffer = null; handleRemoteOffer(o) }
            }
        } catch (e: Exception) {
            Log.e(TAG, "initWebRTCAsync failed", e)
            withContext(Dispatchers.Main) {
                if (isAdded) { tvStatus?.text = "Setup failed"; scheduleClose(1500) }
            }
        }
    }

    /** Lightweight local preview before full PeerConnection is ready (outbound video) */
    private suspend fun startLocalPreviewOnly() = withContext(Dispatchers.IO) {
        if (!isVideo || !hasCameraPermission()) return@withContext
        val ctx = requireContext().applicationContext
        try {
            val egl = EglBase.create()
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions()
            )
            val factory = PeerConnectionFactory.builder()
                .setOptions(PeerConnectionFactory.Options())
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                .createPeerConnectionFactory()

            val capturer = makeCameraCapturer(usingFrontCamera) ?: return@withContext
            val stHelper = SurfaceTextureHelper.create("PreviewThread", egl.eglBaseContext)
            val videoSource = factory.createVideoSource(capturer.isScreencast)
            capturer.initialize(stHelper, ctx, videoSource.capturerObserver)
            capturer.startCapture(1280, 720, 30)
            val videoTrack = factory.createVideoTrack("video_preview", videoSource)

            withContext(Dispatchers.Main) {
                if (!isAdded || peerConnectionFactory != null) {
                    // Full init already happened — discard preview resources
                    runCatching { capturer.stopCapture(); capturer.dispose() }
                    runCatching { stHelper.dispose(); videoTrack.dispose() }
                    runCatching { factory.dispose(); egl.release() }
                    return@withContext
                }
                eglBase               = egl
                peerConnectionFactory = factory
                videoCapturer         = capturer
                surfaceTextureHelper  = stHelper
                localVideoTrack       = videoTrack

                localVideoView?.apply {
                    init(egl.eglBaseContext, null)
                    setMirror(usingFrontCamera)
                    setEnableHardwareScaler(true)
                    videoTrack.addSink(this)
                    visibility = View.VISIBLE
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Preview failed: ${e.message}")
        }
    }

    // ── PeerConnection observer ───────────────────────────────────────────

    private fun makePcObserver() = object : PeerConnection.Observer {
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
            val track = receiver.track() ?: return
            mainHandler.post {
                if (!isAdded) return@post
                if (track is VideoTrack) {
                    remoteVideoView?.let { rv ->
                        track.addSink(rv)
                        rv.visibility = View.VISIBLE
                    }
                }
                if (callState != CallState.ACTIVE) {
                    callState = CallState.ACTIVE
                    updateUI()
                    mainHandler.post(durationTick)
                }
            }
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            Log.d(TAG, "ICE: $state")
            mainHandler.post {
                if (!isAdded) return@post
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> {
                        if (callState != CallState.ACTIVE) {
                            callState = CallState.ACTIVE
                            updateUI()
                            mainHandler.post(durationTick)
                        }
                    }
                    PeerConnection.IceConnectionState.FAILED -> {
                        tvStatus?.text = "Connection failed"; scheduleClose(2000)
                    }
                    PeerConnection.IceConnectionState.DISCONNECTED -> {
                        if (callState == CallState.ACTIVE) tvStatus?.text = "Reconnecting…"
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
    }

    // ── Signaling handlers ────────────────────────────────────────────────

    private fun handleRemoteOffer(sdpJson: String) {
        if (peerConnection == null) { pendingOffer = sdpJson; return }
        val obj = runCatching { JSONObject(sdpJson) }.getOrNull() ?: return
        val sdp = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(obj.optString("type", "offer")),
            obj.optString("sdp", ""))
        peerConnection?.setRemoteDescription(makeSdpObserver(
            onSuccess = {
                remoteDescSet = true
                drainCandidates()
                peerConnection?.createAnswer(object : SdpObserver {
                    override fun onCreateSuccess(answer: SessionDescription) {
                        peerConnection?.setLocalDescription(makeSdpObserver(
                            onSuccess = {
                                wsManager.sendCallSignal("call_answer", callId, remoteDevice,
                                    JSONObject().apply {
                                        put("data", JSONObject().apply {
                                            put("type", answer.type.canonicalForm())
                                            put("sdp", answer.description)
                                        })
                                    })
                            },
                            onFail = { Log.e(TAG, "setLocalDesc(answer) failed: $it") }
                        ), answer)
                    }
                    override fun onCreateFailure(e: String?) { Log.e(TAG, "createAnswer failed: $e") }
                    override fun onSetSuccess() {}
                    override fun onSetFailure(p0: String?) {}
                }, MediaConstraints())
            },
            onFail = { Log.e(TAG, "setRemoteDesc(offer) failed: $it") }
        ), sdp)
    }

    private fun handleRemoteAnswer(sdpJson: String) {
        if (peerConnection == null) return
        val obj = runCatching { JSONObject(sdpJson) }.getOrNull() ?: return
        val sdp = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(obj.optString("type", "answer")),
            obj.optString("sdp", ""))
        peerConnection?.setRemoteDescription(makeSdpObserver(
            onSuccess = { remoteDescSet = true; drainCandidates() },
            onFail    = { Log.e(TAG, "setRemoteDesc(answer) failed: $it") }
        ), sdp)
    }

    private fun handleRemoteIce(json: String) {
        if (remoteDescSet) applyCandidate(json)
        else synchronized(pendingCandidates) { pendingCandidates.add(json) }
    }

    private fun drainCandidates() {
        val list = synchronized(pendingCandidates) { pendingCandidates.toList().also { pendingCandidates.clear() } }
        list.forEach { applyCandidate(it) }
    }

    private fun applyCandidate(json: String) {
        try {
            val obj = JSONObject(json)
            peerConnection?.addIceCandidate(IceCandidate(
                obj.optString("sdpMid", ""),
                obj.optInt("sdpMLineIndex", 0),
                obj.optString("candidate", "")))
        } catch (e: Exception) { Log.e(TAG, "addIceCandidate: ${e.message}") }
    }

    // ── Controls ──────────────────────────────────────────────────────────

    private fun toggleMute() {
        isMuted = !isMuted
        localAudioTrack?.setEnabled(!isMuted)
        btnMute?.alpha = if (isMuted) 0.4f else 1.0f
        Toast.makeText(requireContext(), if (isMuted) "Muted" else "Unmuted", Toast.LENGTH_SHORT).show()
    }

    private fun toggleSpeaker() {
        isSpeakerOn = !isSpeakerOn
        val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
        am.isSpeakerphoneOn = isSpeakerOn
        btnSpeaker?.alpha = if (isSpeakerOn) 1.0f else 0.4f
    }

    private fun toggleCamera() {
        cameraEnabled = !cameraEnabled
        localVideoTrack?.setEnabled(cameraEnabled)
        btnCameraOff?.alpha = if (cameraEnabled) 1.0f else 0.4f
        localVideoView?.visibility = if (cameraEnabled) View.VISIBLE else View.INVISIBLE
    }

    private fun switchCamera() {
        (videoCapturer as? CameraVideoCapturer)?.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFront: Boolean) {
                usingFrontCamera = isFront
                mainHandler.post { localVideoView?.setMirror(isFront) }
            }
            override fun onCameraSwitchError(e: String?) { Log.e(TAG, "switchCamera: $e") }
        })
    }

    /** Minimize the call — hide this fragment and show floating bar in MainActivity */
    private fun minimizeCall() {
        view?.visibility = View.GONE
        (activity as? MainActivity)?.showCallMinimizedBar(
            name = remoteUsername,
            durationProvider = { durationSec },
            onRestore = { view?.visibility = View.VISIBLE },
            onEnd = { endCall() }
        )
    }

    /** Swap remote (fullscreen) and local (PiP) video surfaces */
    private var videoSwapped = false
    private fun swapVideoViews() {
        if (!isVideo || remoteVideoView == null || localVideoView == null) return
        videoSwapped = !videoSwapped

        // Swap layout params: make local full-screen and remote PiP (or vice-versa)
        val remoteParams = remoteVideoView!!.layoutParams
        val localParams  = localVideoView!!.layoutParams
        remoteVideoView!!.layoutParams = localParams
        localVideoView!!.layoutParams  = remoteParams

        // Swap z-order so whichever is "main" is behind the PiP
        if (videoSwapped) {
            remoteVideoView!!.setZOrderMediaOverlay(false)
            localVideoView!!.setZOrderMediaOverlay(true)
        } else {
            remoteVideoView!!.setZOrderMediaOverlay(false)
            localVideoView!!.setZOrderMediaOverlay(false)
        }
    }

    // ── UI update ─────────────────────────────────────────────────────────

    private fun updateUI() {
        when (callState) {
            CallState.RINGING_IN -> {
                tvStatus?.text = "Incoming ${if (isVideo) "video" else "audio"} call"
                btnAccept?.visibility = View.VISIBLE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
                btnCameraOff?.visibility = View.GONE
                btnSwitchCamera?.visibility = View.GONE
            }
            CallState.RINGING_OUT, CallState.CONNECTING -> {
                tvStatus?.text = if (callState == CallState.CONNECTING) "Connecting…" else "Calling…"
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
                btnCameraOff?.visibility = View.GONE
                btnSwitchCamera?.visibility = View.GONE
            }
            CallState.ACTIVE -> {
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.VISIBLE
                btnSpeaker?.visibility = View.VISIBLE
                btnCameraOff?.visibility = if (isVideo) View.VISIBLE else View.GONE
                btnSwitchCamera?.visibility = if (isVideo) View.VISIBLE else View.GONE
            }
            CallState.ENDED -> {
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
                btnCameraOff?.visibility = View.GONE
                btnSwitchCamera?.visibility = View.GONE
            }
        }
    }

    private fun formatDuration(s: Int) = "%02d:%02d".format(s / 60, s % 60)

    // ── Lifecycle / cleanup ───────────────────────────────────────────────

    private fun scheduleClose(delayMs: Long = 1500) {
        callState = CallState.ENDED
        updateUI()
        mainHandler.removeCallbacks(durationTick)
        mainHandler.postDelayed({ safeCleanupAndClose() }, delayMs)
    }

    private fun safeCleanupAndClose() = mainHandler.post { cleanup(); safeClose() }

    private fun safeClose() {
        if (!isAdded) return
        try { parentFragmentManager.popBackStack() } catch (e: Exception) { Log.e(TAG, "popBackStack: ${e.message}") }
    }

    private fun cleanup() {
        mainHandler.removeCallbacks(durationTick)
        synchronized(pendingCandidates) { pendingCandidates.clear() }
        pendingOffer  = null
        remoteDescSet = false

        runCatching { videoCapturer?.stopCapture() }
        runCatching { videoCapturer?.dispose() }
        runCatching { surfaceTextureHelper?.dispose() }
        videoCapturer       = null
        surfaceTextureHelper= null

        runCatching { localAudioTrack?.dispose() }
        runCatching { localVideoTrack?.dispose() }
        localAudioTrack = null
        localVideoTrack = null

        runCatching { peerConnection?.close() }
        peerConnection = null

        runCatching { localVideoView?.release() }
        runCatching { remoteVideoView?.release() }

        runCatching { peerConnectionFactory?.dispose() }
        peerConnectionFactory = null

        runCatching { eglBase?.release() }
        eglBase = null

        runCatching {
            val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_NORMAL
            am.isSpeakerphoneOn = false
            if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O) {
                @Suppress("DEPRECATION")
                am.abandonAudioFocus(null)
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private fun hasMicPermission() =
        ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED

    private fun hasCameraPermission() =
        ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED

    private fun makeCameraCapturer(useFront: Boolean): CameraVideoCapturer? = try {
        val e = Camera2Enumerator(requireContext())
        e.deviceNames.firstOrNull { if (useFront) e.isFrontFacing(it) else e.isBackFacing(it) }
            ?.let { e.createCapturer(it, null) }
            ?: e.deviceNames.firstOrNull()?.let { e.createCapturer(it, null) }
    } catch (e: Exception) { Log.e(TAG, "makeCameraCapturer: ${e.message}"); null }

    private fun makeSdpObserver(onSuccess: () -> Unit = {}, onFail: (String?) -> Unit = {}) =
        object : SdpObserver {
            override fun onSetSuccess()                        { onSuccess() }
            override fun onSetFailure(e: String?)              { onFail(e) }
            override fun onCreateSuccess(s: SessionDescription?) {}
            override fun onCreateFailure(e: String?)           {}
        }
}
