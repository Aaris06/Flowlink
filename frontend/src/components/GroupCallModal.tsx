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

// ── How many tiles to show in the grid before showing "+N more" ────────────
const MAX_VISIBLE_TILES = 4;

// ── Compute the best grid layout for N visible tiles ──────────────────────
function getGridClass(count: number): string {
  if (count <= 1) return 'gcm-grid-1';
  if (count === 2) return 'gcm-grid-2';
  if (count === 3) return 'gcm-grid-3';
  if (count === 4) return 'gcm-grid-4';
  return 'gcm-grid-4'; // capped at 4 visible + overflow tile
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
  const [showAllParticipants, setShowAllParticipants] = useState(false);
  // Track whether the local video stream has video tracks — drives PiP render
  const [hasLocalVideo, setHasLocalVideo] = useState(false);

  // Local PiP video ref
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
      setHasLocalVideo(false);
    }
  }, [state]);

  useEffect(() => {
    if (state === 'idle' || state === 'ended') {
      setMinimized(false);
      setHasLocalVideo(false);
    }
  }, [state]);

  /**
   * Attach the local stream to the PiP video element.
   * Called both from the ref callback (element mount) and the useEffect below
   * (stream becomes available after mount). Both paths are needed because:
   *   - The element may mount before the stream is ready (ref fires first)
   *   - The stream may be ready before the element mounts (effect fires first)
   */
  const attachLocalStreamToVideo = useCallback((el: HTMLVideoElement | null) => {
    if (!el) return;
    const stream = groupCallService.getLocalStream();
    if (!stream) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    el.muted = true;
    // Force autoplay — browsers sometimes block it even with the attribute
    el.play().catch(() => {});
  }, [groupCallService]);

  // Ref callback: fires when <video> mounts or unmounts
  const attachLocalVideo = useCallback((el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    if (el) attachLocalStreamToVideo(el);
  }, [attachLocalStreamToVideo]);

  /**
   * Poll / react to local stream availability.
   * Runs whenever call state or participant count changes. Checks whether the
   * service now has a stream with video tracks and updates state + re-attaches.
   */
  useEffect(() => {
    const stream = groupCallService.getLocalStream();
    const videoTracks = stream?.getVideoTracks() ?? [];
    const hasVideo = videoTracks.length > 0 && videoTracks[0].readyState !== 'ended';
    setHasLocalVideo(hasVideo);
    // Attach even if we already have the element — stream may have been replaced
    if (localVideoRef.current) {
      attachLocalStreamToVideo(localVideoRef.current);
    }
  }, [state, participants, groupCallService, attachLocalStreamToVideo]);

  const fmt = (s: number) =>
    `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  if (state === 'idle' || !roomInfo) return null;
  if (minimized) return (
    <MinimizedBubble
      roomInfo={roomInfo}
      duration={duration}
      state={state}
      fmt={fmt}
      participants={participants}
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
            {(() => {
              const visibleParticipants = showAllParticipants
                ? participants
                : participants.slice(0, MAX_VISIBLE_TILES);
              const overflowCount = participants.length - MAX_VISIBLE_TILES;
              const showOverflow = !showAllParticipants && overflowCount > 0;
              // Total tiles in grid: visible + possibly 1 overflow tile
              const tileCount = visibleParticipants.length + (showOverflow ? 1 : 0);

              return (
                <div className={`gcm-grid ${getGridClass(Math.max(tileCount, 1))}`}>
                  {participants.length === 0 ? (
                    <div className="gcm-tile gcm-tile-waiting">
                      <div className="gcm-tile-avatar">👥</div>
                      <div className="gcm-tile-label">Waiting for others…</div>
                    </div>
                  ) : (
                    <>
                      {visibleParticipants.map(p => (
                        <RemoteTile key={p.peerId} participant={p} />
                      ))}
                      {showOverflow && (
                        <div
                          className="gcm-tile gcm-tile-overflow"
                          onClick={() => setShowAllParticipants(true)}
                          title="Click to see all participants"
                        >
                          <div className="gcm-tile-overflow-label">
                            +{overflowCount} more
                          </div>
                          <div className="gcm-tile-overflow-sub">Click to expand</div>
                        </div>
                      )}
                      {showAllParticipants && overflowCount > 0 && (
                        <div
                          className="gcm-tile gcm-tile-collapse"
                          onClick={() => setShowAllParticipants(false)}
                          title="Click to collapse"
                        >
                          <div className="gcm-tile-overflow-label">Collapse</div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {/* Local video: small floating PiP in bottom-right */}
            <div className="gcm-pip">
              {/*
                Always mount the <video> element during an active video call.
                Gating on getLocalStream() at render time causes the element to
                never mount if the stream arrives after the first render.
                Instead we use the hasLocalVideo state and always provide the
                video element so the ref callback can attach whenever ready.
              */}
              <video
                ref={attachLocalVideo}
                className="gcm-pip-video"
                autoPlay
                playsInline
                muted
                style={{ display: hasLocalVideo ? 'block' : 'none' }}
              />
              {!hasLocalVideo && (
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
  participants: GroupCallParticipant[];
  fmt: (s: number) => string;
  onRestore: () => void;
  onLeave: () => void;
}

// Max video thumbnails shown in the minimized bubble
const BUBBLE_MAX_VIDEOS = 4;

function MinimizedBubble({ roomInfo, duration, state, participants, fmt, onRestore, onLeave }: MinimizedBubbleProps) {
  const isVideo = roomInfo.callType === 'video';
  const visibleParticipants = participants.slice(0, BUBBLE_MAX_VIDEOS);
  const overflowCount = participants.length - BUBBLE_MAX_VIDEOS;

  return (
    <div className="gcm-bubble" onClick={onRestore} title="Click to restore call">
      {/* Always render audio players so audio never stops when minimized */}
      {participants.map(p =>
        p.stream ? <AudioPlayer key={p.peerId} stream={p.stream} /> : null
      )}

      <div className="gcm-bubble-content">
        {/* Video thumbnails (video call only) */}
        {isVideo && participants.length > 0 ? (
          <div className="gcm-bubble-videos">
            {visibleParticipants.map(p => (
              <BubbleVideoThumb key={p.peerId} participant={p} />
            ))}
            {overflowCount > 0 && (
              <div className="gcm-bubble-overflow">+{overflowCount}</div>
            )}
          </div>
        ) : (
          /* Audio-only or no participants yet: show single avatar */
          <div className="gcm-bubble-avatar">{roomInfo.initiatorUsername[0]?.toUpperCase()}</div>
        )}

        {/* Info: name + timer */}
        <div className="gcm-bubble-info">
          <span className="gcm-bubble-name">
            {participants.length > 0
              ? `${participants.length + 1} in call`
              : roomInfo.initiatorUsername}
          </span>
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

// ── Single video thumbnail inside the minimized bubble ──────────────────────

function BubbleVideoThumb({ participant }: { participant: GroupCallParticipant }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current && participant.stream) {
      attachStream(videoRef.current, participant.stream);
    }
  }, [participant.stream]);

  const hasVideo = participant.stream && participant.stream.getVideoTracks().length > 0;

  return (
    <div className="gcm-bubble-thumb" title={participant.peerUsername}>
      {hasVideo ? (
        <video
          ref={(el) => {
            videoRef.current = el;
            if (el && participant.stream) attachStream(el, participant.stream);
          }}
          className="gcm-bubble-thumb-video"
          autoPlay
          playsInline
          muted
        />
      ) : (
        <div className="gcm-bubble-thumb-avatar">
          {(participant.peerUsername || '?')[0]?.toUpperCase()}
        </div>
      )}
    </div>
  );
}
