import { useEffect, useRef, useState } from 'react';
import { CallService, CallState, CallInfo } from '../services/CallService';
import './CallModal.css';

interface CallModalProps {
  callService: CallService;
  state: CallState;
  callInfo: CallInfo | null;
}

export default function CallModal({ callService, state, callInfo }: CallModalProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);

  // Attach media streams to video elements when call goes active
  useEffect(() => {
    if (state !== 'active') return;
    const local = callService.getLocalStream();
    const remote = callService.getRemoteStream();
    if (localVideoRef.current && local) localVideoRef.current.srcObject = local;
    if (remoteVideoRef.current && remote) remoteVideoRef.current.srcObject = remote;
  }, [state, callService]);

  // Call duration timer
  useEffect(() => {
    if (state !== 'active') { setDuration(0); return; }
    const t = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const formatDuration = (s: number) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  if (state === 'idle' || !callInfo) return null;

  const isVideo = callInfo.isVideo;

  return (
    <div className={`call-modal-overlay${state === 'active' && isVideo ? ' call-modal-video-mode' : ''}`}>
      <div className="call-modal">
        {/* Remote video (full screen background in video calls) */}
        {isVideo && state === 'active' && (
          <video ref={remoteVideoRef} className="call-video-remote" autoPlay playsInline />
        )}

        {/* Local video (picture-in-picture) */}
        {isVideo && (state === 'active' || state === 'connecting') && (
          <video ref={localVideoRef} className="call-video-local" autoPlay playsInline muted />
        )}

        {/* Call info */}
        <div className="call-modal-info">
          <div className="call-avatar">{callInfo.remoteUsername[0]?.toUpperCase()}</div>
          <div className="call-username">{callInfo.remoteUsername}</div>
          <div className="call-status">
            {state === 'ringing_out' && (
              <>
                <span className="call-status-dot ringing" />
                Calling…
              </>
            )}
            {state === 'ringing_in' && (
              <>
                <span className="call-status-dot ringing" />
                Incoming {isVideo ? 'video' : 'audio'} call
              </>
            )}
            {state === 'connecting' && 'Connecting…'}
            {state === 'active' && formatDuration(duration)}
            {state === 'ended' && 'Call ended'}
          </div>
        </div>

        {/* Controls */}
        <div className="call-controls">
          {/* Incoming call: accept / reject */}
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

          {/* Outgoing ringing: cancel */}
          {state === 'ringing_out' && (
            <button className="call-btn call-btn-end" onClick={() => callService.endCall()} title="Cancel">
              <span className="call-icon">📵</span>
            </button>
          )}

          {/* Active call controls */}
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
                  title={cameraOff ? 'Turn camera on' : 'Turn camera off'}
                >
                  <span className="call-icon">{cameraOff ? '📷' : '🎥'}</span>
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
