import { useState, useEffect } from 'react';
import { AppContext } from '../App';
import './ActivityPage.css';

interface ActivityItem { id: string; type: string; label: string; sub: string; time: number; icon: string; }
interface Props { ctx: AppContext; }

// Global activity log so it persists across page navigations
const activityLog: ActivityItem[] = [];
let activityListeners: Array<(items: ActivityItem[]) => void> = [];

export function logActivity(item: Omit<ActivityItem, 'id' | 'time'>) {
  const entry: ActivityItem = { ...item, id: `${Date.now()}-${Math.random()}`, time: Date.now() };
  activityLog.unshift(entry);
  if (activityLog.length > 200) activityLog.splice(200);
  activityListeners.forEach(fn => fn([...activityLog]));
}

export default function ActivityPage({ ctx }: Props) {
  const { session, deviceId } = ctx;
  const [activity, setActivity] = useState<ActivityItem[]>([...activityLog]);

  useEffect(() => {
    activityListeners.push(setActivity);
    return () => { activityListeners = activityListeners.filter(fn => fn !== setActivity); };
  }, []);

  useEffect(() => {
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws) return;
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'device_connected') {
        const device = msg.payload?.device || msg.payload;
        if (device?.id) logActivity({ type: 'device', icon: '📱', label: `${device.username || device.name || 'A device'} joined the session`, sub: `Device: ${device.name || device.deviceName || device.id}` });
      }
      if (msg.type === 'device_disconnected') logActivity({ type: 'device', icon: '🔌', label: 'A device left the session', sub: '' });
      if (msg.type === 'chat_message' && msg.payload?.sourceDevice !== deviceId) logActivity({ type: 'chat', icon: '💬', label: `${msg.payload?.chat?.username || 'Someone'} sent a message`, sub: (msg.payload?.chat?.text || '').slice(0, 80) });
      if (msg.type === 'study_store_upload') logActivity({ type: 'file', icon: '📤', label: 'File uploaded to study store', sub: msg.payload?.file?.name || '' });
      if (msg.type === 'study_store_delete') logActivity({ type: 'file', icon: '🗑', label: 'File deleted from study store', sub: '' });
      if (msg.type === 'study_sync' && msg.payload?.mode === 'open_pdf') logActivity({ type: 'study', icon: '📚', label: 'Document opened in Study Room', sub: '' });
      if (msg.type === 'intent_received') logActivity({ type: 'intent', icon: '📨', label: `Received: ${msg.payload?.intent?.intent_type?.replace(/_/g, ' ')}`, sub: '' });
      if (msg.type === 'group_created') logActivity({ type: 'group', icon: '👥', label: `Group created: ${msg.payload?.group?.name}`, sub: `${msg.payload?.group?.deviceIds?.length || 0} devices` });
      if (msg.type === 'group_deleted') logActivity({ type: 'group', icon: '🗑', label: 'Group deleted', sub: '' });
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [session, deviceId]);

  const typeColors: Record<string, string> = {
    device: '#16a34a', chat: '#2563eb', file: '#d97706',
    study: '#7c3aed', intent: '#0891b2', group: '#db2777',
  };

  return (
    <div className="activity-page">
      <div className="card activity-card">
        <div className="ac-header">
          <div>
            <div className="ac-title">⚡ Activity Log</div>
            <div className="ac-sub">Your recent actions and session events.</div>
          </div>
          {activity.length > 0 && <button className="btn-secondary ac-clear" onClick={() => { activityLog.splice(0); setActivity([]); }}>Clear</button>}
        </div>
        {activity.length === 0 && <div className="ac-empty">No activity yet. Actions will appear here as you use FlowLink.</div>}
        <div className="ac-list">
          {activity.map(item => (
            <div key={item.id} className="ac-item">
              <div className="ac-item-icon" style={{ background: `${typeColors[item.type] || '#94a3b8'}18`, color: typeColors[item.type] || '#94a3b8' }}>{item.icon}</div>
              <div className="ac-item-body">
                <div className="ac-item-label">{item.label}</div>
                {item.sub && <div className="ac-item-sub">{item.sub}</div>}
              </div>
              <div className="ac-item-time">{new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
