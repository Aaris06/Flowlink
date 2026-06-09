import { useEffect, useRef, useState, useCallback } from 'react';
import { CallService, CallState, CallInfo } from '../services/CallService';
import './CallModal.css';

interface CallModalProps {
  callService: CallService;
  state: CallState;
  callInfo: CallInfo | null;
}

export default function CallModal({ callService, state, callInfo }: CallModalProps) {
  const [muted, setMuted]           = useState(false);
  const [cameraOff, setCameraOff]   = useState(false);
  const [duration, setDuration]     = useState(0);
  const [minimized, setMinimized]   = useState(false);
  const [swapped, setSwapped]       = useState(false); // swap local/remote display

  const localVideoRef  = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  // Attach stream to a video element immediately when it mounts
  const attachLocal = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el) {
      const stream = callService.getLocalStream();
      if (stream) { el.srcObject = stream; el.play().catch(() => {}); }
    }
  }, [callService]);

  const attachRemote = useCallback((el: HTMLVideoElement | null) => {
    remoteVideoRef.current = el;
    if (el) {
      const stream = callService.getRemoteStream();
      if (stream) { el.srcObject = stream; el.play().catch(() => {}); }
    }
  }, [callService]);

  // Remote track callback — fires whenever a new remote stream arrives
  useEffect(() => {
    callService.setOnRemoteTrack((stream) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        remoteVideoRef.current.play().catch(() => {});
      }
    });
    callService.setOnLocalTrack((stream) => {
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    });
    return () => {
      callService.setOnRemoteTrack(() => {});
      callService.setOnLocalTrack(() => {});
    };
  }, [callService]);

  // Fallback: when state changes to active, ensure streams are attached
  useEffect(() => {
    if (state === 'active' || state === 'connecting') {
      const local = callService.getLocalStream();
      if (localVideoRef.current && local) {
        if (localVideoRef.current.srcObject !== local) {
          localVideoRef.current.srcObject = local;
        }
      }
      const remote = callService.getRemoteStream();
      if (remoteVideoRef.current && remote) {
        if (remoteVideoRef.current.srcObject !== remote) {
          remoteVideoRef.current.srcObject = remote;
          remoteVideoRef.current.play().catch(() => {});
        }
      }
    }
  }, [state, callService]);

  // Reset UI state on new call
  useEffect(() => {
    if (state === 'ringing_in' || state === 'ringing_out') {
      setMuted(false); setCameraOff(false); setSwapped(false); setMinimized(false);
    }
  }, [state]);

  // Duration timer
  useEffect(() => {
    if (state !== 'active') { setDuration(0); return; }
    const t = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  if (state === 'idle' || !callInfo) return null;

  const isVideo = callInfo.isVideo;
  const isActive = state === 'active';
  const showVideoUI = isVideo && (state === 'connecting' || state === 'active');
  const showLocalPreview = isVideo && state !== 'idle' && state !== 'ended';

  // ── Minimized pill ──────────────────────────────────────────────────
  if (minimized) {
    return (
      <div className="call-minimized" onClick={() => setMinimized(false)}>
        <span className="call-minimized-dot" />
        <span className="call-minimized-name">{callInfo.remoteUsername}</span>
        <span className="call-minimized-time">{isActive ? fmt(duration) : state === 'ringing_in' ? 'Incoming' : 'Calling…'}</span>
        <button className="call-minimized-end" onClick={e => { e.stopPropagation(); callService.endCall(); }} title="End call">📵</button>
      </div>
    );
  }

  return (
    <div className={`call-modal-overlay${isActive && isVideo ? ' call-modal-video-mode' : ''}`}>
      <div className="call-modal">

        {/* Remote video — full background. Click to swap */}
        {showVideoUI && (
          <video
            ref={swapped ? attachLocal : attachRemote}
            className="call-video-remote"
            autoPlay playsInline
            onClick={() => setSwapped(s => !s)}
            title="Tap to swap"
          />
        )}

        {/* Local PiP. Click to swap */}
        {showLocalPreview && (
          <video
            ref={swapped ? attachRemote : attachLocal}
            className={`call-video-local${swapped ? ' swapped' : ''}`}
            autoPlay playsInline muted
            onClick={() => setSwapped(s => !s)}
            title="Tap to swap"
          />
        )}

        {/* Info overlay */}
        <div className="call-modal-info">
          {!(isActive && isVideo) && (
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

        {/* Minimize button (shown in active/connecting/ringing_out) */}
        {(state === 'active' || state === 'connecting' || state === 'ringing_out') && (
          <button className="call-btn-minimize" onClick={() => setMinimized(true)} title="Minimize">⬇</button>
        )}

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
