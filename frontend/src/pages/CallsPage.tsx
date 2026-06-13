import { useState, useEffect } from 'react';
import { AppContext } from '../App';
import './CallsPage.css';

interface Props { ctx: AppContext }

interface SessionDevice {
  id: string;
  name: string;
  username: string;
  type: string;
  online: boolean;
}

export default function CallsPage({ ctx }: Props) {
  const { session, deviceId, callService, groupCallService } = ctx;
  const [devices, setDevices] = useState<SessionDevice[]>([]);
  const [callState, setCallState] = useState(callService?.getState() ?? 'idle');
  const [groupCallState, setGroupCallState] = useState(groupCallService?.getState() ?? 'idle');

  // Multi-select for group calls
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Pull session devices from the global snapshot kept by App.tsx
  useEffect(() => {
    const refresh = () => {
      const snap = (window as any)._sessionDevices as SessionDevice[] | undefined;
      if (snap && snap.length > 0) {
        setDevices(snap.filter((d: SessionDevice) => d.id !== deviceId));
      }
    };
    // immediate
    refresh();
    // re-run on any session event (join/leave/connect/disconnect)
    window.addEventListener('sessionMessage', refresh);
    // also poll for the first 3s in case the snapshot arrives late
    const t1 = setTimeout(refresh, 500);
    const t2 = setTimeout(refresh, 1500);
    const t3 = setTimeout(refresh, 3000);
    return () => {
      window.removeEventListener('sessionMessage', refresh);
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
    };
  }, [deviceId, session]);

  // Mirror call states
  useEffect(() => {
    if (!callService) return;
    const t = setInterval(() => setCallState(callService.getState()), 500);
    return () => clearInterval(t);
  }, [callService]);

  useEffect(() => {
    if (!groupCallService) return;
    const t = setInterval(() => setGroupCallState(groupCallService.getState()), 500);
    return () => clearInterval(t);
  }, [groupCallService]);

  const isInCall = (callState !== 'idle' && callState !== 'ended') ||
                   (groupCallState !== 'idle' && groupCallState !== 'ended');

  const toggleSelect = (d: SessionDevice) => {
    if (!d.online) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(d.id)) next.delete(d.id);
      else next.add(d.id);
      return next;
    });
  };

  const selectAll = () => {
    const online = devices.filter(d => d.online);
    setSelected(new Set(online.map(d => d.id)));
  };

  const clearSelection = () => setSelected(new Set());

  const startAudio = (d: SessionDevice) => {
    if (selected.size === 0) {
      callService?.startCall(d.username || d.name, d.id, false);
    }
  };

  const startVideo = (d: SessionDevice) => {
    if (selected.size === 0) {
      callService?.startCall(d.username || d.name, d.id, true);
    }
  };

  const startGroupAudio = () => {
    if (!groupCallService || !session || selected.size === 0) return;
    const invitees = devices
      .filter(d => selected.has(d.id))
      .map(d => ({ username: d.username || d.name, deviceId: d.id }));
    groupCallService.startGroupCall(invitees, 'audio', session.id);
    setSelected(new Set());
  };

  const startGroupVideo = () => {
    if (!groupCallService || !session || selected.size === 0) return;
    const invitees = devices
      .filter(d => selected.has(d.id))
      .map(d => ({ username: d.username || d.name, deviceId: d.id }));
    groupCallService.startGroupCall(invitees, 'video', session.id);
    setSelected(new Set());
  };

  const selectedCount = selected.size;
  const isGroupMode = selectedCount > 0;

  return (
    <div className="calls-page">
      <div className="calls-header card">
        <div className="calls-header-icon">📞</div>
        <div>
          <div className="calls-header-title">Calls</div>
          <div className="calls-header-sub">
            {session
              ? `Session ${session.code} · ${devices.length} device${devices.length !== 1 ? 's' : ''} available`
              : 'Join a session to start calling'}
          </div>
        </div>
        {isInCall && (
          <div className="calls-active-badge">
            <span className="calls-active-dot" />
            Call in progress
          </div>
        )}
      </div>

      {!session && (
        <div className="calls-empty card">
          <div className="calls-empty-icon">📵</div>
          <div className="calls-empty-title">No active session</div>
          <p>Create or join a session from the Overview page, then come back here to call connected devices.</p>
        </div>
      )}

      {session && devices.length === 0 && (
        <div className="calls-empty card">
          <div className="calls-empty-icon">🔍</div>
          <div className="calls-empty-title">No other devices in session</div>
          <p>Invite someone to your session — they'll appear here once connected.</p>
        </div>
      )}

      {session && devices.length > 0 && (
        <>
          {/* Group call action bar (shown when devices are available) */}
          <div className="calls-group-bar card">
            <div className="calls-group-bar-left">
              <span className="calls-group-label">
                {isGroupMode
                  ? `${selectedCount} device${selectedCount !== 1 ? 's' : ''} selected`
                  : 'Select devices for a group call'}
              </span>
              {devices.filter(d => d.online).length > 1 && (
                <button
                  className="calls-select-btn"
                  onClick={isGroupMode ? clearSelection : selectAll}
                >
                  {isGroupMode ? 'Clear' : 'Select All'}
                </button>
              )}
            </div>
            {isGroupMode && (
              <div className="calls-group-actions">
                <button
                  className="calls-btn calls-btn-audio calls-btn-group"
                  disabled={isInCall}
                  onClick={startGroupAudio}
                  title="Start group voice call"
                >
                  <span className="calls-btn-icon">📞</span>
                  Group Voice
                </button>
                <button
                  className="calls-btn calls-btn-video calls-btn-group"
                  disabled={isInCall}
                  onClick={startGroupVideo}
                  title="Start group video call"
                >
                  <span className="calls-btn-icon">🎥</span>
                  Group Video
                </button>
              </div>
            )}
          </div>

          <div className="calls-devices">
            {devices.map(d => (
              <div
                key={d.id}
                className={`calls-device-card card${!d.online ? ' offline' : ''}${selected.has(d.id) ? ' selected' : ''}`}
                onClick={() => toggleSelect(d)}
                title={d.online ? (selected.has(d.id) ? 'Deselect' : 'Select for group call') : undefined}
              >
                {/* Selection indicator */}
                <div className={`calls-select-check${selected.has(d.id) ? ' checked' : ''}`}>
                  {selected.has(d.id) ? '✓' : ''}
                </div>

                <div className="calls-device-avatar">
                  {(d.username || d.name)[0]?.toUpperCase()}
                </div>
                <div className="calls-device-info">
                  <div className="calls-device-name">{d.username || d.name}</div>
                  <div className="calls-device-meta">
                    <span className={`calls-status-dot${d.online ? ' online' : ''}`} />
                    {d.online ? 'Online' : 'Offline'} · {d.type}
                  </div>
                </div>
                <div className="calls-device-actions" onClick={e => e.stopPropagation()}>
                  {/* 1-to-1 call buttons (only shown when nothing selected) */}
                  {!isGroupMode && (
                    <>
                      <button
                        className="calls-btn calls-btn-audio"
                        title="Audio call"
                        disabled={!d.online || isInCall}
                        onClick={() => startAudio(d)}
                      >
                        <span className="calls-btn-icon">📞</span>
                        Audio
                      </button>
                      <button
                        className="calls-btn calls-btn-video"
                        title="Video call"
                        disabled={!d.online || isInCall}
                        onClick={() => startVideo(d)}
                      >
                        <span className="calls-btn-icon">🎥</span>
                        Video
                      </button>
                    </>
                  )}
                  {isGroupMode && d.online && (
                    <div className="calls-selected-hint">
                      {selected.has(d.id) ? '✓ In group' : 'Tap to add'}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
