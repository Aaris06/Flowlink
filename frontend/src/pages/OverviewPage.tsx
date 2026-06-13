import { useState, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useNavigate } from 'react-router-dom';
import { Session, Device } from '@shared/types';
import { AppContext } from '../App';
import InvitationPanel from '../components/InvitationPanel';
import './OverviewPage.css';

interface Props { ctx: AppContext; }

export default function OverviewPage({ ctx }: Props) {
  const { session, deviceId, deviceName, username, invitationService, onSessionCreated, onSessionJoined, onLeaveSession } = ctx;
  const [sessionCode, setSessionCode] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<Map<string, Device>>(new Map());
  const [showInvite, setShowInvite] = useState(false);
  const [remoteText, setRemoteText] = useState('');
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const [studyFileCount, setStudyFileCount] = useState(0);
  const [msgCount, setMsgCount] = useState(0);
  const [groupCount, setGroupCount] = useState(0);
  const navigate = useNavigate();

  const normalizeDevice = (payload: any): Device | null => {
    const raw = payload?.device || payload;
    if (!raw?.id) return null;
    return {
      id: raw.id,
      name: raw.name || raw.deviceName || 'Unknown Device',
      username: raw.username || '',
      type: raw.type || raw.deviceType || 'laptop',
      online: typeof raw.online === 'boolean' ? raw.online : true,
      permissions: raw.permissions || { files: false, media: false, prompts: false, clipboard: false, remote_browse: false },
      joinedAt: raw.joinedAt || Date.now(),
      lastSeen: raw.lastSeen || Date.now(),
    };
  };

  useEffect(() => {
    const handleSessionMsg = (e: Event) => {
      const msg = (e as CustomEvent).detail?.message;
      if (!msg) return;
      if (msg.type === 'session_created') {
        setIsCreating(false);
        const s: Session = {
          id: msg.payload.sessionId, code: msg.payload.code, createdBy: deviceId,
          createdAt: Date.now(), expiresAt: msg.payload.expiresAt,
          devices: new Map([[deviceId, { id: deviceId, name: deviceName, username, type: 'laptop', online: true, permissions: { files: false, media: false, prompts: false, clipboard: false, remote_browse: false }, joinedAt: Date.now(), lastSeen: Date.now() }]]),
        };
        sessionStorage.setItem('sessionId', s.id);
        sessionStorage.setItem('sessionCode', s.code);
        sessionStorage.setItem('deviceId', deviceId);
        onSessionCreated(s);
      }
      if (msg.type === 'session_joined') {
        setIsJoining(false);
        const dm = new Map<string, Device>();
        msg.payload.devices?.forEach((d: any) => dm.set(d.id, d));
        const s: Session = {
          id: msg.payload.sessionId,
          code: sessionCode || msg.payload.code || '',
          createdBy: msg.payload.devices?.[0]?.id || '',
          createdAt: Date.now(), expiresAt: Date.now() + 3600000, devices: dm,
        };
        sessionStorage.setItem('sessionId', s.id);
        sessionStorage.setItem('sessionCode', s.code);
        sessionStorage.setItem('deviceId', deviceId);
        onSessionJoined(s);
      }
      if (msg.type === 'error') { setError(msg.payload.message); setIsCreating(false); setIsJoining(false); }
    };
    const handleJoinInv = (e: Event) => joinWithCode((e as CustomEvent).detail.sessionCode);
    window.addEventListener('sessionMessage', handleSessionMsg);
    window.addEventListener('joinSessionFromInvitation', handleJoinInv);
    return () => {
      window.removeEventListener('sessionMessage', handleSessionMsg);
      window.removeEventListener('joinSessionFromInvitation', handleJoinInv);
    };
  }, [sessionCode, deviceId]);

  useEffect(() => {
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'device_connected') {
        const device = normalizeDevice(msg.payload);
        if (device && device.id !== deviceId) setDevices(p => { const m = new Map(p); m.set(device.id, device); return m; });
      }
      if (msg.type === 'device_disconnected') setDevices(p => { const m = new Map(p); m.delete(msg.payload.deviceId); return m; });
      if (msg.type === 'session_joined' && msg.payload?.devices) {
        const dm = new Map<string, Device>();
        msg.payload.devices.forEach((d: any) => {
          const device = normalizeDevice(d);
          if (device && device.id !== deviceId) dm.set(device.id, device);
        });
        setDevices(dm);
        setStudyFileCount(msg.payload.studyStore?.length || 0);
        setGroupCount(msg.payload.groups?.length || 0);
      }
      if (msg.type === 'study_store_list') setStudyFileCount(msg.payload?.files?.length || 0);
      if (msg.type === 'chat_message') setMsgCount(p => p + 1);
      if (msg.type === 'group_created') setGroupCount(p => p + 1);
      if (msg.type === 'group_deleted') setGroupCount(p => Math.max(0, p - 1));
    };
    ws?.addEventListener('message', handler);
    return () => ws?.removeEventListener('message', handler);
  }, [session, deviceId]);

  const createSession = () => {
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) { setError('Not connected to server'); return; }
    setError(null); setIsCreating(true);
    ws.send(JSON.stringify({ type: 'session_create', payload: { deviceId, deviceName, deviceType: 'laptop', username }, timestamp: Date.now() }));
  };

  const joinWithCode = (code: string) => {
    if (!code || code.length !== 6) { setError('Enter a valid 6-digit code'); return; }
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) { setError('Not connected to server'); return; }
    setError(null); setIsJoining(true);
    ws.send(JSON.stringify({ type: 'session_join', payload: { code, deviceId, deviceName, deviceType: 'laptop', username }, timestamp: Date.now() }));
  };

  const leaveSession = () => {
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (ws?.readyState === WebSocket.OPEN && session) {
      ws.send(JSON.stringify({ type: 'session_leave', sessionId: session.id, deviceId, timestamp: Date.now() }));
    }
    setDevices(new Map());
    onLeaveSession();
  };

  const sendRemoteText = () => {
    if (!remoteText.trim() || !session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    const target = Array.from(devices.values())[0];
    if (!ws || !target) return;
    ws.send(JSON.stringify({ type: 'intent_send', sessionId: session.id, deviceId, payload: { targetDevice: target.id, intent: { intent_type: 'clipboard_sync', payload: { clipboard: { text: remoteText } }, timestamp: Date.now(), auto_open: false } }, timestamp: Date.now() }));
    setRemoteText('');
  };

  const onlineCount = session ? Array.from(devices.values()).filter(d => d.online).length + 1 : 0;
  const deviceArr = Array.from(devices.values());

  useEffect(() => {
    if (!session) {
      setDevices(new Map());
      return;
    }
    const next = new Map<string, Device>();
    session.devices.forEach((d, id) => {
      if (id !== deviceId) next.set(id, d);
    });
    setDevices(next);
  }, [session, deviceId]);

  // No session → session creation gate
  if (!session) {
    return (
      <div className="session-gate">
        <div className="sg-card card">
          <div className="sg-brand">
            <img src="/logo.png" alt="FlowLink" className="sg-logo-img" />
            <h2>FlowLink</h2>
            <p>Cross-Device Continuity</p>
          </div>
          <div className="sg-section">
            <div className="sg-section-label">Start a session</div>
            <button className="btn-primary sg-btn" onClick={createSession} disabled={isCreating}>
              {isCreating ? 'Creating…' : 'Create Session'}
            </button>
          </div>
          <div className="sg-divider">OR</div>
          <div className="sg-section">
            <div className="sg-section-label">Join existing session</div>
            <input
              className="sg-code-input"
              type="text"
              inputMode="numeric"
              placeholder="000000"
              maxLength={6}
              value={sessionCode}
              onChange={e => { setSessionCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
            />
            <button className="btn-primary sg-btn" onClick={() => joinWithCode(sessionCode)} disabled={sessionCode.length !== 6 || isJoining}>
              {isJoining ? 'Joining…' : 'Join Session'}
            </button>
            {error && <div className="sg-error">{error}</div>}
          </div>
        </div>
      </div>
    );
  }

  // Active session → dashboard
  return (
    <div className="overview-page">
      <div className="overview-session-card card">
        <div className="osc-header">
          <div>
            <div className="osc-title">Connected Devices</div>
            <div className="osc-sub">Collaborate and connect seamlessly across all your devices.</div>
          </div>
          <div className="osc-actions">
            <button className="osc-action-btn code-btn" onClick={() => navigator.clipboard.writeText(session.code)}>{session.code}</button>
            <button className="osc-action-btn" onClick={() => setShowInvite(true)}>Invite</button>
            <button className="osc-action-btn" onClick={() => navigate('/study')}>Study</button>
            <button className="osc-action-btn" onClick={() => navigate('/messages')}>Chat</button>
            <button className="osc-action-btn danger" onClick={leaveSession}>Leave</button>
          </div>
        </div>
        <div className="overview-stats">
          {[
            { label: 'Online', num: onlineCount, sub: 'Active now', color: '#16a34a', bg: 'rgba(34,197,94,0.12)', onClick: undefined },
            { label: 'Files', num: studyFileCount, sub: 'Shared files', color: '#d97706', bg: 'rgba(245,158,11,0.12)', onClick: () => navigate('/files') },
            { label: 'Messages', num: msgCount, sub: 'Unread', color: '#2563eb', bg: 'rgba(59,130,246,0.12)', onClick: () => navigate('/messages') },
            { label: 'Groups', num: groupCount, sub: 'Active groups', color: '#7c3aed', bg: 'rgba(139,92,246,0.12)', onClick: () => navigate('/groups') },
          ].map(s => (
            <div key={s.label} className="stat-tile" onClick={s.onClick} style={{ cursor: s.onClick ? 'pointer' : 'default' }}>
              <div className="stat-body">
                <div className="stat-num" style={{ color: s.color }}>{s.num}</div>
                <div className="stat-lbl">{s.label}</div>
                <div className="stat-sub" style={{ color: s.color }}>{s.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="overview-bottom">
        <div className="card connect-card">
          <div className="connect-card-title">Connect a Device</div>
          <div className="connect-card-sub">Scan the QR code from another device to connect instantly.</div>
          <div className="connect-body">
            <div className="qr-wrap">
              <div className="qr-box"><QRCodeSVG value={session.code} size={130} /></div>
            </div>
            <div className="connect-right">
              <div className="connect-code-label">Your Connection Code</div>
              <div className="connect-code">{session.code}</div>
              <div className="connect-secure">Secure connection · End-to-end encrypted</div>
            </div>
          </div>
        </div>

        <div className="card your-devices-card">
          <div className="yd-header">
            <div>
              <div className="connect-card-title">Your Devices</div>
              <div className="connect-card-sub">Manage and control your connected devices.</div>
            </div>
            <button className="btn-primary" style={{ fontSize: '0.78rem', padding: '0.45rem 0.85rem' }} onClick={() => setShowInvite(true)}>+ Add Device</button>
          </div>
          <div className="yd-list">
            <div className="yd-item">
              <div className="yd-icon yd-icon-laptop" />
              <div className="yd-info">
                <div className="yd-name">{username}</div>
                <div className="yd-sub">{deviceName} · <span style={{ color: '#16a34a' }}>Online</span></div>
              </div>
              <div className="yd-perms"><span className="perm-badge">Permissions</span><span className="perm-none">None</span></div>
            </div>
            {deviceArr.map(d => (
              <div key={d.id} className="yd-item">
                <div className={`yd-icon yd-icon-${d.type === 'phone' ? 'phone' : 'laptop'}`} />
                <div className="yd-info">
                  <div className="yd-name">{d.username || d.name}</div>
                  <div className="yd-sub">{d.name} · <span style={{ color: d.online ? '#16a34a' : '#94a3b8' }}>{d.online ? 'Online' : 'Offline'}</span></div>
                </div>
                <div className="yd-perms">
                  <span className="perm-badge">Permissions</span>
                  <span className="perm-none">{Object.values(d.permissions || {}).some(Boolean) ? 'Active' : 'None'}</span>
                </div>
              </div>
            ))}
            {deviceArr.length === 0 && <div className="yd-empty">Waiting for other devices to join…</div>}
          </div>
          <div className="remote-access-row">
            <div className="ra-label">Enable Remote Access <span className="ra-info" title="Send text/clipboard to connected device">ⓘ</span></div>
            <label className="toggle">
              <input type="checkbox" checked={remoteEnabled} onChange={e => setRemoteEnabled(e.target.checked)} />
              <span className="toggle-slider" />
            </label>
          </div>
          {remoteEnabled && (
            <div className="ra-send-row">
              <input className="ra-input" placeholder="Type or paste text to send" value={remoteText} onChange={e => setRemoteText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') sendRemoteText(); }} />
              <button className="btn-primary" onClick={sendRemoteText} style={{ fontSize: '0.8rem' }}>Send</button>
            </div>
          )}
        </div>
      </div>

      <InvitationPanel sessionId={session.id} sessionCode={session.code} invitationService={invitationService} isOpen={showInvite} onClose={() => setShowInvite(false)} />
    </div>
  );
}
