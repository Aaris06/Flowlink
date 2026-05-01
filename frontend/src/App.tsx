import { Component, ReactNode, useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Session } from '@shared/types';
import { generateDeviceId } from '@shared/utils';
import InvitationService from './services/InvitationService';
import { friendService } from './services/FriendService';
import { SIGNALING_WS_URL } from './config/signaling';
import OverviewPage from './pages/OverviewPage';
import MyDevicesPage from './pages/MyDevicesPage';
import GroupsPage from './pages/GroupsPage';
import MessagesPage from './pages/MessagesPage';
import FilesPage from './pages/FilesPage';
import ActivityPage from './pages/ActivityPage';
import SettingsPage from './pages/SettingsPage';
import StudyPage from './pages/StudyPage';
import StudyRoomPage from './pages/StudyRoomPage';
import RemoteAccess from './components/RemoteAccess';
import DownloadPage from './components/DownloadPage';
import UsernameModal from './components/UsernameModal';
import './App.css';

export interface AppContext {
  session: Session | null;
  deviceId: string;
  deviceName: string;
  username: string;
  invitationService: InvitationService | null;
  onSessionCreated: (s: Session) => void;
  onSessionJoined: (s: Session) => void;
  onLeaveSession: () => void;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('FlowLink UI error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-shell">
          <main className="page-content" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
            <div className="card" style={{ maxWidth: 420, padding: 24, textAlign: 'center' }}>
              <h2>FlowLink needs a quick refresh</h2>
              <p style={{ color: '#64748b' }}>A temporary UI error occurred, but your session can usually reconnect.</p>
              <button className="btn-primary" onClick={() => window.location.reload()}>Refresh</button>
            </div>
          </main>
        </div>
      );
    }

    return this.props.children;
  }
}
function Shell() {
  const [session, setSession] = useState<Session | null>(null);
  const [deviceId] = useState(() => generateDeviceId());
  const [deviceName] = useState(() => (navigator as any).userAgentData?.platform || 'Laptop');
  const [username, setUsername] = useState<string | null>(() => localStorage.getItem('flowlink_username'));
  const [invitationService, setInvitationService] = useState<InvitationService | null>(null);
  const [chatUnread, setChatUnread] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // CRITICAL FIX #6: Persist inbox unread count to localStorage
  const [inboxUnread, setInboxUnread] = useState(() => {
    const stored = localStorage.getItem('flowlink_inbox_unread');
    return stored ? parseInt(stored, 10) : friendService.getInbox().filter(r => r.status === 'pending').length;
  });

  // Persist inbox unread count
  useEffect(() => {
    localStorage.setItem('flowlink_inbox_unread', inboxUnread.toString());
  }, [inboxUnread]);
  const [isConnected, setIsConnected] = useState(false);
  const invitationServiceRef = useRef<InvitationService | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  const connectWebSocket = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;
    const ws = new WebSocket(SIGNALING_WS_URL);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'device_register', payload: { deviceId, deviceName, deviceType: 'laptop', username }, timestamp: Date.now() }));
      wsRef.current = ws;
      (window as any).appWebSocket = ws;
      setIsConnected(true);
      if (invitationServiceRef.current) invitationServiceRef.current.setWebSocket(ws);
    };
    ws.onmessage = (e) => handleWebSocketMessage(JSON.parse(e.data));
    ws.onclose = () => { 
      wsRef.current = null; 
      (window as any).appWebSocket = null; 
      setIsConnected(false);
      setTimeout(connectWebSocket, 2000); 
    };
    ws.onerror = () => { setIsConnected(false); };
    wsRef.current = ws;
    return ws;
  };

  const handleWebSocketMessage = (message: any) => {
    switch (message.type) {
      case 'session_created':
      case 'session_joined':
        window.dispatchEvent(new CustomEvent('sessionMessage', { detail: { message } }));
        break;
      case 'chat_message':
      case 'chat_delivered':
      case 'chat_seen':
      case 'chat_typing':
        window.dispatchEvent(new CustomEvent('chatMessage', { detail: { message } }));
        if (message.type === 'chat_message') {
          setChatUnread(p => p + 1);
          // Buffer message in sessionStorage so MessagesPage gets it even if not mounted
          try {
            const chat = message.payload?.chat;
            if (chat?.messageId) {
              const sessionId = message.sessionId || message.payload?.sessionId;
              const key = `flowlink_messages_${sessionId || 'none'}`;
              const stored = sessionStorage.getItem(key);
              const msgs: any[] = stored ? JSON.parse(stored) : [];
              if (!msgs.find((m: any) => m.messageId === chat.messageId)) {
                // Normalize attachment format (mobile sends flat fields)
                let attachment = chat.attachment;
                if (!attachment && chat.fileId && chat.fileName) {
                  attachment = { name: chat.fileName, type: chat.fileType || 'application/octet-stream', size: chat.fileSize || 0, data: chat.fileData || '' };
                }
                const text = attachment
                  ? (chat.text?.replace(/^📎\s*/, '') === chat.fileName ? '' : (chat.text?.replace(/^📎\s*/, '') || ''))
                  : (chat.text || '');
                msgs.push({
                  messageId: chat.messageId,
                  text,
                  username: chat.username || 'Unknown',
                  sourceDevice: message.payload?.sourceDevice || '',
                  sentAt: chat.sentAt || Date.now(),
                  delivered: true,
                  seen: false,
                  replyTo: chat.replyTo,
                  attachment,
                });
                sessionStorage.setItem(key, JSON.stringify(msgs.slice(-200)));
              }
            }
          } catch { /* ignore storage errors */ }
        }
        break;
      case 'session_invitation':
        if (invitationServiceRef.current) {
          const inv = message.payload.invitation;
          invitationServiceRef.current.handleIncomingInvitation(inv);
          invitationServiceRef.current.storeInvitationData(inv.sessionId, inv.sessionCode);
        }
        break;
      case 'nearby_session_broadcast':
        if (invitationServiceRef.current) {
          const ns = message.payload.nearbySession;
          invitationServiceRef.current.handleNearbySession(ns);
          invitationServiceRef.current.storeInvitationData(ns.sessionId, ns.sessionCode);
        }
        break;
      case 'invitation_response':
        if (invitationServiceRef.current) {
          const r = message.payload;
          invitationServiceRef.current.notificationService.showToast({
            type: r.accepted ? 'success' : 'info',
            title: r.accepted ? 'Invitation Accepted' : 'Invitation Declined',
            message: `${r.inviteeUsername} ${r.accepted ? 'accepted' : 'declined'} your invitation`,
            duration: 3500,
          });
        }
        break;
      case 'invitation_sent':
        if (invitationServiceRef.current) {
          invitationServiceRef.current.notificationService.showToast({
            type: 'success', title: 'Invitation Sent',
            message: `Sent to ${message.payload.targetUsername || message.payload.targetIdentifier}`,
            duration: 3000,
          });
        }
        break;
      case 'media_handoff_offer':
        if (invitationServiceRef.current) {
          const m = message.payload;
          const ts = m.timestamp || 0;
          const tsText = ts > 0 ? ` at ${Math.floor(ts / 60)}:${(ts % 60).toString().padStart(2, '0')}` : '';
          let url = m.url;
          if (ts > 0 && m.url?.includes('youtube.com')) url += `${m.url.includes('?') ? '&' : '?'}t=${Math.floor(ts)}`;
          invitationServiceRef.current.notificationService.showToast({
            type: 'info', title: `Continue on ${m.platform || 'this device'}?`,
            message: `${m.title}${tsText}`, duration: 10000,
            actions: [{ id: 'open', label: 'Open', action: 'accept' as const }, { id: 'dismiss', label: 'Dismiss', action: 'dismiss' as const }],
            onAction: (id: string) => { if (id === 'open') window.open(url, '_blank'); },
          });
        }
        break;
      case 'clipboard_sync': {
        const txt = message.payload?.clipboard?.text || message.payload?.clipboard?.url;
        if (txt) navigator.clipboard.writeText(txt).catch(() => {});
        break;
      }
      case 'link_open': {
        const linkJson = message.payload?.link;
        if (linkJson) {
          try {
            const url = typeof linkJson === 'string' ? JSON.parse(linkJson).url : linkJson.url;
            if (url) window.open(url, '_blank', 'noopener,noreferrer');
          } catch { /* ignore parse errors */ }
        }
        break;
      }
      case 'tab_handoff_offer': {
        // Extension sent active tab or window tabs - open them
        const tabs: any[] = message.payload?.tabs || [];
        const source = message.payload?.sourceUsername || message.payload?.sourceDeviceName || 'Extension';
        if (tabs.length === 1) {
          const url = tabs[0]?.url;
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
          if (invitationServiceRef.current) {
            invitationServiceRef.current.notificationService.showToast({
              type: 'success', title: `Tab received from ${source}`,
              message: tabs[0]?.title || url, duration: 4000,
            });
          }
        } else if (tabs.length > 1) {
          // Open all tabs
          tabs.forEach((tab: any) => {
            if (tab?.url) window.open(tab.url, '_blank', 'noopener,noreferrer');
          });
          if (invitationServiceRef.current) {
            invitationServiceRef.current.notificationService.showToast({
              type: 'success', title: `${tabs.length} tabs received from ${source}`,
              message: message.payload?.collectionTitle || '', duration: 4000,
            });
          }
        }
        break;
      }
      case 'file_transfer_start':
        // Only buffer if MyDevicesPage is NOT mounted (it handles transfers itself)
        if (!(window as any)._myDevicesPageMounted) {
          (window as any)._ftBuffers = (window as any)._ftBuffers || {};
          (window as any)._ftBuffers[message.payload?.transferId] = {
            fileName: message.payload?.fileName || 'file',
            fileType: message.payload?.fileType || 'application/octet-stream',
            totalBytes: message.payload?.totalBytes || 0,
            chunks: [] as Uint8Array[],
          };
        }
        break;
      case 'file_transfer_chunk': {
        const buf = (window as any)._ftBuffers?.[message.payload?.transferId];
        if (buf && message.payload?.data) {
          try {
            const b64 = message.payload.data as string;
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            buf.chunks.push(bytes);
          } catch { /* ignore bad chunk */ }
        }
        break;
      }
      case 'file_transfer_complete': {
        const buf = (window as any)._ftBuffers?.[message.payload?.transferId];
        if (buf) {
          try {
            const totalLen = (buf.chunks as Uint8Array[]).reduce((s: number, c: Uint8Array) => s + c.length, 0);
            const merged = new Uint8Array(totalLen);
            let pos = 0;
            for (const chunk of buf.chunks as Uint8Array[]) { merged.set(chunk, pos); pos += chunk.length; }
            const blob = new Blob([merged], { type: buf.fileType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = buf.fileName; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
            if (invitationServiceRef.current) {
              invitationServiceRef.current.notificationService.showToast({
                type: 'success', title: `File received: ${buf.fileName}`, message: '', duration: 4000,
              });
            }
          } catch { /* ignore */ }
          delete (window as any)._ftBuffers[message.payload?.transferId];
        }
        break;
      }
      case 'friend_request':
      case 'friend_request_response':
      case 'sos_alert':
        friendService.handleIncoming(message, username || '', deviceId);
        if (message.type === 'friend_request') {
          setInboxUnread(p => {
            const newCount = p + 1;
            localStorage.setItem('flowlink_inbox_unread', newCount.toString());
            return newCount;
          });
        }
        break;
    }
  };

  const joinSessionWithCode = (sessionCode: string) => {
    setSession(null);
    window.dispatchEvent(new CustomEvent('joinSessionFromInvitation', { detail: { sessionCode } }));
  };

  useEffect(() => {
    if (!username) return;
    if (!invitationServiceRef.current) {
      const svc = new InvitationService(deviceId, username, deviceName, (code) => joinSessionWithCode(code));
      invitationServiceRef.current = svc;
      setInvitationService(svc);
    }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) connectWebSocket();
    return () => { wsRef.current?.close(); };
  }, [username]);

  useEffect(() => {
    if (invitationServiceRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      invitationServiceRef.current.setWebSocket(wsRef.current);
    }
  }, [invitationService]);

  useEffect(() => {
    if (location.pathname === '/messages') setChatUnread(0);
    if (location.pathname === '/settings') {
      setInboxUnread(0);
      localStorage.setItem('flowlink_inbox_unread', '0');
    }
    setSidebarOpen(false); // close sidebar on navigation
  }, [location.pathname]);

  // Handle tab visibility - reconnect WebSocket when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // Tab visible - reconnect WebSocket if disconnected
        if (wsRef.current?.readyState !== WebSocket.OPEN) {
          connectWebSocket();
        }
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const ctx: AppContext = {
    session, deviceId, deviceName, username: username || '',
    invitationService,
    onSessionCreated: setSession,
    onSessionJoined: setSession,
    onLeaveSession: () => setSession(null),
  };

  const navItems: { to: string; icon: string; label: string; badge?: number }[] = [
    { to: '/', icon: '🏠', label: 'Overview' },
    { to: '/devices', icon: '📱', label: 'My Devices' },
    { to: '/messages', icon: '💬', label: 'Messages', badge: chatUnread },
    { to: '/files', icon: '📁', label: 'Files' },
    { to: '/activity', icon: '⚡', label: 'Activity' },
    { to: '/study', icon: '📚', label: 'Study' },
    { to: '/settings', icon: '⚙️', label: 'Settings', badge: inboxUnread },
  ];

  const pageTitles: Record<string, { title: string; sub: string }> = {
    '/': { title: `Welcome back, ${username || 'User'}! 👋`, sub: 'All your devices are in sync and ready to go.' },
    '/devices': { title: 'My Devices', sub: 'Manage and control your connected devices.' },
    '/groups': { title: 'Groups', sub: 'Organize devices into groups for broadcast.' },
    '/messages': { title: 'Messages', sub: 'Chat with connected devices.' },
    '/files': { title: 'Files', sub: 'Shared files across your session.' },
    '/activity': { title: 'Activity', sub: 'Recent actions and events.' },
    '/study': { title: 'Study', sub: 'Collaborative document viewer.' },
    '/study/room': { title: 'Study Room', sub: 'Synchronized reading session.' },
    '/settings': { title: 'Settings', sub: 'Preferences and configuration.' },
  };
  const pt = pageTitles[location.pathname] || { title: 'FlowLink', sub: '' };

  return (
    <div className="app-shell">
      <UsernameModal
        isOpen={!username}
        onSubmit={(u) => { localStorage.setItem('flowlink_username', u); setUsername(u); }}
        deviceName={deviceName}
      />

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-logo">⚡</div>
          <div className="sidebar-brand-text">
            <h1>FlowLink</h1>
            <p>Cross-Device Continuity</p>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
              {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <NavLink to="/settings" className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <span className="nav-icon">🎨</span> Theme
          </NavLink>
          <a href="https://github.com" target="_blank" rel="noreferrer" className="nav-item">
            <span className="nav-icon">❓</span> Help & Support
          </a>
        </div>
      </aside>

      <div className="main-content">
        <header className="top-header">
          <div className="top-header-left" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button className="hamburger-btn" onClick={() => setSidebarOpen(o => !o)} aria-label="Menu">
              ☰
            </button>
            <div>
              <h2>{pt.title}</h2>
              <p>{pt.sub}</p>
            </div>
          </div>
          <div className="top-header-right">
            {/* CRITICAL FIX #5: Reconnect button in top-right header */}
            {!isConnected && (
              <button 
                className="header-reconnect-btn" 
                onClick={() => {
                  if (wsRef.current) wsRef.current.close();
                  connectWebSocket();
                }}
                title="Reconnect to server"
              >
                🔄 Reconnect
              </button>
            )}
            <button className="header-notif-btn" title="Notifications">
              🔔<span className="notif-dot" />
            </button>
            {session && (
              <div className="session-badge-header" onClick={() => navigate('/')}>
                <span className="dot" />
                {session.code}
              </div>
            )}
            <div className="header-user">
              <div className="header-avatar">{(username || 'U')[0].toUpperCase()}</div>
              <span className="header-user-name">{username || 'User'}</span>
              <span className="header-user-caret">▾</span>
            </div>
          </div>
        </header>

        <main className="page-content">
          <Routes>
            <Route path="/" element={<OverviewPage ctx={ctx} />} />
            <Route path="/devices" element={<MyDevicesPage ctx={ctx} />} />
            <Route path="/groups" element={<GroupsPage ctx={ctx} />} />
            <Route path="/messages" element={<MessagesPage ctx={ctx} />} />
            <Route path="/files" element={<FilesPage ctx={ctx} />} />
            <Route path="/activity" element={<ActivityPage ctx={ctx} />} />
            <Route path="/settings" element={<SettingsPage ctx={ctx} />} />
            <Route path="/study" element={<StudyPage ctx={ctx} />} />
            <Route path="/study/room" element={<StudyRoomPage ctx={ctx} />} />
            <Route path="/download" element={<DownloadPage />} />
            <Route path="/remote/:deviceId" element={<RemoteAccess />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </AppErrorBoundary>
  );
}
