import { useEffect, useRef, useState, useCallback } from 'react';
import { GroupCallService, GroupCallState, GroupCallInfo, GroupCallParticipant } from '../services/GroupCallService';
import { startRingtone, stopRingtone } from '../services/RingtoneService';
import './GroupCallModal.css';

interface GroupCallModalProps {
  groupCallService: GroupCallService;
  state: GroupCallState;
  roomInfo: GroupCallInfo | null;
  participants: GroupCallParticipant[];
  localUsername: string;
}

function attachStream(el: HTMLMediaElement | null, stream: MediaStream | null) {
  if (!el || !stream) return;
  if (el.srcObject !== stream) el.srcObject = stream;
  el.play().catch((e) => {
    if (e?.name !== 'NotAllowedError') console.warn('[GroupCallModal] play error:', e);
  });
}

// ── Compute the best grid layout for N remote participants ─────────────────
function getGridClass(count: number): string {
  if (count <= 1) return 'gcm-grid-1';
  if (count === 2) return 'gcm-grid-2';
  if (count === 3) return 'gcm-grid-3';
  if (count === 4) return 'gcm-grid-4';
  if (count <= 6) return 'gcm-grid-6';
  if (count <= 9) return 'gcm-grid-9';
  return 'gcm-grid-9'; // cap at 3×3
}

export default function GroupCallModal({
  groupCallService,
  state,
  roomInfo,
  participants,
  localUsername,
}: GroupCallModalProps) {
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [minimized, setMinimized] = useState(false);

  // Local PiP video
  const localVideoRef = useRef<HTMLVideoElement | null>(null);

  // Ringtone
  useEffect(() => {
    if (state === 'ringing_in') {
      startRingtone((window as any).__flowlink_username ?? 'default');
    } else {
      stopRingtone();
    }
    return () => stopRingtone();
  }, [state]);

  // Duration counter
  useEffect(() => {
    if (state !== 'active') { setDuration(0); return; }
    const t = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  // Reset UI on new call
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

  // Attach local stream to the PiP video
  const attachLocalVideo = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el) {
      const stream = groupCallService.getLocalStream();
      if (stream) { el.srcObject = stream; el.muted = true; el.play().catch(() => {}); }
    }
  }, [groupCallService]);

  useEffect(() => {
    if (state === 'active') {
      const stream = groupCallService.getLocalStream();
      if (localVideoRef.current && stream) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        localVideoRef.current.play().catch(() => {});
      }
    }
  }, [state, participants, groupCallService]);

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  if (state === 'idle' || !roomInfo) return null;
  if (minimized) return (
    <MinimizedBubble
      roomInfo={roomInfo}
      duration={duration}
      state={state}
      fmt={fmt}
      onRestore={() => setMinimized(false)}
      onLeave={() => groupCallService.leaveCall()}
    />
  );

  const isVideo = roomInfo.callType === 'video';

  return (
    <div className={`gcm-overlay${state === 'active' && isVideo ? ' gcm-video-mode' : ''}`}>
      <div className="gcm-modal">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="gcm-header">
          <div className="gcm-header-info">
            <span className="gcm-header-icon">{isVideo ? '🎥' : '📞'}</span>
            <span className="gcm-header-title">
              {state === 'ringing_in'
                ? `${roomInfo.initiatorUsername} is inviting you`
                : state === 'ringing_out'
                  ? 'Calling participants…'
                  : state === 'active'
                    ? `Group ${isVideo ? 'Video' : 'Audio'} Call · ${fmt(duration)}`
                    : `Group ${isVideo ? 'Video' : 'Audio'} Call`}
            </span>
            {state === 'active' && (
              <span className="gcm-participant-count">
                {participants.length + 1} participant{participants.length + 1 !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          {(state === 'active' || state === 'ringing_out') && (
            <button className="gcm-minimize-btn" onClick={() => setMinimized(true)} title="Minimize">⬇</button>
          )}
        </div>

        {/* ── Active video call: remote grid + local PiP ──────────────── */}
        {isVideo && state === 'active' && (
          <div className="gcm-video-area">
            {/* Remote participants grid */}
            <div className={`gcm-grid ${getGridClass(Math.max(participants.length, 1))}`}>
              {participants.length === 0 ? (
                // No remote peers yet — show waiting placeholder
                <div className="gcm-tile gcm-tile-waiting">
                  <div className="gcm-tile-avatar">👥</div>
                  <div className="gcm-tile-label">Waiting for others…</div>
                </div>
              ) : (
                participants.map(p => (
                  <RemoteTile key={p.peerId} participant={p} />
                ))
              )}
            </div>

            {/* Local video: small floating PiP in bottom-right */}
            <div className="gcm-pip">
              {groupCallService.getLocalStream()?.getVideoTracks().length ? (
                <video
                  ref={attachLocalVideo}
                  className="gcm-pip-video"
                  autoPlay
                  playsInline
                  muted
                />
              ) : (
                <div className="gcm-pip-avatar">{(localUsername || 'Y')[0]?.toUpperCase()}</div>
              )}
              <div className="gcm-pip-label">You</div>
            </div>
          </div>
        )}

        {/* ── Active audio call: avatar grid ──────────────────────────── */}
        {!isVideo && state === 'active' && (
          <div className="gcm-audio-grid">
            {/* Self tile */}
            <div className="gcm-audio-tile gcm-audio-tile-self">
              <div className="gcm-audio-avatar">{(localUsername || 'Y')[0]?.toUpperCase()}</div>
              <div className="gcm-audio-name">You</div>
            </div>
            {/* Remote tiles */}
            {participants.map(p => (
              <div key={p.peerId} className="gcm-audio-tile">
                <div className="gcm-audio-avatar">{(p.peerUsername || '?')[0]?.toUpperCase()}</div>
                <div className="gcm-audio-name">{p.peerUsername}</div>
                {p.stream && <AudioPlayer stream={p.stream} />}
              </div>
            ))}
          </div>
        )}

        {/* ── Ringing / calling states ─────────────────────────────────── */}
        {(state === 'ringing_in' || state === 'ringing_out') && (
          <div className="gcm-ringing-info">
            <div className="gcm-ringing-avatar">{roomInfo.initiatorUsername[0]?.toUpperCase()}</div>
            <div className="gcm-ringing-name">{roomInfo.initiatorUsername}</div>
            <div className="gcm-ringing-sub">
              {state === 'ringing_in'
                ? `Incoming ${isVideo ? 'video' : 'audio'} group call`
                : 'Waiting for others to join…'}
            </div>
          </div>
        )}

        {/* ── Controls ────────────────────────────────────────────────── */}
        <div className="gcm-controls">
          {state === 'ringing_in' && (
            <>
              <button className="gcm-btn gcm-btn-accept" onClick={() => groupCallService.acceptGroupCall()} title="Accept">
                <span className="gcm-btn-icon">📞</span>
              </button>
              <button className="gcm-btn gcm-btn-reject" onClick={() => groupCallService.rejectGroupCall()} title="Decline">
                <span className="gcm-btn-icon">📵</span>
              </button>
            </>
          )}
          {state === 'ringing_out' && (
            <button className="gcm-btn gcm-btn-end" onClick={() => groupCallService.leaveCall()} title="Cancel">
              <span className="gcm-btn-icon">📵</span>
            </button>
          )}
          {state === 'active' && (
            <>
              <button
                className={`gcm-btn gcm-btn-mute${muted ? ' active' : ''}`}
                onClick={() => setMuted(groupCallService.toggleMute())}
                title={muted ? 'Unmute' : 'Mute'}
              >
                <span className="gcm-btn-icon">{muted ? '🔇' : '🎙️'}</span>
              </button>
              {isVideo && (
                <button
                  className={`gcm-btn gcm-btn-camera${cameraOff ? ' active' : ''}`}
                  onClick={() => setCameraOff(groupCallService.toggleCamera())}
                  title={cameraOff ? 'Camera on' : 'Camera off'}
                >
                  <span className="gcm-btn-icon">{cameraOff ? '📷' : '🎥'}</span>
                </button>
              )}
              <button className="gcm-btn gcm-btn-end" onClick={() => groupCallService.leaveCall()} title="Leave call">
                <span className="gcm-btn-icon">📵</span>
              </button>
            </>
          )}
        </div>

      </div>
    </div>
  );
}

// ── Remote tile ──────────────────────────────────────────────────────────────

function RemoteTile({ participant }: { participant: GroupCallParticipant }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current && participant.stream) {
      attachStream(videoRef.current, participant.stream);
    }
  }, [participant.stream]);

  const hasVideo = participant.stream && participant.stream.getVideoTracks().length > 0;

  return (
    <div className="gcm-tile">
      {hasVideo ? (
        <video
          ref={(el) => {
            videoRef.current = el;
            if (el && participant.stream) attachStream(el, participant.stream);
          }}
          className="gcm-tile-video"
          autoPlay
          playsInline
        />
      ) : (
        <div className="gcm-tile-avatar">{(participant.peerUsername || '?')[0]?.toUpperCase()}</div>
      )}
      <div className="gcm-tile-label">{participant.peerUsername}</div>
      {/* Hidden audio player */}
      {participant.stream && <AudioPlayer stream={participant.stream} />}
    </div>
  );
}

function AudioPlayer({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      ref.current.volume = 1;
      ref.current.muted = false;
      ref.current.play().catch(() => {});
    }
  }, [stream]);
  return <audio ref={ref} autoPlay playsInline style={{ display: 'none' }} />;
}

// ── Minimized bubble ─────────────────────────────────────────────────────────

interface MinimizedBubbleProps {
  roomInfo: GroupCallInfo;
  duration: number;
  state: GroupCallState;
  fmt: (s: number) => string;
  onRestore: () => void;
  onLeave: () => void;
}

function MinimizedBubble({ roomInfo, duration, state, fmt, onRestore, onLeave }: MinimizedBubbleProps) {
  return (
    <div className="gcm-bubble" onClick={onRestore} title="Click to restore call">
      <div className="gcm-bubble-circle">
        <div className="gcm-bubble-avatar">{roomInfo.initiatorUsername[0]?.toUpperCase()}</div>
        <div className="gcm-bubble-info">
          <span className="gcm-bubble-name">{roomInfo.initiatorUsername}</span>
          <span className="gcm-bubble-timer">{state === 'active' ? fmt(duration) : 'Calling…'}</span>
        </div>
      </div>
      <button
        className="gcm-bubble-end"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onLeave(); }}
        title="Leave call"
      >✕</button>
    </div>
  );
}
