import { useEffect, useRef, useState } from 'react';
import { GroupCallService, GroupCallState, GroupCallRoom, GroupCallParticipant } from '../services/GroupCallService';
import { startRingtone, stopRingtone } from '../services/RingtoneService';
import './GroupCallModal.css';

interface Props {
  groupCallService: GroupCallService;
  state: GroupCallState;
  room: GroupCallRoom | null;
}

// ── Participant tile ───────────────────────────────────────────────────────

function ParticipantTile({ participant, isVideo }: { participant: GroupCallParticipant; isVideo: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Attach stream to video/audio element whenever it changes
  useEffect(() => {
    const stream = participant.stream;
    if (!stream) return;

    if (isVideo && !participant.isSelf && videoRef.current) {
      if (videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
    }

    if (!participant.isSelf && audioRef.current) {
      if (audioRef.current.srcObject !== stream) {
        audioRef.current.srcObject = stream;
        audioRef.current.play().catch(() => {});
      }
    }

    if (participant.isSelf && isVideo && videoRef.current) {
      if (videoRef.current.srcObject !== stream) {
        videoRef.current.srcObject = stream;
        // Self preview is muted
      }
    }
  }, [participant.stream, isVideo, participant.isSelf]);

  const initials = (participant.username[0] || '?').toUpperCase();
  const hasVideo = isVideo && !!participant.stream;

  return (
    <div className={`gcall-tile${hasVideo ? ' has-video' : ''}${participant.isSelf ? ' self' : ''}`}>
      {/* Audio element — always present for remote peers */}
      {!participant.isSelf && (
        <audio
          ref={audioRef}
          autoPlay
          playsInline
          style={{ display: 'none' }}
        />
      )}

      {/* Video stream */}
      {hasVideo ? (
        <video
          ref={videoRef}
          className="gcall-tile-video"
          autoPlay
          playsInline
          muted={participant.isSelf}
        />
      ) : (
        <div className="gcall-tile-avatar">
          <span>{initials}</span>
        </div>
      )}

      {/* Name label */}
      <div className="gcall-tile-label">
        <span className="gcall-tile-name">{participant.username}{participant.isSelf ? ' (You)' : ''}</span>
        {participant.muted && <span className="gcall-tile-muted">🔇</span>}
        {isVideo && participant.cameraOff && <span className="gcall-tile-camoff">📷</span>}
      </div>
    </div>
  );
}

// ── Main GroupCallModal ────────────────────────────────────────────────────

export default function GroupCallModal({ groupCallService, state, room }: Props) {
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [duration, setDuration] = useState(0);
  const [participants, setParticipants] = useState<GroupCallParticipant[]>(room?.participants ?? []);
  const [minimized, setMinimized] = useState(false);

  const isVideo = room?.callType === 'video';

  // ── Ringtone ──────────────────────────────────────────────────────────
  useEffect(() => {
    const username = (window as any).__flowlink_username ?? 'default';
    if (state === 'ringing_in') {
      startRingtone(username);
    } else {
      stopRingtone();
    }
    return () => stopRingtone();
  }, [state]);

  // ── Sync participants from service ────────────────────────────────────
  useEffect(() => {
    groupCallService.setOnParticipantsChange(p => setParticipants([...p]));
    return () => groupCallService.setOnParticipantsChange(() => {});
  }, [groupCallService]);

  useEffect(() => {
    if (room?.participants) setParticipants([...room.participants]);
  }, [room]);

  // ── Duration timer ────────────────────────────────────────────────────
  useEffect(() => {
    if (state !== 'active') { setDuration(0); return; }
    const t = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  // ── Reset state on new call ───────────────────────────────────────────
  useEffect(() => {
    if (state === 'ringing_in' || state === 'joining') {
      setMuted(false);
      setCameraOff(false);
      setMinimized(false);
    }
    if (state === 'idle' || state === 'ended') setMinimized(false);
  }, [state]);

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  // ── Render guard ──────────────────────────────────────────────────────
  if (state === 'idle' || !room) return null;

  const otherCount = participants.filter(p => !p.isSelf).length;

  // ── Minimized bubble ──────────────────────────────────────────────────
  if (minimized) {
    return (
      <div className="gcall-bubble" onClick={() => setMinimized(false)} title="Click to restore group call">
        <div className="gcall-bubble-circle">
          <span className="gcall-bubble-icon">{isVideo ? '🎥' : '📞'}</span>
          <span className="gcall-bubble-count">{participants.length}</span>
        </div>
        <div className="gcall-bubble-info">
          <span>{state === 'active' ? fmt(duration) : 'Calling…'}</span>
        </div>
        <button
          className="gcall-bubble-end"
          onClick={e => { e.stopPropagation(); groupCallService.leaveCall(); }}
          title="Leave call"
        >✕</button>
      </div>
    );
  }

  // ── Incoming ring screen ──────────────────────────────────────────────
  if (state === 'ringing_in') {
    return (
      <div className="gcall-overlay">
        <div className="gcall-modal gcall-ring-modal">
          <div className="gcall-ring-icon">{isVideo ? '🎥' : '📞'}</div>
          <div className="gcall-ring-title">
            Group {isVideo ? 'Video' : 'Voice'} Call
          </div>
          <div className="gcall-ring-sub">
            <strong>{room.hostUsername}</strong> is starting a group call
          </div>
          <div className="gcall-ring-controls">
            <button
              className="call-btn call-btn-accept"
              onClick={() => groupCallService.acceptGroupCall()}
              title="Join"
            >
              <span className="call-icon">📞</span>
            </button>
            <button
              className="call-btn call-btn-end"
              onClick={() => groupCallService.rejectGroupCall()}
              title="Decline"
            >
              <span className="call-icon">📵</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Joining / active ──────────────────────────────────────────────────
  return (
    <div className={`gcall-overlay${state === 'active' && isVideo ? ' gcall-video-mode' : ''}`}>
      <div className="gcall-modal">

        {/* Header */}
        <div className="gcall-header">
          <div className="gcall-header-left">
            <span className="gcall-header-icon">{isVideo ? '🎥' : '📞'}</span>
            <span className="gcall-header-title">
              Group {isVideo ? 'Video' : 'Voice'} Call
            </span>
            <span className="gcall-header-count">{participants.length} participant{participants.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="gcall-header-right">
            {state === 'active' && (
              <span className="gcall-header-timer">{fmt(duration)}</span>
            )}
            {state === 'joining' && (
              <span className="gcall-header-connecting">Connecting…</span>
            )}
            <button
              className="gcall-minimize-btn"
              onClick={() => setMinimized(true)}
              title="Minimize"
            >⬇</button>
          </div>
        </div>

        {/* Participant Grid */}
        <div className={`gcall-grid gcall-grid-${Math.min(participants.length, 6)}`}>
          {participants.map(p => (
            <ParticipantTile
              key={p.deviceId}
              participant={p}
              isVideo={!!isVideo}
            />
          ))}
          {otherCount === 0 && state === 'active' && (
            <div className="gcall-waiting">
              <div className="gcall-waiting-icon">👥</div>
              <div className="gcall-waiting-text">Waiting for others to join…</div>
              <div className="gcall-waiting-sub">Share the call link or invite from the session</div>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="gcall-controls">
          <button
            className={`call-btn call-btn-mute${muted ? ' active' : ''}`}
            onClick={() => setMuted(groupCallService.toggleMute())}
            title={muted ? 'Unmute' : 'Mute'}
          >
            <span className="call-icon">{muted ? '🔇' : '🎙️'}</span>
          </button>

          {isVideo && (
            <>
              <button
                className={`call-btn call-btn-camera${cameraOff ? ' active' : ''}`}
                onClick={() => setCameraOff(groupCallService.toggleCamera())}
                title={cameraOff ? 'Camera on' : 'Camera off'}
              >
                <span className="call-icon">{cameraOff ? '📷' : '🎥'}</span>
              </button>
              <button
                className="call-btn call-btn-switch"
                onClick={() => groupCallService.switchCamera()}
                title="Switch camera"
              >
                <span className="call-icon">🔄</span>
              </button>
            </>
          )}

          <button
            className="call-btn call-btn-end"
            onClick={() => groupCallService.leaveCall()}
            title="Leave call"
          >
            <span className="call-icon">📵</span>
          </button>
        </div>
      </div>
    </div>
  );
}
