import { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Session } from '@shared/types';
import InvitationService from '../services/InvitationService';
import './SessionManager.css';

interface SessionManagerProps {
  deviceId: string;
  deviceName: string;
  deviceType: 'phone' | 'laptop' | 'desktop' | 'tablet';
  username: string;
  invitationService: InvitationService | null;
  onSessionCreated: (session: Session) => void;
  onSessionJoined: (session: Session) => void;
}

export default function SessionManager({
  deviceId,
  deviceName,
  deviceType,
  username,
  onSessionCreated,
  onSessionJoined,
}: SessionManagerProps) {
  const [sessionCode, setSessionCode] = useState('');
  const [createdSession, setCreatedSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const joinSessionWithCode = async (code: string) => {
    if (!code || code.length !== 6) { setError('Enter a valid 6-digit code'); return; }
    try {
      setError(null);
      setIsJoining(true);
      const ws = (window as any).appWebSocket;
      if (!ws || ws.readyState !== WebSocket.OPEN) { setError('Not connected to server'); setIsJoining(false); return; }
      sessionStorage.setItem('pendingSessionCode', code);
      sessionStorage.setItem('pendingJoinDeviceId', deviceId);
      ws.send(JSON.stringify({ type: 'session_join', payload: { code, deviceId, deviceName, deviceType, username }, timestamp: Date.now() }));
    } catch { setError('Failed to join session'); setIsJoining(false); }
  };

  useEffect(() => {
    const handleJoinFromInvitation = (event: Event) => joinSessionWithCode((event as CustomEvent).detail.sessionCode);
    const handleSessionMessage = (event: Event) => handleWebSocketMessage((event as CustomEvent).detail.message);
    window.addEventListener('joinSessionFromInvitation', handleJoinFromInvitation);
    window.addEventListener('sessionMessage', handleSessionMessage);
    return () => {
      wsRef.current?.close();
      window.removeEventListener('joinSessionFromInvitation', handleJoinFromInvitation);
      window.removeEventListener('sessionMessage', handleSessionMessage);
    };
  }, [sessionCode]);

  const handleWebSocketMessage = (message: any) => {
    setIsCreating(false);
    setIsJoining(false);
    switch (message.type) {
      case 'session_created': {
        const session: Session = {
          id: message.payload.sessionId,
          code: message.payload.code,
          createdBy: deviceId,
          createdAt: Date.now(),
          expiresAt: message.payload.expiresAt,
          devices: new Map([[deviceId, { id: deviceId, name: deviceName, username, type: deviceType, online: true, permissions: { files: false, media: false, prompts: false, clipboard: false, remote_browse: false }, joinedAt: Date.now(), lastSeen: Date.now() }]]),
        };
        sessionStorage.setItem('sessionId', session.id);
        sessionStorage.setItem('sessionCode', session.code);
        sessionStorage.setItem('deviceId', deviceId);
        setCreatedSession(session);
        onSessionCreated(session);
        break;
      }
      case 'session_joined': {
        const joinedSession: Session = {
          id: message.payload.sessionId,
          code: sessionCode || '',
          createdBy: message.payload.devices[0]?.id || '',
          createdAt: Date.now(),
          expiresAt: Date.now() + 3600000,
          devices: new Map(message.payload.devices.map((d: any) => [d.id, { id: d.id, name: d.name, username: d.username, type: d.type, online: d.online, permissions: d.permissions, joinedAt: d.joinedAt, lastSeen: Date.now() }])),
        };
        sessionStorage.setItem('sessionId', joinedSession.id);
        sessionStorage.setItem('sessionCode', joinedSession.code);
        sessionStorage.setItem('deviceId', deviceId);
        sessionStorage.removeItem('pendingSessionCode');
        sessionStorage.removeItem('pendingJoinDeviceId');
        onSessionJoined(joinedSession);
        break;
      }
      case 'device_connected': {
        if (!createdSession && !sessionCode) break;
        const device = message.payload?.device;
        if (!device?.id) break;
        const current = createdSession || null;
        if (current && !current.devices.has(device.id)) {
          const devices = new Map(current.devices);
          devices.set(device.id, device);
          const next = { ...current, devices };
          setCreatedSession(next);
          onSessionCreated(next);
        }
        break;
      }
      case 'error':
        setError(message.payload.message);
        break;
    }
  };

  const handleCreateSession = async () => {
    try {
      setError(null);
      setIsCreating(true);
      const ws = (window as any).appWebSocket;
      if (!ws || ws.readyState !== WebSocket.OPEN) { setError('Not connected to server'); setIsCreating(false); return; }
      ws.send(JSON.stringify({ type: 'session_create', payload: { deviceId, deviceName, deviceType, username }, timestamp: Date.now() }));
    } catch { setError('Failed to create session'); setIsCreating(false); }
  };

  return (
    <div className="session-manager">
      <div className="session-manager-inner">
        {/* Brand */}
        <div className="session-brand">
          <img src="/logo.png" alt="FlowLink" className="session-brand-logo" />
          <h2>FlowLink</h2>
          <p>Cross-Device Continuity</p>
        </div>

        {/* Actions card */}
        <div className="session-card">
          <div className="session-card-title">Start a session</div>
          <button className="btn-create" onClick={handleCreateSession} disabled={isCreating}>
            {isCreating ? 'Creating…' : 'Create Session'}
          </button>
        </div>

        {/* Divider */}
        <div className="session-divider">OR</div>

        {/* Join card */}
        <div className="session-card">
          <div className="session-card-title">Join existing session</div>
          <input
            className="session-code-input"
            type="text"
            inputMode="numeric"
            value={sessionCode}
            onChange={(e) => { setSessionCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
            placeholder="000000"
            maxLength={6}
          />
          <button
            className="btn-join"
            onClick={() => joinSessionWithCode(sessionCode)}
            disabled={sessionCode.length !== 6 || isJoining}
          >
            {isJoining ? 'Joining…' : 'Join Session'}
          </button>
          {error && <div className="session-error">{error}</div>}
        </div>

        {/* QR display (shown after create, before DeviceTiles loads) */}
        {createdSession && (
          <div className="session-created-card" style={{ marginTop: '1rem' }}>
            <div className="session-code-label">Share this code</div>
            <div className="session-code-display">{createdSession.code}</div>
            <div className="session-qr-wrapper">
              <QRCodeSVG value={createdSession.code} size={200} />
            </div>
            <div className="session-waiting">
              <div className="session-waiting-dot" />
              <div className="session-waiting-dot" />
              <div className="session-waiting-dot" />
              <span>Waiting for devices…</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
