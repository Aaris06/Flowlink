/**
 * CallService - WebRTC audio/video call management
 * Handles signaling (via WebSocket) and peer connection lifecycle
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

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
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
  private pendingOffer: RTCSessionDescriptionInit | null = null;

  constructor(deviceId: string, username: string, onStateChange: CallEventHandler) {
    this.deviceId = deviceId;
    this.username = username;
    this.onStateChange = onStateChange;
  }

  setWebSocket(ws: WebSocket) {
    this.ws = ws;
  }

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

  /** Initiate a call to another user */
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

  /** Accept an incoming call */
  async acceptCall(): Promise<{ localStream: MediaStream; remoteStream: MediaStream }> {
    if (!this.currentCall || this.state !== 'ringing_in') throw new Error('No incoming call');
    this.setState('connecting');

    const stream = await this.getUserMedia(this.currentCall.isVideo);
    this.localStream = stream;

    this.pc = this.createPeerConnection();
    stream.getTracks().forEach(t => this.pc!.addTrack(t, stream));

    this.send({
      type: 'call_accept',
      payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, fromUsername: this.username },
    });

    // Set remote offer that arrived before accept
    if (this.pendingOffer) {
      await this.pc.setRemoteDescription(this.pendingOffer);
      this.pendingOffer = null;
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.send({
        type: 'call_answer',
        payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, data: answer },
      });
    }

    return { localStream: this.localStream!, remoteStream: this.remoteStream! };
  }

  /** Reject an incoming call */
  rejectCall() {
    if (!this.currentCall) return;
    this.send({
      type: 'call_reject',
      payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, reason: 'rejected' },
    });
    this.cleanup();
  }

  /** End an active call */
  endCall() {
    if (!this.currentCall) return;
    this.send({
      type: 'call_end',
      payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId },
    });
    this.cleanup();
  }

  toggleMute(): boolean {
    if (!this.localStream) return false;
    const audio = this.localStream.getAudioTracks()[0];
    if (!audio) return false;
    audio.enabled = !audio.enabled;
    return !audio.enabled; // returns true if muted
  }

  toggleCamera(): boolean {
    if (!this.localStream) return false;
    const video = this.localStream.getVideoTracks()[0];
    if (!video) return false;
    video.enabled = !video.enabled;
    return !video.enabled; // returns true if camera off
  }

  /** Handle incoming WebSocket message */
  async handleMessage(message: any) {
    const { type, payload } = message;
    switch (type) {
      case 'call_invite':
        if (this.state !== 'idle') {
          // Busy - send reject back
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
        const stream = await this.getUserMedia(this.currentCall.isVideo);
        this.localStream = stream;
        this.pc = this.createPeerConnection();
        stream.getTracks().forEach(t => this.pc!.addTrack(t, stream));
        const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: this.currentCall.isVideo });
        await this.pc.setLocalDescription(offer);
        this.send({ type: 'call_offer', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, data: offer } });
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
        if (!this.currentCall) return;
        const offerDesc = payload.data as RTCSessionDescriptionInit;
        if (this.pc) {
          await this.pc.setRemoteDescription(offerDesc);
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.send({ type: 'call_answer', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, data: answer } });
        } else {
          this.pendingOffer = offerDesc;
        }
        break;
      }

      case 'call_answer':
        if (this.pc && this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(payload.data as RTCSessionDescriptionInit);
        }
        break;

      case 'call_ice':
        if (this.pc && payload.data) {
          try { await this.pc.addIceCandidate(payload.data); } catch { /* ignore */ }
        }
        break;
    }
  }

  private createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.remoteStream = new MediaStream();

    pc.ontrack = (e) => {
      e.streams[0]?.getTracks().forEach(t => this.remoteStream!.addTrack(t));
      this.setState('active');
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && this.currentCall) {
        this.send({ type: 'call_ice', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, data: e.candidate } });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.cleanup('connection_failed');
      }
    };

    return pc;
  }

  private async getUserMedia(video: boolean): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({ audio: true, video });
  }

  private cleanup(reason?: string) {
    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.localStream = null;
    this.remoteStream = null;
    this.pc = null;
    this.pendingOffer = null;
    const prevCall = this.currentCall;
    this.currentCall = null;
    this.setState('ended');
    // Reset to idle after brief delay so UI can show "call ended"
    setTimeout(() => {
      if (this.state === 'ended') this.setState('idle');
    }, reason === 'rejected' || reason === 'busy' ? 2000 : 1500);
    console.log(`Call cleaned up. Reason: ${reason || 'normal'}`, prevCall?.callId);
  }
}
