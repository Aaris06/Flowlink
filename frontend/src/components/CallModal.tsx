import { useEffect, useRef, useState, useCallback } from 'react';
import { CallService, CallState, CallInfo } from '../services/CallService';
import { startRingtone, stopRingtone } from '../services/RingtoneService';
import './CallModal.css';

interface CallModalProps {
  callService: CallService;
  state: CallState;
  callInfo: CallInfo | null;
}

/**
 * Attach a MediaStream to a media element and start playback.
 * Safe to call multiple times — only reassigns srcObject if the stream changed.
 */
function attachAndPlay(el: HTMLMediaElement | null, stream: MediaStream | null) {
  if (!el || !stream) return;
  if (el.srcObject !== stream) {
    el.srcObject = stream;
  }
  el.volume = 1;
  el.muted = false;
  el.play().catch((err) => {
    if (err?.name !== 'NotAllowedError') console.warn('[CallModal] play error:', err);
  });
}

/**
 * On iOS, audio playback requires a user gesture before it can start.
 * Register one-shot listeners so that the next user interaction resumes
 * any paused audio elements.
 */
function ensureAudioUnlocked(el: HTMLAudioElement | null) {
  if (!el) return;
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

  // ── Ringtone ────────────────────────────────────────────────────────────
  useEffect(() => {
    const username = (window as any).__flowlink_username ?? 'default';
    if (state === 'ringing_in') {
      startRingtone(username);
    } else {
      stopRingtone();
    }
    return () => stopRingtone();
  }, [state]);

  // ── Refs ────────────────────────────────────────────────────────────────
  const bubbleRef      = useRef<HTMLDivElement | null>(null);
  const dragState      = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });
  const localVideoRef  = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  // The remote audio element is ALWAYS mounted (even during connecting/ringing)
  // so it is never torn down and recreated at the moment a track arrives.
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // ── Helpers ─────────────────────────────────────────────────────────────
  const attachRemoteMedia = useCallback((stream: MediaStream | null) => {
    if (!stream) return;
    // Audio: always attach to keep audio running regardless of video visibility
    attachAndPlay(remoteAudioRef.current, stream);
    ensureAudioUnlocked(remoteAudioRef.current);
    // Video: only attach when the video element is mounted
    if (remoteVideoRef.current) {
      attachAndPlay(remoteVideoRef.current, stream);
    }
  }, []);

  // ── Register callbacks with CallService once ────────────────────────────
  useEffect(() => {
    // Called whenever a remote track arrives (can fire multiple times for audio + video)
    callService.setOnRemoteTrack((stream) => {
      attachRemoteMedia(stream);
    });
    callService.setOnLocalTrack((stream) => {
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
      }
    });
    return () => {
      callService.setOnRemoteTrack(() => {});
      callService.setOnLocalTrack(() => {});
    };
  }, [callService, attachRemoteMedia]);

  // ── Re-attach streams when state becomes connecting/active ──────────────
  // This covers the case where the DOM elements mounted *after* the track arrived.
  useEffect(() => {
    if (state === 'active' || state === 'connecting') {
      const local = callService.getLocalStream();
      if (localVideoRef.current && local) {
        localVideoRef.current.srcObject = local;
        localVideoRef.current.muted = true;
      }
      attachRemoteMedia(callService.getRemoteStream());
    }
  }, [state, callService, attachRemoteMedia]);

  // ── Attach ref callbacks for elements that mount/unmount ────────────────
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

  // The audio element is always-mounted; this ref callback fires once on mount.
  const attachRemoteAudio = useCallback((el: HTMLAudioElement | null) => {
    remoteAudioRef.current = el;
    if (el) {
      const stream = callService.getRemoteStream();
      if (stream) {
        attachAndPlay(el, stream);
        ensureAudioUnlocked(el);
      }
    }
  }, [callService]);

  // ── Periodic retry for audio (iOS autoplay policy) ──────────────────────
  // Polls for 5 seconds after connecting to ensure audio starts playing.
  useEffect(() => {
    if (state !== 'active' && state !== 'connecting') return;
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const el = remoteAudioRef.current;
      const stream = callService.getRemoteStream();
      if (el && stream) {
        if (el.srcObject !== stream) {
          el.srcObject = stream;
          el.muted = false;
        }
        if (el.paused) {
          el.play().catch(() => {});
        }
      }
      if (attempts >= 50) clearInterval(poll); // 5 seconds @ 100ms
    }, 100);
    return () => clearInterval(poll);
  }, [state, callService]);

  // ── Reset state on new call ─────────────────────────────────────────────
  useEffect(() => {
    if (state === 'ringing_in' || state === 'ringing_out') {
      setMuted(false);
      setCameraOff(false);
      setMinimized(false);
    }
  }, [state]);

  useEffect(() => {
    if (state === 'idle' || state === 'ended') setMinimized(false);
  }, [state]);

  // ── Duration timer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (state !== 'active') { setDuration(0); return; }
    const t = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  // ── Bubble drag ─────────────────────────────────────────────────────────
  const onBubbleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.call-bubble-end')) return;
    const el = bubbleRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragState.current = { dragging: true, startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top };
    e.preventDefault();
  };

  useEffect(() => {
    const BUBBLE_SIZE = 100;
    const onMove = (e: MouseEvent) => {
      const ds = dragState.current;
      if (!ds.dragging || !bubbleRef.current) return;
      const rawX = ds.origX + (e.clientX - ds.startX);
      const rawY = ds.origY + (e.clientY - ds.startY);
      const clampedX = Math.min(Math.max(rawX, 10), window.innerWidth  - BUBBLE_SIZE - 10);
      const clampedY = Math.min(Math.max(rawY, 10), window.innerHeight - BUBBLE_SIZE - 10);
      bubbleRef.current.style.left   = `${clampedX}px`;
      bubbleRef.current.style.top    = `${clampedY}px`;
      bubbleRef.current.style.right  = 'auto';
      bubbleRef.current.style.bottom = 'auto';
    };
    const onUp = () => { dragState.current.dragging = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  if (state === 'idle' || !callInfo) return null;

  const isVideo = callInfo.isVideo;
  const showRemoteVideo  = isVideo && (state === 'connecting' || state === 'active');
  const showLocalPreview = isVideo && (state === 'ringing_out' || state === 'connecting' || state === 'active');
  const showMinimizeBtn  = state === 'active' || state === 'connecting' || state === 'ringing_out';

  // ── Minimized bubble ────────────────────────────────────────────────────
  if (minimized) {
    return (
      <div
        ref={bubbleRef}
        className="call-bubble"
        onMouseDown={onBubbleMouseDown}
        onClick={() => setMinimized(false)}
        title="Click to restore call"
      >
        {/*
          The audio element must always be present — even in the bubble —
          so audio never stops when minimizing/restoring.
        */}
        <audio ref={attachRemoteAudio} autoPlay playsInline style={{ display: 'none' }} />

        <div className="call-bubble-circle">
          {showRemoteVideo && (
            <video ref={attachRemoteVideo} className="call-bubble-video" autoPlay playsInline />
          )}
          {!showRemoteVideo && (
            <div className="call-bubble-avatar">{callInfo.remoteUsername[0]?.toUpperCase()}</div>
          )}
          <div className="call-bubble-info">
            <span className="call-bubble-name">{callInfo.remoteUsername}</span>
            <span className="call-bubble-timer">{state === 'active' ? fmt(duration) : 'Calling…'}</span>
          </div>
        </div>

        <button
          className="call-bubble-end"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); callService.endCall(); }}
          title="End call"
        >✕</button>
      </div>
    );
  }

  // ── Full call modal ──────────────────────────────────────────────────────
  return (
    <div className={`call-modal-overlay${state === 'active' && isVideo ? ' call-modal-video-mode' : ''}`}>
      <div className="call-modal">

        {showMinimizeBtn && (
          <button className="call-btn-minimize" onClick={() => setMinimized(true)} title="Minimize call">
            <span>⬇</span>
          </button>
        )}

        {/*
          The audio element is ALWAYS rendered (never conditional) so it is
          never unmounted/remounted when state changes from connecting→active.
          If it were conditional it could be torn down at the exact moment a
          track fires, causing the audio to go silent.
        */}
        <audio ref={attachRemoteAudio} autoPlay playsInline style={{ display: 'none' }} />

        {showRemoteVideo && (
          <video ref={attachRemoteVideo} className="call-video-remote" autoPlay playsInline />
        )}

        {showLocalPreview && (
          <video ref={attachLocal} className="call-video-local" autoPlay playsInline muted />
        )}

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
