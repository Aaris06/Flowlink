package com.flowlink.app.service

import android.util.Log
import org.webrtc.*

/**
 * CallSession — singleton that survives CallFragment destruction.
 *
 * When the user minimizes a call, CallFragment is popped off the back stack
 * (so the app is usable underneath), but this object keeps the WebRTC
 * PeerConnection and all state alive. When the user taps the bubble to
 * restore, a new CallFragment is created and re-attaches to this session.
 */
object CallSession {

    private const val TAG = "CallSession"

    // ── Active call metadata ───────────────────────────────────────────────
    var callId         : String  = ""
    var remoteUsername : String  = ""
    var remoteDevice   : String  = ""
    var isVideo        : Boolean = false
    var direction      : String  = "inbound"   // "inbound" | "outbound"

    enum class State { IDLE, RINGING_IN, RINGING_OUT, CONNECTING, ACTIVE, ENDED }
    var state: State = State.IDLE
        private set

    // ── WebRTC objects ─────────────────────────────────────────────────────
    var eglBase               : EglBase?               = null
    var peerConnectionFactory : PeerConnectionFactory? = null
    var peerConnection        : PeerConnection?        = null
    var localAudioTrack       : AudioTrack?            = null
    var localVideoTrack       : VideoTrack?            = null
    var remoteVideoTrack      : VideoTrack?            = null
    var videoCapturer         : CameraVideoCapturer?   = null
    var surfaceTextureHelper  : SurfaceTextureHelper?  = null

    // Signaling race buffers
    var pendingOffer      : String? = null
    val pendingCandidates : MutableList<String> = mutableListOf()
    var remoteDescSet     : Boolean = false

    // Camera state
    var usingFrontCamera : Boolean = true
    var cameraEnabled    : Boolean = true
    var isMuted          : Boolean = false
    var isSpeakerOn      : Boolean = false
    var isSwapped        : Boolean = false

    // Duration
    var durationSec : Int = 0

    // ── State helpers ──────────────────────────────────────────────────────
    val isActive get() = state != State.IDLE && state != State.ENDED

    fun setState(s: State) { state = s }

    fun startNew(
        callId: String,
        remoteUsername: String,
        remoteDevice: String,
        isVideo: Boolean,
        direction: String
    ) {
        this.callId         = callId
        this.remoteUsername = remoteUsername
        this.remoteDevice   = remoteDevice
        this.isVideo        = isVideo
        this.direction      = direction
        this.state          = if (direction == "inbound") State.RINGING_IN else State.RINGING_OUT
        this.durationSec    = 0
        this.isSwapped      = false
        this.isMuted        = false
        this.isSpeakerOn    = false
        this.cameraEnabled  = true
        this.pendingOffer   = null
        this.pendingCandidates.clear()
        this.remoteDescSet  = false
        Log.d(TAG, "CallSession started: $callId → $remoteUsername (video=$isVideo, dir=$direction)")
    }

    fun cleanup() {
        runCatching { videoCapturer?.stopCapture() }
        runCatching { videoCapturer?.dispose() }
        runCatching { surfaceTextureHelper?.dispose() }
        runCatching { localAudioTrack?.dispose() }
        runCatching { localVideoTrack?.dispose() }
        runCatching { remoteVideoTrack?.dispose() }
        runCatching { peerConnection?.close() }
        runCatching { peerConnectionFactory?.dispose() }
        runCatching { eglBase?.release() }

        eglBase               = null
        peerConnectionFactory = null
        peerConnection        = null
        localAudioTrack       = null
        localVideoTrack       = null
        remoteVideoTrack      = null
        videoCapturer         = null
        surfaceTextureHelper  = null
        pendingOffer          = null
        pendingCandidates.clear()
        remoteDescSet         = false
        durationSec           = 0
        state                 = State.IDLE
        Log.d(TAG, "CallSession cleaned up")
    }
}
