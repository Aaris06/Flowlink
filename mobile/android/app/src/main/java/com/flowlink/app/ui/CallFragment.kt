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
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.flowlink.app.MainActivity
import com.flowlink.app.R
import com.flowlink.app.service.WebSocketManager
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.webrtc.*

/**
 * CallFragment — handles audio/video calls via WebRTC.
 *
 * Lifecycle:
 *   Incoming: state = RINGING_IN  → user taps Accept → CONNECTING → ACTIVE
 *   Outgoing: state = RINGING_OUT → remote accepts  → CONNECTING → ACTIVE
 */
class CallFragment : Fragment() {

    enum class CallState { RINGING_IN, RINGING_OUT, CONNECTING, ACTIVE, ENDED }

    companion object {
        const val ARG_CALL_ID = "callId"
        const val ARG_REMOTE_USERNAME = "remoteUsername"
        const val ARG_REMOTE_DEVICE = "remoteDevice"
        const val ARG_IS_VIDEO = "isVideo"
        const val ARG_DIRECTION = "direction" // "inbound" | "outbound"

        fun newIncoming(callId: String, fromUsername: String, fromDevice: String, isVideo: Boolean): CallFragment {
            return CallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_CALL_ID, callId)
                    putString(ARG_REMOTE_USERNAME, fromUsername)
                    putString(ARG_REMOTE_DEVICE, fromDevice)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "inbound")
                }
            }
        }

        fun newOutgoing(callId: String, toUsername: String, toDevice: String, isVideo: Boolean): CallFragment {
            return CallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_CALL_ID, callId)
                    putString(ARG_REMOTE_USERNAME, toUsername)
                    putString(ARG_REMOTE_DEVICE, toDevice)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "outbound")
                }
            }
        }
    }

    private lateinit var mainActivity: MainActivity
    private lateinit var wsManager: WebSocketManager

    private var callId = ""
    private var remoteUsername = ""
    private var remoteDevice = ""
    private var isVideo = false
    private var direction = "inbound"
    private var callState = CallState.RINGING_IN

    // WebRTC
    private var peerConnectionFactory: PeerConnectionFactory? = null
    private var peerConnection: PeerConnection? = null
    private var localAudioTrack: AudioTrack? = null
    private var localVideoTrack: VideoTrack? = null
    private var remoteVideoView: SurfaceViewRenderer? = null
    private var localVideoView: SurfaceViewRenderer? = null
    private var eglBase: EglBase? = null
    private var isMuted = false
    private var isSpeakerOn = false

    // Duration timer
    private val handler = Handler(Looper.getMainLooper())
    private var durationSeconds = 0
    private val durationRunnable = object : Runnable {
        override fun run() {
            durationSeconds++
            view?.findViewById<TextView>(R.id.call_status)?.text = formatDuration(durationSeconds)
            handler.postDelayed(this, 1000)
        }
    }

    // Views
    private lateinit var btnAccept: ImageButton
    private lateinit var btnEnd: ImageButton
    private lateinit var btnMute: ImageButton
    private lateinit var btnSpeaker: ImageButton
    private lateinit var tvRemoteUsername: TextView
    private lateinit var tvStatus: TextView
    private lateinit var tvAvatar: TextView

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

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.fragment_call, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        remoteVideoView = view.findViewById(R.id.remote_video)
        localVideoView = view.findViewById(R.id.local_video)
        btnAccept = view.findViewById(R.id.btn_accept)
        btnEnd = view.findViewById(R.id.btn_end)
        btnMute = view.findViewById(R.id.btn_mute)
        btnSpeaker = view.findViewById(R.id.btn_speaker)
        tvRemoteUsername = view.findViewById(R.id.remote_username)
        tvStatus = view.findViewById(R.id.call_status)
        tvAvatar = view.findViewById(R.id.avatar_text)

        tvRemoteUsername.text = remoteUsername
        tvAvatar.text = remoteUsername.firstOrNull()?.uppercaseChar()?.toString() ?: "?"

        updateUI()

        btnAccept.setOnClickListener { acceptCall() }
        btnEnd.setOnClickListener {
            when (callState) {
                CallState.RINGING_IN -> rejectCall()
                else -> endCall()
            }
        }
        btnMute.setOnClickListener { toggleMute() }
        btnSpeaker.setOnClickListener { toggleSpeaker() }

        // Listen for call events from WebSocketManager
        lifecycleScope.launch {
            wsManager.callEvents.collect { event -> handleCallEvent(event) }
        }

        // If outbound, send invite immediately
        if (direction == "outbound") {
            wsManager.sendCallSignal("call_invite", callId, remoteDevice,
                JSONObject().apply { put("isVideo", isVideo) })
            tvStatus.text = "Calling…"
        }
    }

    private fun handleCallEvent(event: WebSocketManager.CallEvent) {
        requireActivity().runOnUiThread {
            when (event) {
                is WebSocketManager.CallEvent.Accepted -> {
                    if (event.callId == callId && callState == CallState.RINGING_OUT) {
                        callState = CallState.CONNECTING
                        tvStatus.text = "Connecting…"
                        initWebRTCAndSendOffer()
                    }
                }
                is WebSocketManager.CallEvent.Rejected -> {
                    if (event.callId == callId) {
                        val msg = if (event.reason == "busy") "Line is busy" else "Call declined"
                        tvStatus.text = msg
                        scheduleClose()
                    }
                }
                is WebSocketManager.CallEvent.Ended -> {
                    if (event.callId == callId) {
                        tvStatus.text = "Call ended"
                        scheduleClose()
                    }
                }
                is WebSocketManager.CallEvent.Offer -> {
                    if (event.callId == callId) {
                        handleRemoteOffer(event.sdp)
                    }
                }
                is WebSocketManager.CallEvent.Answer -> {
                    if (event.callId == callId) {
                        handleRemoteAnswer(event.sdp)
                    }
                }
                is WebSocketManager.CallEvent.IceCandidate -> {
                    if (event.callId == callId) {
                        addIceCandidate(event.candidate)
                    }
                }
                else -> { /* Incoming handled at MainActivity level */ }
            }
        }
    }

    private fun acceptCall() {
        if (callState != CallState.RINGING_IN) return
        callState = CallState.CONNECTING
        tvStatus.text = "Connecting…"
        btnAccept.visibility = View.GONE
        updateUI()

        wsManager.sendCallSignal("call_accept", callId, remoteDevice)
        // Offer will arrive from the caller, then we respond with answer
        initWebRTC()
    }

    private fun rejectCall() {
        wsManager.sendCallSignal("call_reject", callId, remoteDevice,
            JSONObject().apply { put("reason", "rejected") })
        closeFragment()
    }

    private fun endCall() {
        wsManager.sendCallSignal("call_end", callId, remoteDevice)
        cleanup()
        closeFragment()
    }

    private fun initWebRTCAndSendOffer() {
        if (!checkAudioPermission()) return
        initWebRTC()
        val constraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", isVideo.toString()))
        }
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
                    override fun onSetFailure(error: String?) { Log.e("Call", "setLocalDescription failed: $error") }
                    override fun onCreateSuccess(p0: SessionDescription?) {}
                    override fun onCreateFailure(p0: String?) {}
                }, sdp)
            }
            override fun onCreateFailure(error: String?) { Log.e("Call", "createOffer failed: $error") }
            override fun onSetSuccess() {}
            override fun onSetFailure(p0: String?) {}
        }, constraints)
    }

    private fun handleRemoteOffer(sdpJson: String) {
        val obj = JSONObject(sdpJson)
        val sdp = SessionDescription(SessionDescription.Type.fromCanonicalForm(obj.optString("type", "offer")), obj.optString("sdp", ""))
        peerConnection?.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() {
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
                            override fun onSetFailure(e: String?) {}
                            override fun onCreateSuccess(p0: SessionDescription?) {}
                            override fun onCreateFailure(p0: String?) {}
                        }, answer)
                    }
                    override fun onCreateFailure(e: String?) { Log.e("Call", "createAnswer failed: $e") }
                    override fun onSetSuccess() {}
                    override fun onSetFailure(p0: String?) {}
                }, constraints)
            }
            override fun onSetFailure(e: String?) { Log.e("Call", "setRemoteDescription (offer) failed: $e") }
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onCreateFailure(p0: String?) {}
        }, sdp)
    }

    private fun handleRemoteAnswer(sdpJson: String) {
        val obj = JSONObject(sdpJson)
        val sdp = SessionDescription(SessionDescription.Type.fromCanonicalForm(obj.optString("type", "answer")), obj.optString("sdp", ""))
        peerConnection?.setRemoteDescription(object : SdpObserver {
            override fun onSetSuccess() { Log.d("Call", "Remote answer set") }
            override fun onSetFailure(e: String?) { Log.e("Call", "setRemoteDescription (answer) failed: $e") }
            override fun onCreateSuccess(p0: SessionDescription?) {}
            override fun onCreateFailure(p0: String?) {}
        }, sdp)
    }

    private fun addIceCandidate(candidateJson: String) {
        try {
            val obj = JSONObject(candidateJson)
            val candidate = IceCandidate(
                obj.optString("sdpMid", ""),
                obj.optInt("sdpMLineIndex", 0),
                obj.optString("candidate", "")
            )
            peerConnection?.addIceCandidate(candidate)
        } catch (e: Exception) {
            Log.e("Call", "addIceCandidate failed", e)
        }
    }

    private fun initWebRTC() {
        if (!checkAudioPermission()) return

        eglBase = EglBase.create()

        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(requireContext())
                .createInitializationOptions()
        )

        val options = PeerConnectionFactory.Options()
        peerConnectionFactory = PeerConnectionFactory.builder()
            .setOptions(options)
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase!!.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase!!.eglBaseContext))
            .createPeerConnectionFactory()

        val iceServers = listOf(
            PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
            PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer()
        )
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
        }

        peerConnection = peerConnectionFactory!!.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
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
                if (track is VideoTrack) {
                    requireActivity().runOnUiThread {
                        remoteVideoView?.visibility = View.VISIBLE
                        track.addSink(remoteVideoView)
                    }
                }
                requireActivity().runOnUiThread {
                    callState = CallState.ACTIVE
                    updateUI()
                    handler.post(durationRunnable)
                }
            }
            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                if (state == PeerConnection.IceConnectionState.CONNECTED || state == PeerConnection.IceConnectionState.COMPLETED) {
                    requireActivity().runOnUiThread {
                        callState = CallState.ACTIVE
                        updateUI()
                        handler.post(durationRunnable)
                    }
                } else if (state == PeerConnection.IceConnectionState.FAILED || state == PeerConnection.IceConnectionState.DISCONNECTED) {
                    requireActivity().runOnUiThread {
                        tvStatus.text = "Connection lost"
                        scheduleClose()
                    }
                }
            }
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: MediaStream?) {}
            override fun onRemoveStream(p0: MediaStream?) {}
            override fun onDataChannel(p0: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
        })

        // Add local audio track
        val audioSource = peerConnectionFactory!!.createAudioSource(MediaConstraints())
        localAudioTrack = peerConnectionFactory!!.createAudioTrack("audio0", audioSource)
        peerConnection?.addTrack(localAudioTrack!!)

        // Add local video track if video call
        if (isVideo) {
            val videoCapturer = createCameraCapturer()
            if (videoCapturer != null) {
                val surfaceHelper = SurfaceTextureHelper.create("CaptureThread", eglBase!!.eglBaseContext)
                val videoSource = peerConnectionFactory!!.createVideoSource(videoCapturer.isScreencast)
                videoCapturer.initialize(surfaceHelper, requireContext(), videoSource.capturerObserver)
                videoCapturer.startCapture(640, 480, 30)
                localVideoTrack = peerConnectionFactory!!.createVideoTrack("video0", videoSource)
                peerConnection?.addTrack(localVideoTrack!!)

                requireActivity().runOnUiThread {
                    localVideoView?.let { vv ->
                        vv.init(eglBase!!.eglBaseContext, null)
                        vv.setMirror(true)
                        vv.visibility = View.VISIBLE
                        localVideoTrack?.addSink(vv)
                    }
                    remoteVideoView?.init(eglBase!!.eglBaseContext, null)
                }
            }
        }
    }

    private fun createCameraCapturer(): CameraVideoCapturer? {
        val enumerator = Camera2Enumerator(requireContext())
        // Try front camera first
        for (device in enumerator.deviceNames) {
            if (enumerator.isFrontFacing(device)) {
                return enumerator.createCapturer(device, null)
            }
        }
        // Fallback to any camera
        for (device in enumerator.deviceNames) {
            return enumerator.createCapturer(device, null)
        }
        return null
    }

    private fun toggleMute() {
        isMuted = !isMuted
        localAudioTrack?.setEnabled(!isMuted)
        btnMute.alpha = if (isMuted) 0.5f else 1.0f
        Toast.makeText(requireContext(), if (isMuted) "Muted" else "Unmuted", Toast.LENGTH_SHORT).show()
    }

    private fun toggleSpeaker() {
        isSpeakerOn = !isSpeakerOn
        val audioManager = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as android.media.AudioManager
        audioManager.isSpeakerphoneOn = isSpeakerOn
        btnSpeaker.alpha = if (isSpeakerOn) 1.0f else 0.5f
    }

    private fun checkAudioPermission(): Boolean {
        return ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    }

    private fun formatDuration(seconds: Int): String {
        val m = seconds / 60
        val s = seconds % 60
        return "%02d:%02d".format(m, s)
    }

    private fun updateUI() {
        when (callState) {
            CallState.RINGING_IN -> {
                tvStatus.text = "Incoming ${if (isVideo) "video" else "audio"} call"
                btnAccept.visibility = View.VISIBLE
                btnMute.visibility = View.GONE
                btnSpeaker.visibility = View.GONE
            }
            CallState.RINGING_OUT -> {
                tvStatus.text = "Calling…"
                btnAccept.visibility = View.GONE
                btnMute.visibility = View.GONE
                btnSpeaker.visibility = View.GONE
            }
            CallState.CONNECTING -> {
                tvStatus.text = "Connecting…"
                btnAccept.visibility = View.GONE
                btnMute.visibility = View.GONE
                btnSpeaker.visibility = View.GONE
            }
            CallState.ACTIVE -> {
                btnAccept.visibility = View.GONE
                btnMute.visibility = View.VISIBLE
                btnSpeaker.visibility = View.VISIBLE
            }
            CallState.ENDED -> {
                btnAccept.visibility = View.GONE
                btnMute.visibility = View.GONE
                btnSpeaker.visibility = View.GONE
            }
        }
    }

    private fun scheduleClose() {
        callState = CallState.ENDED
        cleanup()
        handler.postDelayed({ closeFragment() }, 1500)
    }

    private fun cleanup() {
        handler.removeCallbacks(durationRunnable)
        localAudioTrack?.dispose()
        localVideoTrack?.dispose()
        peerConnection?.close()
        peerConnectionFactory?.dispose()
        localVideoView?.release()
        remoteVideoView?.release()
        eglBase?.release()
        localAudioTrack = null
        localVideoTrack = null
        peerConnection = null
        peerConnectionFactory = null
    }

    private fun closeFragment() {
        requireActivity().runOnUiThread {
            try {
                parentFragmentManager.popBackStack()
            } catch (e: Exception) {
                Log.e("Call", "Failed to pop back stack", e)
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        cleanup()
    }
}
