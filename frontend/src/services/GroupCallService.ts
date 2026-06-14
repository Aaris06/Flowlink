/**
 * GroupCallService — Room-based multi-participant WebRTC call management
 *
 * Architecture (full-mesh):
 *   - One RTCPeerConnection per remote participant
 *   - The caller creates the room and sends invites to all participants
 *   - Each invited participant receives call_room_invite → shows ringing UI
 *   - Accepting → send call_room_join → server returns list of existing peers
 *   - New joiner initiates offers to every existing peer (they are the "caller" side)
 *   - When a peer joins later, existing participants are notified via call_room_peer_joined
 *     and the new joiner initiates offers to them too
 *
 * Participant state per peer:
 *   peerId, peerUsername, pc (RTCPeerConnection), remoteStream, localStream ref
 */

export interface GroupCallParticipant {
  peerId: string;
  peerUsername: string;
  stream: MediaStream | null;
}

export type GroupCallState =
  | 'idle'
  | 'ringing_in'   // received invite, not yet accepted
  | 'ringing_out'  // sent invites, waiting for first join
  | 'active'       // in the call room
  | 'ended';

export interface GroupCallInfo {
  roomId: string;
  callType: 'audio' | 'video';
  initiatorUsername: string;
  sessionId: string | null;
}

export type GroupCallStateHandler = (
  state: GroupCallState,
  info: GroupCallInfo | null,
  participants: GroupCallParticipant[]
) => void;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

interface PeerState {
  peerId: string;
  peerUsername: string;
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescSet: boolean;
}

export class GroupCallService {
  private ws: WebSocket | null = null;
  private deviceId: string;
  private username: string;
  private state: GroupCallState = 'idle';
  private currentRoom: GroupCallInfo | null = null;
  private onStateChange: GroupCallStateHandler;

  private localStream: MediaStream | null = null;
  private peers = new Map<string, PeerState>(); // keyed by peerId

  constructor(
    deviceId: string,
    username: string,
    onStateChange: GroupCallStateHandler
  ) {
    this.deviceId = deviceId;
    this.username = username;
    this.onStateChange = onStateChange;
  }

  setWebSocket(ws: WebSocket) { this.ws = ws; }
  getState() { return this.state; }
  getCurrentRoom() { return this.currentRoom; }
  getLocalStream() { return this.localStream; }
  getParticipants(): GroupCallParticipant[] {
    return Array.from(this.peers.values()).map(p => ({
      peerId: p.peerId,
      peerUsername: p.peerUsername,
      stream: p.remoteStream.getTracks().length > 0 ? p.remoteStream : null,
    }));
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Start a group call: create a room and invite participants.
   */
  async startGroupCall(
    invitees: { deviceId: string; username: string }[],
    callType: 'audio' | 'video',
    sessionId: string | null
  ): Promise<void> {
    if (this.state !== 'idle') throw new Error('Already in a call');

    const roomId = `room_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.currentRoom = {
      roomId,
      callType,
      initiatorUsername: this.username,
      sessionId,
    };
    this.setState('ringing_out');

    // Acquire local media
    try {
      this.localStream = await this.getUserMedia(callType === 'video');
    } catch (err) {
      console.error('[GroupCallService] getUserMedia failed:', err);
      this.cleanup('media_error');
      return;
    }

    this.send({
      type: 'call_room_create',
      payload: {
        roomId,
        callType,
        invitees,
        sessionId,
        fromUsername: this.username,
      },
    });
  }

  /**
   * Accept an incoming group call invite.
   */
  async acceptGroupCall(): Promise<void> {
    if (!this.currentRoom || this.state !== 'ringing_in') return;

    this.setState('active');

    try {
      this.localStream = await this.getUserMedia(this.currentRoom.callType === 'video');
    } catch (err) {
      console.error('[GroupCallService] getUserMedia failed:', err);
      this.cleanup('media_error');
      return;
    }

    this.send({
      type: 'call_room_join',
      payload: {
        roomId: this.currentRoom.roomId,
        fromUsername: this.username,
      },
    });
  }

  /**
   * Join an ongoing call from a chat "Join Now" button.
   */
  async joinRoom(roomId: string, callType: 'audio' | 'video', sessionId: string | null, initiatorUsername: string): Promise<void> {
    if (this.state !== 'idle') return;

    this.currentRoom = { roomId, callType, initiatorUsername, sessionId };
    this.setState('active');

    try {
      this.localStream = await this.getUserMedia(callType === 'video');
    } catch (err) {
      console.error('[GroupCallService] getUserMedia failed:', err);
      this.cleanup('media_error');
      return;
    }

    this.send({
      type: 'call_room_join',
      payload: { roomId, fromUsername: this.username },
    });
  }

  /**
   * Reject an incoming invite without affecting others in the room.
   */
  rejectGroupCall(): void {
    if (this.state !== 'ringing_in') return;
    // Simply do nothing — the room continues without us.
    // Optionally send a call_reject signal back to the initiator only for UX.
    this.cleanup('rejected');
  }

  /**
   * Leave the call room. Others remain connected.
   */
  leaveCall(): void {
    if (!this.currentRoom) return;
    this.send({
      type: 'call_room_leave',
      payload: { roomId: this.currentRoom.roomId, fromUsername: this.username },
    });
    this.cleanup('left');
  }

  toggleMute(): boolean {
    const audio = this.localStream?.getAudioTracks()[0];
    if (!audio) return false;
    audio.enabled = !audio.enabled;
    return !audio.enabled; // returns true if NOW muted
  }

  toggleCamera(): boolean {
    const video = this.localStream?.getVideoTracks()[0];
    if (!video) return false;
    video.enabled = !video.enabled;
    return !video.enabled;
  }

  // ── Incoming message handler ──────────────────────────────────────────

  async handleMessage(message: any): Promise<void> {
    const { type, payload } = message;

    switch (type) {

      // ── Received invite from another device ────────────────────────────
      case 'call_room_invite': {
        if (this.state !== 'idle') {
          // Already in a call — silently ignore (room stays open)
          return;
        }
        this.currentRoom = {
          roomId: payload.roomId,
          callType: payload.callType,
          initiatorUsername: payload.fromUsername || 'Unknown',
          sessionId: payload.sessionId ?? null,
        };
        this.setState('ringing_in');
        break;
      }

      // ── Creator confirmed room created ─────────────────────────────────
      case 'call_room_created': {
        if (this.state === 'ringing_out') {
          this.setState('active');
        }
        break;
      }

      // ── We just joined, server sends existing participant list ──────────
      case 'call_room_joined': {
        const existingPeers: { deviceId: string; username: string }[] = payload.participants || [];
        // Initiate offer to every existing participant
        for (const peer of existingPeers) {
          await this.initiatePeerConnection(peer.deviceId, peer.username);
        }
        this.notifyStateChange();
        break;
      }

      // ── A new peer joined the room (server notifies existing members) ──
      case 'call_room_peer_joined': {
        const { peerId, peerUsername } = payload;
        if (peerId === this.deviceId) break;
        if (!this.peers.has(peerId) && this.state === 'active') {
          // We're an existing participant — the new joiner will send us an offer.
          // Pre-create the peer state so we're ready to receive it.
          this.getOrCreatePeer(peerId, peerUsername);
          this.notifyStateChange();
        }
        break;
      }

      // ── A peer left ────────────────────────────────────────────────────
      case 'call_room_peer_left': {
        const { peerId } = payload;
        this.removePeer(peerId);
        this.notifyStateChange();
        break;
      }

      // ── Room not found (expired or never existed) ──────────────────────
      case 'call_room_error': {
        if (payload.reason === 'room_not_found') {
          this.cleanup('room_not_found');
        }
        break;
      }

      // ── WebRTC signaling between peers ─────────────────────────────────
      case 'call_room_offer': {
        const { fromPeerId, toPeerId, data, peerUsername } = payload;
        if (toPeerId !== this.deviceId) break;
        let peerState = this.peers.get(fromPeerId);
        if (!peerState) {
          peerState = this.getOrCreatePeer(fromPeerId, peerUsername || fromPeerId);
        }
        await this.handleRemoteOffer(peerState, data);
        this.notifyStateChange();
        break;
      }

      case 'call_room_answer': {
        const { fromPeerId, toPeerId, data } = payload;
        if (toPeerId !== this.deviceId) break;
        const peerState = this.peers.get(fromPeerId);
        if (!peerState) break;
        if (peerState.pc.signalingState === 'have-local-offer') {
          await peerState.pc.setRemoteDescription(data);
          peerState.remoteDescSet = true;
          this.drainCandidates(peerState);
        }
        break;
      }

      case 'call_room_ice': {
        const { fromPeerId, toPeerId, data } = payload;
        if (toPeerId !== this.deviceId) break;
        const peerState = this.peers.get(fromPeerId);
        if (!peerState) break;
        if (peerState.remoteDescSet) {
          try { await peerState.pc.addIceCandidate(data); } catch { /* ignore */ }
        } else {
          peerState.pendingCandidates.push(data);
        }
        break;
      }
    }
  }

  // ── WebRTC helpers ────────────────────────────────────────────────────

  /**
   * Initiate a peer connection TO an existing participant.
   * The joining peer is always the "caller" (creates offer).
   */
  private async initiatePeerConnection(peerId: string, peerUsername: string): Promise<void> {
    if (!this.localStream || !this.currentRoom) return;
    if (this.peers.has(peerId)) return; // already connected

    const peerState = this.getOrCreatePeer(peerId, peerUsername);
    const pc = peerState.pc;

    // Add our local tracks to the connection
    this.localStream.getTracks().forEach(track => {
      if (track.kind === 'video' && this.currentRoom?.callType !== 'video') return;
      pc.addTrack(track, this.localStream!);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.send({
      type: 'call_room_offer',
      payload: {
        roomId: this.currentRoom.roomId,
        toPeerId: peerId,
        fromPeerId: this.deviceId,
        peerUsername: this.username,
        data: offer,
      },
    });
  }

  /**
   * Handle incoming offer from a peer that joined after us.
   */
  private async handleRemoteOffer(peerState: PeerState, offerDesc: RTCSessionDescriptionInit): Promise<void> {
    if (!this.localStream || !this.currentRoom) return;
    const pc = peerState.pc;

    await pc.setRemoteDescription(offerDesc);
    peerState.remoteDescSet = true;
    this.drainCandidates(peerState);

    // Add our local tracks AFTER setRemoteDescription
    this.localStream.getTracks().forEach(track => {
      if (track.kind === 'video' && this.currentRoom?.callType !== 'video') return;
      const alreadyAdded = pc.getSenders().some(s => s.track?.id === track.id);
      if (!alreadyAdded) pc.addTrack(track, this.localStream!);
    });

    // Force sendrecv on all transceivers
    pc.getTransceivers().forEach(tr => {
      if (tr.direction === 'recvonly' || tr.direction === 'inactive') {
        tr.direction = 'sendrecv';
      }
    });

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.send({
      type: 'call_room_answer',
      payload: {
        roomId: this.currentRoom!.roomId,
        toPeerId: peerState.peerId,
        fromPeerId: this.deviceId,
        data: answer,
      },
    });
  }

  private getOrCreatePeer(peerId: string, peerUsername: string): PeerState {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const remoteStream = new MediaStream();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const peerState: PeerState = {
      peerId,
      peerUsername,
      pc,
      remoteStream,
      pendingCandidates: [],
      remoteDescSet: false,
    };
    this.peers.set(peerId, peerState);

    pc.ontrack = (e) => {
      const track = e.track;
      if (!remoteStream.getTracks().find(t => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
      e.streams[0]?.getTracks().forEach(t => {
        if (!remoteStream.getTracks().find(x => x.id === t.id)) {
          remoteStream.addTrack(t);
        }
      });
      console.log(`[GroupCallService] ontrack from ${peerUsername}: ${track.kind}`);
      this.notifyStateChange();
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && this.currentRoom) {
        this.send({
          type: 'call_room_ice',
          payload: {
            roomId: this.currentRoom.roomId,
            toPeerId: peerId,
            fromPeerId: this.deviceId,
            data: e.candidate.toJSON(),
          },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[GroupCallService] peer ${peerUsername} connection: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        this.removePeer(peerId);
        this.notifyStateChange();
      }
    };

    pc.onnegotiationneeded = async () => {
      // Only re-negotiate if we already set a local description (i.e., we're the offerer)
      if (pc.signalingState !== 'stable') return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (this.currentRoom) {
          this.send({
            type: 'call_room_offer',
            payload: {
              roomId: this.currentRoom.roomId,
              toPeerId: peerId,
              fromPeerId: this.deviceId,
              peerUsername: this.username,
              data: offer,
            },
          });
        }
      } catch { /* ignore */ }
    };

    return peerState;
  }

  private removePeer(peerId: string) {
    const peerState = this.peers.get(peerId);
    if (!peerState) return;
    peerState.pc.close();
    this.peers.delete(peerId);
  }

  private drainCandidates(peerState: PeerState) {
    const queued = peerState.pendingCandidates.splice(0);
    queued.forEach(c => {
      try { peerState.pc.addIceCandidate(c); } catch { /* ignore */ }
    });
  }

  // ── Internal state helpers ────────────────────────────────────────────

  private setState(state: GroupCallState) {
    this.state = state;
    this.notifyStateChange();
  }

  private notifyStateChange() {
    this.onStateChange(this.state, this.currentRoom, this.getParticipants());
  }

  private send(msg: object) {
    const ws = this.ws || (window as any).appWebSocket;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...msg, deviceId: this.deviceId, timestamp: Date.now() }));
    }
  }

  private async getUserMedia(video: boolean): Promise<MediaStream> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
          : false,
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    }
    stream.getAudioTracks().forEach(t => { t.enabled = true; });
    return stream;
  }

  private cleanup(reason?: string) {
    // Close all peer connections
    for (const [, peerState] of this.peers) {
      try { peerState.pc.close(); } catch { /* ignore */ }
    }
    this.peers.clear();

    // Stop local media
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;

    this.currentRoom = null;
    this.setState('ended');
    const delay = reason === 'rejected' ? 1000 : 1500;
    setTimeout(() => {
      if (this.state === 'ended') this.setState('idle');
    }, delay);
    console.log('[GroupCallService] cleanup. reason:', reason);
  }
}
