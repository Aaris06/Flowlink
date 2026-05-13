import { useState, useEffect, useRef } from 'react';
import { AppContext } from '../App';
import { logActivity } from './ActivityPage';
import { friendService, Friend, FriendRequest, SosAlert } from '../services/FriendService';
import './SettingsPage.css';

interface Props { ctx: AppContext; }
type Tab = 'session' | 'chat' | 'privacy' | 'inbox' | 'browser' | 'friends' | 'permissions' | 'feedback' | 'about';

export default function SettingsPage({ ctx }: Props) {
  const { session, username, deviceName, deviceId, onLogout } = ctx;
  const [tab, setTab] = useState<Tab>('session');
  const [feedbackText, setFeedbackText] = useState('');
  const [feedbackType, setFeedbackType] = useState<'feedback' | 'report'>('feedback');
  const [feedbackSent, setFeedbackSent] = useState(false);

  // Namespace settings keys by username
  const uKey = (k: string) => `${(username || 'default').toLowerCase()}_${k}`;

  const [chatBg, setChatBg] = useState(() => localStorage.getItem(uKey('chat_bg')) || '#eef2ff');
  const [chatFontSize, setChatFontSize] = useState(() => localStorage.getItem(uKey('chat_font')) || 'medium');
  const [readReceipts, setReadReceipts] = useState(() => localStorage.getItem(uKey('read_receipts')) !== 'false');
  const [showActive, setShowActive] = useState(() => localStorage.getItem(uKey('show_active')) !== 'false');
  const [clipboardSync, setClipboardSync] = useState(() => localStorage.getItem(uKey('clipboard_sync')) !== 'false');
  const [notifications, setNotifications] = useState(() => localStorage.getItem(uKey('notifications')) !== 'false');

  // Friends & inbox
  const [friends, setFriends] = useState<Friend[]>(() => friendService.getFriends());
  const [inbox, setInbox] = useState<FriendRequest[]>(() => friendService.getInbox());
  const [sosAlerts, setSosAlerts] = useState<SosAlert[]>([]);
  const [sosSending, setSosSending] = useState(false);
  const sosAudioRef = useRef<HTMLAudioElement | null>(null);

  // Subscribe to friendService events
  useEffect(() => {
    const u1 = friendService.on<Friend[]>('friends_changed', setFriends);
    const u2 = friendService.on<FriendRequest[]>('inbox_changed', setInbox);
    const u3 = friendService.on<SosAlert>('sos_received', (alert) => {
      setSosAlerts(p => [alert, ...p].slice(0, 20));
      // Play danger sound
      try {
        if (!sosAudioRef.current) {
          const ctx2 = new AudioContext();
          const osc = ctx2.createOscillator();
          const gain = ctx2.createGain();
          osc.connect(gain); gain.connect(ctx2.destination);
          osc.type = 'sawtooth'; osc.frequency.setValueAtTime(880, ctx2.currentTime);
          osc.frequency.exponentialRampToValueAtTime(220, ctx2.currentTime + 0.5);
          gain.gain.setValueAtTime(0.6, ctx2.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx2.currentTime + 0.8);
          osc.start(); osc.stop(ctx2.currentTime + 0.8);
          // Repeat 3 times
          setTimeout(() => {
            const osc2 = ctx2.createOscillator(); const g2 = ctx2.createGain();
            osc2.connect(g2); g2.connect(ctx2.destination);
            osc2.type = 'sawtooth'; osc2.frequency.setValueAtTime(880, ctx2.currentTime);
            osc2.frequency.exponentialRampToValueAtTime(220, ctx2.currentTime + 0.5);
            g2.gain.setValueAtTime(0.6, ctx2.currentTime);
            g2.gain.exponentialRampToValueAtTime(0.001, ctx2.currentTime + 0.8);
            osc2.start(); osc2.stop(ctx2.currentTime + 0.8);
          }, 900);
        }
      } catch { /* AudioContext not available */ }
      // Switch to inbox tab to show alert
      setTab('inbox');
    });
    const u4 = friendService.on<{ username: string }>('friend_accepted', ({ username: u }) => {
      logActivity({ type: 'friends', icon: '✅', label: `${u} accepted your friend request`, sub: '' });
    });
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  const save = (key: string, val: string) => {
    localStorage.setItem(uKey(key), val);
    logActivity({ type: 'settings', icon: '⚙️', label: `Setting changed: ${key}`, sub: val });
  };

  const handleSos = () => {
    setSosSending(true);
    friendService.sendSos(username, deviceId, session?.id);
    logActivity({ type: 'sos', icon: '🆘', label: 'SOS alert sent to friends', sub: '' });
    setTimeout(() => setSosSending(false), 3000);
  };

  const pendingInbox = inbox.filter(r => r.status === 'pending');
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'session', label: 'Session Details' },
    { id: 'chat', label: 'Chat' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'inbox', label: 'Inbox', badge: pendingInbox.length + sosAlerts.length },
    { id: 'browser', label: 'Browser' },
    { id: 'friends', label: 'Friends', badge: friends.length || undefined },
    { id: 'permissions', label: 'Permissions' },
    { id: 'feedback', label: 'Feedback' },
    { id: 'about', label: 'About FlowLink' },
  ];

  return (
    <div className="settings-page">
      {/* Profile + SOS + Logout */}
      <div className="card settings-profile">
        <div className="sp-avatar">{(username || 'U')[0].toUpperCase()}</div>
        <div className="sp-info">
          <div className="sp-name">{username || 'Unknown'}</div>
          <div className="sp-sub">{deviceName}</div>
        </div>
        <button
          className={`sos-btn${sosSending ? ' sending' : ''}`}
          onClick={handleSos}
          title="Send SOS alert with your location to all friends"
          disabled={sosSending}
        >
          {sosSending ? 'Sending…' : 'SOS'}
        </button>
        <button
          className="logout-btn"
          onClick={() => { if (confirm('Log out and change username?')) onLogout(); }}
          title="Log out to change username"
        >
          Logout
        </button>
      </div>

      <div className="settings-layout">
        {/* Sidebar tabs */}
        <div className="settings-tabs">
          {tabs.map(t => (
            <button
              key={t.id}
              className={`settings-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span className={`st-icon st-icon-${t.id}`} />
              <span className="st-label">{t.label}</span>
              {t.badge ? <span className="st-badge">{t.badge}</span> : null}
            </button>
          ))}
        </div>

        {/* Content panel */}
        <div className="settings-content card">

          {/* ── Session Details ── */}
          {tab === 'session' && (
            <div className="settings-section">
              <div className="ss-title">Session Details</div>
              {!session
                ? <div className="ss-empty">No active session. Create or join one from the Overview page.</div>
                : <>
                    <div className="ss-row-info"><span>Session Code</span><strong>{session.code}</strong></div>
                    <div className="ss-row-info"><span>Session ID</span><code>{session.id.slice(0, 16)}…</code></div>
                    <div className="ss-row-info"><span>Created By</span><span>{session.createdBy === deviceId ? 'You' : session.createdBy.slice(0, 8)}</span></div>
                    <div className="ss-row-info"><span>Expires</span><span>{new Date(session.expiresAt).toLocaleTimeString()}</span></div>
                    <div className="ss-row-info"><span>Devices</span><span>{session.devices.size}</span></div>
                  </>
              }
            </div>
          )}

          {/* ── Chat ── */}
          {tab === 'chat' && (
            <div className="settings-section">
              <div className="ss-title">Chat Settings</div>
              <div className="ss-toggle-row">
                <div><div className="ss-label">Chat Background Color</div><div className="ss-desc">Customize the chat area background.</div></div>
                <input type="color" value={chatBg} onChange={e => { setChatBg(e.target.value); save('chat_bg', e.target.value); }} className="ss-color-input" />
              </div>
              <div className="ss-toggle-row">
                <div><div className="ss-label">Font Size</div><div className="ss-desc">Adjust message text size.</div></div>
                <select className="ss-select" value={chatFontSize} onChange={e => { setChatFontSize(e.target.value); save('chat_font', e.target.value); }}>
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large">Large</option>
                </select>
              </div>
            </div>
          )}

          {/* ── Privacy ── */}
          {tab === 'privacy' && (
            <div className="settings-section">
              <div className="ss-title">Privacy</div>
              {[
                { key: 'read_receipts', label: 'Read Receipts', desc: 'Let others know when you have read their messages.', val: readReceipts, set: (v: boolean) => { setReadReceipts(v); save('read_receipts', String(v)); } },
                { key: 'show_active', label: 'Show Active Status', desc: 'Let others see when you are online.', val: showActive, set: (v: boolean) => { setShowActive(v); save('show_active', String(v)); } },
                { key: 'clipboard_sync', label: 'Clipboard Sync', desc: 'Automatically sync clipboard across devices.', val: clipboardSync, set: (v: boolean) => { setClipboardSync(v); save('clipboard_sync', String(v)); } },
                { key: 'notifications', label: 'Notifications', desc: 'Receive alerts for invitations and messages.', val: notifications, set: (v: boolean) => { setNotifications(v); save('notifications', String(v)); } },
              ].map(item => (
                <div key={item.key} className="ss-toggle-row">
                  <div><div className="ss-label">{item.label}</div><div className="ss-desc">{item.desc}</div></div>
                  <label className="toggle">
                    <input type="checkbox" checked={item.val} onChange={e => item.set(e.target.checked)} />
                    <span className="toggle-slider" />
                  </label>
                </div>
              ))}
            </div>
          )}

          {/* ── Inbox ── */}
          {tab === 'inbox' && (
            <div className="settings-section">
              <div className="ss-title">Inbox</div>

              {/* SOS alerts */}
              {sosAlerts.length > 0 && (
                <div className="inbox-section">
                  <div className="inbox-section-label">SOS Alerts</div>
                  {sosAlerts.map((alert, i) => (
                    <div key={i} className="inbox-sos-card">
                      <div className="sos-card-header">
                        <span className="sos-icon sos-icon-svg" />
                        <div>
                          <div className="sos-from">{alert.fromUsername} needs help!</div>
                          <div className="sos-time">{new Date(alert.sentAt).toLocaleTimeString()}</div>
                        </div>
                        <button className="inbox-dismiss" onClick={() => setSosAlerts(p => p.filter((_, j) => j !== i))}>×</button>
                      </div>
                      {(alert.lat != null && alert.lng != null) && (
                        <a
                          className="sos-location-link"
                          href={`https://www.google.com/maps?q=${alert.lat},${alert.lng}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View location on map ({alert.lat.toFixed(4)}, {alert.lng.toFixed(4)})
                        </a>
                      )}
                      {!alert.lat && <div className="sos-no-location">Location not available</div>}
                    </div>
                  ))}
                </div>
              )}

              {/* Friend requests */}
              <div className="inbox-section">
                <div className="inbox-section-label">Friend Requests</div>
                {pendingInbox.length === 0
                  ? <div className="ss-empty" style={{ padding: '1rem 0' }}>No pending friend requests.</div>
                  : pendingInbox.map(req => (
                      <div key={req.id} className="inbox-request-card">
                        <div className="irc-avatar">{req.fromUsername[0]?.toUpperCase()}</div>
                        <div className="irc-info">
                          <div className="irc-name">{req.fromUsername}</div>
                          <div className="irc-time">{new Date(req.sentAt).toLocaleTimeString()}</div>
                        </div>
                        <div className="irc-actions">
                          <button
                            className="btn-primary irc-btn"
                            onClick={() => {
                              friendService.respondToRequest(req, true, deviceId, session?.id);
                              logActivity({ type: 'friends', icon: '✅', label: `Accepted friend request from ${req.fromUsername}`, sub: '' });
                            }}
                          >
                            Accept
                          </button>
                          <button
                            className="btn-danger irc-btn"
                            onClick={() => {
                              friendService.respondToRequest(req, false, deviceId, session?.id);
                              logActivity({ type: 'friends', icon: '❌', label: `Rejected friend request from ${req.fromUsername}`, sub: '' });
                            }}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))
                }
              </div>

              {/* Accepted/rejected history */}
              {inbox.filter(r => r.status !== 'pending').length > 0 && (
                <div className="inbox-section">
                  <div className="inbox-section-label">History</div>
                  {inbox.filter(r => r.status !== 'pending').map(req => (
                    <div key={req.id} className="inbox-history-row">
                      <span className="irc-avatar small">{req.fromUsername[0]?.toUpperCase()}</span>
                      <span className="irc-name">{req.fromUsername}</span>
                      <span className={`irc-status ${req.status}`}>{req.status === 'accepted' ? 'Friends' : 'Rejected'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Browser ── */}
          {tab === 'browser' && (
            <div className="settings-section">
              <div className="ss-title">Browser Integration</div>
              <div className="ss-toggle-row">
                <div><div className="ss-label">FlowLink Extension</div><div className="ss-desc">Install the browser extension for tab handoff and media sync.</div></div>
                <a href="/download" className="btn-primary" style={{ fontSize: '0.78rem', padding: '0.45rem 0.85rem', textDecoration: 'none' }}>Install</a>
              </div>
              <div className="ss-row-info"><span>Tab Handoff</span><span>Send open tabs to connected devices</span></div>
              <div className="ss-row-info"><span>Media Sync</span><span>Continue watching videos on other devices</span></div>
              <div className="ss-row-info"><span>Clipboard</span><span>Sync clipboard via extension</span></div>
            </div>
          )}

          {/* ── Friends ── */}
          {tab === 'friends' && (
            <div className="settings-section">
              <div className="ss-title">Friends</div>
              <div className="ss-desc" style={{ marginBottom: '1rem' }}>
                Friends are added when they accept your request from a device tile (+). You can invite them to sessions directly.
              </div>

              {friends.length === 0
                ? <div className="ss-empty">No friends yet. Send a friend request from a device tile.</div>
                : (
                  <div className="friends-list">
                    {friends.map((f, i) => (
                      <div key={i} className="friend-card">
                        <div className="friend-avatar">{f.username[0]?.toUpperCase()}</div>
                        <div className="friend-info">
                          <div className="friend-name">{f.username}</div>
                          <div className="friend-since">Friends since {new Date(f.addedAt).toLocaleDateString()}</div>
                        </div>
                        <div className="friend-actions">
                          {session && (
                            <button
                              className="btn-primary friend-invite-btn"
                              title="Invite to current session"
                              onClick={() => {
                                const ws = (window as any).appWebSocket as WebSocket | null;
                                if (!ws || ws.readyState !== WebSocket.OPEN || !session) return;
                                ws.send(JSON.stringify({
                                  type: 'session_invitation',
                                  sessionId: session.id,
                                  deviceId,
                                  payload: {
                                    targetIdentifier: f.username,
                                    invitation: { sessionId: session.id, sessionCode: session.code, inviterUsername: username, inviterDeviceName: deviceName },
                                  },
                                  timestamp: Date.now(),
                                }));
                                logActivity({ type: 'friends', icon: '📨', label: `Invited ${f.username} to session`, sub: session.code });
                              }}
                            >
                              Invite
                            </button>
                          )}
                          <button
                            className="btn-danger friend-remove-btn"
                            title="Remove friend"
                            onClick={() => {
                              friendService.removeFriend(f.username);
                              logActivity({ type: 'friends', icon: '🗑', label: `Removed friend: ${f.username}`, sub: '' });
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              }

              {/* SOS button in friends tab too */}
              <div className="friends-sos-row">
                <div>
                  <div className="ss-label">SOS Alert</div>
                  <div className="ss-desc">Send your location to all friends as an emergency alert.</div>
                </div>
                <button className={`sos-btn${sosSending ? ' sending' : ''}`} onClick={handleSos} disabled={sosSending}>
                  {sosSending ? 'Sending…' : 'Send SOS'}
                </button>
              </div>
            </div>
          )}

          {/* ── Permissions ── */}
          {tab === 'permissions' && (
            <div className="settings-section">
              <div className="ss-title">App Permissions</div>
              <div className="ss-desc" style={{ marginBottom: '1rem' }}>System permissions required for FlowLink features. Disabling a permission will block that feature.</div>
              {[
                { label: 'Notifications', desc: 'Receive alerts for invitations and messages.', key: 'notifications' as const },
                { label: 'Camera', desc: 'For QR code scanning and video calls.', key: 'camera' as const },
                { label: 'Storage', desc: 'For file transfers and downloads.', key: 'storage' as const },
                { label: 'Microphone', desc: 'For voice chat and audio messages.', key: 'microphone' as const },
              ].map(p => {
                const permEngine = (window as any).permissionEngine;
                const isGranted = permEngine?.hasSystemPermission(p.key) ?? true;
                
                return (
                  <div key={p.label} className="ss-toggle-row">
                    <div>
                      <div className="ss-label">{p.label}</div>
                      <div className="ss-desc">{p.desc}</div>
                    </div>
                    <label className="toggle">
                      <input 
                        type="checkbox" 
                        checked={isGranted}
                        onChange={e => {
                          const granted = e.target.checked;
                          permEngine?.setSystemPermission(p.key, granted);
                          logActivity({ 
                            type: 'settings', 
                            icon: 'shield', 
                            label: `Permission ${p.label}: ${granted ? 'enabled' : 'disabled'}`, 
                            sub: granted ? 'Feature enabled' : 'Feature blocked' 
                          });
                        }} 
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Feedback ── */}
          {tab === 'feedback' && (
            <div className="settings-section">
              <div className="ss-title">Feedback & Reports</div>
              <div className="ss-desc" style={{ marginBottom: '1rem' }}>
                Send feedback or report an issue. Your message goes directly to the FlowLink team.
              </div>
              <div className="ss-toggle-row" style={{ borderBottom: 'none', marginBottom: '0.75rem' }}>
                <div><div className="ss-label">Type</div></div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {(['feedback', 'report'] as const).map(t => (
                    <button key={t} onClick={() => setFeedbackType(t)}
                      style={{ padding: '0.35rem 0.85rem', borderRadius: '8px', border: '1.5px solid', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
                        background: feedbackType === t ? 'var(--brand)' : 'transparent',
                        color: feedbackType === t ? '#fff' : 'var(--text-2)',
                        borderColor: feedbackType === t ? 'var(--brand)' : 'var(--border)' }}>
                      {t === 'feedback' ? 'Feedback' : 'Report'}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                style={{ width: '100%', minHeight: 120, padding: '0.75rem', borderRadius: '10px', border: '1.5px solid var(--border)', background: 'rgba(255,255,255,0.7)', color: 'var(--text)', fontSize: '0.88rem', resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
                placeholder={feedbackType === 'report' ? 'Describe the issue…' : 'Share your thoughts…'}
                value={feedbackText}
                onChange={e => setFeedbackText(e.target.value)}
              />
              {feedbackSent && <div style={{ color: '#16a34a', fontSize: '0.82rem', marginTop: '0.5rem' }}>Sent! Thank you.</div>}
              <button className="btn-primary" style={{ marginTop: '0.75rem' }}
                disabled={!feedbackText.trim()}
                onClick={() => {
                  const ws = (window as any).appWebSocket as WebSocket | null;
                  if (!ws || ws.readyState !== WebSocket.OPEN) return;
                  ws.send(JSON.stringify({ type: 'feedback_submit', deviceId, payload: { type: feedbackType, text: feedbackText.trim(), fromUsername: username }, timestamp: Date.now() }));
                  setFeedbackText(''); setFeedbackSent(true);
                  setTimeout(() => setFeedbackSent(false), 4000);
                }}>
                Send {feedbackType === 'report' ? 'Report' : 'Feedback'}
              </button>
            </div>
          )}

          {/* ── About ── */}
          {tab === 'about' && (
            <div className="settings-section">
              <div className="ss-title">About FlowLink</div>
              <img src="/logo.png" alt="FlowLink" className="ss-about-logo" />
              <div className="ss-about-name">FlowLink</div>
              <div className="ss-about-tagline">Cross-Device Continuity Platform</div>
              {[
                ['Version', '1.0.0'],
                ['Platform', 'Web (React + TypeScript)'],
                ['Backend', 'Node.js WebSocket + WebRTC'],
                ['Storage', 'In-memory (session-scoped)'],
                ['Encryption', 'End-to-end (WebRTC DTLS)'],
                ['License', 'MIT'],
              ].map(([k, v]) => (
                <div key={k} className="ss-row-info"><span>{k}</span><span>{v}</span></div>
              ))}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
