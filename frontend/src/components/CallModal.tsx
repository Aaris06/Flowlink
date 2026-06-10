import { useEffect, useRef, useState, useCallback } from 'react';
import { CallService, CallState, CallInfo } from '../services/CallService';
import './CallModal.css';

interface CallModalProps {
  callService: CallService;
  state: CallState;
  callInfo: CallInfo | null;
}

function attachAndPlay(el: HTMLMediaElement, stream: MediaStream) {
  if (!el) return;
  if (el.srcObject !== stream) el.srcObject = stream;
  el.volume = 1;
  el.muted = false;
  el.play().catch((err) => {
    if (err?.name !== 'NotAllowedError') console.warn('[CallModal] audio play error:', err);
  });
}

function ensureAudioUnlocked(el: HTMLAudioElement) {
  const unlock = () => {
    if (el.paused && el.srcObject) el.play().catch(() => {});
    document.removeEventListener('click', unlock, true);
    document.removeEventListener('keydown', unlock, true);
    document.removeEventListener('touchstart', unlock, true);
  };
  document.addEventListener('click', unlock, { capture: true, once: true });
  document.addEventListener('keydown', unlock, { capture: true, once: true });
  document.addEventListener('touchstart', unlock, { capture: true, once: true });
}

export default function CallModal({ callService, state, callInfo }: CallModalProps) {
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [minimized, setMinimized] = useState(false);

  // Bubble drag state
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const dragState  = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  const localVideoRef  = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  const attachLocal = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el) {
      const stream = callService.getLocalStream();
      if (stream) { el.srcObject = stream; el.muted = true; }
    }
  }, [callService]);

  const attachRemoteVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
    if (el) {
      const stream = callService.getRemoteStream();
      if (stream) attachAndPlay(el, stream);
    }
  }, [callService]);

  const attachRemoteAudio = useCallback((el: HTMLAudioElement | null) => {
    remoteAudioRef.current = el;
    if (el) {
      const stream = callService.getRemoteStream();
      if (stream) { attachAndPlay(el, stream); ensureAudioUnlocked(el); }
    }
  }, [callService]);

  useEffect(() => {
    callService.setOnRemoteTrack((stream) => {
      if (remoteVideoRef.current) attachAndPlay(remoteVideoRef.current, stream);
      if (remoteAudioRef.current) { attachAndPlay(remoteAudioRef.current, stream); ensureAudioUnlocked(remoteAudioRef.current); }
    });
    callService.setOnLocalTrack((stream) => {
      if (localVideoRef.current) { localVideoRef.current.srcObject = stream; localVideoRef.current.muted = true; }
    });
    return () => { callService.setOnRemoteTrack(() => {}); callService.setOnLocalTrack(() => {}); };
  }, [callService]);

  useEffect(() => {
    if (state === 'active' || state === 'connecting') {
      const local = callService.getLocalStream();
      if (localVideoRef.current && local) { localVideoRef.current.srcObject = local; localVideoRef.current.muted = true; }
      const remote = callService.getRemoteStream();
      if (remote) {
        if (remoteVideoRef.current) attachAndPlay(remoteVideoRef.current, remote);
        if (remoteAudioRef.current) { attachAndPlay(remoteAudioRef.current, remote); ensureAudioUnlocked(remoteAudioRef.current); }
      }
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        const rem = callService.getRemoteStream();
        if (rem && remoteAudioRef.current && remoteAudioRef.current.srcObject !== rem) {
          attachAndPlay(remoteAudioRef.current, rem); ensureAudioUnlocked(remoteAudioRef.current);
        }
        if (attempts >= 30) clearInterval(poll);
      }, 100);
      return () => clearInterval(poll);
    }
  }, [state, callService]);

  useEffect(() => {
    if (state === 'ringing_in' || state === 'ringing_out') { setMuted(false); setCameraOff(false); setMinimized(false); }
  }, [state]);

  // Un-minimize automatically when call ends
  useEffect(() => {
    if (state === 'idle' || state === 'ended') setMinimized(false);
  }, [state]);

  useEffect(() => {
    if (state !== 'active') { setDuration(0); return; }
    const t = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  // ── Bubble drag ────────────────────────────────────────────────────────
  const onBubbleMouseDown = (e: React.MouseEvent) => {
    const el = bubbleRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragState.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top };
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const ds = dragState.current;
      if (!ds.dragging || !bubbleRef.current) return;
      const dx = e.clientX - ds.startX;
      const dy = e.clientY - ds.startY;
      bubbleRef.current.style.left = `${ds.origX + dx}px`;
      bubbleRef.current.style.top  = `${ds.origY + dy}px`;
      bubbleRef.current.style.right  = 'auto';
      bubbleRef.current.style.bottom = 'auto';
    };
    const onUp = () => { dragState.current.dragging = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  if (state === 'idle' || !callInfo) return null;

  const isVideo = callInfo.isVideo;
  const showRemoteVideo  = isVideo && (state === 'connecting' || state === 'active');
  const showLocalPreview = isVideo && (state === 'ringing_out' || state === 'connecting' || state === 'active');
  const showMinimizeBtn  = state === 'active' || state === 'connecting' || state === 'ringing_out';

  // ── Minimized bubble ───────────────────────────────────────────────────
  if (minimized) {
    return (
      <div
        ref={bubbleRef}
        className="call-bubble"
        onMouseDown={onBubbleMouseDown}
        onClick={() => setMinimized(false)}
        title="Click to restore call"
      >
        {/* Always-present audio even when minimized */}
        <audio ref={attachRemoteAudio} autoPlay playsInline style={{ display: 'none' }} />

        {/* Video preview inside bubble for video calls */}
        {showRemoteVideo && (
          <video ref={attachRemoteVideo} className="call-bubble-video" autoPlay playsInline />
        )}

        {/* Avatar shown for audio calls */}
        {!showRemoteVideo && (
          <div className="call-bubble-avatar">{callInfo.remoteUsername[0]?.toUpperCase()}</div>
        )}

        {/* Status row */}
        <div className="call-bubble-info">
          <span className="call-bubble-name">{callInfo.remoteUsername}</span>
          <span className="call-bubble-timer">{state === 'active' ? fmt(duration) : 'Calling…'}</span>
        </div>

        {/* End call button — positioned top-right of bubble */}
        <button
          className="call-bubble-end"
          onClick={(e) => { e.stopPropagation(); callService.endCall(); }}
          title="End call"
        >✕</button>
      </div>
    );
  }

  // ── Full call modal ────────────────────────────────────────────────────
  return (
    <div className={`call-modal-overlay${state === 'active' && isVideo ? ' call-modal-video-mode' : ''}`}>
      <div className="call-modal">

        {/* Minimize button */}
        {showMinimizeBtn && (
          <button
            className="call-btn-minimize"
            onClick={() => setMinimized(true)}
            title="Minimize call"
          >
            <span>⬇</span>
          </button>
        )}

        {/* Always-present hidden audio element */}
        <audio ref={attachRemoteAudio} autoPlay playsInline style={{ display: 'none' }} />

        {/* Remote video */}
        {showRemoteVideo && (
          <video ref={attachRemoteVideo} className="call-video-remote" autoPlay playsInline />
        )}

        {/* Local preview PiP */}
        {showLocalPreview && (
          <video ref={attachLocal} className="call-video-local" autoPlay playsInline muted />
        )}

        {/* Info overlay */}
        <div className="call-modal-info">
          {!(state === 'active' && isVideo) && (
            <div className="call-avatar">{callInfo.remoteUsername[0]?.toUpperCase()}</div>
          )}
          <div className="call-username">{callInfo.remoteUsername}</div>
          <div className="call-status">
            {state === 'ringing_out' && <><span className="call-status-dot ringing" />Calling…</>}
            {state === 'ringing_in'  && <><span className="call-status-dot ringing" />Incoming {isVideo ? 'video' : 'audio'} call</>}
            {state === 'connecting'  && 'Connecting…'}
            {state === 'active'      && fmt(duration)}
            {state === 'ended'       && 'Call ended'}
          </div>
        </div>

        {/* Controls */}
        <div className="call-controls">
          {state === 'ringing_in' && (
            <>
              <button className="call-btn call-btn-accept" onClick={() => callService.acceptCall()} title="Accept">
                <span className="call-icon">📞</span>
              </button>
              <button className="call-btn call-btn-end" onClick={() => callService.rejectCall()} title="Decline">
                <span className="call-icon">📵</span>
              </button>
            </>
          )}
          {state === 'ringing_out' && (
            <button className="call-btn call-btn-end" onClick={() => callService.endCall()} title="Cancel">
              <span className="call-icon">📵</span>
            </button>
          )}
          {(state === 'active' || state === 'connecting') && (
            <>
              <button
                className={`call-btn call-btn-mute${muted ? ' active' : ''}`}
                onClick={() => setMuted(callService.toggleMute())}
                title={muted ? 'Unmute' : 'Mute'}
              >
                <span className="call-icon">{muted ? '🔇' : '🎙️'}</span>
              </button>
              {isVideo && (
                <button
                  className={`call-btn call-btn-camera${cameraOff ? ' active' : ''}`}
                  onClick={() => setCameraOff(callService.toggleCamera())}
                  title={cameraOff ? 'Camera on' : 'Camera off'}
                >
                  <span className="call-icon">{cameraOff ? '📷' : '🎥'}</span>
                </button>
              )}
              {isVideo && (
                <button className="call-btn call-btn-switch" onClick={() => callService.switchCamera()} title="Switch camera">
                  <span className="call-icon">🔄</span>
                </button>
              )}
              <button className="call-btn call-btn-end" onClick={() => callService.endCall()} title="End call">
                <span className="call-icon">📵</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
