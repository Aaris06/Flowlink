package com.flowlink.app.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
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
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * CallFragment — WhatsApp-style WebRTC audio/video call UI
 *
 * Features:
 * - Tap local PiP to swap local ↔ remote video (WhatsApp style)
 * - Minimize button → floating draggable bubble overlay so user can use the app mid-call
 * - Restore by tapping the bubble
 * - End call from bubble
 * - Full video call with camera switch, mute, speaker
 */
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

    // ── State ─────────────────────────────────────────────────────────────

    private lateinit var mainActivity: MainActivity
    private lateinit var wsManager: WebSocketManager
    private val mainHandler = Handler(Looper.getMainLooper())

    private var callId         = ""
    private var remoteUsername = ""
    private var remoteDevice   = ""
    private var isVideo        = false
    private var direction      = "inbound"
    @Volatile private var callState = CallState.RINGING_IN

    // WebRTC
    private var eglBase               : EglBase? = null
    private var peerConnectionFactory : PeerConnectionFactory? = null
    private var peerConnection        : PeerConnection? = null
    private var localAudioTrack       : AudioTrack? = null
    private var localVideoTrack       : VideoTrack? = null
    private var remoteVideoTrack      : VideoTrack? = null
    private var videoCapturer         : CameraVideoCapturer? = null
    private var surfaceTextureHelper  : SurfaceTextureHelper? = null

    // Signaling race queues
    private var pendingOffer      : String? = null
    private val pendingCandidates = mutableListOf<String>()
    @Volatile private var remoteDescSet = false

    // Camera / controls state
    private var usingFrontCamera = true
    private var cameraEnabled    = true
    private var isMuted          = false
    private var isSpeakerOn      = false

    // Video swap state — tracks which surface is currently showing remote vs local
    private var isSwapped = false   // false = remote full-screen, local PiP

    // Minimize state
    private var isMinimized = false
    private var minimizedOverlay: View? = null

    // Views — nullable safe after onDestroyView
    private var callRootView    : FrameLayout? = null
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
    private var tvSwapHint      : TextView? = null

    // Duration counter
    private var durationSec = 0
    private val durationTick = object : Runnable {
        override fun run() {
            if (callState == CallState.ACTIVE && isAdded) {
                durationSec++
                val formatted = formatDuration(durationSec)
                tvStatus?.text = formatted
                // Update minimized timer too
                minimizedOverlay?.findViewById<TextView>(R.id.minimized_timer)?.text = formatted
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

    override fun onCreateView(inf: LayoutInflater, c: ViewGroup?, s: Bundle?): View? =
        inf.inflate(R.layout.fragment_call, c, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        callRootView    = view.findViewById(R.id.call_root)
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
        tvSwapHint      = view.findViewById(R.id.tv_swap_hint)

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

        // Tap local PiP to swap local ↔ remote video streams (WhatsApp style)
        localVideoView?.setOnClickListener  { swapVideoViews() }

        // Also tap remote video to reveal controls briefly (WhatsApp style)
        remoteVideoView?.setOnClickListener { flashControls() }

        lifecycleScope.launch { wsManager.callEvents.collect { handleCallEvent(it) } }

        if (direction == "outbound") {
            activity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL
            wsManager.sendCallSignal("call_invite", callId, remoteDevice,
                JSONObject().apply { put("isVideo", isVideo) })
            if (isVideo) lifecycleScope.launch { startLocalPreviewOnly() }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        mainHandler.removeCallbacksAndMessages(null)
        removeMinimizedOverlay()
        cleanup()
        callRootView    = null
        remoteVideoView = null
        localVideoView  = null
        btnMinimize     = null
        tvSwapHint      = null
    }

    // ── Signaling event dispatch ──────────────────────────────────────────

    private fun handleCallEvent(event: WebSocketManager.CallEvent) {
        if (!isAdded) return
        mainHandler.post {
            if (!isAdded) return@post
            when (event) {
                is WebSocketManager.CallEvent.Accepted -> {
                    if (event.callId == callId && callState == CallState.RINGING_OUT) {
                        callState = CallState.CONNECTING
                        tvStatus?.text = "Connecting…"
                        updateMinimizedUI()
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
                    if (event.callId == callId) {
                        tvStatus?.text = "Call ended"
                        scheduleClose(1500)
                    }
                }
                is WebSocketManager.CallEvent.Offer        -> if (event.callId == callId) handleRemoteOffer(event.sdp)
                is WebSocketManager.CallEvent.Answer       -> if (event.callId == callId) handleRemoteAnswer(event.sdp)
                is WebSocketManager.CallEvent.IceCandidate -> if (event.callId == callId) handleRemoteIce(event.candidate)
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
        activity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL
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

    // ── Minimize / restore ────────────────────────────────────────────────

    private fun minimizeCall() {
        if (isMinimized) return
        isMinimized = true

        // Hide the full call UI but keep fragment alive
        callRootView?.visibility = View.GONE

        // Inflate and attach minimized overlay to the activity's root window
        attachMinimizedOverlay()
    }

    private fun restoreCall() {
        if (!isMinimized) return
        isMinimized = false
        callRootView?.visibility = View.VISIBLE
        removeMinimizedOverlay()

        // Re-attach video sinks since they may have been detached
        reattachVideoSinks()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun attachMinimizedOverlay() {
        val activity = activity ?: return
        val decor = activity.window.decorView as? FrameLayout ?: return

        val overlay = LayoutInflater.from(activity)
            .inflate(R.layout.overlay_call_minimized, decor, false)

        // Set content
        val avatarTv = overlay.findViewById<TextView>(R.id.minimized_avatar)
        val nameTv   = overlay.findViewById<TextView>(R.id.minimized_username)
        val timerTv  = overlay.findViewById<TextView>(R.id.minimized_timer)
        val endBtn   = overlay.findViewById<ImageButton>(R.id.minimized_btn_end)
        val localVid = overlay.findViewById<SurfaceViewRenderer?>(R.id.minimized_local_video)

        avatarTv.text = remoteUsername.firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        nameTv.text   = remoteUsername
        timerTv.text  = if (callState == CallState.ACTIVE) formatDuration(durationSec) else "Calling…"

        // Attach local video to minimized bubble for video calls
        if (isVideo) {
            val egl = eglBase
            val vTrack = localVideoTrack
            if (egl != null && vTrack != null && localVid != null) {
                try {
                    localVid.init(egl.eglBaseContext, null)
                    localVid.setMirror(usingFrontCamera)
                    localVid.setEnableHardwareScaler(true)
                    vTrack.addSink(localVid)
                    localVid.visibility = View.VISIBLE
                    overlay.findViewById<View>(R.id.minimized_audio_bg)?.visibility = View.GONE
                } catch (e: Exception) {
                    Log.w(TAG, "minimized video init failed: ${e.message}")
                }
            }
        }

        // End call from bubble
        endBtn.setOnClickListener { endCall() }

        // Tap bubble to restore full call UI
        overlay.setOnClickListener { restoreCall() }

        // Draggable bubble
        var startX = 0f; var startY = 0f
        var origX = 0f;  var origY = 0f
        overlay.setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = event.rawX; startY = event.rawY
                    origX = v.x;         origY = v.y
                    false // pass through so click also works
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - startX
                    val dy = event.rawY - startY
                    v.x = origX + dx
                    v.y = origY + dy
                    true
                }
                else -> false
            }
        }

        // Position bottom-left initially
        val params = FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            // Will be positioned after first layout
        }
        decor.addView(overlay, params)

        // Position after view is measured
        overlay.post {
            val parentH = decor.height
            overlay.y = (parentH - overlay.height - 120).toFloat().coerceAtLeast(0f)
            overlay.x = 16f
        }

        minimizedOverlay = overlay
    }

    private fun removeMinimizedOverlay() {
        val overlay = minimizedOverlay ?: return
        minimizedOverlay = null
        // Release minimized local video sink before removing
        try {
            val localVid = overlay.findViewById<SurfaceViewRenderer?>(R.id.minimized_local_video)
            if (localVid?.visibility == View.VISIBLE) {
                localVideoTrack?.removeSink(localVid)
                localVid.release()
            }
        } catch (e: Exception) { Log.w(TAG, "minimized video release: ${e.message}") }
        (overlay.parent as? ViewGroup)?.removeView(overlay)
    }

    private fun updateMinimizedUI() {
        val overlay = minimizedOverlay ?: return
        overlay.findViewById<TextView>(R.id.minimized_timer)?.text =
            if (callState == CallState.ACTIVE) formatDuration(durationSec) else "Calling…"
    }

    // ── Tap-to-swap video (WhatsApp style) ────────────────────────────────

    /**
     * Swaps which surface shows the remote vs local stream.
     * Remote becomes PiP, local becomes full-screen — then swap back on next tap.
     */
    private fun swapVideoViews() {
        if (!isVideo || callState != CallState.ACTIVE) return
        val egl     = eglBase ?: return
        val remote  = remoteVideoView ?: return
        val local   = localVideoView  ?: return
        val rTrack  = remoteVideoTrack
        val lTrack  = localVideoTrack

        isSwapped = !isSwapped

        if (isSwapped) {
            // Remote → PiP (local_video position), Local → full screen (remote_video)
            rTrack?.removeSink(remote)
            lTrack?.removeSink(local)
            lTrack?.addSink(remote)   // local stream on the big surface
            rTrack?.addSink(local)    // remote stream on the small surface
            local.setMirror(false)    // remote stream shouldn't mirror
            remote.setMirror(usingFrontCamera)
        } else {
            // Restore: Remote → full screen, Local → PiP
            rTrack?.removeSink(local)
            lTrack?.removeSink(remote)
            rTrack?.addSink(remote)
            lTrack?.addSink(local)
            local.setMirror(usingFrontCamera)
            remote.setMirror(false)
        }
        Toast.makeText(requireContext(),
            if (isSwapped) "Your camera is full screen" else "Remote video is full screen",
            Toast.LENGTH_SHORT).show()
    }

    private fun reattachVideoSinks() {
        val egl    = eglBase ?: return
        val remote = remoteVideoView ?: return
        val local  = localVideoView  ?: return
        if (!isVideo) return

        if (isSwapped) {
            localVideoTrack?.addSink(remote)
            remoteVideoTrack?.addSink(local)
        } else {
            remoteVideoTrack?.addSink(remote)
            localVideoTrack?.addSink(local)
        }
    }

    /** Briefly show controls overlay when tapping the remote video during active call */
    private fun flashControls() {
        if (callState != CallState.ACTIVE) return
        val controls = view?.findViewById<View>(R.id.controls_layout) ?: return
        controls.visibility = View.VISIBLE
        controls.alpha = 1f
        mainHandler.removeCallbacksAndMessages("hide_controls")
        mainHandler.postDelayed({
            controls.animate().alpha(0f).setDuration(400).withEndAction {
                controls.visibility = View.VISIBLE // keep visible but transparent
                controls.alpha = 1f               // reset for next show
            }.start()
        }, 3000)
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
            withContext(Dispatchers.Main) {
                if (isAdded) { tvStatus?.text = "Mic permission required"; scheduleClose(1500) }
            }
            return@withContext
        }
        val ctx = requireContext().applicationContext

        withContext(Dispatchers.Main) {
            val am = ctx.getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            am.isSpeakerphoneOn = false
            activity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL
        }

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
                    .setUsername("openrelayproject").setPassword("openrelayproject").createIceServer()
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

            // Audio with echo cancellation
            val audioConstraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
            }
            val audioTrack = factory.createAudioTrack(
                "audio0", factory.createAudioSource(audioConstraints))
            pc.addTrack(audioTrack)

            // Video
            var videoTrack : VideoTrack? = null
            var capturer   : CameraVideoCapturer? = null
            var stHelper   : SurfaceTextureHelper? = null

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

                // Clean up any preview capturer
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

                if (isVideo && videoTrack != null) {
                    localVideoView?.apply {
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
                    runCatching { capturer.stopCapture(); capturer.dispose() }
                    runCatching { stHelper.dispose(); videoTrack.dispose(); factory.dispose(); egl.release() }
                    return@withContext
                }
                eglBase               = egl
                peerConnectionFactory = factory
                videoCapturer         = capturer
                surfaceTextureHelper  = stHelper
                localVideoTrack       = videoTrack

                localVideoView?.apply {
                    runCatching { release() }
                    init(egl.eglBaseContext, null)
                    setMirror(usingFrontCamera)
                    setEnableHardwareScaler(true)
                    videoTrack.addSink(this)
                    visibility = View.VISIBLE
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "startLocalPreviewOnly failed: ${e.message}")
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
                    remoteVideoTrack = track
                    if (!isSwapped) {
                        remoteVideoView?.let { rv ->
                            track.addSink(rv)
                            rv.visibility = View.VISIBLE
                        }
                    } else {
                        // Swapped — put remote on local PiP surface
                        localVideoView?.let { lv ->
                            track.addSink(lv)
                        }
                    }
                }
                if (callState != CallState.ACTIVE) {
                    callState = CallState.ACTIVE
                    updateUI()
                    mainHandler.post(durationTick)
                    // Show swap hint briefly for video calls
                    if (isVideo) showSwapHint()
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
                        tvStatus?.text = "Connection failed"
                        scheduleClose(2000)
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
        videoCapturer?.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFront: Boolean) {
                usingFrontCamera = isFront
                mainHandler.post {
                    // Update mirror on whichever surface is showing local stream
                    if (!isSwapped) {
                        localVideoView?.setMirror(isFront)
                    } else {
                        remoteVideoView?.setMirror(isFront)
                    }
                }
            }
            override fun onCameraSwitchError(e: String?) { Log.e(TAG, "switchCamera: $e") }
        })
    }

    // ── Swap hint ─────────────────────────────────────────────────────────

    private fun showSwapHint() {
        val hint = tvSwapHint ?: return
        hint.visibility = View.VISIBLE
        hint.alpha = 1f
        mainHandler.postDelayed({
            hint.animate().alpha(0f).setDuration(600).withEndAction {
                hint.visibility = View.GONE
            }.start()
        }, 2500)
    }

    // ── UI ────────────────────────────────────────────────────────────────

    private fun updateUI() {
        when (callState) {
            CallState.RINGING_IN -> {
                tvStatus?.text = "Incoming ${if (isVideo) "video" else "audio"} call"
                btnAccept?.visibility = View.VISIBLE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
                btnCameraOff?.visibility = View.GONE
                btnSwitchCamera?.visibility = View.GONE
                btnMinimize?.visibility = View.GONE
            }
            CallState.RINGING_OUT, CallState.CONNECTING -> {
                tvStatus?.text = if (callState == CallState.CONNECTING) "Connecting…" else "Calling…"
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
                btnCameraOff?.visibility = View.GONE
                btnSwitchCamera?.visibility = View.GONE
                btnMinimize?.visibility = View.VISIBLE
            }
            CallState.ACTIVE -> {
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.VISIBLE
                btnSpeaker?.visibility = View.VISIBLE
                btnCameraOff?.visibility = if (isVideo) View.VISIBLE else View.GONE
                btnSwitchCamera?.visibility = if (isVideo) View.VISIBLE else View.GONE
                btnMinimize?.visibility = View.VISIBLE
                // Hide avatar/name card in active video calls (remote video fills screen)
                if (isVideo) {
                    (view as? ViewGroup)?.getChildAt(2)
                        ?.animate()?.alpha(0f)?.setDuration(400)?.start()
                }
            }
            CallState.ENDED -> {
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.GONE
                btnSpeaker?.visibility = View.GONE
                btnCameraOff?.visibility = View.GONE
                btnSwitchCamera?.visibility = View.GONE
                btnMinimize?.visibility = View.GONE
                removeMinimizedOverlay()
            }
        }
    }

    private fun formatDuration(s: Int) = "%02d:%02d".format(s / 60, s % 60)

    // ── Cleanup ───────────────────────────────────────────────────────────

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
        videoCapturer        = null
        surfaceTextureHelper = null

        runCatching { localAudioTrack?.dispose() }
        runCatching { localVideoTrack?.dispose() }
        runCatching { remoteVideoTrack?.dispose() }
        localAudioTrack  = null
        localVideoTrack  = null
        remoteVideoTrack = null

        runCatching { peerConnection?.close() }
        peerConnection = null

        runCatching { localVideoView?.release() }
        runCatching { remoteVideoView?.release() }

        runCatching { peerConnectionFactory?.dispose() }
        peerConnectionFactory = null

        runCatching { eglBase?.release() }
        eglBase = null

        // Restore audio
        runCatching {
            val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
            am.mode             = AudioManager.MODE_NORMAL
            am.isSpeakerphoneOn = false
        }
        runCatching {
            requireActivity().volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
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
        e.deviceNames
            .firstOrNull { if (useFront) e.isFrontFacing(it) else e.isBackFacing(it) }
            ?.let { e.createCapturer(it, null) }
            ?: e.deviceNames.firstOrNull()?.let { e.createCapturer(it, null) }
    } catch (e: Exception) { Log.e(TAG, "makeCameraCapturer: ${e.message}"); null }

    private fun makeSdpObserver(onSuccess: () -> Unit = {}, onFail: (String?) -> Unit = {}) =
        object : SdpObserver {
            override fun onSetSuccess()                          { onSuccess() }
            override fun onSetFailure(e: String?)                { onFail(e) }
            override fun onCreateSuccess(s: SessionDescription?) {}
            override fun onCreateFailure(e: String?)             {}
        }
}
