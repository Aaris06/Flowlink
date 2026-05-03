import { useState, useEffect } from 'react';
import { AppContext } from '../App';
import { SIGNALING_HTTP_URL } from '../config/signaling';
import { authService } from '../services/AuthService';
import './AdminPage.css';

interface DeviceEntry {
  id: string; username: string; name: string; online: boolean; role?: string;
  isActive?: boolean; lastSeen: string; inactive: boolean;
}
interface FeedbackEntry {
  id: number; type: string; text: string; fromUsername: string; sentAt: number;
}
interface SessionEntry {
  id: string; code: string; createdBy: string; deviceCount: number;
  devices: { id: string; username: string; name: string; online: boolean }[];
  createdAt: string; expiresAt: string; reportCount: number;
}

type Tab = 'devices' | 'sessions' | 'feedback' | 'announce';

interface Props { ctx: AppContext; }

export default function AdminPage({ ctx }: Props) {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [tab, setTab] = useState<Tab>('devices');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [announceTitle, setAnnounceTitle] = useState('');
  const [announceMsg, setAnnounceMsg] = useState('');
  const [announceType, setAnnounceType] = useState<'info' | 'update' | 'warning'>('info');
  const [announceSent, setAnnounceSent] = useState(false);

  const headers = {
    'x-admin-secret': 'flowlink_admin_2024',
    'Authorization': `Bearer ${authService.getToken() || ''}`,
    'Content-Type': 'application/json',
  };

  const load = async (t: Tab) => {
    setLoading(true); setMsg('');
    try {
      if (t === 'devices') {
        const r = await fetch(`${SIGNALING_HTTP_URL}/admin/devices`, { headers });
        setDevices((await r.json()).devices || []);
      } else if (t === 'sessions') {
        const r = await fetch(`${SIGNALING_HTTP_URL}/admin/sessions`, { headers });
        setSessions((await r.json()).sessions || []);
      } else if (t === 'feedback') {
        const r = await fetch(`${SIGNALING_HTTP_URL}/admin/feedback`, { headers });
        setFeedback((await r.json()).feedback || []);
      }
    } catch { setMsg('Failed to load data'); }
    setLoading(false);
  };

  useEffect(() => { load(tab); }, [tab]);

  // Real-time feedback via WebSocket
  useEffect(() => {
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws) return;
    const handler = (e: MessageEvent) => {
      const m = JSON.parse(e.data);
      if (m.type === 'admin_feedback') setFeedback(p => [m.payload, ...p]);
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, []);

  const deleteDevice = async (id: string) => {
    if (!confirm('Deactivate this account?')) return;
    await fetch(`${SIGNALING_HTTP_URL}/admin/devices/${id}`, { method: 'DELETE', headers });
    setDevices(p => p.map(d => d.id === id ? { ...d, isActive: false } : d));
    setMsg('Account deactivated');
  };

  const deleteSession = async (id: string) => {
    if (!confirm('Terminate this session? All members will be disconnected.')) return;
    await fetch(`${SIGNALING_HTTP_URL}/admin/sessions/${id}`, { method: 'DELETE', headers });
    setSessions(p => p.filter(s => s.id !== id));
    setMsg('Session terminated');
  };

  const deleteFeedback = async (idx: number) => {
    await fetch(`${SIGNALING_HTTP_URL}/admin/feedback/${idx}`, { method: 'DELETE', headers });
    setFeedback(p => p.filter((_, i) => i !== idx));
  };

  const sendAnnouncement = async () => {
    if (!announceTitle.trim() || !announceMsg.trim()) return;
    const r = await fetch(`${SIGNALING_HTTP_URL}/admin/announce`, {
      method: 'POST', headers,
      body: JSON.stringify({ title: announceTitle, message: announceMsg, type: announceType }),
    });
    const data = await r.json();
    if (data.success) {
      setAnnounceSent(true);
      setMsg(`✅ Announcement sent to ${data.reached} connected devices`);
      setAnnounceTitle(''); setAnnounceMsg('');
      setTimeout(() => setAnnounceSent(false), 4000);
    }
  };

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'devices', label: 'Users', icon: '👤' },
    { id: 'sessions', label: 'Sessions', icon: '🔗' },
    { id: 'feedback', label: 'Reports', icon: '📝' },
    { id: 'announce', label: 'Announce', icon: '📢' },
  ];

  return (
    <div className="admin-page">
      <div className="admin-header card">
        <span className="admin-badge">🛡️ Admin Panel</span>
        <span className="admin-user">Logged in as <strong>{ctx.username}</strong></span>
      </div>

      <div className="admin-tabs">
        {tabs.map(t => (
          <button key={t.id} className={`admin-tab${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {msg && <div className="admin-msg">{msg}</div>}
      {loading && <div className="admin-loading">Loading…</div>}

      {/* ── Users ── */}
      {tab === 'devices' && !loading && (
        <div className="admin-section card">
          <div className="admin-section-header">
            <span>Registered Users ({devices.length})</span>
            <button className="btn-secondary" onClick={() => load('devices')}>↻ Refresh</button>
          </div>
          {devices.length === 0 && <div className="admin-empty">No users yet.</div>}
          {devices.map(d => (
            <div key={d.id} className={`admin-device-row${d.inactive ? ' inactive' : ''}${!d.isActive ? ' deactivated' : ''}`}>
              <div className="admin-device-dot" style={{ background: d.online ? '#22c55e' : '#6b7280' }} />
              <div className="admin-device-info">
                <div className="admin-device-name">
                  {d.username}
                  {d.role === 'admin' && <span className="admin-role-badge">👑 admin</span>}
                  {!d.isActive && <span className="admin-deactivated-badge"> · Deactivated</span>}
                </div>
                <div className="admin-device-meta">
                  Last seen: {new Date(d.lastSeen).toLocaleString()}
                  {d.inactive && d.isActive && <span className="admin-inactive-badge"> · Inactive 7d+</span>}
                </div>
              </div>
              <button className="btn-danger admin-kick-btn" onClick={() => deleteDevice(d.id)}
                disabled={!d.isActive}>
                {d.isActive ? '🚫 Deactivate' : '✓ Inactive'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Sessions ── */}
      {tab === 'sessions' && !loading && (
        <div className="admin-section card">
          <div className="admin-section-header">
            <span>Active Sessions ({sessions.length})</span>
            <button className="btn-secondary" onClick={() => load('sessions')}>↻ Refresh</button>
          </div>
          {sessions.length === 0 && <div className="admin-empty">No active sessions.</div>}
          {sessions.map(s => (
            <div key={s.id} className="admin-session-row">
              <div className="admin-session-info">
                <div className="admin-session-code">
                  Session <strong>{s.code}</strong>
                  {s.reportCount > 0 && <span className="admin-report-badge">⚠ {s.reportCount} report{s.reportCount > 1 ? 's' : ''}</span>}
                </div>
                <div className="admin-session-meta">
                  Created by: {s.createdBy} · {s.deviceCount} device{s.deviceCount !== 1 ? 's' : ''}
                  {s.createdAt && ` · ${new Date(s.createdAt).toLocaleTimeString()}`}
                </div>
                <div className="admin-session-devices">
                  {s.devices.map(d => (
                    <span key={d.id} className={`admin-session-device${d.online ? ' online' : ''}`}>
                      {d.online ? '🟢' : '⚫'} {d.username || d.name}
                    </span>
                  ))}
                </div>
              </div>
              <button className="btn-danger admin-kick-btn" onClick={() => deleteSession(s.id)}>
                🗑 Terminate
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Feedback & Reports ── */}
      {tab === 'feedback' && !loading && (
        <div className="admin-section card">
          <div className="admin-section-header">
            <span>Feedback & Reports ({feedback.length})</span>
            <button className="btn-secondary" onClick={() => load('feedback')}>↻ Refresh</button>
          </div>
          {feedback.length === 0 && <div className="admin-empty">No feedback yet.</div>}
          {feedback.map((f, i) => (
            <div key={i} className="admin-feedback-row">
              <div className="admin-feedback-header">
                <span className={`admin-fb-type ${f.type}`}>
                  {f.type === 'report' ? '🚨 Report' : f.type === 'session_report' ? '⚠ Session Report' : '💬 Feedback'}
                </span>
                <span className="admin-fb-user">from <strong>{f.fromUsername}</strong></span>
                <span className="admin-fb-time">{new Date(f.sentAt).toLocaleString()}</span>
                <button className="admin-fb-delete" onClick={() => deleteFeedback(i)}>✕</button>
              </div>
              <div className="admin-fb-text">{f.text}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── Announcements ── */}
      {tab === 'announce' && (
        <div className="admin-section card">
          <div className="admin-section-header">
            <span>Send Announcement to All Users</span>
          </div>
          <div className="admin-announce-form">
            <div className="admin-announce-type">
              {(['info', 'update', 'warning'] as const).map(t => (
                <button key={t} onClick={() => setAnnounceType(t)}
                  className={`admin-type-btn${announceType === t ? ' active' : ''}`}>
                  {t === 'info' ? 'ℹ Info' : t === 'update' ? '🚀 Update' : '⚠ Warning'}
                </button>
              ))}
            </div>
            <input
              className="admin-announce-input"
              placeholder="Title (e.g. New Feature Released!)"
              value={announceTitle}
              onChange={e => setAnnounceTitle(e.target.value)}
            />
            <textarea
              className="admin-announce-textarea"
              placeholder="Message body… (e.g. We've added voice messages, file previews, and more!)"
              value={announceMsg}
              onChange={e => setAnnounceMsg(e.target.value)}
              rows={4}
            />
            <button className="btn-primary" onClick={sendAnnouncement}
              disabled={!announceTitle.trim() || !announceMsg.trim() || announceSent}>
              {announceSent ? '✅ Sent!' : '📢 Send to All Users'}
            </button>
            <div className="admin-announce-note">
              This will show a notification to all currently connected users instantly.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
