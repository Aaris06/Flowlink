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
  const { session, deviceId, callService } = ctx;
  const [devices, setDevices] = useState<SessionDevice[]>([]);
  const [callState, setCallState] = useState(callService?.getState() ?? 'idle');

  // Pull session devices from the global snapshot kept by App.tsx
  useEffect(() => {
    const refresh = () => {
      const snap = (window as any)._sessionDevices as SessionDevice[] | undefined;
      if (snap) setDevices(snap.filter(d => d.id !== deviceId));
    };
    refresh();
    // Refresh on any session message (device join/leave)
    const handler = () => refresh();
    window.addEventListener('sessionMessage', handler);
    return () => window.removeEventListener('sessionMessage', handler);
  }, [deviceId]);

  // Mirror call state for the button labels
  useEffect(() => {
    if (!callService) return;
    // Poll state — lightweight since CallService already drives the overlay
    const t = setInterval(() => setCallState(callService.getState()), 500);
    return () => clearInterval(t);
  }, [callService]);

  const isInCall = callState !== 'idle' && callState !== 'ended';

  const startAudio = (d: SessionDevice) => {
    callService?.startCall(d.username || d.name, d.id, false);
  };

  const startVideo = (d: SessionDevice) => {
    callService?.startCall(d.username || d.name, d.id, true);
  };

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
        <div className="calls-devices">
          {devices.map(d => (
            <div key={d.id} className={`calls-device-card card${!d.online ? ' offline' : ''}`}>
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
              <div className="calls-device-actions">
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
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
