/**
 * CallService - WebRTC audio/video call management
 *
 * Architecture notes:
 *
 * CALLER flow:
 *   startCall() → [remote accepts] → call_accept received → getUserMedia →
 *   createPC → addTrack (creates sendrecv transceivers) → createOffer →
 *   setLocalDescription → send call_offer → [receive call_answer] →
 *   setRemoteDescription → ICE connects
 *
 * CALLEE flow:
 *   call_invite → [user accepts] → acceptCall() → getUserMedia →
 *   createPC → send call_accept → [receive call_offer] →
 *   setRemoteDescription (creates transceivers from offer m-lines) →
 *   addTrack for each local track (matched to existing m-lines) →
 *   force sendrecv on all transceivers → createAnswer →
 *   setLocalDescription → send call_answer → ICE connects
 *
 * CRITICAL: The callee must NOT call addTrack() before setRemoteDescription().
 * If addTrack() is called first it creates transceivers with no m-line binding.
 * When setRemoteDescription() then runs, it creates NEW transceivers for the
 * offer m-lines and the pre-created ones become orphaned — so the local audio/
 * video tracks are never associated with the negotiated m-lines and nothing is
 * sent back to the caller.
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

  private sendCallActivityMessage(kind: 'started' | 'joined' | 'ended') {
    const ws = this.ws || (window as any).appWebSocket;
    const sessionId = sessionStorage.getItem('sessionId');
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId || !this.currentCall) return;

    ws.send(JSON.stringify({
      type: 'chat_message',
      sessionId,
      deviceId: this.deviceId,
      payload: {
        chat: {
          messageId: `call-${this.currentCall.callId}-${kind}`,
          text: `[[CALL_ACTIVITY]]${JSON.stringify({
            callId: this.currentCall.callId,
            kind,
            callType: this.currentCall.isVideo ? 'video' : 'audio',
            remoteUsername: this.currentCall.remoteUsername,
            remoteDeviceId: this.currentCall.remoteDeviceId,
            sourceUsername: this.username,
            sourceDeviceId: this.deviceId,
          })}`,
          username: this.username,
          sentAt: Date.now(),
          format: 'plain',
        },
      },
      timestamp: Date.now(),
    }));
  }

  // ── Public API ────────────────────────────────────────────────────────

  async startCall(toUsername: string, toDeviceId: string, isVideo: boolean): Promise<void> {
    if (this.state !== 'idle') throw new Error('Already in a call');
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.currentCall = { callId, remoteUsername: toUsername, remoteDeviceId: toDeviceId, isVideo, direction: 'outbound' };
    this.setState('ringing_out');
    this.sendCallActivityMessage('started');
    this.send({
      type: 'call_invite',
      payload: { callId, toDevice: toDeviceId, toUsername, fromUsername: this.username, isVideo },
    });
  }

  async acceptCall(): Promise<void> {
    if (!this.currentCall || this.state !== 'ringing_in') throw new Error('No incoming call');
    this.setState('connecting');
    this.sendCallActivityMessage('joined');

    try {
      // Acquire media first so we're ready to add tracks after setRemoteDescription
      const stream = await this.getUserMedia(this.currentCall.isVideo);
      this.localStream = stream;

      // Create the peer connection but do NOT add tracks yet.
      // Tracks must be added AFTER setRemoteDescription so the browser can
      // match them to the correct m-lines from the offer. Adding tracks before
      // the offer creates orphaned transceivers that never get negotiated.
      this.pc = this.createPeerConnection();

      // Tell caller we're ready — they'll send us the offer
      this.send({
        type: 'call_accept',
        payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, fromUsername: this.username },
      });

      // If the offer arrived before acceptCall finished (race condition), process it now
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
    this.send({ type: 'call_reject', payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, reason: 'rejected' } });
    this.cleanup('rejected');
  }

  endCall() {
    if (!this.currentCall) return;
    this.sendCallActivityMessage('ended');
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
    if (!this.localStream || !this.currentCall?.isVideo) return;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) return;

    const settings = videoTrack.getSettings();
    const currentFacing = settings.facingMode ?? 'user';
    const nextFacing = currentFacing === 'user' ? 'environment' : 'user';

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { exact: nextFacing } },
      });
      const newVideoTrack = newStream.getVideoTracks()[0];

      if (this.pc) {
        const sender = this.pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(newVideoTrack);
      }

      videoTrack.stop();
      this.localStream.removeTrack(videoTrack);
      this.localStream.addTrack(newVideoTrack);

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
        // We're the caller — callee accepted. Build PC, add tracks, send offer.
        if (this.state !== 'ringing_out' || !this.currentCall) return;
        this.setState('connecting');
        try {
          const stream = await this.getUserMedia(this.currentCall.isVideo);
          this.localStream = stream;
          this.pc = this.createPeerConnection();

          // Caller adds tracks BEFORE createOffer — this is correct for the caller.
          // The caller is the one building the offer; its transceivers define the m-lines.
          this.addTracksToPC(stream, this.currentCall.isVideo);

          const offer = await this.pc.createOffer();
          await this.pc.setLocalDescription(offer);

          console.log('[CallService] caller offer SDP directions:',
            offer.sdp?.match(/a=(sendrecv|sendonly|recvonly|inactive)/g));

          this.send({
            type: 'call_offer',
            payload: { callId: this.currentCall.callId, toDevice: this.currentCall.remoteDeviceId, data: offer },
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
        // We're the callee — received SDP offer from caller
        const offerDesc = payload.data as RTCSessionDescriptionInit;
        if (!this.currentCall) return;

        if (!this.pc) {
          // acceptCall hasn't finished yet — buffer the offer
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
          console.warn('[CallService] call_answer: no PC yet, answer dropped');
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

  /**
   * Callee-side offer processing.
   *
   * Order matters critically:
   * 1. setRemoteDescription(offer) — browser creates transceivers for each m-line
   * 2. addTrack() for each local track — browser matches each track to an existing
   *    m-line transceiver (because the m-lines already exist). This sets the sender.
   * 3. Force all transceivers to sendrecv (in case any ended up recvonly after
   *    matching — can happen when the offer m-line was sendonly)
   * 4. createAnswer() — now the answer will include our local tracks as send
   * 5. setLocalDescription(answer)
   * 6. send call_answer
   */
  private async applyRemoteOffer(offerDesc: RTCSessionDescriptionInit) {
    if (!this.pc || !this.localStream) return;

    // Step 1: establish the remote description first
    await this.pc.setRemoteDescription(offerDesc);
    this.remoteDescSet = true;
    this.drainCandidates();

    // Step 2: add our local tracks NOW — after setRemoteDescription.
    // The browser matches each addTrack() call to an existing m-line transceiver
    // rather than creating a new one. This ensures our audio/video is sent back.
    const isVideo = this.currentCall?.isVideo ?? false;
    this.addTracksToPC(this.localStream, isVideo);

    // Step 3: ensure every transceiver is sendrecv so our answer advertises sending
    this.pc.getTransceivers().forEach(tr => {
      if (tr.direction === 'recvonly' || tr.direction === 'inactive') {
        tr.direction = 'sendrecv';
        console.log(`[CallService] callee: forced transceiver ${tr.mid} to sendrecv`);
      }
    });

    // Step 4+5: create and apply the answer
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    console.log('[CallService] callee answer SDP directions:',
      answer.sdp?.match(/a=(sendrecv|sendonly|recvonly|inactive)/g));

    // Step 6: send to caller
    this.send({
      type: 'call_answer',
      payload: { callId: this.currentCall!.callId, toDevice: this.currentCall!.remoteDeviceId, data: answer },
    });
  }

  /**
   * Add local media tracks to the peer connection.
   * Only call this at the right time:
   *   - CALLER: before createOffer()
   *   - CALLEE: after setRemoteDescription()
   */
  private addTracksToPC(stream: MediaStream, isVideo: boolean) {
    if (!this.pc) return;
    stream.getTracks().forEach(track => {
      if (track.kind === 'video' && !isVideo) return;
      // Guard against double-adding (e.g. on reconnect)
      const alreadyAdded = this.pc!.getSenders().some(s => s.track?.id === track.id);
      if (alreadyAdded) return;
      this.pc!.addTrack(track, stream);
      console.log(`[CallService] addTrack: kind=${track.kind} enabled=${track.enabled} readyState=${track.readyState}`);
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
      const track = e.track;

      // Guard: don't add the same track twice (ontrack can fire multiple times)
      if (!this.remoteStream!.getTracks().find(t => t.id === track.id)) {
        this.remoteStream!.addTrack(track);
      }

      // Also harvest from e.streams[0] for browsers that bundle tracks into a stream
      e.streams[0]?.getTracks().forEach(t => {
        if (!this.remoteStream!.getTracks().find(x => x.id === t.id)) {
          this.remoteStream!.addTrack(t);
        }
      });

      console.log(`[CallService] ontrack: kind=${track.kind} id=${track.id} remote tracks now: ${this.remoteStream!.getTracks().map(t=>t.kind).join(',')}`);

      // Always notify so CallModal re-attaches the updated stream to the elements
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
      console.warn('[CallService] getUserMedia with constraints failed, retrying basic:', err);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
      } catch (err2) {
        console.error('[CallService] getUserMedia basic also failed:', err2);
        throw err2;
      }
    }

    // Ensure audio tracks are enabled (some browsers return disabled tracks on constraint failure)
    stream.getAudioTracks().forEach(t => {
      t.enabled = true;
      console.log(`[CallService] audio track: id=${t.id} enabled=${t.enabled} muted=${t.muted} readyState=${t.readyState}`);
    });

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
    this.pendingCandidates = [];
    this.remoteDescSet = false;
    // NOTE: do NOT null out onTrackCallback / onLocalTrackCallback here.
    // CallModal registers them once on mount; clearing them would break the next call.
    const prevCall = this.currentCall;
    this.currentCall = null;
    this.setState('ended');
    const delay = (reason === 'rejected' || reason === 'busy') ? 2000 : 1500;
    setTimeout(() => { if (this.state === 'ended') this.setState('idle'); }, delay);
    console.log('[CallService] cleaned up. reason:', reason, 'callId:', prevCall?.callId);
  }
}
