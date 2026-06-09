/**
 * CallService - WebRTC audio/video call management
 *
 * Fixes:
 * - ICE candidates buffered until remote description is set
 * - offer can arrive before acceptCall() — stored as pendingOffer
 * - answer/ice arriving before PC is created are queued
 * - audio mode set correctly for calls
 */

export type CallState = 'idle' | 'ringing_out' | 'ringing_in' | 'connecting' | 'active' | 'ended';

export interface CallInfo {
  callId: string;
  remoteUsername: string;
  remoteDeviceId: string;
  isVideo: boolean;
  direction: 'inbound' | 'outbound';
}

type CallEventHandler = (state: CallState, info: CallInfo | null) => void;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // TURN fallback so calls work across strict NATs
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export class CallService {
  private ws: WebSocket | null = null;
  private deviceId: string;
  private username: string;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private state: CallState = 'idle';
  private currentCall: CallInfo | null = null;
  private onStateChange: CallEventHandler;
  private onTrackCallback: ((stream: MediaStream) => void) | null = null;
  private onLocalTrackCallback: ((stream: MediaStream) => void) | null = null;

  // Signaling race buffers
  private pendingOffer: RTCSessionDescriptionInit | null = null;   // offer arrived before acceptCall
  private pendingAnswer: RTCSessionDescriptionInit | null = null;  // answer arrived before PC ready
  private pendingCandidates: RTCIceCandidateInit[] = [];           // ICE before remote desc
  private remoteDescSet = false;

  constructor(deviceId: string, username: string, onStateChange: CallEventHandler) {
    this.deviceId = deviceId;
    this.username = username;
    this.onStateChange = onStateChange;
  }

  setWebSocket(ws: WebSocket) { this.ws = ws; }
  setOnRemoteTrack(cb: (stream: MediaStream) => void) { this.onTrackCallback = cb; }
  setOnLocalTrack(cb: (stream: MediaStream) => void) { this.onLocalTrackCallback = cb; }
  getState() { return this.state; }
  getCurrentCall() { return this.currentCall; }
  getRemoteStream() { return this.remoteStream; }
  getLocalStream() { return this.localStream; }

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
      this.pc = this.createPeerConnection();
      stream.getTracks().forEach(t => this.pc!.addTrack(t, stream));

      this.send({
        type: 'call_accept',
        payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, fromUsername: this.username },
      });

      // If the offer arrived before we accepted, process it now
      if (this.pendingOffer) {
        const offer = this.pendingOffer;
        this.pendingOffer = null;
        await this.applyRemoteOffer(offer);
      }
      // If a stale answer arrived (shouldn't happen inbound, but be safe)
      if (this.pendingAnswer) {
        const answer = this.pendingAnswer;
        this.pendingAnswer = null;
        if (this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(answer);
          this.remoteDescSet = true;
          this.drainCandidates();
        }
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

  /** Switch between front and back camera (mobile browsers) */
  async switchCamera(): Promise<void> {
    if (!this.localStream || !this.currentCall?.isVideo) return;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) return;

    // Read current facing mode
    const settings = videoTrack.getSettings();
    const currentFacing = settings.facingMode ?? 'user';
    const nextFacing = currentFacing === 'user' ? 'environment' : 'user';

    try {
      // Get new stream with opposite camera
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { exact: nextFacing } },
      });
      const newVideoTrack = newStream.getVideoTracks()[0];

      // Replace the track in the peer connection
      if (this.pc) {
        const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newVideoTrack);
      }

      // Swap in local stream
      videoTrack.stop();
      this.localStream.removeTrack(videoTrack);
      this.localStream.addTrack(newVideoTrack);

      // Re-attach local preview
      if (this.onLocalTrackCallback) this.onLocalTrackCallback(this.localStream);
    } catch {
      // Browser doesn't support exact facingMode — silently skip
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
        // We're the caller — callee accepted, now build PC and send offer
        if (this.state !== 'ringing_out' || !this.currentCall) return;
        this.setState('connecting');
        try {
          const stream = await this.getUserMedia(this.currentCall.isVideo);
          this.localStream = stream;
          this.pc = this.createPeerConnection();
          stream.getTracks().forEach(t => this.pc!.addTrack(t, stream));

          const offer = await this.pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: this.currentCall.isVideo,
          });
          await this.pc.setLocalDescription(offer);
          this.send({ type: 'call_offer', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, data: offer } });
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

      case 'call_end':
        if (this.state !== 'idle') this.cleanup('ended');
        break;

      case 'call_offer': {
        // We're the callee — received SDP offer from caller
        const offerDesc = payload.data as RTCSessionDescriptionInit;
        if (!this.currentCall) return;

        if (!this.pc) {
          // acceptCall hasn't finished setting up PC yet — buffer it
          this.pendingOffer = offerDesc;
          return;
        }
        await this.applyRemoteOffer(offerDesc);
        break;
      }

      case 'call_answer': {
        // We're the caller — received SDP answer from callee
        const answerDesc = payload.data as RTCSessionDescriptionInit;
        if (!this.pc) {
          this.pendingAnswer = answerDesc;
          return;
        }
        if (this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(answerDesc);
          this.remoteDescSet = true;
          this.drainCandidates();
        }
        break;
      }

      case 'call_ice': {
        const candidate = payload.data as RTCIceCandidateInit;
        if (!candidate) return;
        if (this.pc && this.remoteDescSet) {
          try { await this.pc.addIceCandidate(candidate); } catch { /* ignore */ }
        } else {
          this.pendingCandidates.push(candidate);
        }
        break;
      }
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private async applyRemoteOffer(offerDesc: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(offerDesc);
    this.remoteDescSet = true;
    this.drainCandidates();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.send({
      type: 'call_answer',
      payload: { callId: this.currentCall!.callId, toDevice: this.currentCall!.remoteDeviceId, data: answer },
    });
  }

  private drainCandidates() {
    const queued = this.pendingCandidates.splice(0);
    queued.forEach(c => {
      try { this.pc?.addIceCandidate(c); } catch { /* ignore */ }
    });
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.remoteStream = new MediaStream();

    pc.ontrack = (e) => {
      // Add the track directly from the event — don't rely on e.streams[0]
      // which can be undefined in Unified Plan (Android WebRTC)
      const track = e.track;
      this.remoteStream!.addTrack(track);

      // Also add from stream if present (belt-and-suspenders)
      e.streams[0]?.getTracks().forEach(t => {
        if (!this.remoteStream!.getTracks().find(x => x.id === t.id)) {
          this.remoteStream!.addTrack(t);
        }
      });

      // Notify CallModal to re-attach the stream
      if (this.onTrackCallback) this.onTrackCallback(this.remoteStream!);
      if (this.state !== 'active') this.setState('active');
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && this.currentCall) {
        this.send({
          type: 'call_ice',
          payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, data: e.candidate.toJSON() },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[CallService] connection state:', pc.connectionState);
      if (pc.connectionState === 'connected' && this.state !== 'active') {
        this.setState('active');
      } else if (pc.connectionState === 'failed') {
        this.cleanup('connection_failed');
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[CallService] ICE state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        if (this.state !== 'active') this.setState('active');
      } else if (pc.iceConnectionState === 'failed') {
        this.cleanup('ice_failed');
      }
    };

    return pc;
  }

  private async getUserMedia(video: boolean): Promise<MediaStream> {
    // Try with ideal constraints first, fall back to basic audio if denied
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
          // Chrome-specific legacy constraints (belt-and-suspenders)
          // @ts-ignore
          googEchoCancellation: true,
          // @ts-ignore
          googNoiseSuppression: true,
          // @ts-ignore
          googAutoGainControl: true,
        },
        video: video
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
          : false,
      });
    } catch (err) {
      console.warn('[CallService] getUserMedia with constraints failed, retrying basic:', err);
      // Retry with minimal constraints (some browsers reject advanced ones)
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    }
    if (this.onLocalTrackCallback) this.onLocalTrackCallback(stream);
    return stream;
  }

  private cleanup(reason?: string) {
    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.localStream = null;
    this.remoteStream = null;
    this.pc = null;
    this.pendingOffer = null;
    this.pendingAnswer = null;
    this.pendingCandidates = [];
    this.remoteDescSet = false;
    // NOTE: do NOT null out onTrackCallback / onLocalTrackCallback here.
    // CallModal registers them once on mount; clearing them here breaks
    // subsequent calls in the same session.
    const prevCall = this.currentCall;
    this.currentCall = null;
    this.setState('ended');
    const delay = (reason === 'rejected' || reason === 'busy') ? 2000 : 1500;
    setTimeout(() => { if (this.state === 'ended') this.setState('idle'); }, delay);
    console.log('[CallService] cleaned up. reason:', reason, 'callId:', prevCall?.callId);
  }
}
