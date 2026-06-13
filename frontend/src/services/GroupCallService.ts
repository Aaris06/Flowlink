/**
 * GroupCallService — Room-based group audio/video calling
 *
 * Architecture: Full mesh WebRTC.
 * Every participant creates a direct peer connection to every other participant.
 *
 * Call Room lifecycle:
 *   creator:  group_call_create  → receives room_state
 *   invitees: receive group_call_invite  → accept → group_call_join → negotiate with each existing peer
 *   late join: group_call_join (via "Join Now") → same negotiation path
 *
 * Per-pair signaling flow (caller side = the peer who already is in the room):
 *   existing peer sends call_offer → new joiner receives → sends call_answer → ICE exchange
 */

export type GroupCallState = 'idle' | 'ringing_in' | 'joining' | 'active' | 'ended';

export interface GroupCallParticipant {
  deviceId: string;
  username: string;
  stream: MediaStream | null;
  muted: boolean;
  cameraOff: boolean;
  isSelf: boolean;
}

export interface GroupCallRoom {
  roomId: string;
  callType: 'audio' | 'video';
  hostUsername: string;
  sessionId: string;
  participants: GroupCallParticipant[];
}

export type GroupCallEventHandler = (
  state: GroupCallState,
  room: GroupCallRoom | null
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

interface PeerEntry {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  makingOffer: boolean;
  ignoreOffer: boolean;
  remoteDescSet: boolean;
  pendingCandidates: RTCIceCandidateInit[];
}

export class GroupCallService {
  private ws: WebSocket | null = null;
  private deviceId: string;
  private username: string;

  private state: GroupCallState = 'idle';
  private room: GroupCallRoom | null = null;
  private localStream: MediaStream | null = null;

  // deviceId -> PeerEntry
  private peers = new Map<string, PeerEntry>();

  private onStateChange: GroupCallEventHandler;
  private onParticipantsChange: ((participants: GroupCallParticipant[]) => void) | null = null;

  // Pending invite info (for when user accepts)
  private pendingInvite: { roomId: string; sessionId: string; hostUsername: string; callType: 'audio' | 'video' } | null = null;

  constructor(deviceId: string, username: string, onStateChange: GroupCallEventHandler) {
    this.deviceId = deviceId;
    this.username = username;
    this.onStateChange = onStateChange;
  }

  setWebSocket(ws: WebSocket) { this.ws = ws; }
  setOnParticipantsChange(cb: (p: GroupCallParticipant[]) => void) { this.onParticipantsChange = cb; }
  getState() { return this.state; }
  getRoom() { return this.room; }
  getLocalStream() { return this.localStream; }

  /** Update deviceId / username after initial construction (set before WS connects) */
  updateIdentity(deviceId: string, username: string) {
    this.deviceId = deviceId;
    this.username = username;
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Host starts a new group call and invites a list of targets.
   */
  async startGroupCall(
    invitees: { username: string; deviceId: string }[],
    callType: 'audio' | 'video',
    sessionId: string
  ): Promise<void> {
    if (this.state !== 'idle') throw new Error('Already in a call');

    const roomId = `gcall_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.room = {
      roomId,
      callType,
      hostUsername: this.username,
      sessionId,
      participants: [
        { deviceId: this.deviceId, username: this.username, stream: null, muted: false, cameraOff: false, isSelf: true },
      ],
    };
    this.setState('joining');

    // Acquire local media
    try {
      this.localStream = await this.getUserMedia(callType === 'video');
      this.updateSelfStream(this.localStream);
    } catch (err) {
      console.error('[GroupCallService] getUserMedia failed:', err);
      this.cleanup();
      return;
    }

    // Create room on server
    this.send({
      type: 'group_call_create',
      payload: {
        roomId,
        callType,
        sessionId,
        invitees: invitees.map(i => ({ username: i.username, deviceId: i.deviceId })),
        hostUsername: this.username,
      },
    });

    this.setState('active');
    // Post a "Join Now" chat message for this session
    this.sendJoinNowChatMessage(roomId, callType, sessionId);
  }

  /**
   * Accept an incoming group call invitation.
   */
  async acceptGroupCall(): Promise<void> {
    if (!this.pendingInvite || this.state !== 'ringing_in') return;
    const { roomId, sessionId, callType } = this.pendingInvite;

    this.setState('joining');

    try {
      this.localStream = await this.getUserMedia(callType === 'video');
      this.updateSelfStream(this.localStream);
    } catch (err) {
      console.error('[GroupCallService] getUserMedia failed:', err);
      this.cleanup();
      return;
    }

    // Tell server we're joining the room
    this.send({
      type: 'group_call_join',
      payload: { roomId, sessionId, username: this.username },
    });
    // State will flip to 'active' when we receive the room_state back
  }

  /**
   * Reject an incoming group call invitation.
   */
  rejectGroupCall(): void {
    if (!this.pendingInvite) return;
    const { roomId, sessionId } = this.pendingInvite;
    this.send({
      type: 'group_call_reject',
      payload: { roomId, sessionId, username: this.username },
    });
    this.pendingInvite = null;
    this.cleanup();
  }

  /**
   * Join an ongoing call via "Join Now" link in chat.
   */
  async joinByRoomId(roomId: string, callType: 'audio' | 'video', sessionId: string, hostUsername: string): Promise<void> {
    if (this.state !== 'idle') return; // already in a call
    this.pendingInvite = { roomId, sessionId, hostUsername, callType };
    this.room = {
      roomId,
      callType,
      hostUsername,
      sessionId,
      participants: [
        { deviceId: this.deviceId, username: this.username, stream: null, muted: false, cameraOff: false, isSelf: true },
      ],
    };
    this.setState('ringing_in'); // show UI so user taps Accept
    // Auto-accept since they explicitly clicked "Join Now"
    await this.acceptGroupCall();
  }

  /**
   * Leave the group call.
   */
  leaveCall(): void {
    if (!this.room) return;
    this.send({
      type: 'group_call_leave',
      payload: { roomId: this.room.roomId, sessionId: this.room.sessionId },
    });
    this.cleanup();
  }

  toggleMute(): boolean {
    const audio = this.localStream?.getAudioTracks()[0];
    if (!audio) return false;
    audio.enabled = !audio.enabled;
    const muted = !audio.enabled;
    this.updateSelfMeta({ muted });
    return muted;
  }

  toggleCamera(): boolean {
    const video = this.localStream?.getVideoTracks()[0];
    if (!video) return false;
    video.enabled = !video.enabled;
    const cameraOff = !video.enabled;
    this.updateSelfMeta({ cameraOff });
    return cameraOff;
  }

  async switchCamera(): Promise<void> {
    if (!this.localStream || this.room?.callType !== 'video') return;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) return;
    const settings = videoTrack.getSettings();
    const nextFacing = (settings.facingMode ?? 'user') === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { exact: nextFacing } },
      });
      const newVideoTrack = newStream.getVideoTracks()[0];
      for (const entry of this.peers.values()) {
        const sender = entry.pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newVideoTrack);
      }
      videoTrack.stop();
      this.localStream.removeTrack(videoTrack);
      this.localStream.addTrack(newVideoTrack);
      this.updateSelfStream(this.localStream);
    } catch { /* facingMode exact not supported */ }
  }

  // ── Incoming message handler ──────────────────────────────────────────

  async handleMessage(message: any): Promise<void> {
    const { type, payload } = message;

    switch (type) {
      case 'group_call_invite':
        await this.onGroupCallInvite(payload);
        break;

      case 'group_call_room_state':
        await this.onRoomState(payload);
        break;

      case 'group_call_peer_joined':
        await this.onPeerJoined(payload);
        break;

      case 'group_call_peer_left':
        this.onPeerLeft(payload);
        break;

      case 'group_call_offer':
        await this.onRemoteOffer(payload);
        break;

      case 'group_call_answer':
        await this.onRemoteAnswer(payload);
        break;

      case 'group_call_ice':
        await this.onRemoteIce(payload);
        break;
    }
  }

  // ── Signaling handlers ────────────────────────────────────────────────

  private async onGroupCallInvite(payload: any): Promise<void> {
    if (this.state !== 'idle') {
      // Already in a call — auto-reject
      this.send({
        type: 'group_call_reject',
        payload: { roomId: payload.roomId, sessionId: payload.sessionId, username: this.username, reason: 'busy' },
      });
      return;
    }
    this.pendingInvite = {
      roomId: payload.roomId,
      sessionId: payload.sessionId,
      hostUsername: payload.hostUsername,
      callType: payload.callType,
    };
    this.room = {
      roomId: payload.roomId,
      callType: payload.callType,
      hostUsername: payload.hostUsername,
      sessionId: payload.sessionId,
      participants: [
        { deviceId: this.deviceId, username: this.username, stream: null, muted: false, cameraOff: false, isSelf: true },
      ],
    };
    this.setState('ringing_in');
  }

  /**
   * Server sends full room state after we join.
   * existingPeers: list of { deviceId, username } already in the room.
   * As the new joiner, we wait for each existing peer to send us an offer.
   */
  private async onRoomState(payload: any): Promise<void> {
    const { roomId, callType, hostUsername, sessionId, participants } = payload;
    if (this.room && this.room.roomId !== roomId) return;

    if (!this.room) {
      this.room = { roomId, callType, hostUsername, sessionId, participants: [] };
    }

    // Ensure self is in participants list
    const selfEntry: GroupCallParticipant = {
      deviceId: this.deviceId,
      username: this.username,
      stream: this.localStream,
      muted: false,
      cameraOff: false,
      isSelf: true,
    };
    const others: GroupCallParticipant[] = (participants as any[])
      .filter(p => p.deviceId !== this.deviceId)
      .map(p => ({
        deviceId: p.deviceId,
        username: p.username,
        stream: null,
        muted: false,
        cameraOff: false,
        isSelf: false,
      }));

    this.room.participants = [selfEntry, ...others];
    this.setState('active');
    this.notifyParticipants();

    // Each existing peer (already in room) will send us an offer.
    // We just ensure a PeerEntry exists so we're ready to handle it.
    for (const p of others) {
      if (!this.peers.has(p.deviceId)) {
        this.getOrCreatePeer(p.deviceId);
      }
    }
  }

  /**
   * Another peer has joined the room while we're already in it.
   * As the "older" peer, we initiate the offer toward the new joiner.
   */
  private async onPeerJoined(payload: any): Promise<void> {
    const { deviceId, username } = payload;
    if (deviceId === this.deviceId || !this.room) return;

    // Add to participant list if not already there
    if (!this.room.participants.find(p => p.deviceId === deviceId)) {
      this.room.participants.push({ deviceId, username, stream: null, muted: false, cameraOff: false, isSelf: false });
      this.notifyParticipants();
    }

    // Create peer and send offer
    const entry = this.getOrCreatePeer(deviceId);
    await this.sendOffer(deviceId, entry);
  }

  private onPeerLeft(payload: any): void {
    const { deviceId } = payload;
    if (!this.room) return;
    this.room.participants = this.room.participants.filter(p => p.deviceId !== deviceId);
    this.notifyParticipants();
    const entry = this.peers.get(deviceId);
    if (entry) {
      entry.pc.close();
      this.peers.delete(deviceId);
    }
    // If everyone left, end the call
    const others = this.room.participants.filter(p => !p.isSelf);
    if (others.length === 0) {
      console.log('[GroupCallService] All peers left, ending call');
      this.cleanup();
    }
  }

  private async onRemoteOffer(payload: any): Promise<void> {
    const { fromDeviceId, data: offerDesc } = payload;
    if (!this.room || !this.localStream) return;

    const entry = this.getOrCreatePeer(fromDeviceId);

    // Perfect negotiation: polite peer check
    const offerCollision = entry.makingOffer || entry.pc.signalingState !== 'stable';
    // We use deviceId lexicographic order for polite/impolite
    const isPolite = this.deviceId < fromDeviceId;
    entry.ignoreOffer = !isPolite && offerCollision;
    if (entry.ignoreOffer) {
      console.warn('[GroupCallService] Ignoring colliding offer from', fromDeviceId);
      return;
    }

    await entry.pc.setRemoteDescription(new RTCSessionDescription(offerDesc));
    entry.remoteDescSet = true;
    this.drainCandidates(fromDeviceId, entry);

    // Add local tracks after setRemoteDescription (callee pattern)
    this.addTracksToPC(entry.pc, this.localStream, this.room.callType === 'video');

    // Force sendrecv
    entry.pc.getTransceivers().forEach(tr => {
      if (tr.direction === 'recvonly' || tr.direction === 'inactive') {
        tr.direction = 'sendrecv';
      }
    });

    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);

    this.send({
      type: 'group_call_answer',
      payload: {
        roomId: this.room.roomId,
        toDeviceId: fromDeviceId,
        data: answer,
      },
    });
  }

  private async onRemoteAnswer(payload: any): Promise<void> {
    const { fromDeviceId, data: answerDesc } = payload;
    const entry = this.peers.get(fromDeviceId);
    if (!entry) return;

    if (entry.pc.signalingState === 'have-local-offer') {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(answerDesc));
      entry.remoteDescSet = true;
      this.drainCandidates(fromDeviceId, entry);
    }
  }

  private async onRemoteIce(payload: any): Promise<void> {
    const { fromDeviceId, data: candidate } = payload;
    if (!candidate) return;
    const entry = this.peers.get(fromDeviceId);
    if (!entry) return;

    if (entry.remoteDescSet) {
      try { await entry.pc.addIceCandidate(candidate); } catch { /* ignore */ }
    } else {
      entry.pendingCandidates.push(candidate);
    }
  }

  // ── Peer connection helpers ───────────────────────────────────────────

  private getOrCreatePeer(remoteDeviceId: string): PeerEntry {
    if (this.peers.has(remoteDeviceId)) return this.peers.get(remoteDeviceId)!;

    const remoteStream = new MediaStream();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    const entry: PeerEntry = {
      pc,
      remoteStream,
      makingOffer: false,
      ignoreOffer: false,
      remoteDescSet: false,
      pendingCandidates: [],
    };

    pc.ontrack = (e) => {
      const track = e.track;
      if (!remoteStream.getTracks().find(t => t.id === track.id)) {
        remoteStream.addTrack(track);
      }
      e.streams[0]?.getTracks().forEach(t => {
        if (!remoteStream.getTracks().find(x => x.id === t.id)) remoteStream.addTrack(t);
      });

      // Update participant stream
      if (this.room) {
        const participant = this.room.participants.find(p => p.deviceId === remoteDeviceId);
        if (participant) {
          participant.stream = remoteStream;
          this.notifyParticipants();
        }
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && this.room) {
        this.send({
          type: 'group_call_ice',
          payload: {
            roomId: this.room.roomId,
            toDeviceId: remoteDeviceId,
            data: e.candidate.toJSON(),
          },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[GroupCallService] peer ${remoteDeviceId} connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed') {
        // Try ICE restart
        this.restartIce(remoteDeviceId, entry);
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await entry.pc.setLocalDescription();
        this.send({
          type: 'group_call_offer',
          payload: {
            roomId: this.room?.roomId,
            toDeviceId: remoteDeviceId,
            data: entry.pc.localDescription,
          },
        });
      } catch (err) {
        console.error('[GroupCallService] onnegotiationneeded error:', err);
      } finally {
        entry.makingOffer = false;
      }
    };

    this.peers.set(remoteDeviceId, entry);
    return entry;
  }

  private async sendOffer(remoteDeviceId: string, entry: PeerEntry): Promise<void> {
    if (!this.room || !this.localStream) return;
    try {
      entry.makingOffer = true;

      // Add tracks before offer (caller pattern)
      this.addTracksToPC(entry.pc, this.localStream, this.room.callType === 'video');

      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);

      this.send({
        type: 'group_call_offer',
        payload: {
          roomId: this.room.roomId,
          toDeviceId: remoteDeviceId,
          data: entry.pc.localDescription,
        },
      });
    } catch (err) {
      console.error('[GroupCallService] sendOffer error:', err);
    } finally {
      entry.makingOffer = false;
    }
  }

  private async restartIce(remoteDeviceId: string, entry: PeerEntry): Promise<void> {
    if (!this.room) return;
    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer({ iceRestart: true });
      await entry.pc.setLocalDescription(offer);
      this.send({
        type: 'group_call_offer',
        payload: { roomId: this.room.roomId, toDeviceId: remoteDeviceId, data: entry.pc.localDescription },
      });
    } catch { /* ignore */ } finally {
      entry.makingOffer = false;
    }
  }

  private addTracksToPC(pc: RTCPeerConnection, stream: MediaStream, isVideo: boolean): void {
    stream.getTracks().forEach(track => {
      if (track.kind === 'video' && !isVideo) return;
      const alreadyAdded = pc.getSenders().some(s => s.track?.id === track.id);
      if (!alreadyAdded) pc.addTrack(track, stream);
    });
  }

  private drainCandidates(_remoteDeviceId: string, entry: PeerEntry): void {
    const queued = entry.pendingCandidates.splice(0);
    queued.forEach(c => { try { entry.pc.addIceCandidate(c); } catch { /* ignore */ } });
  }

  // ── Utilities ─────────────────────────────────────────────────────────

  private async getUserMedia(video: boolean): Promise<MediaStream> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    }
    stream.getAudioTracks().forEach(t => { t.enabled = true; });
    return stream;
  }

  private send(msg: object): void {
    const ws = this.ws || (window as any).appWebSocket;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...msg, deviceId: this.deviceId, timestamp: Date.now() }));
    }
  }

  private sendJoinNowChatMessage(roomId: string, callType: 'audio' | 'video', sessionId: string): void {
    const ws = this.ws || (window as any).appWebSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const icon = callType === 'video' ? '🎥' : '📞';
    const label = callType === 'video' ? 'video' : 'voice';
    ws.send(JSON.stringify({
      type: 'chat_message',
      sessionId,
      deviceId: this.deviceId,
      payload: {
        chat: {
          messageId: `gcall-start-${roomId}`,
          text: `[[GROUP_CALL_START]]${JSON.stringify({ roomId, callType, hostUsername: this.username })}`,
          username: this.username,
          sentAt: Date.now(),
          format: 'plain',
        },
      },
      timestamp: Date.now(),
    }));
    console.log(`[GroupCallService] ${icon} Group ${label} call started — Join Now message sent`);
  }

  private setState(state: GroupCallState): void {
    this.state = state;
    this.onStateChange(state, this.room);
  }

  private updateSelfStream(stream: MediaStream): void {
    if (this.room) {
      const self = this.room.participants.find(p => p.isSelf);
      if (self) { self.stream = stream; this.notifyParticipants(); }
    }
  }

  private updateSelfMeta(meta: Partial<GroupCallParticipant>): void {
    if (this.room) {
      const self = this.room.participants.find(p => p.isSelf);
      if (self) { Object.assign(self, meta); this.notifyParticipants(); }
    }
  }

  private notifyParticipants(): void {
    if (this.onParticipantsChange && this.room) {
      this.onParticipantsChange([...this.room.participants]);
    }
    // Also re-trigger onStateChange so React re-renders
    this.onStateChange(this.state, this.room ? { ...this.room } : null);
  }

  cleanup(): void {
    this.localStream?.getTracks().forEach(t => t.stop());
    this.peers.forEach(entry => entry.pc.close());
    this.peers.clear();
    this.localStream = null;
    this.room = null;
    this.pendingInvite = null;
    this.setState('ended');
    setTimeout(() => { if (this.state === 'ended') this.setState('idle'); }, 1500);
  }
}
