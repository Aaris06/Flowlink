/**
 * CallService - WebRTC audio/video call management
 *
 * Key design: microphone/camera is acquired during startCall() and acceptCall()
 * which run inside button-click handlers (user gesture context). This is
 * critical because browsers block getUserMedia() called from WebSocket message
 * handlers (non-user-gesture). The pre-acquired stream is stored and reused
 * when the actual WebRTC offer/answer exchange happens.
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
  private pendingOffer: RTCSessionDescriptionInit | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescSet = false;

  /**
   * Stream grabbed during startCall() user gesture.
   * Consumed in the call_accept handler (which runs in WS message context,
   * where getUserMedia is blocked on some browsers/configs).
   */
  private preAcquiredStream: MediaStream | null = null;

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

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Outbound call — called from a button click (user gesture).
   * Acquires mic/camera NOW so the stream is ready when call_accept arrives.
   */
  async startCall(toUsername: string, toDeviceId: string, isVideo: boolean): Promise<void> {
    if (this.state !== 'idle') throw new Error('Already in a call');

    // Acquire media under user gesture
    try {
      this.preAcquiredStream = await this.getUserMedia(isVideo);
      console.log('[CallService] pre-acquired tracks:',
        this.preAcquiredStream.getTracks().map(t => `${t.kind}(enabled=${t.enabled})`));
    } catch (err) {
      console.error('[CallService] startCall getUserMedia failed:', err);
      throw err;
    }

    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.currentCall = {
      callId,
      remoteUsername: toUsername,
      remoteDeviceId: toDeviceId,
      isVideo,
      direction: 'outbound',
    };
    this.setState('ringing_out');
    this.send({
      type: 'call_invite',
      payload: { callId, toDevice: toDeviceId, toUsername, fromUsername: this.username, isVideo },
    });
  }

  /**
   * Inbound call accept — called from the Accept button (user gesture).
   * Acquires mic/camera NOW.
   */
  async acceptCall(): Promise<void> {
    if (!this.currentCall || this.state !== 'ringing_in') throw new Error('No incoming call');
    this.setState('connecting');

    try {
      const stream = await this.getUserMedia(this.currentCall.isVideo);
      this.localStream = stream;
      this.pc = this.createPeerConnection();

      stream.getTracks().forEach(t => {
        this.pc!.addTrack(t, stream);
        console.log(`[CallService] callee addTrack: ${t.kind} enabled=${t.enabled} state=${t.readyState}`);
      });

      this.send({
        type: 'call_accept',
        payload: {
          callId: this.currentCall.callId,
          toDevice: this.currentCall.remoteDeviceId,
          fromUsername: this.username,
        },
      });

      // Process offer if it arrived before acceptCall() completed
      if (this.pendingOffer) {
        const offer = this.pendingOffer;
        this.pendingOffer = null;
        await this.applyRemoteOffer(offer);
      }
    } catch (err) {
      console.error('[CallService] acceptCall failed:', err);
      this.cleanup('setup_failed');
    }
  }

  rejectCall() {
    if (!this.currentCall) return;
    this.send({
      type: 'call_reject',
      payload: {
        callId: this.currentCall.callId,
        toDevice: this.currentCall.remoteDeviceId,
        reason: 'rejected',
      },
    });
    this.cleanup('rejected');
  }

  endCall() {
    if (!this.currentCall) return;
    this.send({
      type: 'call_end',
      payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId },
    });
    this.cleanup('ended');
  }

  toggleMute(): boolean {
    const audio = this.localStream?.getAudioTracks()[0];
    if (!audio) return false;
    audio.enabled = !audio.enabled;
    return !audio.enabled; // returns true when muted
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
    const currentFacing = videoTrack.getSettings().facingMode ?? 'user';
    const nextFacing = currentFacing === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { exact: nextFacing } },
      });
      const newVideo = newStream.getVideoTracks()[0];
      const sender = this.pc?.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(newVideo);
      videoTrack.stop();
      this.localStream.removeTrack(videoTrack);
      this.localStream.addTrack(newVideo);
      if (this.onLocalTrackCallback) this.onLocalTrackCallback(this.localStream);
    } catch { /* facingMode exact not supported on this browser */ }
  }

  // ── Incoming WebSocket message handler ────────────────────────────────

  async handleMessage(message: any) {
    const { type, payload } = message;

    switch (type) {

      case 'call_invite':
        if (this.state !== 'idle') {
          this.send({
            type: 'call_reject',
            payload: { callId: payload.callId, toDevice: payload.fromDevice, reason: 'busy' },
          });
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
        // We're the caller — remote accepted. Build PC using pre-acquired stream.
        if (this.state !== 'ringing_out' || !this.currentCall) return;
        this.setState('connecting');
        try {
          // Use the stream grabbed during startCall() user gesture
          const stream = this.preAcquiredStream;
          if (!stream) {
            // This should not happen in normal flow. Log and fail gracefully.
            console.error('[CallService] call_accept: no pre-acquired stream! Was startCall() called?');
            this.cleanup('setup_failed');
            return;
          }
          this.preAcquiredStream = null;
          this.localStream = stream;
          this.pc = this.createPeerConnection();

          stream.getTracks().forEach(t => {
            this.pc!.addTrack(t, stream);
            console.log(`[CallService] caller addTrack: ${t.kind} enabled=${t.enabled} state=${t.readyState}`);
          });

          // Force sendrecv so both sides send and receive
          this.pc.getTransceivers().forEach(tr => { tr.direction = 'sendrecv'; });

          const offer = await this.pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: this.currentCall.isVideo,
          });
          await this.pc.setLocalDescription(offer);
          console.log('[CallService] offer SDP directions:',
            offer.sdp?.match(/a=(sendrecv|sendonly|recvonly|inactive)/g));

          this.send({
            type: 'call_offer',
            payload: {
              callId: this.currentCall.callId,
              toDevice: this.currentCall.remoteDeviceId,
              data: offer,
            },
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

      case 'call_end':
        if (this.state !== 'idle') this.cleanup('ended');
        break;

      case 'call_offer': {
        const offerDesc = payload.data as RTCSessionDescriptionInit;
        if (!this.currentCall) return;
        if (!this.pc) {
          // PC not ready yet (acceptCall still running) — buffer
          this.pendingOffer = offerDesc;
          return;
        }
        await this.applyRemoteOffer(offerDesc);
        break;
      }

      case 'call_answer': {
        const answerDesc = payload.data as RTCSessionDescriptionInit;
        // PC is always created before we send the offer, so a null PC here
        // means a stale/duplicate answer — safe to ignore.
        if (!this.pc) return;
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
          try { await this.pc.addIceCandidate(candidate); } catch { /* stale candidate, ignore */ }
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

    // After setRemoteDescription the browser may set transceivers to recvonly
    // (mirroring the remote's sendonly). Force sendrecv so we actually send back.
    this.pc.getTransceivers().forEach(tr => {
      if (tr.direction === 'recvonly' || tr.direction === 'inactive') {
        tr.direction = 'sendrecv';
      }
    });

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    console.log('[CallService] answer SDP directions:',
      answer.sdp?.match(/a=(sendrecv|sendonly|recvonly|inactive)/g));

    this.send({
      type: 'call_answer',
      payload: {
        callId: this.currentCall!.callId,
        toDevice: this.currentCall!.remoteDeviceId,
        data: answer,
      },
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
      // Add directly from event — e.streams[0] can be undefined in Unified Plan
      const track = e.track;
      this.remoteStream!.addTrack(track);
      e.streams[0]?.getTracks().forEach(t => {
        if (!this.remoteStream!.getTracks().find(x => x.id === t.id)) {
          this.remoteStream!.addTrack(t);
        }
      });
      if (this.onTrackCallback) this.onTrackCallback(this.remoteStream!);
      if (this.state !== 'active') this.setState('active');
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && this.currentCall) {
        this.send({
          type: 'call_ice',
          payload: {
            callId: this.currentCall.callId,
            toDevice: this.currentCall.remoteDeviceId,
            data: e.candidate.toJSON(),
          },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('[CallService] connectionState:', pc.connectionState);
      if (pc.connectionState === 'connected' && this.state !== 'active') {
        this.setState('active');
      } else if (pc.connectionState === 'failed') {
        this.cleanup('connection_failed');
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('[CallService] iceConnectionState:', pc.iceConnectionState);
      if (
        pc.iceConnectionState === 'connected' ||
        pc.iceConnectionState === 'completed'
      ) {
        if (this.state !== 'active') this.setState('active');
      } else if (pc.iceConnectionState === 'failed') {
        this.cleanup('ice_failed');
      }
    };

    return pc;
  }

  /**
   * Acquire mic/camera. Must be called from a user-gesture context
   * (button click handler), never from a WebSocket event handler.
   */
  private async getUserMedia(video: boolean): Promise<MediaStream> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: video
          ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
          : false,
      });
    } catch (err) {
      console.warn('[CallService] getUserMedia constrained failed, retrying basic:', err);
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    }

    // Ensure tracks are enabled (some browsers return disabled tracks on constraint mismatch)
    stream.getAudioTracks().forEach(t => {
      t.enabled = true;
      console.log(`[CallService] audio track: enabled=${t.enabled} muted=${t.muted} state=${t.readyState}`);
    });

    if (this.onLocalTrackCallback) this.onLocalTrackCallback(stream);
    return stream;
  }

  private cleanup(reason?: string) {
    // Release pre-acquired stream if call was cancelled before it was used
    this.preAcquiredStream?.getTracks().forEach(t => t.stop());
    this.preAcquiredStream = null;

    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc?.close();
    this.localStream  = null;
    this.remoteStream = null;
    this.pc           = null;
    this.pendingOffer = null;
    this.pendingCandidates = [];
    this.remoteDescSet = false;

    // Do NOT null out onTrackCallback/onLocalTrackCallback here.
    // CallModal registers them once on mount — clearing them breaks subsequent calls.

    const prevCall = this.currentCall;
    this.currentCall = null;
    this.setState('ended');
    const delay = (reason === 'rejected' || reason === 'busy') ? 2000 : 1500;
    setTimeout(() => { if (this.state === 'ended') this.setState('idle'); }, delay);
    console.log('[CallService] cleanup. reason:', reason, 'callId:', prevCall?.callId);
  }
}
