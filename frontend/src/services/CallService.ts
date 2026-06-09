/**
 * CallService - WebRTC audio/video call management
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
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];

export class CallService {
  private ws: WebSocket | null = null;
  deviceId: string;   // public so App.tsx can update it
  username: string;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null; // for audio-only calls
  private state: CallState = 'idle';
  private currentCall: CallInfo | null = null;
  private onStateChange: CallEventHandler;
  private onTrackCallback: ((stream: MediaStream) => void) | null = null;
  private onLocalTrackCallback: ((stream: MediaStream) => void) | null = null;

  // Signaling race buffers
  private pendingOffer: RTCSessionDescriptionInit | null = null;
  private pendingAnswer: RTCSessionDescriptionInit | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
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
    this.send({ type: 'call_invite', payload: { callId, toDevice: toDeviceId, toUsername, fromUsername: this.username, isVideo } });
  }

  async acceptCall(): Promise<void> {
    if (!this.currentCall || this.state !== 'ringing_in') return;
    this.setState('connecting');
    try {
      const stream = await this.getUserMedia(this.currentCall.isVideo);
      this.localStream = stream;
      this.pc = this.createPeerConnection();
      stream.getTracks().forEach(t => this.pc!.addTrack(t, stream));
      this.send({ type: 'call_accept', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, fromUsername: this.username } });
      if (this.pendingOffer) { const o = this.pendingOffer; this.pendingOffer = null; await this.applyRemoteOffer(o); }
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

  async switchCamera(): Promise<void> {
    if (!this.localStream) return;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) return;
    const settings = videoTrack.getSettings();
    const nextFacing = (settings.facingMode ?? 'user') === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { exact: nextFacing } } });
      const newVideoTrack = newStream.getVideoTracks()[0];
      const sender = this.pc?.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(newVideoTrack);
      videoTrack.stop();
      this.localStream.removeTrack(videoTrack);
      this.localStream.addTrack(newVideoTrack);
      if (this.onLocalTrackCallback) this.onLocalTrackCallback(this.localStream);
    } catch { /* silently skip */ }
  }

  // ── Message handler ───────────────────────────────────────────────────

  async handleMessage(message: any) {
    const { type, payload } = message;
    switch (type) {
      case 'call_invite':
        if (this.state !== 'idle') {
          this.send({ type: 'call_reject', payload: { callId: payload.callId, toDevice: payload.fromDevice, reason: 'busy' } });
          return;
        }
        this.currentCall = { callId: payload.callId, remoteUsername: payload.fromUsername, remoteDeviceId: payload.fromDevice, isVideo: payload.isVideo, direction: 'inbound' };
        this.setState('ringing_in');
        break;

      case 'call_accept': {
        if (this.state !== 'ringing_out' || !this.currentCall) return;
        this.setState('connecting');
        try {
          const stream = await this.getUserMedia(this.currentCall.isVideo);
          this.localStream = stream;
          this.pc = this.createPeerConnection();
          stream.getTracks().forEach(t => this.pc!.addTrack(t, stream));
          const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: this.currentCall.isVideo });
          await this.pc.setLocalDescription(offer);
          this.send({ type: 'call_offer', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, data: offer } });
        } catch (err) {
          console.error('[CallService] call_accept handler failed:', err);
          this.cleanup('setup_failed');
        }
        break;
      }

      case 'call_reject':
        if (this.state === 'ringing_out' || this.state === 'connecting') this.cleanup(payload?.reason === 'busy' ? 'busy' : 'rejected');
        break;

      case 'call_end':
        if (this.state !== 'idle') this.cleanup('ended');
        break;

      case 'call_offer': {
        if (!this.currentCall) return;
        if (!this.pc) { this.pendingOffer = payload.data; return; }
        await this.applyRemoteOffer(payload.data);
        break;
      }

      case 'call_answer': {
        if (!this.pc) { this.pendingAnswer = payload.data; return; }
        if (this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(payload.data);
          this.remoteDescSet = true;
          this.drainCandidates();
        }
        break;
      }

      case 'call_ice': {
        if (!payload.data) return;
        if (this.pc && this.remoteDescSet) { try { await this.pc.addIceCandidate(payload.data); } catch { } }
        else this.pendingCandidates.push(payload.data);
        break;
      }
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async applyRemoteOffer(offerDesc: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(offerDesc);
    this.remoteDescSet = true;
    this.drainCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.send({ type: 'call_answer', payload: { callId: this.currentCall!.callId, toDevice: this.currentCall!.remoteDeviceId, data: answer } });
  }

  private drainCandidates() {
    this.pendingCandidates.splice(0).forEach(c => { try { this.pc?.addIceCandidate(c); } catch { } });
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.remoteStream = new MediaStream();

    pc.ontrack = (e) => {
      // Add track to remote stream
      e.streams[0]?.getTracks().forEach(t => {
        if (!this.remoteStream!.getTracks().find(x => x.id === t.id)) {
          this.remoteStream!.addTrack(t);
        }
      });

      // KEY FIX: For audio tracks, attach to hidden audio element so audio plays
      // even without a <video> element (audio-only calls)
      e.streams[0]?.getAudioTracks().forEach(audioTrack => {
        if (!this.audioEl) {
          this.audioEl = new Audio();
          this.audioEl.autoplay = true;
          this.audioEl.setAttribute('playsinline', 'true');
          document.body.appendChild(this.audioEl);
        }
        // Only set if not already playing this stream
        if (this.audioEl.srcObject !== e.streams[0]) {
          this.audioEl.srcObject = e.streams[0] ?? null;
          this.audioEl.play().catch(err => console.warn('[CallService] audio play failed:', err));
        }
      });

      if (this.onTrackCallback) this.onTrackCallback(this.remoteStream!);
      if (this.state !== 'active') this.setState('active');
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && this.currentCall) {
        this.send({ type: 'call_ice', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, data: e.candidate.toJSON() } });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[CallService] connection:', pc.connectionState);
      if (pc.connectionState === 'connected' && this.state !== 'active') this.setState('active');
      else if (pc.connectionState === 'failed') this.cleanup('connection_failed');
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[CallService] ICE:', pc.iceConnectionState);
      if ((pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') && this.state !== 'active') this.setState('active');
      else if (pc.iceConnectionState === 'failed') this.cleanup('ice_failed');
    };

    return pc;
  }

  private async getUserMedia(video: boolean): Promise<MediaStream> {
    // Request with explicit audio constraints to ensure microphone works
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
    });
    if (this.onLocalTrackCallback) this.onLocalTrackCallback(stream);
    return stream;
  }

  private cleanup(reason?: string) {
    // Remove hidden audio element
    if (this.audioEl) {
      this.audioEl.srcObject = null;
      this.audioEl.remove();
      this.audioEl = null;
    }
    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.localStream = null;
    this.remoteStream = null;
    this.pc = null;
    this.pendingOffer = null;
    this.pendingAnswer = null;
    this.pendingCandidates = [];
    this.remoteDescSet = false;
    this.onTrackCallback = null;
    this.onLocalTrackCallback = null;
    const prevCall = this.currentCall;
    this.currentCall = null;
    this.setState('ended');
    const delay = (reason === 'rejected' || reason === 'busy') ? 2000 : 1500;
    setTimeout(() => { if (this.state === 'ended') this.setState('idle'); }, delay);
    console.log('[CallService] cleaned up. reason:', reason, 'callId:', prevCall?.callId);
  }
}
