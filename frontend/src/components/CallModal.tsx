import { useEffect, useRef, useState, useCallback } from 'react';
import { CallService, CallState, CallInfo } from '../services/CallService';
import './CallModal.css';

interface CallModalProps {
  callService: CallService;
  state: CallState;
  callInfo: CallInfo | null;
}

/**
 * Robustly attach a MediaStream to an HTMLMediaElement and play it.
 * Handles the browser autoplay policy by retrying on user-gesture events.
 */
function attachAndPlay(el: HTMLMediaElement, stream: MediaStream) {
  if (!el) return;
  if (el.srcObject !== stream) {
    el.srcObject = stream;
  }
  el.volume = 1;
  el.muted = false;
  const tryPlay = () => {
    el.play().catch((err) => {
      // NotAllowedError = autoplay blocked — will be unblocked on first user gesture
      if (err?.name !== 'NotAllowedError') {
        console.warn('[CallModal] audio play error:', err);
      }
    });
  };
  tryPlay();
}

/**
 * Install a one-shot user-gesture listener that retries audio playback.
 * Needed on web browsers where autoplay is blocked until the user interacts.
 */
function ensureAudioUnlocked(el: HTMLAudioElement) {
  const unlock = () => {
    if (el.paused && el.srcObject) {
      el.play().catch(() => {});
    }
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

  const localVideoRef  = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  // Dedicated audio element — guarantees remote audio plays even on audio-only calls
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);

  // Attach local stream to video element when it mounts
  const attachLocal = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el) {
      const stream = callService.getLocalStream();
      if (stream) { el.srcObject = stream; el.muted = true; }
    }
  }, [callService]);

  // Attach remote stream to the video element when it mounts
  const attachRemoteVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
    if (el) {
      const stream = callService.getRemoteStream();
      if (stream) attachAndPlay(el, stream);
    }
  }, [callService]);

  // Attach remote stream to the dedicated audio element when it mounts
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

  // Called when new remote tracks arrive mid-call
  useEffect(() => {
    callService.setOnRemoteTrack((stream) => {
      if (remoteVideoRef.current) attachAndPlay(remoteVideoRef.current, stream);
      if (remoteAudioRef.current) {
        attachAndPlay(remoteAudioRef.current, stream);
        ensureAudioUnlocked(remoteAudioRef.current);
      }
    });
    callService.setOnLocalTrack((stream) => {
      if (localVideoRef.current) { localVideoRef.current.srcObject = stream; localVideoRef.current.muted = true; }
    });
    return () => {
      callService.setOnRemoteTrack(() => {});
      callService.setOnLocalTrack(() => {});
    };
  }, [callService]);

  // Fallback: re-attach streams whenever state changes to active/connecting
  // Also start a short polling interval to catch the race where ontrack fires
  // before the audio ref is mounted (common on web browsers).
  useEffect(() => {
    if (state === 'active' || state === 'connecting') {
      const local = callService.getLocalStream();
      if (localVideoRef.current && local) { localVideoRef.current.srcObject = local; localVideoRef.current.muted = true; }

      const remote = callService.getRemoteStream();
      if (remote) {
        if (remoteVideoRef.current) attachAndPlay(remoteVideoRef.current, remote);
        if (remoteAudioRef.current) {
          attachAndPlay(remoteAudioRef.current, remote);
          ensureAudioUnlocked(remoteAudioRef.current);
        }
      }

      // Poll for up to 3 seconds to catch the ref-mount race
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        const rem = callService.getRemoteStream();
        if (rem && remoteAudioRef.current && remoteAudioRef.current.srcObject !== rem) {
          attachAndPlay(remoteAudioRef.current, rem);
          ensureAudioUnlocked(remoteAudioRef.current);
        }
        if (attempts >= 30) clearInterval(poll);
      }, 100);
      return () => clearInterval(poll);
    }
  }, [state, callService]);

  // Reset controls on new call
  useEffect(() => {
    if (state === 'ringing_in' || state === 'ringing_out') {
      setMuted(false);
      setCameraOff(false);
    }
  }, [state]);

  // Duration counter
  useEffect(() => {
    if (state !== 'active') { setDuration(0); return; }
    const t = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  if (state === 'idle' || !callInfo) return null;

  const isVideo = callInfo.isVideo;
  const showRemoteVideo  = isVideo && (state === 'connecting' || state === 'active');
  const showLocalPreview = isVideo && (state === 'ringing_out' || state === 'connecting' || state === 'active');

  return (
    <div className={`call-modal-overlay${state === 'active' && isVideo ? ' call-modal-video-mode' : ''}`}>
      <div className="call-modal">

        {/* ── Always-present hidden audio element for remote audio ──────── */}
        {/* Mounted as long as the modal is visible so audio plays even     */}
        {/* before the video element exists (audio-only calls)              */}
        <audio
          ref={attachRemoteAudio}
          autoPlay
          playsInline
          style={{ display: 'none' }}
        />

        {/* Remote video — full-screen background during active video calls */}
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
                <button
                  className="call-btn call-btn-switch"
                  onClick={() => callService.switchCamera()}
                  title="Switch camera"
                >
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
