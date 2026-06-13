import { useEffect, useRef, useState, useCallback } from 'react';
import { CallService, CallState, CallInfo, RemoteParticipant } from '../services/CallService';
import { startRingtone, stopRingtone } from '../services/RingtoneService';
import './CallModal.css';

interface CallModalProps {
  callService: CallService;
  state: CallState;
  callInfo: CallInfo | null;
}

function attachAndPlay(el: HTMLMediaElement | null, stream: MediaStream | null) {
  if (!el || !stream) return;
  if (el.srcObject !== stream) el.srcObject = stream;
  el.volume = 1;
  el.muted = false;
  el.play().catch((err) => {
    if (err?.name !== 'NotAllowedError') console.warn('[CallModal] play error:', err);
  });
}

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

/** Renders one remote video tile — manages its own video + audio elements */
function RemoteTile({ participant }: { participant: RemoteParticipant }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (videoRef.current) attachAndPlay(videoRef.current, participant.stream);
    if (audioRef.current) {
      attachAndPlay(audioRef.current, participant.stream);
      ensureAudioUnlocked(audioRef.current);
    }
  }, [participant.stream]);

  return (
    <div className="call-grid-tile">
      <video ref={videoRef} className="call-grid-video" autoPlay playsInline />
      <audio ref={audioRef} autoPlay playsInline style={{ display: 'none' }} />
      <div className="call-grid-label">{participant.username}</div>
    </div>
  );
}

export default function CallModal({ callService, state, callInfo }: CallModalProps) {
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [minimized, setMinimized] = useState(false);
  const [participants, setParticipants] = useState<RemoteParticipant[]>([]);

  // ── Ringtone ────────────────────────────────────────────────────────────
  useEffect(() => {
    const username = (window as any).__flowlink_username ?? 'default';
    if (state === 'ringing_in') startRingtone(username);
    else stopRingtone();
    return () => stopRingtone();
  }, [state]);

  // ── Refs ────────────────────────────────────────────────────────────────
  const bubbleRef     = useRef<HTMLDivElement | null>(null);
  const dragState     = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  // Fallback single-peer audio+video refs (used when there is exactly 1 remote participant)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // ── Register service callbacks ──────────────────────────────────────────
  useEffect(() => {
    callService.setOnRemoteTrack((stream) => {
      if (remoteVideoRef.current) attachAndPlay(remoteVideoRef.current, stream);
      if (remoteAudioRef.current) { attachAndPlay(remoteAudioRef.current, stream); ensureAudioUnlocked(remoteAudioRef.current); }
    });
    callService.setOnLocalTrack((stream) => {
      if (localVideoRef.current) { localVideoRef.current.srcObject = stream; localVideoRef.current.muted = true; }
    });
    callService.setOnParticipantsChanged((ps) => {
      setParticipants([...ps]);
      // Update audio/video refs for legacy single-peer path
      if (ps.length === 1) {
        if (remoteVideoRef.current) attachAndPlay(remoteVideoRef.current, ps[0].stream);
        if (remoteAudioRef.current) { attachAndPlay(remoteAudioRef.current, ps[0].stream); ensureAudioUnlocked(remoteAudioRef.current); }
      }
    });
    return () => {
      callService.setOnRemoteTrack(() => {});
      callService.setOnLocalTrack(() => {});
      callService.setOnParticipantsChanged(() => {});
    };
  }, [callService]);

  // ── Re-attach when state transitions ───────────────────────────────────
  useEffect(() => {
    if (state === 'active' || state === 'connecting') {
      const local = callService.getLocalStream();
      if (localVideoRef.current && local) { localVideoRef.current.srcObject = local; localVideoRef.current.muted = true; }
      const remote = callService.getRemoteStream();
      if (remote) {
        if (remoteVideoRef.current) attachAndPlay(remoteVideoRef.current, remote);
        if (remoteAudioRef.current) { attachAndPlay(remoteAudioRef.current, remote); ensureAudioUnlocked(remoteAudioRef.current); }
      }
      // Sync participants
      setParticipants([...callService.getParticipants()]);
    }
  }, [state, callService]);

  // ── Ref callbacks ───────────────────────────────────────────────────────
  const attachLocal = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el) { const s = callService.getLocalStream(); if (s) { el.srcObject = s; el.muted = true; } }
  }, [callService]);

  const attachRemoteVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
    if (el) { const s = callService.getRemoteStream(); if (s) attachAndPlay(el, s); }
  }, [callService]);

  const attachRemoteAudio = useCallback((el: HTMLAudioElement | null) => {
    remoteAudioRef.current = el;
    if (el) { const s = callService.getRemoteStream(); if (s) { attachAndPlay(el, s); ensureAudioUnlocked(el); } }
  }, [callService]);

  // ── Audio retry poll ────────────────────────────────────────────────────
  useEffect(() => {
    if (state !== 'active' && state !== 'connecting') return;
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const el = remoteAudioRef.current;
      const stream = callService.getRemoteStream();
      if (el && stream) {
        if (el.srcObject !== stream) { el.srcObject = stream; el.muted = false; }
        if (el.paused) el.play().catch(() => {});
      }
      if (attempts >= 50) clearInterval(poll);
    }, 100);
    return () => clearInterval(poll);
  }, [state, callService]);

  // ── Reset on new call ───────────────────────────────────────────────────
  useEffect(() => {
    if (state === 'ringing_in' || state === 'ringing_out') { setMuted(false); setCameraOff(false); setMinimized(false); setParticipants([]); }
  }, [state]);

  useEffect(() => {
    if (state === 'idle' || state === 'ended') setMinimized(false);
  }, [state]);

  // ── Duration ────────────────────────────────────────────────────────────
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
      const clampedX = Math.min(Math.max(rawX, 10), window.innerWidth - BUBBLE_SIZE - 10);
      const clampedY = Math.min(Math.max(rawY, 10), window.innerHeight - BUBBLE_SIZE - 10);
      bubbleRef.current.style.left = `${clampedX}px`;
      bubbleRef.current.style.top = `${clampedY}px`;
      bubbleRef.current.style.right = 'auto';
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
  const isGroup = participants.length > 1;
  const showLocalPreview = isVideo && (state === 'ringing_out' || state === 'connecting' || state === 'active');
  const showRemoteVideo = isVideo && (state === 'connecting' || state === 'active');
  const showMinimizeBtn = state === 'active' || state === 'connecting' || state === 'ringing_out';

  const controls = (
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
          <button className={`call-btn call-btn-mute${muted ? ' active' : ''}`} onClick={() => setMuted(callService.toggleMute())} title={muted ? 'Unmute' : 'Mute'}>
            <span className="call-icon">{muted ? '🔇' : '🎙️'}</span>
          </button>
          {isVideo && (
            <button className={`call-btn call-btn-camera${cameraOff ? ' active' : ''}`} onClick={() => setCameraOff(callService.toggleCamera())} title={cameraOff ? 'Camera on' : 'Camera off'}>
              <span className="call-icon">{cameraOff ? '📷' : '🎥'}</span>
            </button>
          )}
          {isVideo && (
            <button className="call-btn call-btn-switch" onClick={() => callService.switchCamera()} title="Switch camera">
              <span className="call-icon">🔄</span>
            </button>
          )}
          <button className="call-btn call-btn-end" onClick={() => callService.endCall()} title="Leave call">
            <span className="call-icon">📵</span>
          </button>
        </>
      )}
    </div>
  );

  // ── Minimized bubble ────────────────────────────────────────────────────
  if (minimized) {
    const firstParticipant = participants[0];
    return (
      <div ref={bubbleRef} className="call-bubble" onMouseDown={onBubbleMouseDown} onClick={() => setMinimized(false)} title="Click to restore call">
        <audio ref={attachRemoteAudio} autoPlay playsInline style={{ display: 'none' }} />
        <div className="call-bubble-circle">
          {showRemoteVideo && firstParticipant
            ? <video ref={attachRemoteVideo} className="call-bubble-video" autoPlay playsInline />
            : <div className="call-bubble-avatar">{callInfo.remoteUsername[0]?.toUpperCase()}</div>
          }
          <div className="call-bubble-info">
            <span className="call-bubble-name">{callInfo.remoteUsername}</span>
            <span className="call-bubble-timer">{state === 'active' ? fmt(duration) : 'Calling…'}</span>
          </div>
        </div>
        <button className="call-bubble-end" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); callService.endCall(); }} title="End call">✕</button>
      </div>
    );
  }

  // ── Group call grid layout ───────────────────────────────────────────────
  if (isGroup && isVideo && (state === 'active' || state === 'connecting')) {
    const gridClass = participants.length <= 2 ? 'call-grid-2'
      : participants.length <= 4 ? 'call-grid-4'
      : 'call-grid-6';

    return (
      <div className="call-modal-overlay call-modal-group-mode">
        <div className="call-modal call-modal-group">
          {showMinimizeBtn && (
            <button className="call-btn-minimize" onClick={() => setMinimized(true)} title="Minimize"><span>⬇</span></button>
          )}

          <div className={`call-grid ${gridClass}`}>
            {/* Local self tile */}
            <div className="call-grid-tile call-grid-tile-self">
              <video ref={attachLocal} className="call-grid-video" autoPlay playsInline muted />
              <div className="call-grid-label">You ({callService.username})</div>
            </div>
            {/* Remote participant tiles */}
            {participants.map(p => (
              <RemoteTile key={p.deviceId} participant={p} />
            ))}
          </div>

          <div className="call-status call-group-status">
            <span>{participants.length + 1} participants · {fmt(duration)}</span>
          </div>

          {controls}
        </div>
      </div>
    );
  }

  // ── Standard 1-to-1 modal ────────────────────────────────────────────────
  return (
    <div className={`call-modal-overlay${state === 'active' && isVideo ? ' call-modal-video-mode' : ''}`}>
      <div className="call-modal">
        {showMinimizeBtn && (
          <button className="call-btn-minimize" onClick={() => setMinimized(true)} title="Minimize call"><span>⬇</span></button>
        )}

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

        {controls}
      </div>
    </div>
  );
}
