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
import com.flowlink.app.service.CallSession
import com.flowlink.app.service.WebSocketManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.webrtc.*

/**
 * CallFragment — WhatsApp-style audio/video call UI.
 *
 * All WebRTC state lives in CallSession (singleton) so that the fragment
 * can be destroyed (minimize) and recreated (restore) without tearing down
 * the actual call.
 *
 * Minimize flow:
 *   1. CallFragment pops itself off the back stack  → app is fully usable
 *   2. MainActivity.showCallBubble() attaches a floating draggable bubble
 *   3. Tapping the bubble calls MainActivity.restoreCall() which re-adds this fragment
 */
class CallFragment : Fragment() {

    companion object {
        private const val TAG = "CallFragment"

        const val ARG_CALL_ID       = "callId"
        const val ARG_REMOTE_NAME   = "remoteUsername"
        const val ARG_REMOTE_DEVICE = "remoteDevice"
        const val ARG_IS_VIDEO      = "isVideo"
        const val ARG_DIRECTION     = "direction"
        /** Set to true when fragment is being restored after minimize */
        const val ARG_RESTORE       = "restore"

        fun newIncoming(callId: String, fromUsername: String, fromDevice: String, isVideo: Boolean) =
            CallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_CALL_ID, callId)
                    putString(ARG_REMOTE_NAME, fromUsername)
                    putString(ARG_REMOTE_DEVICE, fromDevice)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "inbound")
                    putBoolean(ARG_RESTORE, false)
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
                    putBoolean(ARG_RESTORE, false)
                }
            }

        /** Creates a fragment that re-attaches to the existing CallSession */
        fun restore() = CallFragment().apply {
            arguments = Bundle().apply {
                putBoolean(ARG_RESTORE, true)
            }
        }
    }

    // ── Activity / manager refs ───────────────────────────────────────────
    private lateinit var mainActivity: MainActivity
    private lateinit var wsManager: WebSocketManager

    // ── Args ──────────────────────────────────────────────────────────────
    private var isRestore = false

    // ── Main thread handler ───────────────────────────────────────────────
    private val mainHandler = Handler(Looper.getMainLooper())

    // ── Views ─────────────────────────────────────────────────────────────
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

    // ── Duration tick ─────────────────────────────────────────────────────
    private val durationTick = object : Runnable {
        override fun run() {
            if (CallSession.state == CallSession.State.ACTIVE && isAdded) {
                CallSession.durationSec++
                tvStatus?.text = fmt(CallSession.durationSec)
                mainActivity.updateBubbleTimer(fmt(CallSession.durationSec))
                mainHandler.postDelayed(this, 1000)
            }
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mainActivity = activity as MainActivity
        wsManager    = mainActivity.webSocketManager
        isRestore    = arguments?.getBoolean(ARG_RESTORE, false) ?: false

        if (!isRestore) {
            // Fresh call — populate CallSession from args
            CallSession.startNew(
                callId         = arguments?.getString(ARG_CALL_ID, "") ?: "",
                remoteUsername = arguments?.getString(ARG_REMOTE_NAME, "Unknown") ?: "Unknown",
                remoteDevice   = arguments?.getString(ARG_REMOTE_DEVICE, "") ?: "",
                isVideo        = arguments?.getBoolean(ARG_IS_VIDEO, false) ?: false,
                direction      = arguments?.getString(ARG_DIRECTION, "inbound") ?: "inbound"
            )
        }
        // else: CallSession already has live state — just re-attach UI
    }

    override fun onCreateView(inf: LayoutInflater, c: ViewGroup?, s: Bundle?): View? =
        inf.inflate(R.layout.fragment_call, c, false)

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
        tvSwapHint      = view.findViewById(R.id.tv_swap_hint)

        tvUsername?.text = CallSession.remoteUsername
        tvAvatar?.text   = CallSession.remoteUsername.firstOrNull()?.uppercaseChar()?.toString() ?: "?"

        btnAccept?.setOnClickListener       { acceptCall() }
        btnEnd?.setOnClickListener          {
            if (CallSession.state == CallSession.State.RINGING_IN) rejectCall() else endCall()
        }
        btnMute?.setOnClickListener         { toggleMute() }
        btnSpeaker?.setOnClickListener      { toggleSpeaker() }
        btnCameraOff?.setOnClickListener    { toggleCamera() }
        btnSwitchCamera?.setOnClickListener { switchCamera() }
        btnMinimize?.setOnClickListener     { minimizeCall() }
        localVideoView?.setOnClickListener  { swapVideoViews() }
        remoteVideoView?.setOnClickListener { flashControls() }

        // Re-sync mute button alpha
        btnMute?.alpha    = if (CallSession.isMuted) 0.4f else 1.0f
        btnSpeaker?.alpha = if (CallSession.isSpeakerOn) 1.0f else 0.4f

        // Collect signaling events
        lifecycleScope.launch { wsManager.callEvents.collect { handleCallEvent(it) } }

        if (isRestore) {
            // Re-attach video renderers to existing tracks
            attachVideoSinks()
            // Resume timer if active
            if (CallSession.state == CallSession.State.ACTIVE) {
                tvStatus?.text = fmt(CallSession.durationSec)
                mainHandler.post(durationTick)
            }
            updateUI()
        } else {
            updateUI()
            if (CallSession.direction == "outbound") {
                activity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL
                wsManager.sendCallSignal("call_invite", CallSession.callId, CallSession.remoteDevice,
                    JSONObject().apply { put("isVideo", CallSession.isVideo) })
                if (CallSession.isVideo) lifecycleScope.launch { startLocalPreviewOnly() }
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        mainHandler.removeCallbacks(durationTick)
        // Detach video sinks from views that are being destroyed
        // (tracks stay alive in CallSession)
        detachVideoSinks()
        remoteVideoView?.release()
        localVideoView?.release()
        remoteVideoView = null
        localVideoView  = null
        btnMinimize     = null
        tvSwapHint      = null
    }

    // ── Signaling ─────────────────────────────────────────────────────────

    private fun handleCallEvent(event: WebSocketManager.CallEvent) {
        if (!isAdded) return
        mainHandler.post {
            if (!isAdded) return@post
            when (event) {
                is WebSocketManager.CallEvent.Accepted -> {
                    if (event.callId == CallSession.callId &&
                        CallSession.state == CallSession.State.RINGING_OUT) {
                        CallSession.setState(CallSession.State.CONNECTING)
                        tvStatus?.text = "Connecting…"
                        mainActivity.updateBubbleTimer("Connecting…")
                        lifecycleScope.launch { initWebRTCAndSendOffer() }
                    }
                }
                is WebSocketManager.CallEvent.Rejected -> {
                    if (event.callId == CallSession.callId) {
                        tvStatus?.text = if (event.reason == "busy") "Line is busy" else "Call declined"
                        scheduleClose(1500)
                    }
                }
                is WebSocketManager.CallEvent.Ended -> {
                    if (event.callId == CallSession.callId) {
                        tvStatus?.text = "Call ended"
                        scheduleClose(1500)
                    }
                }
                is WebSocketManager.CallEvent.Offer ->
                    if (event.callId == CallSession.callId) handleRemoteOffer(event.sdp)
                is WebSocketManager.CallEvent.Answer ->
                    if (event.callId == CallSession.callId) handleRemoteAnswer(event.sdp)
                is WebSocketManager.CallEvent.IceCandidate ->
                    if (event.callId == CallSession.callId) handleRemoteIce(event.candidate)
                else -> {}
            }
        }
    }

    // ── Call control ──────────────────────────────────────────────────────

    private fun acceptCall() {
        if (CallSession.state != CallSession.State.RINGING_IN) return
        CallSession.setState(CallSession.State.CONNECTING)
        tvStatus?.text = "Connecting…"
        btnAccept?.visibility = View.GONE
        updateUI()
        activity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL
        wsManager.sendCallSignal("call_accept", CallSession.callId, CallSession.remoteDevice)
        lifecycleScope.launch { initWebRTCAsync() }
    }

    private fun rejectCall() {
        wsManager.sendCallSignal("call_reject", CallSession.callId, CallSession.remoteDevice,
            JSONObject().apply { put("reason", "rejected") })
        finishCall()
    }

    private fun endCall() {
        wsManager.sendCallSignal("call_end", CallSession.callId, CallSession.remoteDevice)
        scheduleClose(0)
    }

    // ── Minimize: pop fragment, show bubble ───────────────────────────────

    private fun minimizeCall() {
        // Pop ourselves off the stack — app content becomes visible immediately
        mainActivity.hideBubbleAndRestoreIfNeeded() // clear any stale bubble
        mainActivity.showCallBubble()               // attach the new bubble
        try { parentFragmentManager.popBackStack() } catch (e: Exception) {
            Log.e(TAG, "popBackStack on minimize: ${e.message}")
        }
    }

    // ── Video sinks ───────────────────────────────────────────────────────

    private fun attachVideoSinks() {
        val egl    = CallSession.eglBase ?: return
        val lTrack = CallSession.localVideoTrack
        val rTrack = CallSession.remoteVideoTrack

        if (CallSession.isVideo) {
            localVideoView?.apply {
                runCatching { release() }
                init(egl.eglBaseContext, null)
                setMirror(CallSession.usingFrontCamera)
                setEnableHardwareScaler(true)
                if (!CallSession.isSwapped) lTrack?.addSink(this)
                else rTrack?.addSink(this)
                visibility = View.VISIBLE
            }
            remoteVideoView?.apply {
                runCatching { release() }
                init(egl.eglBaseContext, null)
                setEnableHardwareScaler(true)
                if (!CallSession.isSwapped) rTrack?.addSink(this)
                else lTrack?.addSink(this)
                visibility = View.VISIBLE
            }
        }
    }

    private fun detachVideoSinks() {
        CallSession.localVideoTrack?.let  { t ->
            runCatching { localVideoView?.let  { t.removeSink(it) } }
        }
        CallSession.remoteVideoTrack?.let { t ->
            runCatching { remoteVideoView?.let { t.removeSink(it) } }
        }
    }

    // ── Tap-to-swap (WhatsApp style) ──────────────────────────────────────

    private fun swapVideoViews() {
        if (!CallSession.isVideo || CallSession.state != CallSession.State.ACTIVE) return
        val lv = localVideoView  ?: return
        val rv = remoteVideoView ?: return
        val lTrack = CallSession.localVideoTrack
        val rTrack = CallSession.remoteVideoTrack

        CallSession.isSwapped = !CallSession.isSwapped

        lTrack?.removeSink(lv); lTrack?.removeSink(rv)
        rTrack?.removeSink(lv); rTrack?.removeSink(rv)

        if (CallSession.isSwapped) {
            lTrack?.addSink(rv); rv.setMirror(CallSession.usingFrontCamera)
            rTrack?.addSink(lv); lv.setMirror(false)
        } else {
            rTrack?.addSink(rv); rv.setMirror(false)
            lTrack?.addSink(lv); lv.setMirror(CallSession.usingFrontCamera)
        }
        showSwapHint()
    }

    private fun flashControls() {
        if (CallSession.state != CallSession.State.ACTIVE) return
        val controls = view?.findViewById<View>(R.id.controls_layout) ?: return
        controls.animate().cancel()
        controls.alpha = 1f
        controls.visibility = View.VISIBLE
        mainHandler.postDelayed({
            controls.animate().alpha(0f).setDuration(400)
                .withEndAction { controls.alpha = 1f }.start()
        }, 3000)
    }

    private fun showSwapHint() {
        val hint = tvSwapHint ?: return
        hint.visibility = View.VISIBLE; hint.alpha = 1f
        mainHandler.postDelayed({
            hint.animate().alpha(0f).setDuration(500)
                .withEndAction { hint.visibility = View.GONE; hint.alpha = 1f }.start()
        }, 2000)
    }

    // ── Controls ──────────────────────────────────────────────────────────

    private fun toggleMute() {
        CallSession.isMuted = !CallSession.isMuted
        CallSession.localAudioTrack?.setEnabled(!CallSession.isMuted)
        btnMute?.alpha = if (CallSession.isMuted) 0.4f else 1.0f
        Toast.makeText(requireContext(),
            if (CallSession.isMuted) "Muted" else "Unmuted", Toast.LENGTH_SHORT).show()
    }

    private fun toggleSpeaker() {
        CallSession.isSpeakerOn = !CallSession.isSpeakerOn
        val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
        am.isSpeakerphoneOn = CallSession.isSpeakerOn
        btnSpeaker?.alpha = if (CallSession.isSpeakerOn) 1.0f else 0.4f
    }

    private fun toggleCamera() {
        CallSession.cameraEnabled = !CallSession.cameraEnabled
        CallSession.localVideoTrack?.setEnabled(CallSession.cameraEnabled)
        btnCameraOff?.alpha = if (CallSession.cameraEnabled) 1.0f else 0.4f
        localVideoView?.visibility = if (CallSession.cameraEnabled) View.VISIBLE else View.INVISIBLE
    }

    private fun switchCamera() {
        CallSession.videoCapturer?.switchCamera(object : CameraVideoCapturer.CameraSwitchHandler {
            override fun onCameraSwitchDone(isFront: Boolean) {
                CallSession.usingFrontCamera = isFront
                mainHandler.post {
                    if (!CallSession.isSwapped) localVideoView?.setMirror(isFront)
                    else remoteVideoView?.setMirror(isFront)
                }
            }
            override fun onCameraSwitchError(e: String?) { Log.e(TAG, "switchCamera: $e") }
        })
    }

    // ── UI sync ───────────────────────────────────────────────────────────

    private fun updateUI() {
        when (CallSession.state) {
            CallSession.State.RINGING_IN -> {
                tvStatus?.text = "Incoming ${if (CallSession.isVideo) "video" else "audio"} call"
                btnAccept?.visibility = View.VISIBLE
                btnMute?.visibility = View.GONE; btnSpeaker?.visibility = View.GONE
                btnCameraOff?.visibility = View.GONE; btnSwitchCamera?.visibility = View.GONE
                btnMinimize?.visibility = View.GONE
            }
            CallSession.State.RINGING_OUT, CallSession.State.CONNECTING -> {
                tvStatus?.text = if (CallSession.state == CallSession.State.CONNECTING) "Connecting…" else "Calling…"
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.GONE; btnSpeaker?.visibility = View.GONE
                btnCameraOff?.visibility = View.GONE; btnSwitchCamera?.visibility = View.GONE
                btnMinimize?.visibility = View.VISIBLE
            }
            CallSession.State.ACTIVE -> {
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.VISIBLE; btnSpeaker?.visibility = View.VISIBLE
                btnCameraOff?.visibility = if (CallSession.isVideo) View.VISIBLE else View.GONE
                btnSwitchCamera?.visibility = if (CallSession.isVideo) View.VISIBLE else View.GONE
                btnMinimize?.visibility = View.VISIBLE
                if (CallSession.isVideo) {
                    (view as? ViewGroup)?.getChildAt(2)
                        ?.animate()?.alpha(0f)?.setDuration(400)?.start()
                }
            }
            CallSession.State.ENDED, CallSession.State.IDLE -> {
                btnAccept?.visibility = View.GONE
                btnMute?.visibility = View.GONE; btnSpeaker?.visibility = View.GONE
                btnCameraOff?.visibility = View.GONE; btnSwitchCamera?.visibility = View.GONE
                btnMinimize?.visibility = View.GONE
            }
        }
    }

    // ── WebRTC init ───────────────────────────────────────────────────────

    private suspend fun initWebRTCAndSendOffer() {
        initWebRTCAsync()
        if (!isAdded || CallSession.peerConnection == null) return
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", CallSession.isVideo.toString()))
        }
        CallSession.peerConnection?.createOffer(object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) {
                CallSession.peerConnection?.setLocalDescription(sdpObserver(
                    onSuccess = {
                        wsManager.sendCallSignal("call_offer", CallSession.callId, CallSession.remoteDevice,
                            JSONObject().apply {
                                put("data", JSONObject().apply {
                                    put("type", sdp.type.canonicalForm())
                                    put("sdp", sdp.description)
                                })
                            })
                    }), sdp)
            }
            override fun onCreateFailure(e: String?) { Log.e(TAG, "createOffer failed: $e") }
            override fun onSetSuccess() {}; override fun onSetFailure(p0: String?) {}
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
                PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions())
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

            val audioConstraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("googHighpassFilter", "true"))
            }
            val audioTrack = factory.createAudioTrack("audio0", factory.createAudioSource(audioConstraints))
            pc.addTrack(audioTrack)

            var videoTrack: VideoTrack? = null
            var capturer: CameraVideoCapturer? = null
            var stHelper: SurfaceTextureHelper? = null

            if (CallSession.isVideo && hasCameraPermission()) {
                capturer = makeCameraCapturer(CallSession.usingFrontCamera)
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

                // Clean up preview capturer if it was started separately
                if (CallSession.videoCapturer != null && CallSession.videoCapturer !== capturer) {
                    runCatching { CallSession.videoCapturer?.stopCapture(); CallSession.videoCapturer?.dispose() }
                    runCatching { CallSession.surfaceTextureHelper?.dispose() }
                    runCatching { CallSession.localVideoTrack?.dispose() }
                }

                CallSession.eglBase               = egl
                CallSession.peerConnectionFactory = factory
                CallSession.peerConnection        = pc
                CallSession.localAudioTrack       = audioTrack
                CallSession.localVideoTrack       = videoTrack
                CallSession.videoCapturer         = capturer
                CallSession.surfaceTextureHelper  = stHelper

                if (CallSession.isVideo && videoTrack != null) {
                    localVideoView?.apply {
                        runCatching { release() }
                        init(egl.eglBaseContext, null)
                        setMirror(CallSession.usingFrontCamera)
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

                CallSession.pendingOffer?.let { o ->
                    CallSession.pendingOffer = null
                    handleRemoteOffer(o)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "initWebRTCAsync failed", e)
            withContext(Dispatchers.Main) {
                if (isAdded) { tvStatus?.text = "Setup failed"; scheduleClose(1500) }
            }
        }
    }

    private suspend fun startLocalPreviewOnly() = withContext(Dispatchers.IO) {
        if (!CallSession.isVideo || !hasCameraPermission()) return@withContext
        val ctx = requireContext().applicationContext
        try {
            val egl = EglBase.create()
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions())
            val factory = PeerConnectionFactory.builder()
                .setOptions(PeerConnectionFactory.Options())
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
                .createPeerConnectionFactory()
            val capturer = makeCameraCapturer(CallSession.usingFrontCamera) ?: return@withContext
            val stHelper = SurfaceTextureHelper.create("PreviewThread", egl.eglBaseContext)
            val videoSource = factory.createVideoSource(capturer.isScreencast)
            capturer.initialize(stHelper, ctx, videoSource.capturerObserver)
            capturer.startCapture(1280, 720, 30)
            val videoTrack = factory.createVideoTrack("video_preview", videoSource)

            withContext(Dispatchers.Main) {
                if (!isAdded || CallSession.peerConnectionFactory != null) {
                    runCatching { capturer.stopCapture(); capturer.dispose() }
                    runCatching { stHelper.dispose(); videoTrack.dispose(); factory.dispose(); egl.release() }
                    return@withContext
                }
                CallSession.eglBase = egl; CallSession.peerConnectionFactory = factory
                CallSession.videoCapturer = capturer; CallSession.surfaceTextureHelper = stHelper
                CallSession.localVideoTrack = videoTrack
                localVideoView?.apply {
                    runCatching { release() }
                    init(egl.eglBaseContext, null); setMirror(CallSession.usingFrontCamera)
                    setEnableHardwareScaler(true); videoTrack.addSink(this); visibility = View.VISIBLE
                }
            }
        } catch (e: Exception) { Log.w(TAG, "startLocalPreviewOnly: ${e.message}") }
    }

    // ── PeerConnection observer ───────────────────────────────────────────

    private fun makePcObserver() = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            wsManager.sendCallSignal("call_ice", CallSession.callId, CallSession.remoteDevice,
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
                    CallSession.remoteVideoTrack = track
                    val rv = remoteVideoView
                    val lv = localVideoView
                    if (rv != null) {
                        if (!CallSession.isSwapped) track.addSink(rv)
                        else lv?.let { track.addSink(it) }
                        rv.visibility = View.VISIBLE
                    }
                }
                if (CallSession.state != CallSession.State.ACTIVE) {
                    CallSession.setState(CallSession.State.ACTIVE)
                    updateUI()
                    mainHandler.post(durationTick)
                    if (CallSession.isVideo) showSwapHint()
                }
            }
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            mainHandler.post {
                if (!isAdded) return@post
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED,
                    PeerConnection.IceConnectionState.COMPLETED -> {
                        if (CallSession.state != CallSession.State.ACTIVE) {
                            CallSession.setState(CallSession.State.ACTIVE)
                            updateUI(); mainHandler.post(durationTick)
                        }
                    }
                    PeerConnection.IceConnectionState.FAILED -> {
                        tvStatus?.text = "Connection failed"; scheduleClose(2000)
                    }
                    PeerConnection.IceConnectionState.DISCONNECTED -> {
                        if (CallSession.state == CallSession.State.ACTIVE) tvStatus?.text = "Reconnecting…"
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
        val pc = CallSession.peerConnection
        if (pc == null) { CallSession.pendingOffer = sdpJson; return }
        val obj = runCatching { JSONObject(sdpJson) }.getOrNull() ?: return
        val sdp = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(obj.optString("type", "offer")),
            obj.optString("sdp", ""))
        pc.setRemoteDescription(sdpObserver(onSuccess = {
            CallSession.remoteDescSet = true; drainCandidates()
            pc.createAnswer(object : SdpObserver {
                override fun onCreateSuccess(answer: SessionDescription) {
                    pc.setLocalDescription(sdpObserver(onSuccess = {
                        wsManager.sendCallSignal("call_answer", CallSession.callId, CallSession.remoteDevice,
                            JSONObject().apply {
                                put("data", JSONObject().apply {
                                    put("type", answer.type.canonicalForm())
                                    put("sdp", answer.description)
                                })
                            })
                    }), answer)
                }
                override fun onCreateFailure(e: String?) { Log.e(TAG, "createAnswer: $e") }
                override fun onSetSuccess() {}; override fun onSetFailure(p0: String?) {}
            }, MediaConstraints())
        }), sdp)
    }

    private fun handleRemoteAnswer(sdpJson: String) {
        val pc = CallSession.peerConnection ?: return
        val obj = runCatching { JSONObject(sdpJson) }.getOrNull() ?: return
        val sdp = SessionDescription(
            SessionDescription.Type.fromCanonicalForm(obj.optString("type", "answer")),
            obj.optString("sdp", ""))
        pc.setRemoteDescription(sdpObserver(onSuccess = {
            CallSession.remoteDescSet = true; drainCandidates()
        }), sdp)
    }

    private fun handleRemoteIce(json: String) {
        if (CallSession.remoteDescSet) applyCandidate(json)
        else synchronized(CallSession.pendingCandidates) { CallSession.pendingCandidates.add(json) }
    }

    private fun drainCandidates() {
        val list = synchronized(CallSession.pendingCandidates) {
            CallSession.pendingCandidates.toList().also { CallSession.pendingCandidates.clear() }
        }
        list.forEach { applyCandidate(it) }
    }

    private fun applyCandidate(json: String) {
        try {
            val obj = JSONObject(json)
            CallSession.peerConnection?.addIceCandidate(IceCandidate(
                obj.optString("sdpMid", ""),
                obj.optInt("sdpMLineIndex", 0),
                obj.optString("candidate", "")))
        } catch (e: Exception) { Log.e(TAG, "addIceCandidate: ${e.message}") }
    }

    // ── Cleanup / close ───────────────────────────────────────────────────

    private fun scheduleClose(delayMs: Long) {
        CallSession.setState(CallSession.State.ENDED)
        updateUI()
        mainHandler.removeCallbacks(durationTick)
        mainHandler.postDelayed({ finishCall() }, delayMs)
    }

    private fun finishCall() {
        mainActivity.hideBubbleAndRestoreIfNeeded()
        restoreAudio()
        CallSession.cleanup()
        if (!isAdded) return
        try { parentFragmentManager.popBackStack() } catch (e: Exception) {
            Log.e(TAG, "popBackStack: ${e.message}")
        }
    }

    private fun restoreAudio() {
        runCatching {
            val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_NORMAL; am.isSpeakerphoneOn = false
        }
        runCatching { requireActivity().volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE }
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    private fun fmt(s: Int) = "%02d:%02d".format(s / 60, s % 60)

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

    private fun sdpObserver(onSuccess: () -> Unit = {}, onFail: (String?) -> Unit = {}) =
        object : SdpObserver {
            override fun onSetSuccess()                          { onSuccess() }
            override fun onSetFailure(e: String?)                { onFail(e) }
            override fun onCreateSuccess(s: SessionDescription?) {}
            override fun onCreateFailure(e: String?)             {}
        }
}
