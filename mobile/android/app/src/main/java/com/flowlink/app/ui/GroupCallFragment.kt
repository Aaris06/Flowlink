package com.flowlink.app.ui

import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.*
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
 * GroupCallFragment — Room-based multi-participant call UI.
 *
 * Uses a full-mesh WebRTC topology: one RTCPeerConnection per remote participant.
 *
 * Key design rules:
 * - One user's rejection/leave NEVER tears down the room.
 * - Late joiners: send call_room_join to get the current participant list,
 *   then initiate offers to every peer in that list.
 * - New peer joined: server notifies everyone; new joiner sends offers to us.
 * - WebRTC tracks follow the callee pattern: setRemoteDescription THEN addTrack.
 */
class GroupCallFragment : Fragment() {

    companion object {
        private const val TAG = "GroupCallFragment"

        const val ARG_ROOM_ID   = "roomId"
        const val ARG_IS_VIDEO  = "isVideo"
        const val ARG_DIRECTION = "direction"
        const val ARG_INITIATOR = "initiator"

        /** Guards against calling PeerConnectionFactory.initialize() more than once per process */
        @Volatile private var pcfInitialized = false

        fun newIncomingRoom(roomId: String, fromUsername: String, isVideo: Boolean) =
            GroupCallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_ROOM_ID,   roomId)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "inbound")
                    putString(ARG_INITIATOR, fromUsername)
                }
            }

        fun newOutgoingRoom(roomId: String, isVideo: Boolean, initiatorUsername: String) =
            GroupCallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_ROOM_ID,   roomId)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "outbound")
                    putString(ARG_INITIATOR, initiatorUsername)
                }
            }

        /** Late-join from the "Join Now" chat button — skips ringing, auto-accepts */
        fun newJoinNow(roomId: String, isVideo: Boolean, creatorUsername: String) =
            GroupCallFragment().apply {
                arguments = Bundle().apply {
                    putString(ARG_ROOM_ID,   roomId)
                    putBoolean(ARG_IS_VIDEO, isVideo)
                    putString(ARG_DIRECTION, "join_now")
                    putString(ARG_INITIATOR, creatorUsername)
                }
            }
    }

    // ── Activity / manager refs ───────────────────────────────────────────
    private lateinit var mainActivity: MainActivity
    private lateinit var wsManager: WebSocketManager

    // ── Args ─────────────────────────────────────────────────────────────
    private var roomId    = ""
    private var isVideo   = false
    private var direction = "inbound"
    private var initiator = ""

    // ── State ─────────────────────────────────────────────────────────────
    private val mainHandler = Handler(Looper.getMainLooper())
    private var activeRingtone: android.media.Ringtone? = null
    private var durationSec = 0
    private var isActive = false

    // ── Views ─────────────────────────────────────────────────────────────
    private var tvStatus       : TextView?             = null
    private var tvParticipants : TextView?             = null
    private var btnAccept      : ImageButton?          = null
    private var btnEnd         : ImageButton?          = null
    private var btnMute        : ImageButton?          = null
    private var btnSpeaker     : ImageButton?          = null
    private var btnCameraOff   : ImageButton?          = null
    private var btnMinimize    : ImageButton?          = null
    private var videoGrid      : LinearLayout?         = null
    private var localPip       : SurfaceViewRenderer? = null  // local camera PiP overlay

    // ── WebRTC shared resources ───────────────────────────────────────────
    private var factory          : PeerConnectionFactory? = null
    private var eglBase          : EglBase?               = null
    private var localAudioSource : AudioSource?           = null
    private var localAudioTrack  : AudioTrack?            = null
    private var localVideoSource : VideoSource?           = null
    private var localVideoTrack  : VideoTrack?            = null
    private var videoCapturer    : CameraVideoCapturer?   = null

    // ── Per-peer state ────────────────────────────────────────────────────
    private data class PeerConn(
        val pc: PeerConnection,
        val videoView: SurfaceViewRenderer?,
        val peerUsername: String = "",
        var remoteVideoTrack: VideoTrack? = null,
        var remoteDescSet: Boolean = false,
        val pendingCandidates: MutableList<JSONObject> = mutableListOf()
    )
    private val peers = mutableMapOf<String, PeerConn>()

    // ── Duration ticker ───────────────────────────────────────────────────
    private val durationTick = object : Runnable {
        override fun run() {
            if (isActive && isAdded) {
                durationSec++
                tvStatus?.text = fmt(durationSec)
                // Also update the bubble timer if we are currently minimized
                mainActivity.updateGroupCallBubbleTimer(durationSec)
                mainHandler.postDelayed(this, 1000)
            }
        }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mainActivity = activity as MainActivity
        wsManager    = mainActivity.webSocketManager
        roomId    = arguments?.getString(ARG_ROOM_ID,   "") ?: ""
        isVideo   = arguments?.getBoolean(ARG_IS_VIDEO, false) ?: false
        direction = arguments?.getString(ARG_DIRECTION, "inbound") ?: "inbound"
        initiator = arguments?.getString(ARG_INITIATOR, "Group Call") ?: "Group Call"
    }

    override fun onCreateView(inf: LayoutInflater, c: ViewGroup?, s: Bundle?): View? =
        inf.inflate(R.layout.fragment_group_call, c, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)

        tvStatus       = view.findViewById(R.id.gcf_status)
        tvParticipants = view.findViewById(R.id.gcf_participants)
        btnAccept      = view.findViewById(R.id.gcf_btn_accept)
        btnEnd         = view.findViewById(R.id.gcf_btn_end)
        btnMute        = view.findViewById(R.id.gcf_btn_mute)
        btnSpeaker     = view.findViewById(R.id.gcf_btn_speaker)
        btnCameraOff   = view.findViewById(R.id.gcf_btn_camera)
        btnMinimize    = view.findViewById(R.id.gcf_btn_minimize)
        videoGrid      = view.findViewById(R.id.gcf_video_grid)
        localPip       = view.findViewById(R.id.gcf_local_pip)

        view.findViewById<TextView>(R.id.gcf_title)?.text =
            "${if (isVideo) "Video" else "Audio"} Group Call"

        btnAccept?.setOnClickListener    { acceptGroupCall() }
        btnEnd?.setOnClickListener       { leaveGroupCall() }
        btnMute?.setOnClickListener      { toggleMute() }
        btnSpeaker?.setOnClickListener   { toggleSpeaker() }
        btnCameraOff?.setOnClickListener { toggleCamera() }
        btnMinimize?.setOnClickListener  { minimizeGroupCall() }

        lifecycleScope.launch { wsManager.callEvents.collect { handleCallEvent(it) } }

        when (direction) {
            "inbound" -> {
                tvStatus?.text = "Incoming ${if (isVideo) "video" else "audio"} group call from $initiator"
                btnAccept?.visibility = View.VISIBLE
                btnMute?.visibility   = View.GONE
                startRingtone()
            }
            "outbound" -> {
                tvStatus?.text = "Calling…"
                btnAccept?.visibility = View.GONE
                btnMinimize?.visibility = View.VISIBLE
                activity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL
                lifecycleScope.launch { initWebRTC() }
            }
            "join_now" -> {
                // Late join from chat "Join Now" button — skip ringing, auto-join
                tvStatus?.text = "Joining…"
                btnAccept?.visibility = View.GONE
                btnMinimize?.visibility = View.VISIBLE
                activity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL
                lifecycleScope.launch {
                    initWebRTC()
                    // Send join after WebRTC is ready and fragment is attached
                    wsManager.sendRoomSignal("call_room_join", JSONObject().apply {
                        put("roomId", roomId)
                    })
                }
            }
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        stopRingtone()
        mainHandler.removeCallbacks(durationTick)
        // Bubble is on WindowManager — only hide it if call is ending (not when restoring)
        // isActive=false means call has ended or was never active; hide the bubble.
        // If the call is still active (minimized), the bubble should stay up.
        if (!isActive) {
            mainActivity.hideGroupCallBubble()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // Fragment is being destroyed entirely (back press while minimized, or call ended).
        // Always hide the bubble and clean up WebRTC.
        mainActivity.hideGroupCallBubble()
        cleanupAll()
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        // Reflow grid on orientation change
        mainHandler.post { rebuildVideoGrid() }
    }

    // ── Ringtone ──────────────────────────────────────────────────────────

    private fun startRingtone() {
        stopRingtone()
        activeRingtone = SettingsFragment.playRingtone(requireContext())
    }

    private fun stopRingtone() {
        activeRingtone?.stop()
        activeRingtone = null
    }

    // ── Call controls ─────────────────────────────────────────────────────

    private fun acceptGroupCall() {
        if (!isAdded) return
        stopRingtone()
        mainActivity.notificationService.dismissIncomingCall()
        tvStatus?.text = "Connecting…"
        btnAccept?.visibility = View.GONE
        activity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL
        lifecycleScope.launch {
            initWebRTC()
            wsManager.sendRoomSignal("call_room_join", JSONObject().apply { put("roomId", roomId) })
        }
    }

    private fun leaveGroupCall() {
        mainActivity.hideGroupCallBubble()
        wsManager.sendRoomSignal("call_room_leave", JSONObject().apply { put("roomId", roomId) })
        cleanupAll()
        mainActivity.hideCallFragmentContainer()
        try { parentFragmentManager.popBackStack() } catch (e: Exception) {
            Log.e(TAG, "leaveGroupCall popBackStack: ${e.message}")
        }
    }

    /** Minimize: hide fragment (WebRTC stays alive), show WindowManager floating bubble. */
    private fun minimizeGroupCall() {
        val peerList    = peers.values.toList()
        val usernames   = peerList.map { it.peerUsername }
        val videoTracks = if (isVideo) peerList.mapNotNull { it.remoteVideoTrack } else emptyList()
        val egl         = eglBase

        mainActivity.showGroupCallBubble(
            roomId      = roomId,
            isVideo     = isVideo,
            initiator   = initiator,
            durationSec = durationSec,
            usernames   = usernames,
            videoTracks = videoTracks,
            eglBase     = egl,
            onLeave     = { leaveGroupCall() }
        )
        // Hide both the fragment AND the container so no touches are blocked
        mainActivity.hideCallFragmentContainer()
        try {
            parentFragmentManager.beginTransaction()
                .hide(this)
                .commitAllowingStateLoss()
        } catch (e: Exception) {
            Log.e(TAG, "hide on minimize: ${e.message}")
        }
    }

    private fun toggleMute() {
        localAudioTrack?.let {
            it.setEnabled(!it.enabled())
            btnMute?.alpha = if (it.enabled()) 1.0f else 0.4f
        }
    }

    private fun toggleSpeaker() {
        val am = requireContext().getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
        am.isSpeakerphoneOn = !am.isSpeakerphoneOn
        btnSpeaker?.alpha = if (am.isSpeakerphoneOn) 1.0f else 0.4f
    }

    private fun toggleCamera() {
        localVideoTrack?.let {
            it.setEnabled(!it.enabled())
            btnCameraOff?.alpha = if (it.enabled()) 1.0f else 0.4f
        }
    }

    // ── Signaling event handler ───────────────────────────────────────────

    private fun handleCallEvent(event: WebSocketManager.CallEvent) {
        if (!isAdded) return
        mainHandler.post {
            if (!isAdded) return@post
            when (event) {
                is WebSocketManager.CallEvent.RoomCreated -> {
                    if (event.roomId != roomId) return@post
                    tvStatus?.text = "Waiting for others to join…"
                    activateActiveState()
                }
                is WebSocketManager.CallEvent.RoomJoined -> {
                    if (event.roomId != roomId) return@post
                    tvStatus?.text = "Connected"
                    activateActiveState()
                    updateParticipantCount(event.participants.size)
                    lifecycleScope.launch {
                        for (peer in event.participants) {
                            if (peer.deviceId.isNotBlank()) {
                                initiateOfferToPeer(peer.deviceId, peer.username)
                            }
                        }
                    }
                }
                is WebSocketManager.CallEvent.RoomPeerJoined -> {
                    if (event.roomId != roomId) return@post
                    // Only pre-create the slot if WebRTC is already initialized
                    // (factory != null). If not, the offer will arrive after
                    // initWebRTC completes and getOrCreatePeerConn will be called then.
                    if (factory != null) {
                        getOrCreatePeerConn(event.peerId, event.peerUsername)
                    }
                    updateParticipantCount(peers.size)
                }
                is WebSocketManager.CallEvent.RoomPeerLeft -> {
                    if (event.roomId != roomId) return@post
                    removePeer(event.peerId)
                    updateParticipantCount(peers.size)
                }
                is WebSocketManager.CallEvent.RoomOffer -> {
                    if (event.roomId != roomId) return@post
                    lifecycleScope.launch {
                        handleRemoteOffer(event.fromPeerId, event.peerUsername, event.sdp)
                    }
                }
                is WebSocketManager.CallEvent.RoomAnswer -> {
                    if (event.roomId != roomId) return@post
                    handleRemoteAnswer(event.fromPeerId, event.sdp)
                }
                is WebSocketManager.CallEvent.RoomIce -> {
                    if (event.roomId != roomId) return@post
                    handleRemoteIce(event.fromPeerId, event.candidate)
                }
                is WebSocketManager.CallEvent.RoomError -> {
                    if (event.roomId != roomId) return@post
                    tvStatus?.text = "Room not found or expired"
                    mainHandler.postDelayed({
                        if (isAdded) try { parentFragmentManager.popBackStack() } catch (_: Exception) {}
                    }, 1500)
                }
                else -> {}
            }
        }
    }

    private fun activateActiveState() {
        if (isActive) return
        isActive = true
        btnMute?.visibility    = View.VISIBLE
        btnSpeaker?.visibility = View.VISIBLE
        if (isVideo) btnCameraOff?.visibility = View.VISIBLE
        btnMinimize?.visibility = View.VISIBLE
        mainHandler.post(durationTick)
    }

    // ── WebRTC init ───────────────────────────────────────────────────────

    private suspend fun initWebRTC() = withContext(Dispatchers.IO) {
        if (factory != null) return@withContext   // already initialized
        val ctx = requireContext().applicationContext

        withContext(Dispatchers.Main) {
            val am = ctx.getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            am.isSpeakerphoneOn = false
        }

        eglBase = EglBase.create()
        if (!pcfInitialized) {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(ctx).createInitializationOptions()
            )
            pcfInitialized = true
        }
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase!!.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase!!.eglBaseContext))
            .createPeerConnectionFactory()

        val audioConstraints = MediaConstraints().apply {
            mandatory.add(MediaConstraints.KeyValuePair("googEchoCancellation", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googNoiseSuppression", "true"))
            mandatory.add(MediaConstraints.KeyValuePair("googAutoGainControl", "true"))
        }
        localAudioSource = factory!!.createAudioSource(audioConstraints)
        localAudioTrack  = factory!!.createAudioTrack("gcAudio0", localAudioSource).also {
            it.setEnabled(true)
        }

        if (isVideo) {
            val enumerator = Camera2Enumerator(ctx)
            val frontCam = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) }
                ?: enumerator.deviceNames.firstOrNull()
            if (frontCam != null) {
                videoCapturer    = enumerator.createCapturer(frontCam, null)
                localVideoSource = factory!!.createVideoSource(false)
                val surfaceHelper = SurfaceTextureHelper.create("GCCapture", eglBase!!.eglBaseContext)
                videoCapturer!!.initialize(surfaceHelper, ctx, localVideoSource!!.capturerObserver)
                videoCapturer!!.startCapture(640, 480, 24)
                localVideoTrack = factory!!.createVideoTrack("gcVideo0", localVideoSource)

                // Attach local track to the PiP view on main thread
                withContext(Dispatchers.Main) {
                    val pip = localPip ?: return@withContext
                    pip.init(eglBase!!.eglBaseContext, null)
                    pip.setEnableHardwareScaler(true)
                    pip.setMirror(true)
                    localVideoTrack?.addSink(pip)
                    pip.visibility = View.VISIBLE
                }
            }
        }
    }

    // ── Peer connection management ────────────────────────────────────────

    /**
     * Initiate an offer to an existing participant.
     * We are the "caller" side: add tracks BEFORE createOffer.
     */
    private suspend fun initiateOfferToPeer(peerId: String, peerUsername: String) =
        withContext(Dispatchers.Main) {
            val conn = getOrCreatePeerConn(peerId, peerUsername)
            val pc   = conn.pc

            addLocalTracksToPc(pc)

            val constraints = MediaConstraints().apply {
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveAudio", "true"))
                mandatory.add(MediaConstraints.KeyValuePair("OfferToReceiveVideo", isVideo.toString()))
            }
            pc.createOffer(object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription) {
                    pc.setLocalDescription(simpleSdpObserver {
                        wsManager.sendRoomSignal("call_room_offer", JSONObject().apply {
                            put("roomId",      roomId)
                            put("toPeerId",    peerId)
                            put("fromPeerId",  wsManager.getDeviceId())
                            put("peerUsername", mainActivity.sessionManager.getUsername())
                            put("data", JSONObject().apply {
                                put("type", sdp.type.canonicalForm())
                                put("sdp",  sdp.description)
                            })
                        })
                    }, sdp)
                }
                override fun onCreateFailure(e: String?) { Log.e(TAG, "createOffer failed: $e") }
                override fun onSetSuccess() {}
                override fun onSetFailure(p0: String?) {}
            }, constraints)
        }

    /**
     * Handle an incoming offer from a peer that joined after us.
     * We are the "callee" side: setRemoteDescription FIRST, then addTrack.
     */
    private suspend fun handleRemoteOffer(
        fromPeerId: String, peerUsername: String, sdpJson: String
    ) = withContext(Dispatchers.Main) {
        val conn = getOrCreatePeerConn(fromPeerId, peerUsername)
        val pc   = conn.pc
        try {
            val obj = JSONObject(sdpJson)
            val sdp = SessionDescription(
                SessionDescription.Type.fromCanonicalForm(obj.optString("type", "offer")),
                obj.optString("sdp", "")
            )
            pc.setRemoteDescription(simpleSdpObserver {
                conn.remoteDescSet = true
                drainCandidates(conn)

                // Add local tracks AFTER setRemoteDescription (callee pattern)
                addLocalTracksToPc(pc)

                // Force all transceivers to sendrecv
                pc.transceivers.forEach { tr ->
                    if (tr.direction == RtpTransceiver.RtpTransceiverDirection.RECV_ONLY ||
                        tr.direction == RtpTransceiver.RtpTransceiverDirection.INACTIVE) {
                        tr.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
                    }
                }

                pc.createAnswer(object : SdpObserver {
                    override fun onCreateSuccess(answerSdp: SessionDescription) {
                        pc.setLocalDescription(simpleSdpObserver {
                            wsManager.sendRoomSignal("call_room_answer", JSONObject().apply {
                                put("roomId",     roomId)
                                put("toPeerId",   fromPeerId)
                                put("fromPeerId", wsManager.getDeviceId())
                                put("data", JSONObject().apply {
                                    put("type", answerSdp.type.canonicalForm())
                                    put("sdp",  answerSdp.description)
                                })
                            })
                        }, answerSdp)
                    }
                    override fun onCreateFailure(e: String?) { Log.e(TAG, "createAnswer failed: $e") }
                    override fun onSetSuccess() {}
                    override fun onSetFailure(p0: String?) {}
                }, MediaConstraints())
            }, sdp)
        } catch (e: Exception) {
            Log.e(TAG, "handleRemoteOffer: ${e.message}")
        }
    }

    private fun handleRemoteAnswer(fromPeerId: String, sdpJson: String) {
        val conn = peers[fromPeerId] ?: return
        try {
            val obj = JSONObject(sdpJson)
            val sdp = SessionDescription(
                SessionDescription.Type.fromCanonicalForm(obj.optString("type", "answer")),
                obj.optString("sdp", "")
            )
            conn.pc.setRemoteDescription(simpleSdpObserver {
                conn.remoteDescSet = true
                drainCandidates(conn)
            }, sdp)
        } catch (e: Exception) {
            Log.e(TAG, "handleRemoteAnswer: ${e.message}")
        }
    }

    private fun handleRemoteIce(fromPeerId: String, candidateJson: String) {
        val conn = peers[fromPeerId] ?: return
        try {
            val c = JSONObject(candidateJson)
            val candidate = IceCandidate(
                c.optString("sdpMid", ""),
                c.optInt("sdpMLineIndex", 0),
                c.optString("candidate", "")
            )
            if (conn.remoteDescSet) {
                conn.pc.addIceCandidate(candidate)
            } else {
                conn.pendingCandidates.add(c)
            }
        } catch (e: Exception) {
            Log.e(TAG, "handleRemoteIce: ${e.message}")
        }
    }

    private fun drainCandidates(conn: PeerConn) {
        val queued = conn.pendingCandidates.toList()
        conn.pendingCandidates.clear()
        queued.forEach { c ->
            try {
                conn.pc.addIceCandidate(IceCandidate(
                    c.optString("sdpMid", ""),
                    c.optInt("sdpMLineIndex", 0),
                    c.optString("candidate", "")
                ))
            } catch (_: Exception) {}
        }
    }

    /**
     * Add our local audio (and optionally video) tracks to a PeerConnection.
     * Guards against double-adding the same track.
     */
    private fun addLocalTracksToPc(pc: PeerConnection) {
        val existingIds = pc.senders.mapNotNull { it.track()?.id() }.toSet()
        localAudioTrack?.let {
            if (it.id() !in existingIds) pc.addTrack(it)
        }
        if (isVideo) {
            localVideoTrack?.let {
                if (it.id() !in existingIds) pc.addTrack(it)
            }
        }
    }

    private fun getOrCreatePeerConn(peerId: String, peerUsername: String): PeerConn {
        peers[peerId]?.let { return it }

        // factory must be initialized before reaching here
        val f = factory ?: run {
            Log.e(TAG, "getOrCreatePeerConn: factory not ready yet for $peerId")
            // Create a stub so callers don't crash; will be replaced when initWebRTC completes
            val stub = PeerConn(
                pc = object : PeerConnection(null) { override fun dispose() {} },
                videoView = null
            )
            peers[peerId] = stub
            return stub
        }

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

        // Create the SurfaceViewRenderer synchronously on the current (main) thread.
        // Do NOT defer this to mainHandler.post — by the time onTrack fires, the view
        // must already be fully initialized so we can addSink() without crashing.
        var videoView: SurfaceViewRenderer? = null
        if (isVideo) {
            val egl = eglBase
            if (egl != null) {
                try {
                    videoView = SurfaceViewRenderer(requireContext()).apply {
                        init(egl.eglBaseContext, null)
                        setEnableHardwareScaler(true)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "SurfaceViewRenderer init failed for $peerId: ${e.message}")
                    videoView = null
                }
            }
        }

        // Capture for use in lambdas
        val capturedVideoView = videoView
        val capturedUsername  = peerUsername

        // Create the PeerConnection
        val pc = f.createPeerConnection(rtcConfig, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate) {
                wsManager.sendRoomSignal("call_room_ice", JSONObject().apply {
                    put("roomId",     roomId)
                    put("toPeerId",   peerId)
                    put("fromPeerId", wsManager.getDeviceId())
                    put("data", JSONObject().apply {
                        put("sdpMid",        candidate.sdpMid)
                        put("sdpMLineIndex", candidate.sdpMLineIndex)
                        put("candidate",     candidate.sdp)
                    })
                })
            }
            override fun onTrack(transceiver: RtpTransceiver) {
                val track = transceiver.receiver.track() ?: return
                if (track is VideoTrack) {
                    mainHandler.post {
                        // Save remote video track reference for bubble preview
                        peers[peerId]?.let { conn ->
                            peers[peerId] = conn.copy(remoteVideoTrack = track)
                        }
                        if (capturedVideoView != null) {
                            track.addSink(capturedVideoView)
                        }
                    }
                }
            }
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState?) {
                Log.d(TAG, "Peer $capturedUsername connection: $newState")
                if (newState == PeerConnection.PeerConnectionState.FAILED) {
                    mainHandler.post { removePeer(peerId) }
                }
            }
            override fun onSignalingChange(p0: PeerConnection.SignalingState?) {}
            override fun onIceConnectionChange(p0: PeerConnection.IceConnectionState?) {}
            override fun onIceConnectionReceivingChange(p0: Boolean) {}
            override fun onIceGatheringChange(p0: PeerConnection.IceGatheringState?) {}
            override fun onIceCandidatesRemoved(p0: Array<out IceCandidate>?) {}
            override fun onAddStream(p0: MediaStream?) {}
            override fun onRemoveStream(p0: MediaStream?) {}
            override fun onDataChannel(p0: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(p0: RtpReceiver?, p1: Array<out MediaStream>?) {}
        })

        if (pc == null) {
            Log.e(TAG, "createPeerConnection returned null for $peerId")
            capturedVideoView?.release()
            val dummy = PeerConn(
                pc = object : PeerConnection(null) { override fun dispose() {} },
                videoView = null
            )
            peers[peerId] = dummy
            return dummy
        }

        val conn = PeerConn(pc = pc, videoView = capturedVideoView, peerUsername = capturedUsername)
        peers[peerId] = conn

        // Add the tile to the grid UI — deferred to main thread is fine here
        // because by the time onTrack fires the view is already init()'d above
        if (capturedVideoView != null) {
            val tileFrame = android.widget.FrameLayout(requireContext()).apply {
                setBackgroundColor(android.graphics.Color.parseColor("#1A1A2E"))
            }
            tileFrame.addView(capturedVideoView, android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT
            ))
            val label = android.widget.TextView(requireContext()).apply {
                text = capturedUsername
                setTextColor(android.graphics.Color.WHITE)
                textSize = 11f
                setPadding(8, 4, 8, 6)
                setBackgroundColor(android.graphics.Color.parseColor("#AA000000"))
                gravity = android.view.Gravity.CENTER_HORIZONTAL
            }
            tileFrame.addView(label, android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.MATCH_PARENT,
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                android.view.Gravity.BOTTOM
            ))
            videoGrid?.addView(tileFrame)
            rebuildVideoGrid()
        }

        return conn
    }

    private fun removePeer(peerId: String) {
        val conn = peers.remove(peerId) ?: return
        try {
            // Remove video sink before releasing the view
            conn.videoView?.let { view ->
                conn.pc.receivers
                    .mapNotNull { it.track() as? VideoTrack }
                    .forEach { it.removeSink(view) }
            }
            conn.videoView?.release()
            conn.pc.close()
            // Find and remove the parent FrameLayout tile that contains this videoView
            mainHandler.post {
                val grid = videoGrid ?: return@post
                // Walk rows to find and remove the tile containing this videoView
                val toRemove = mutableListOf<android.view.View>()
                for (i in 0 until grid.childCount) {
                    val row = grid.getChildAt(i) as? android.widget.LinearLayout ?: continue
                    for (j in 0 until row.childCount) {
                        val tile = row.getChildAt(j) as? android.widget.FrameLayout ?: continue
                        if (tile.getChildAt(0) === conn.videoView) toRemove.add(tile)
                    }
                }
                toRemove.forEach { tile ->
                    (tile.parent as? android.widget.LinearLayout)?.removeView(tile)
                }
                rebuildVideoGrid()
            }
        } catch (_: Exception) {}
    }

    // ── Cleanup ───────────────────────────────────────────────────────────

    private fun cleanupAll() {
        stopRingtone()
        mainHandler.removeCallbacks(durationTick)
        isActive = false
        for ((_, conn) in peers) {
            try {
                conn.videoView?.let { v ->
                    localVideoTrack?.removeSink(v)
                }
                conn.videoView?.release()
                conn.pc.close()
            } catch (_: Exception) {}
        }
        peers.clear()
        try { videoCapturer?.stopCapture() } catch (_: Exception) {}
        try { videoCapturer?.dispose() } catch (_: Exception) {}
        // Release local PiP view
        try {
            localPip?.let { pip ->
                localVideoTrack?.removeSink(pip)
                pip.release()
            }
        } catch (_: Exception) {}
        localVideoTrack?.dispose()
        localAudioTrack?.dispose()
        localVideoSource?.dispose()
        localAudioSource?.dispose()
        factory?.dispose()
        eglBase?.release()
        factory          = null
        eglBase          = null
        localAudioSource = null
        localAudioTrack  = null
        localVideoSource = null
        localVideoTrack  = null
        videoCapturer    = null
    }

    // ── UI helpers ────────────────────────────────────────────────────────

    private fun updateParticipantCount(remoteCount: Int) {
        val total = remoteCount + 1
        tvParticipants?.text = "$total participant${if (total != 1) "s" else ""}"
    }

    /**
     * Rebuild the video grid layout using all available space.
     * Collects all FrameLayout tile views (from direct children or nested rows),
     * clears the grid, then rebuilds it as a vertical LinearLayout of horizontal rows.
     *
     *  1 tile  → 1×1 full screen
     *  2 tiles → 2 rows (portrait) or 2 columns (landscape handled by orientation change)
     *  3 tiles → 1 on top (full width), 2 on bottom
     *  4 tiles → 2×2
     *  5–6     → 2 rows of 3
     *  7–9     → 3 rows of 3
     */
    private fun rebuildVideoGrid() {
        val grid = videoGrid ?: return

        // Step 1: Collect ALL FrameLayout tiles from the current grid hierarchy.
        // Tiles may be:
        //   - Direct children of grid (first call, before any rebuild)
        //   - Inside horizontal LinearLayout rows (after first rebuild)
        val tiles = mutableListOf<android.widget.FrameLayout>()
        for (i in 0 until grid.childCount) {
            val child = grid.getChildAt(i)
            when (child) {
                is android.widget.FrameLayout -> tiles.add(child)
                is android.widget.LinearLayout -> {
                    for (j in 0 until child.childCount) {
                        val inner = child.getChildAt(j)
                        if (inner is android.widget.FrameLayout) tiles.add(inner)
                    }
                }
            }
        }

        // Step 2: Detach every tile from its current parent BEFORE clearing the grid.
        // This is CRITICAL: grid.removeAllViews() removes the row LinearLayouts but
        // leaves the tiles as children of those (now-detached) rows. Calling addView()
        // on a tile that still has a parent throws IllegalStateException.
        tiles.forEach { tile ->
            (tile.parent as? android.view.ViewGroup)?.removeView(tile)
        }

        // Step 3: Clear the grid (now safe — tiles are already detached)
        grid.removeAllViews()

        val n = tiles.size
        if (n == 0) return

        // Step 4: Determine layout dimensions
        val (cols, rows) = when {
            n == 1 -> 1 to 1
            n == 2 -> 1 to 2   // portrait: 2 rows
            n == 3 -> 2 to 2   // top row 1 tile (full-width), bottom row 2
            n == 4 -> 2 to 2
            n <= 6 -> 3 to 2
            else   -> 3 to 3
        }

        // Step 5: Rebuild rows and add tiles
        var idx = 0
        for (row in 0 until rows) {
            if (idx >= n) break
            val remaining = n - idx
            val colsThisRow = if (n == 3 && row == 0) 1 else minOf(cols, remaining)

            val rowLayout = android.widget.LinearLayout(requireContext()).apply {
                orientation = android.widget.LinearLayout.HORIZONTAL
                layoutParams = android.widget.LinearLayout.LayoutParams(
                    android.widget.LinearLayout.LayoutParams.MATCH_PARENT, 0
                ).apply { weight = 1f }
            }
            for (col in 0 until colsThisRow) {
                if (idx >= n) break
                val tile = tiles[idx++]
                // Tile is already detached from any parent — safe to add
                tile.layoutParams = android.widget.LinearLayout.LayoutParams(0,
                    android.widget.LinearLayout.LayoutParams.MATCH_PARENT
                ).apply { weight = 1f; setMargins(2, 2, 2, 2) }
                rowLayout.addView(tile)
            }
            grid.addView(rowLayout)
        }
    }

    private fun fmt(secs: Int) =
        "%02d:%02d".format(secs / 60, secs % 60)

    // ── SdpObserver helper ────────────────────────────────────────────────

    private fun simpleSdpObserver(onSuccess: () -> Unit) = object : SdpObserver {
        override fun onCreateSuccess(p0: SessionDescription?) {}
        override fun onSetSuccess()                           { onSuccess() }
        override fun onCreateFailure(p0: String?)             {}
        override fun onSetFailure(p0: String?)                { Log.e(TAG, "SDP setFailure: $p0") }
    }
}
