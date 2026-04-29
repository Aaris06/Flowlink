import { useState, useEffect } from 'react';
import { AppContext } from '../App';
import { Group, Device } from '@shared/types';
import { groupService } from '../services/GroupService';
import './GroupsPage.css';

interface Props { ctx: AppContext; }

export default function GroupsPage({ ctx }: Props) {
  const { session, deviceId } = ctx;
  const [groups, setGroups] = useState<Group[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);

  const normalizeDevice = (payload: any): Device | null => {
    const raw = payload?.device || payload;
    if (!raw?.id) return null;
    return {
      id: raw.id,
      name: raw.name || raw.deviceName || 'Unknown Device',
      username: raw.username || '',
      type: raw.type || raw.deviceType || 'laptop',
      online: typeof raw.online === 'boolean' ? raw.online : true,
      permissions: raw.permissions || {},
      joinedAt: raw.joinedAt || Date.now(),
      lastSeen: raw.lastSeen || Date.now(),
    };
  };

  useEffect(() => {
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    groupService.initialize(ws!, session.id, deviceId);
    groupService.subscribe(setGroups);
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'device_connected') {
        const device = normalizeDevice(msg.payload);
        if (device && device.id !== deviceId) setDevices(p => [...p.filter(d => d.id !== device.id), device]);
      }
      if (msg.type === 'device_disconnected') setDevices(p => p.filter(d => d.id !== msg.payload.deviceId));
      if (msg.type === 'session_joined' && msg.payload?.devices) {
        setDevices(msg.payload.devices.map(normalizeDevice).filter((d: Device | null): d is Device => Boolean(d && d.id !== deviceId)));
      }
    };
    ws?.addEventListener('message', handler);
    return () => { ws?.removeEventListener('message', handler); groupService.cleanup(); };
  }, [session, deviceId]);

  const createGroup = () => {
    if (!newGroupName.trim() || selectedDevices.length === 0) return;
    groupService.createGroup(newGroupName.trim(), selectedDevices, '#6C63FF');
    setNewGroupName('');
    setSelectedDevices([]);
  };

  const toggleDevice = (id: string) => setSelectedDevices(p => p.includes(id) ? p.filter(d => d !== id) : [...p, id]);

  return (
    <div className="groups-page">
      {!session && <div className="groups-no-session card"><div>🔒</div><div>Join a session to manage groups.</div></div>}

      {session && (
        <>
          {/* Create Group */}
          <div className="card create-group-card">
            <div className="cgc-title">Create Group</div>
            <div className="cgc-body">
              <input className="cgc-input" placeholder="Group name…" value={newGroupName} onChange={e => setNewGroupName(e.target.value)} />
              <div className="cgc-devices">
                {devices.length === 0 && <div className="cgc-empty">No devices connected yet.</div>}
                {devices.map(d => (
                  <label key={d.id} className={`cgc-device-check${selectedDevices.includes(d.id) ? ' selected' : ''}`}>
                    <input type="checkbox" checked={selectedDevices.includes(d.id)} onChange={() => toggleDevice(d.id)} />
                    <span>{d.type === 'phone' ? '📱' : '💻'}</span>
                    <span>{d.username || d.name}</span>
                  </label>
                ))}
              </div>
              <button className="btn-primary" onClick={createGroup} disabled={!newGroupName.trim() || selectedDevices.length === 0}>
                + Create Group
              </button>
            </div>
          </div>

          {/* Groups List */}
          {groups.length === 0 && <div className="groups-empty card"><div>👥</div><div>No groups yet. Create one above.</div></div>}
          <div className="groups-grid">
            {groups.map(g => (
              <div key={g.id} className="group-card card">
                <div className="gc-color" style={{ background: g.color || '#6C63FF' }} />
                <div className="gc-name">{g.name}</div>
                <div className="gc-count">{g.deviceIds.length} device{g.deviceIds.length !== 1 ? 's' : ''}</div>
                <div className="gc-devices">
                  {g.deviceIds.map(id => {
                    const d = devices.find(dev => dev.id === id);
                    return <span key={id} className="gc-device-chip">{d?.username || d?.name || id.slice(0, 8)}</span>;
                  })}
                </div>
                <button className="btn-danger gc-delete-btn" onClick={() => groupService.deleteGroup(g.id)}>Delete</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
