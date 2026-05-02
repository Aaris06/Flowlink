import { useState, useEffect } from 'react';
import { AppContext } from '../App';
import { SIGNALING_HTTP_URL } from '../config/signaling';
import './AdminPage.css';

const ADMIN_SECRET = 'flowlink_admin_2024';

interface DeviceEntry {
  id: string; username: string; name: string; online: boolean; role?: string;
  isActive?: boolean; lastSeen: string; inactive: boolean;
}
interface FeedbackEntry {
  id: number; type: string; text: string; fromUsername: string; sentAt: number;
}

interface Props { ctx: AppContext; }

export default function AdminPage({ ctx }: Props) {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);
  const [tab, setTab] = useState<'devices' | 'feedback'>('devices');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');

  const headers = { 'x-admin-secret': ADMIN_SECRET };

  const loadDevices = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${SIGNALING_HTTP_URL}/admin/devices`, { headers });
      const data = await r.json();
      setDevices(data.devices || []);
    } catch { setMsg('Failed to load devices'); }
    setLoading(false);
  };

  const loadFeedback = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${SIGNALING_HTTP_URL}/admin/feedback`, { headers });
      const data = await r.json();
      setFeedback(data.feedback || []);
    } catch { setMsg('Failed to load feedback'); }
    setLoading(false);
  };

  useEffect(() => {
    if (tab === 'devices') loadDevices();
    else loadFeedback();
  }, [tab]);

  // Also receive real-time feedback via WebSocket
  useEffect(() => {
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws) return;
    const handler = (e: MessageEvent) => {
      const m = JSON.parse(e.data);
      if (m.type === 'admin_feedback') {
        setFeedback(p => [m.payload, ...p]);
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, []);

  const deleteDevice = async (id: string) => {
    if (!confirm('Kick and delete this device?')) return;
    await fetch(`${SIGNALING_HTTP_URL}/admin/devices/${id}`, { method: 'DELETE', headers });
    setDevices(p => p.filter(d => d.id !== id));
    setMsg('Device removed');
  };

  const deleteFeedback = async (idx: number) => {
    await fetch(`${SIGNALING_HTTP_URL}/admin/feedback/${idx}`, { method: 'DELETE', headers });
    setFeedback(p => p.filter((_, i) => i !== idx));
  };

  return (
    <div className="admin-page">
      <div className="admin-header card">
        <span className="admin-badge">🛡️ Admin Panel</span>
        <span className="admin-user">Logged in as <strong>{ctx.username}</strong></span>
      </div>

      <div className="admin-tabs">
        <button className={`admin-tab${tab === 'devices' ? ' active' : ''}`} onClick={() => setTab('devices')}>
          📱 Devices ({devices.length})
        </button>
        <button className={`admin-tab${tab === 'feedback' ? ' active' : ''}`} onClick={() => setTab('feedback')}>
          📝 Feedback & Reports ({feedback.length})
        </button>
      </div>

      {msg && <div className="admin-msg">{msg}</div>}

      {loading && <div className="admin-loading">Loading…</div>}

      {tab === 'devices' && !loading && (
        <div className="admin-section card">
          <div className="admin-section-header">
            <span>All Registered Devices</span>
            <button className="btn-secondary" onClick={loadDevices}>↻ Refresh</button>
          </div>
          {devices.length === 0 && <div className="admin-empty">No devices registered.</div>}
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
                title={d.isActive ? 'Deactivate account' : 'Already deactivated'}>
                {d.isActive ? '🚫 Deactivate' : '✓ Inactive'}
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'feedback' && !loading && (
        <div className="admin-section card">
          <div className="admin-section-header">
            <span>User Feedback & Reports</span>
            <button className="btn-secondary" onClick={loadFeedback}>↻ Refresh</button>
          </div>
          {feedback.length === 0 && <div className="admin-empty">No feedback yet.</div>}
          {feedback.map((f, i) => (
            <div key={i} className="admin-feedback-row">
              <div className="admin-feedback-header">
                <span className={`admin-fb-type ${f.type}`}>{f.type === 'report' ? '🚨 Report' : '💬 Feedback'}</span>
                <span className="admin-fb-user">from <strong>{f.fromUsername}</strong></span>
                <span className="admin-fb-time">{new Date(f.sentAt).toLocaleString()}</span>
                <button className="admin-fb-delete" onClick={() => deleteFeedback(i)}>✕</button>
              </div>
              <div className="admin-fb-text">{f.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
