/**
 * CallService - WebRTC audio/video call management
 *
 * Supports both 1-to-1 and group calls via a mesh topology.
 * In mesh mode each participant holds one RTCPeerConnection per remote peer.
 *
 * CALLER flow (1-to-1 or group initiator):
 *   startCall() → call_invite → [remote accepts] → call_accept received →
 *   getUserMedia → createPeerForDevice → addTracksToPC → createOffer →
 *   setLocalDescription → call_offer → [call_answer] → setRemoteDescription → connected
 *
 * CALLEE flow:
 *   call_invite → [user accepts] → acceptCall() → getUserMedia → createPeerForDevice →
 *   call_accept → [call_offer] → setRemoteDescription → addTracksToPC → sendrecv →
 *   createAnswer → setLocalDescription → call_answer → connected
 *
 * LATE JOINER:
 *   call_join_room → call_room_state (server sends existing participant list) →
 *   for each existing participant: createPeerForDevice + createOffer → exchange SDP
 */

export type CallState = 'idle' | 'ringing_out' | 'ringing_in' | 'connecting' | 'active' | 'ended';

export interface CallInfo {
  callId: string;
  remoteUsername: string;
  remoteDeviceId: string;
  isVideo: boolean;
  direction: 'inbound' | 'outbound';
}

export interface RemoteParticipant {
  deviceId: string;
  username: string;
  stream: MediaStream;
}

type CallEventHandler = (state: CallState, info: CallInfo | null) => void;
type ParticipantsChangedHandler = (participants: RemoteParticipant[]) => void;

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
  pc: RTCPeerConnection;
  stream: MediaStream;
  pendingOffer: RTCSessionDescriptionInit | null;
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescSet: boolean;
  username: string;
}

export class CallService {
  private ws: WebSocket | null = null;
  deviceId: string;
  username: string;
  private state: CallState = 'idle';
  private currentCall: CallInfo | null = null;
  private onStateChange: CallEventHandler;
  private onTrackCallback: ((stream: MediaStream) => void) | null = null;
  private onLocalTrackCallback: ((stream: MediaStream) => void) | null = null;
  private onParticipantsChanged: ParticipantsChangedHandler | null = null;

  private localStream: MediaStream | null = null;

  // Per-peer state: deviceId → PeerState
  private peers = new Map<string, PeerState>();

  constructor(deviceId: string, username: string, onStateChange: CallEventHandler) {
    this.deviceId = deviceId;
    this.username = username;
    this.onStateChange = onStateChange;
  }

  setWebSocket(ws: WebSocket) { this.ws = ws; }
  setOnRemoteTrack(cb: (stream: MediaStream) => void) { this.onTrackCallback = cb; }
  setOnLocalTrack(cb: (stream: MediaStream) => void) { this.onLocalTrackCallback = cb; }
  setOnParticipantsChanged(cb: ParticipantsChangedHandler) { this.onParticipantsChanged = cb; }

  getState() { return this.state; }
  getCurrentCall() { return this.currentCall; }
  getLocalStream() { return this.localStream; }

  /** Returns the remote stream for the first (or only) peer — used by the legacy 1-to-1 modal */
  getRemoteStream(): MediaStream | null {
    const first = this.peers.values().next().value as PeerState | undefined;
    return first?.stream ?? null;
  }

  /** All current remote participants with their streams */
  getParticipants(): RemoteParticipant[] {
    return Array.from(this.peers.entries()).map(([deviceId, p]) => ({
      deviceId,
      username: p.username,
      stream: p.stream,
    }));
  }

  private setState(state: CallState) {
    this.state = state;
    this.onStateChange(state, this.currentCall);
  }

  private send(msg: object) {
    const ws = this.ws || (window as any).appWebSocket;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ ...msg, deviceId: this.deviceId, timestamp: Date.now() }));
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  async startCall(toUsername: string, toDeviceId: string, isVideo: boolean): Promise<void> {
    if (this.state !== 'idle') throw new Error('Already in a call');
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.currentCall = { callId, remoteUsername: toUsername, remoteDeviceId: toDeviceId, isVideo, direction: 'outbound' };
    this.setState('ringing_out');
    this.send({
      type: 'call_invite',
      payload: { callId, toDevice: toDeviceId, toUsername, fromUsername: this.username, isVideo },
    });
  }

  async acceptCall(): Promise<void> {
    if (!this.currentCall || this.state !== 'ringing_in') throw new Error('No incoming call');
    this.setState('connecting');

    try {
      const stream = await this.getUserMedia(this.currentCall.isVideo);
      this.localStream = stream;

      // Create PC for the caller but do NOT add tracks yet (must happen after setRemoteDescription)
      this.createPeerForDevice(this.currentCall.remoteDeviceId, this.currentCall.remoteUsername);

      this.send({
        type: 'call_accept',
        payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, fromUsername: this.username },
      });

      // Process buffered offer if it arrived before acceptCall finished
      const peer = this.peers.get(this.currentCall.remoteDeviceId);
      if (peer?.pendingOffer) {
        const offer = peer.pendingOffer;
        peer.pendingOffer = null;
        await this.applyRemoteOffer(this.currentCall.remoteDeviceId, offer);
      }
    } catch (err) {
      console.error('[CallService] acceptCall failed:', err);
      this.cleanup('setup_failed');
    }
  }

  rejectCall() {
    if (!this.currentCall) return;
    this.send({ type: 'call_reject', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, reason: 'rejected' } });
    this.cleanup('rejected');
  }

  endCall() {
    if (!this.currentCall) return;
    this.send({ type: 'call_end', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId } });
    this.cleanup('ended');
  }

  /** Leave a group call without ending it for others */
  leaveCall() {
    if (!this.currentCall) return;
    this.send({ type: 'call_end', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId } });
    this.cleanup('ended');
  }

  /** Join an ongoing group call from a chat activity message */
  async joinGroupCall(callId: string, isVideo: boolean): Promise<void> {
    if (this.state !== 'idle') return;
    this.currentCall = {
      callId,
      remoteUsername: '',
      remoteDeviceId: '',
      isVideo,
      direction: 'inbound',
    };
    this.setState('connecting');
    try {
      const stream = await this.getUserMedia(isVideo);
      this.localStream = stream;
      // Ask server for the current room state (list of participants)
      this.send({ type: 'call_join_room', payload: { callId } });
    } catch (err) {
      console.error('[CallService] joinGroupCall failed:', err);
      this.cleanup('setup_failed');
    }
  }

  toggleMute(): boolean {
    const audio = this.localStream?.getAudioTracks()[0];
    if (!audio) return false;
    audio.enabled = !audio.enabled;
    return !audio.enabled;
  }

  toggleCamera(): boolean {
    const video = this.localStream?.getVideoTracks()[0];
    if (!video) return false;
    video.enabled = !video.enabled;
    return !video.enabled;
  }

  async switchCamera(): Promise<void> {
    if (!this.localStream || !this.currentCall?.isVideo) return;
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

      // Replace in all peer connections
      for (const { pc } of this.peers.values()) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newVideoTrack);
      }

      videoTrack.stop();
      this.localStream.removeTrack(videoTrack);
      this.localStream.addTrack(newVideoTrack);

      if (this.onLocalTrackCallback) this.onLocalTrackCallback(this.localStream);
    } catch {
      // facingMode exact not supported — skip silently
    }
  }

  // ── Incoming message handler ──────────────────────────────────────────

  async handleMessage(message: any) {
    const { type, payload } = message;

    switch (type) {
      case 'call_invite':
        if (this.state !== 'idle') {
          this.send({ type: 'call_reject', payload: { callId: payload.callId, toDevice: payload.fromDevice, reason: 'busy' } });
          return;
        }
        this.currentCall = {
          callId: payload.callId,
          remoteUsername: payload.fromUsername,
          remoteDeviceId: payload.fromDevice,
          isVideo: payload.isVideo,
          direction: 'inbound',
        };
        this.setState('ringing_in');
        break;

      case 'call_accept': {
        if (this.state !== 'ringing_out' || !this.currentCall) return;
        this.setState('connecting');
        try {
          const stream = await this.getUserMedia(this.currentCall.isVideo);
          this.localStream = stream;

          const remoteDeviceId = payload.fromDevice;
          const remoteUsername = payload.fromUsername || this.currentCall.remoteUsername;
          this.currentCall.remoteDeviceId = remoteDeviceId;
          this.currentCall.remoteUsername = remoteUsername;

          const peer = this.createPeerForDevice(remoteDeviceId, remoteUsername);
          this.addTracksToPC(peer.pc, stream, this.currentCall.isVideo);

          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);

          console.log('[CallService] caller offer SDP directions:',
            offer.sdp?.match(/a=(sendrecv|sendonly|recvonly|inactive)/g));

          this.send({
            type: 'call_offer',
            payload: { callId: this.currentCall.callId, toDevice: remoteDeviceId, data: offer },
          });
        } catch (err) {
          console.error('[CallService] call_accept handler failed:', err);
          this.cleanup('setup_failed');
        }
        break;
      }

      case 'call_reject':
        if (this.state === 'ringing_out' || this.state === 'connecting') {
          this.cleanup(payload?.reason === 'busy' ? 'busy' : 'rejected');
        }
        break;

      case 'call_end': {
        const leavingDevice = payload?.fromDevice;
        if (leavingDevice && this.peers.has(leavingDevice)) {
          // One participant left — remove their peer connection
          this.removePeer(leavingDevice);
          this.notifyParticipantsChanged();
          // If no peers remain, end the call
          if (this.peers.size === 0 && this.state !== 'idle') {
            this.cleanup('ended');
          }
        } else if (this.state !== 'idle') {
          this.cleanup('ended');
        }
        break;
      }

      case 'call_offer': {
        const fromDevice = payload.fromDevice;
        const offerDesc = payload.data as RTCSessionDescriptionInit;
        if (!this.currentCall) return;

        let peer = this.peers.get(fromDevice);
        if (!peer) {
          // New peer joining an existing group call
          const username = (window as any)._sessionDevices?.find((d: any) => d.id === fromDevice)?.username || fromDevice;
          peer = this.createPeerForDevice(fromDevice, username);
        }

        if (peer.pc.signalingState !== 'stable') {
          peer.pendingOffer = offerDesc;
          return;
        }
        await this.applyRemoteOffer(fromDevice, offerDesc);
        break;
      }

      case 'call_answer': {
        const fromDevice = payload.fromDevice;
        const answerDesc = payload.data as RTCSessionDescriptionInit;
        const peer = this.peers.get(fromDevice);
        if (!peer) {
          console.warn('[CallService] call_answer: no peer for', fromDevice);
          return;
        }
        if (peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription(answerDesc);
          peer.remoteDescSet = true;
          this.drainCandidates(fromDevice);
        }
        break;
      }

      case 'call_ice': {
        const fromDevice = payload.fromDevice;
        const candidate = payload.data as RTCIceCandidateInit;
        if (!candidate) return;
        const peer = this.peers.get(fromDevice);
        if (peer && peer.remoteDescSet) {
          try { await peer.pc.addIceCandidate(candidate); } catch { /* ignore */ }
        } else if (peer) {
          peer.pendingCandidates.push(candidate);
        }
        break;
      }

      case 'call_room_state': {
        // Server sent current room participants after call_join_room
        const { participants, isVideo, callId } = payload;
        if (this.currentCall) {
          this.currentCall.isVideo = isVideo;
        }
        // Create peer connections with each existing participant and send offers
        for (const participant of (participants as { deviceId: string; username: string }[])) {
          if (participant.deviceId === this.deviceId) continue;
          if (!this.currentCall) break;
          const peer = this.createPeerForDevice(participant.deviceId, participant.username);
          if (this.localStream) this.addTracksToPC(peer.pc, this.localStream, isVideo);
          const offer = await peer.pc.createOffer();
          await peer.pc.setLocalDescription(offer);
          this.send({
            type: 'call_offer',
            payload: { callId, toDevice: participant.deviceId, data: offer },
          });
        }
        if (participants.length === 0 && this.state === 'connecting') {
          // Empty room — we're the only one; transition to active so UI shows
          this.setState('active');
        }
        break;
      }

      case 'call_participant_joined': {
        // Another participant joined the group call — they'll send us an offer
        // Nothing to do here; the offer will arrive via call_offer
        console.log('[CallService] participant joined:', payload.deviceId, payload.username);
        break;
      }
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private createPeerForDevice(deviceId: string, username: string): PeerState {
    if (this.peers.has(deviceId)) return this.peers.get(deviceId)!;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const stream = new MediaStream();

    const peerState: PeerState = {
      pc, stream, username,
      pendingOffer: null,
      pendingCandidates: [],
      remoteDescSet: false,
    };
    this.peers.set(deviceId, peerState);

    pc.ontrack = (e) => {
      const track = e.track;
      if (!stream.getTracks().find(t => t.id === track.id)) {
        stream.addTrack(track);
      }
      e.streams[0]?.getTracks().forEach(t => {
        if (!stream.getTracks().find(x => x.id === t.id)) stream.addTrack(t);
      });

      console.log(`[CallService] ontrack from ${deviceId}: kind=${track.kind}`);

      // Always notify with the first peer's stream for backward compat
      if (this.onTrackCallback) this.onTrackCallback(stream);
      this.notifyParticipantsChanged();
      if (this.state !== 'active') this.setState('active');
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && this.currentCall) {
        this.send({
          type: 'call_ice',
          payload: { callId: this.currentCall.callId, toDevice: deviceId, data: e.candidate.toJSON() },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[CallService] ${deviceId} connection state:`, pc.connectionState);
      if (pc.connectionState === 'connected' && this.state !== 'active') {
        this.setState('active');
      } else if (pc.connectionState === 'failed') {
        this.removePeer(deviceId);
        this.notifyParticipantsChanged();
        if (this.peers.size === 0) this.cleanup('connection_failed');
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (this.state !== 'active') this.setState('active');
      } else if (pc.iceConnectionState === 'failed') {
        this.removePeer(deviceId);
        this.notifyParticipantsChanged();
        if (this.peers.size === 0) this.cleanup('ice_failed');
      }
    };

    return peerState;
  }

  private removePeer(deviceId: string) {
    const peer = this.peers.get(deviceId);
    if (peer) {
      peer.pc.close();
      this.peers.delete(deviceId);
    }
  }

  private notifyParticipantsChanged() {
    if (this.onParticipantsChanged) {
      this.onParticipantsChanged(this.getParticipants());
    }
  }

  /**
   * Callee-side offer processing.
   * MUST call setRemoteDescription BEFORE addTrack so transceivers are matched to offer m-lines.
   */
  private async applyRemoteOffer(fromDevice: string, offerDesc: RTCSessionDescriptionInit) {
    const peer = this.peers.get(fromDevice);
    if (!peer || !this.localStream) return;

    await peer.pc.setRemoteDescription(offerDesc);
    peer.remoteDescSet = true;
    this.drainCandidates(fromDevice);

    // Add local tracks AFTER setRemoteDescription so they bind to the offer m-lines
    this.addTracksToPC(peer.pc, this.localStream, this.currentCall?.isVideo ?? false);

    // Force sendrecv on all transceivers
    peer.pc.getTransceivers().forEach(tr => {
      if (tr.direction === 'recvonly' || tr.direction === 'inactive') {
        tr.direction = 'sendrecv';
      }
    });

    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);

    console.log('[CallService] callee answer SDP directions:',
      answer.sdp?.match(/a=(sendrecv|sendonly|recvonly|inactive)/g));

    this.send({
      type: 'call_answer',
      payload: { callId: this.currentCall!.callId, toDevice: fromDevice, data: answer },
    });
  }

  private addTracksToPC(pc: RTCPeerConnection, stream: MediaStream, isVideo: boolean) {
    stream.getTracks().forEach(track => {
      if (track.kind === 'video' && !isVideo) return;
      const alreadyAdded = pc.getSenders().some(s => s.track?.id === track.id);
      if (alreadyAdded) return;
      pc.addTrack(track, stream);
      console.log(`[CallService] addTrack: kind=${track.kind} enabled=${track.enabled}`);
    });
  }

  private drainCandidates(deviceId: string) {
    const peer = this.peers.get(deviceId);
    if (!peer) return;
    const queued = peer.pendingCandidates.splice(0);
    queued.forEach(c => {
      try { peer.pc.addIceCandidate(c); } catch { /* ignore */ }
    });
  }

  private async getUserMedia(video: boolean): Promise<MediaStream> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
      });
    } catch (err) {
      console.warn('[CallService] getUserMedia with constraints failed, retrying basic:', err);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
      } catch (err2) {
        console.error('[CallService] getUserMedia basic also failed:', err2);
        throw err2;
      }
    }

    stream.getAudioTracks().forEach(t => {
      t.enabled = true;
      console.log(`[CallService] audio track: id=${t.id} enabled=${t.enabled}`);
    });

    if (this.onLocalTrackCallback) this.onLocalTrackCallback(stream);
    return stream;
  }

  private cleanup(reason?: string) {
    this.localStream?.getTracks().forEach(t => t.stop());
    for (const [deviceId] of this.peers) this.removePeer(deviceId);
    this.peers.clear();
    this.localStream = null;
    const prevCall = this.currentCall;
    this.currentCall = null;
    this.setState('ended');
    const delay = (reason === 'rejected' || reason === 'busy') ? 2000 : 1500;
    setTimeout(() => { if (this.state === 'ended') this.setState('idle'); }, delay);
    console.log('[CallService] cleaned up. reason:', reason, 'callId:', prevCall?.callId);
  }
}
