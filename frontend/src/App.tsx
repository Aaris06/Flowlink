import { Component, ReactNode, useState, useEffect, useRef } from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Session } from '@shared/types';
import { generateDeviceId } from '@shared/utils';
import InvitationService from './services/InvitationService';
import { friendService } from './services/FriendService';
import { authService } from './services/AuthService';
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
import AdminPage from './pages/AdminPage';
import AuthPage from './pages/AuthPage';
import RemoteAccess from './components/RemoteAccess';
import DownloadPage from './components/DownloadPage';
import CallModal from './components/CallModal';
import GroupCallModal from './components/GroupCallModal';
import CallsPage from './pages/CallsPage';
import { CallService, CallState, CallInfo } from './services/CallService';
import { GroupCallService, GroupCallState, GroupCallRoom } from './services/GroupCallService';
import './App.css';

export interface AppContext {
  session: Session | null;
  deviceId: string;
  deviceName: string;
  username: string;
  invitationService: InvitationService | null;
  callService: CallService | null;
  groupCallService: GroupCallService | null;
  onSessionCreated: (s: Session) => void;
  onSessionJoined: (s: Session) => void;
  onLeaveSession: () => void;
  onLogout: () => void;
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
  const [username, setUsername] = useState<string | null>(() => authService.getUsername());
  const [authChecked, setAuthChecked] = useState(false);
  const [invitationService, setInvitationService] = useState<InvitationService | null>(null);
  const [chatUnread, setChatUnread] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('flowlink_theme') === 'dark');
  const [showNotifPanel, setShowNotifPanel] = useState(false);
  const [notifications, setNotifications] = useState<{ id: number; title: string; message: string; type: string; time: number }[]>([]);

  // Apply theme on mount and change
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkMode ? 'dark' : 'light');
    localStorage.setItem('flowlink_theme', darkMode ? 'dark' : 'light');
  }, [darkMode]);
  const [inboxUnread, setInboxUnread] = useState(() => {
    const stored = localStorage.getItem('flowlink_inbox_unread');
    return stored ? parseInt(stored, 10) : 0;
  });

  // Verify token on mount and sync DB data
  useEffect(() => {
    authService.verifyToken().then(async u => {
      if (u) {
        setUsername(u);
        // Sync friends and inbox from DB
        await friendService.syncFromDb();
        // Update badge to match actual pending count from DB
        const pending = friendService.getInbox().filter(r => r.status === 'pending').length;
        setInboxUnread(pending);
        localStorage.setItem('flowlink_inbox_unread', pending.toString());
      } else {
        setUsername(null);
      }
      setAuthChecked(true);
    });
  }, []);

  // Persist inbox unread count
  useEffect(() => {
    localStorage.setItem('flowlink_inbox_unread', inboxUnread.toString());
  }, [inboxUnread]);
  const [isConnected, setIsConnected] = useState(false);
  const invitationServiceRef = useRef<InvitationService | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const location = useLocation();
  const navigate = useNavigate();

  // ── Call state ──────────────────────────────────────────────────────────
  const [callState, setCallState] = useState<CallState>('idle');
  const [callInfo, setCallInfo] = useState<CallInfo | null>(null);
  const callServiceRef = useRef<CallService | null>(null);
  if (!callServiceRef.current) {
    callServiceRef.current = new CallService(
      '', // deviceId not available yet – updated below
      '',
      (state, info) => { setCallState(state); setCallInfo(info); }
    );
  }

  // ── Group call state ─────────────────────────────────────────────────────
  const [groupCallState, setGroupCallState] = useState<GroupCallState>('idle');
  const [groupCallRoom, setGroupCallRoom] = useState<GroupCallRoom | null>(null);
  const groupCallServiceRef = useRef<GroupCallService | null>(null);
  if (!groupCallServiceRef.current) {
    groupCallServiceRef.current = new GroupCallService(
      '', // deviceId not available yet – updated below
      '',
      (state, room) => { setGroupCallState(state); setGroupCallRoom(room); }
    );
  }

  const connectWebSocket = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;
    const ws = new WebSocket(SIGNALING_WS_URL);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'device_register',
        payload: { deviceId, deviceName, deviceType: 'laptop', username, token: authService.getToken() },
        timestamp: Date.now()
      }));
      wsRef.current = ws;
      (window as any).appWebSocket = ws;
      (window as any).__flowlink_username = (username || '').toLowerCase();
      setIsConnected(true);
      if (invitationServiceRef.current) invitationServiceRef.current.setWebSocket(ws);
      // Give CallService the live websocket and identity
      if (callServiceRef.current) {
        (callServiceRef.current as any).deviceId = deviceId;
        (callServiceRef.current as any).username = username || '';
        callServiceRef.current.setWebSocket(ws);
      }
      // Give GroupCallService the live websocket and identity
      if (groupCallServiceRef.current) {
        groupCallServiceRef.current.updateIdentity(deviceId, username || '');
        groupCallServiceRef.current.setWebSocket(ws);
      }
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

  const addNotification = (title: string, message: string, type: string = 'info') => {
    setNotifications(p => [{ id: Date.now(), title, message, type, time: Date.now() }, ...p].slice(0, 50));
  };

  const normalizeDevice = (payload: any) => {
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

  const syncSessionDevices = (updater: (prev: Session | null) => Session | null) => {
    setSession(prev => {
      const next = updater(prev);
      if (next?.devices) {
        (window as any)._sessionDevices = Array.from(next.devices.values());
      }
      return next;
    });
  };

  const handleWebSocketMessage = (message: any) => {
    switch (message.type) {
      case 'session_created':
      case 'session_joined':
      case 'device_connected':
      case 'device_disconnected':
      case 'session_expired':
        window.dispatchEvent(new CustomEvent('sessionMessage', { detail: { message } }));
        if (message.type === 'session_created' || message.type === 'session_joined') {
          // Keep a global snapshot of session devices for call routing
          if (message.payload?.devices) {
            (window as any)._sessionDevices = message.payload.devices;
          }
        }

        if (message.type === 'session_joined' && Array.isArray(message.payload?.devices)) {
          syncSessionDevices(prev => {
            const devices = new Map<string, any>();
            message.payload.devices.forEach((d: any) => {
              const device = normalizeDevice(d);
              if (device) devices.set(device.id, device);
            });
            return prev ? { ...prev, id: message.payload.sessionId || prev.id, devices } : prev;
          });
        }

        if (message.type === 'device_connected') {
          const device = normalizeDevice(message.payload);
          if (device) {
            syncSessionDevices(prev => {
              if (!prev) return prev;
              const devices = new Map(prev.devices);
              devices.set(device.id, device);
              return { ...prev, devices };
            });
          }
        }

        if (message.type === 'device_disconnected') {
          const deviceId = message.payload?.deviceId || message.payload?.device?.id;
          if (deviceId) {
            syncSessionDevices(prev => {
              if (!prev) return prev;
              const devices = new Map(prev.devices);
              devices.delete(deviceId);
              return { ...prev, devices };
            });
          }
        }

        if (message.type === 'session_expired') {
          syncSessionDevices(() => null);
        }
        break;
      case 'chat_message':
      case 'chat_delivered':
      case 'chat_seen':
      case 'chat_typing':
        window.dispatchEvent(new CustomEvent('chatMessage', { detail: { message } }));
        if (message.type === 'chat_message') {
          setChatUnread(p => p + 1);
          const chatText = message.payload?.chat?.text || '';
          if (chatText.startsWith('[[CALL_ACTIVITY]]')) {
            // call activity messages are displayed in chat, but don't duplicate into storage as plain text only
          }
          // Buffer message in sessionStorage so MessagesPage gets it even if not mounted
          try {
            const chat = message.payload?.chat;
            if (chat?.messageId) {
              const sessionId = message.sessionId || message.payload?.sessionId;
              const user = (username || localStorage.getItem('flowlink_username') || '').toLowerCase();
              const key = `flowlink_messages_${user}_${sessionId || 'none'}`;
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
        if (txt) {
          navigator.clipboard.writeText(txt).then(() => {
            if (invitationServiceRef.current) {
              const preview = txt.length > 60 ? txt.slice(0, 60) + '…' : txt;
              invitationServiceRef.current.notificationService.showToast({
                type: 'success',
                title: '📋 Copied to clipboard',
                message: preview,
                duration: 3000,
              });
            }
          }).catch(() => {});
        }
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
        // Extension sent active tab or window tabs
        // window.open() is blocked from WebSocket handlers - show toast with Open button instead
        const tabs: any[] = message.payload?.tabs || [];
        const source = message.payload?.sourceUsername || message.payload?.sourceDeviceName || 'Extension';
        if (!tabs.length || !invitationServiceRef.current) break;

        if (tabs.length === 1) {
          const url = tabs[0]?.url;
          const title = tabs[0]?.title || url;
          if (!url) break;
          invitationServiceRef.current.notificationService.showToast({
            type: 'info',
            title: `Tab from ${source}`,
            message: title,
            duration: 15000,
            actions: [
              { id: 'open', label: 'Open Tab', action: 'accept' as const },
              { id: 'dismiss', label: 'Dismiss', action: 'dismiss' as const },
            ],
            onAction: (id: string) => {
              if (id === 'open') window.open(url, '_blank', 'noopener,noreferrer');
            },
          });
        } else {
          const urls = tabs.map((t: any) => t?.url).filter(Boolean);
          invitationServiceRef.current.notificationService.showToast({
            type: 'info',
            title: `${tabs.length} tabs from ${source}`,
            message: message.payload?.collectionTitle || `${tabs.length} tabs`,
            duration: 15000,
            actions: [
              { id: 'open', label: `Open All ${tabs.length}`, action: 'accept' as const },
              { id: 'dismiss', label: 'Dismiss', action: 'dismiss' as const },
            ],
            onAction: (id: string) => {
              if (id === 'open') urls.forEach((url: string) => window.open(url, '_blank', 'noopener,noreferrer'));
            },
          });
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
            addNotification('File Received', buf.fileName, 'success');
          } catch { /* ignore */ }
          delete (window as any)._ftBuffers[message.payload?.transferId];
        }
        break;
      }
      case 'friend_request':
      case 'friend_request_response':
      case 'sos_alert':
        // Always read username from localStorage to avoid stale closure
        friendService.handleIncoming(message, localStorage.getItem('flowlink_username') || username || '', deviceId);
        if (message.type === 'friend_request') {
          addNotification('Friend Request', `${message.payload?.fromUsername} sent you a friend request`, 'info');
          setInboxUnread(p => {
            const newCount = p + 1;
            localStorage.setItem('flowlink_inbox_unread', newCount.toString());
            return newCount;
          });
        }
        break;
      case 'admin_announcement': {
        const ann = message.payload;
        if (invitationServiceRef.current && ann?.title) {
          invitationServiceRef.current.notificationService.showToast({
            type: ann.type === 'warning' ? 'warning' : ann.type === 'update' ? 'success' : 'info',
            title: ann.title,
            message: ann.message || '',
            duration: 12000,
          });
          addNotification(ann.title, ann.message || '', ann.type || 'info');
        }
        break;
      }
      case 'session_terminated': {
        if (invitationServiceRef.current) {
          invitationServiceRef.current.notificationService.showToast({
            type: 'warning',
            title: 'Session Terminated',
            message: message.payload?.reason || 'This session was terminated by an admin.',
            duration: 8000,
          });
        }
        setSession(null);
        break;
      }
      // ── Call signaling ──────────────────────────────────────────────────
      case 'call_invite':
      case 'call_accept':
      case 'call_reject':
      case 'call_end':
      case 'call_offer':
      case 'call_answer':
      case 'call_ice':
        if (callServiceRef.current) {
          callServiceRef.current.handleMessage(message);
        }
        break;
      // ── Group call signaling ─────────────────────────────────────────────
      case 'group_call_invite':
      case 'group_call_room_state':
      case 'group_call_peer_joined':
      case 'group_call_peer_left':
      case 'group_call_offer':
      case 'group_call_answer':
      case 'group_call_ice':
      case 'group_call_error':
        if (groupCallServiceRef.current) {
          groupCallServiceRef.current.handleMessage(message);
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

  // Close notification panel on outside click
  useEffect(() => {
    if (!showNotifPanel) return;
    const close = (e: MouseEvent) => {
      // Don't close if clicking the bell button itself (handled by toggle)
      const target = e.target as HTMLElement;
      if (target.closest('.header-notif-btn') || target.closest('.notif-panel')) return;
      setShowNotifPanel(false);
    };
    // Use setTimeout to avoid the same click that opened it from closing it
    const timer = setTimeout(() => document.addEventListener('click', close), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', close); };
  }, [showNotifPanel]);

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

  const handleLogout = () => {
    if (session) {
      const user = (username || '').toLowerCase().trim();
      sessionStorage.removeItem(`flowlink_messages_${user}_${session.id}`);
    }
    authService.logout();
    wsRef.current?.close();
    wsRef.current = null;
    (window as any).appWebSocket = null;
    setSession(null);
    setUsername(null);
    setChatUnread(0);
    setInboxUnread(0);
  };

  const isAdmin = authService.isAdmin();

  const ctx: AppContext = {
    session, deviceId, deviceName, username: username || '',
    invitationService,
    callService: callServiceRef.current,
    groupCallService: groupCallServiceRef.current,
    onSessionCreated: setSession,
    onSessionJoined: setSession,
    onLeaveSession: () => setSession(null),
    onLogout: handleLogout,
  };

  const navItems: { to: string; icon: string; label: string; badge?: number }[] = [
    { to: '/', icon: 'home', label: 'Overview' },
    { to: '/devices', icon: 'devices', label: 'My Devices' },
    { to: '/messages', icon: 'chat', label: 'Messages', badge: chatUnread },
    { to: '/calls', icon: 'call', label: 'Calls' },
    { to: '/files', icon: 'files', label: 'Files' },
    { to: '/activity', icon: 'activity', label: 'Activity' },
    { to: '/study', icon: 'study', label: 'Study' },
    { to: '/settings', icon: 'settings', label: 'Settings', badge: inboxUnread },
    ...(isAdmin ? [{ to: '/admin', icon: 'admin', label: 'Admin' }] : []),
  ];

  const pageTitles: Record<string, { title: string; sub: string }> = {
    '/': { title: `Welcome back, ${username || 'User'}! 👋`, sub: 'All your devices are in sync and ready to go.' },
    '/devices': { title: 'My Devices', sub: 'Manage and control your connected devices.' },
    '/calls': { title: 'Calls', sub: 'Audio and video calls with connected devices.' },
    '/groups': { title: 'Groups', sub: 'Organize devices into groups for broadcast.' },
    '/messages': { title: 'Messages', sub: 'Chat with connected devices.' },
    '/files': { title: 'Files', sub: 'Shared files across your session.' },
    '/activity': { title: 'Activity', sub: 'Recent actions and events.' },
    '/study': { title: 'Study', sub: 'Collaborative document viewer.' },
    '/study/room': { title: 'Study Room', sub: 'Synchronized reading session.' },
    '/settings': { title: 'Settings', sub: 'Preferences and configuration.' },
  };
  const pt = pageTitles[location.pathname] || { title: 'FlowLink', sub: '' };

  // Show loading while verifying token
  if (!authChecked) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#0f0c29,#302b63,#24243e)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
          <img src="/logo.png" alt="FlowLink" style={{ width: '80px', height: '80px', objectFit: 'cover', objectPosition: 'center', borderRadius: '50%' }} />
          <div style={{ color: '#a78bfa', fontSize: '1.1rem', fontWeight: 700 }}>Loading FlowLink…</div>
        </div>
      </div>
    );
  }

  // Show auth page if not logged in
  if (!username) {
    return <AuthPage onAuth={(u) => setUsername(u)} />;
  }

  return (
    <div className="app-shell">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="sidebar-brand">
          <div className="sidebar-logo">
            <img src="/logo.png" alt="FlowLink" style={{ width: '36px', height: '36px', objectFit: 'cover', objectPosition: 'center', borderRadius: '50%' }} />
          </div>
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
              <span className={`nav-icon nav-icon-${item.icon}`} />
              {item.label}
              {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="nav-item theme-toggle-btn" onClick={() => setDarkMode(d => !d)} title="Toggle dark/light mode">
            <span className={`nav-icon ${darkMode ? 'nav-icon-sun' : 'nav-icon-moon'}`} />
            {darkMode ? 'Light Mode' : 'Dark Mode'}
          </button>
          <a href="mailto:support@flowlink.app" className="nav-item">
            <span className="nav-icon nav-icon-help" /> Help & Support
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
                Reconnect
              </button>
            )}
            <div style={{ position: 'relative' }}>
              <button
                className={`header-notif-btn${notifications.length > 0 ? ' has-notif' : ''}`}
                title="Notifications"
                onClick={() => setShowNotifPanel(p => !p)}
              >
                {notifications.length > 0 && <span className="notif-dot" />}
              </button>
              {showNotifPanel && (
                <div className="notif-panel">
                  <div className="notif-panel-header">
                    <span>Notifications</span>
                    {notifications.length > 0 && (
                      <button className="notif-clear-btn" onClick={() => setNotifications([])}>Clear all</button>
                    )}
                  </div>
                  {notifications.length === 0
                    ? <div className="notif-empty">No notifications yet.</div>
                    : notifications.map(n => (
                        <div key={n.id} className={`notif-item notif-item-${n.type}`}>
                          <div className="notif-item-title">{n.title}</div>
                          {n.message && <div className="notif-item-msg">{n.message}</div>}
                          <div className="notif-item-time">{new Date(n.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                      ))
                  }
                </div>
              )}
            </div>
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
            <Route path="/calls" element={<CallsPage ctx={ctx} />} />
            <Route path="/groups" element={<GroupsPage ctx={ctx} />} />
            <Route path="/messages" element={<MessagesPage ctx={ctx} />} />
            <Route path="/files" element={<FilesPage ctx={ctx} />} />
            <Route path="/activity" element={<ActivityPage ctx={ctx} />} />
            <Route path="/settings" element={<SettingsPage ctx={ctx} />} />
            <Route path="/study" element={<StudyPage ctx={ctx} />} />
            <Route path="/study/room" element={<StudyRoomPage ctx={ctx} />} />
            <Route path="/admin" element={isAdmin ? <AdminPage ctx={ctx} /> : <Navigate to="/" replace />} />
            <Route path="/download" element={<DownloadPage />} />
            <Route path="/remote/:deviceId" element={<RemoteAccess />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>

      {/* Global call overlay — visible on top of everything */}
      {callServiceRef.current && (
        <CallModal
          callService={callServiceRef.current}
          state={callState}
          callInfo={callInfo}
        />
      )}

      {/* Group call overlay */}
      {groupCallServiceRef.current && (
        <GroupCallModal
          groupCallService={groupCallServiceRef.current}
          state={groupCallState}
          room={groupCallRoom}
        />
      )}
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
