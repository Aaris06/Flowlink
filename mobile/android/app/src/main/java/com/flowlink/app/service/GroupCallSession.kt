package com.flowlink.app.service

import org.webrtc.*

/**
 * Singleton that holds all live WebRTC state for a group call.
 * This allows GroupCallFragment to be popped off the back stack (so
 * the app is fully navigable) and later re-added to restore the full UI,
 * without tearing down the actual peer connections or media tracks.
 */
object GroupCallSession {

    enum class State { IDLE, RINGING_IN, RINGING_OUT, ACTIVE }

    // ── Call metadata ──────────────────────────────────────────────────────
    var roomId    = ""
    var isVideo   = false
    var initiator = ""
    var direction = "inbound"   // "inbound" | "outbound" | "join_now"

    // ── State ──────────────────────────────────────────────────────────────
    @Volatile var state = State.IDLE
    var durationSec = 0
    var isActive    = false

    // ── WebRTC shared resources ────────────────────────────────────────────
    var factory          : PeerConnectionFactory? = null
    var eglBase          : EglBase?               = null
    var localAudioSource : AudioSource?           = null
    var localAudioTrack  : AudioTrack?            = null
    var localVideoSource : VideoSource?           = null
    var localVideoTrack  : VideoTrack?            = null
    var videoCapturer    : CameraVideoCapturer?   = null

    // ── Per-peer state ─────────────────────────────────────────────────────
    data class PeerEntry(
        val pc: PeerConnection,
        val videoView: SurfaceViewRenderer?,
        var remoteDescSet: Boolean = false,
        val pendingCandidates: MutableList<org.json.JSONObject> = mutableListOf(),
        val username: String = ""
    )
    val peers = mutableMapOf<String, PeerEntry>()

    // ── Helpers ────────────────────────────────────────────────────────────
    val isRunning: Boolean get() = state != State.IDLE

    /** First remote peer's video view — used by the minimized bubble preview */
    val firstRemoteVideoView: SurfaceViewRenderer?
        get() = peers.values.firstOrNull { it.videoView != null }?.videoView

    /** Ordered list of remote usernames */
    val peerUsernames: List<String>
        get() = peers.values.map { it.username }

    fun reset() {
        roomId    = ""
        isVideo   = false
        initiator = ""
        direction = "inbound"
        state     = State.IDLE
        durationSec = 0
        isActive  = false
        factory          = null
        eglBase          = null
        localAudioSource = null
        localAudioTrack  = null
        localVideoSource = null
        localVideoTrack  = null
        videoCapturer    = null
        peers.clear()
    }
}
