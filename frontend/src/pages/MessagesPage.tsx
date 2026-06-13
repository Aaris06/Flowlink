import { useState, useEffect, useRef, useCallback } from 'react';
import { AppContext } from '../App';
import './MessagesPage.css';

interface Attachment { name: string; type: string; size: number; data: string; }
interface ChatMsg {
  messageId: string; text: string; username: string; sourceDevice: string;
  sentAt: number; delivered: boolean; seen: boolean;
  replyTo?: string; edited?: boolean;
  attachment?: Attachment;
}

interface CallActivity {
  callId: string;
  kind: 'started' | 'joined' | 'ended';
  callType: 'audio' | 'video';
  remoteUsername: string;
  sourceUsername: string;
}
interface CtxMenu { msgId: string; x: number; y: number; own: boolean; }
interface Props { ctx: AppContext; }
export default function MessagesPage({ ctx }: Props) {
  const { session, deviceId, username } = ctx;

  const loadFromStorage = () => {
    const user = (ctx.username || localStorage.getItem('flowlink_username') || '').toLowerCase();
    const stored = sessionStorage.getItem(`flowlink_messages_${user}_${session?.id || 'none'}`);
    return stored ? JSON.parse(stored) : [];
  };

  const [messages, setMessages] = useState<ChatMsg[]>(loadFromStorage);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState<Record<string, boolean>>({});
  const [replyTo, setReplyTo] = useState<ChatMsg | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);

  // Persist messages whenever they change
  useEffect(() => {
    if (session && messages.length > 0) {
      const user = (username || localStorage.getItem('flowlink_username') || '').toLowerCase();
      sessionStorage.setItem(`flowlink_messages_${user}_${session.id}`, JSON.stringify(messages));
    }
  }, [messages, session, username]);

  // On mount, sync from sessionStorage to catch messages buffered while on another tab
  useEffect(() => {
    const stored = loadFromStorage();
    if (stored.length > 0) {
      setMessages(stored);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' }), 50);
  }, []);

  useEffect(() => {
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws) return;

    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'chat_message') {
        const chat = msg.payload?.chat;
        if (!chat?.messageId) return;
        setMessages(p => {
          if (p.find(m => m.messageId === chat.messageId)) return p;
          // Normalize attachment: website uses {attachment:{name,type,size,data}}
          // Mobile uses flat {fileId,fileName,fileType,fileSize,fileData}
          let attachment = chat.attachment;
          if (!attachment && chat.fileId && chat.fileName) {
            attachment = {
              name: chat.fileName,
              type: chat.fileType || 'application/octet-stream',
              size: chat.fileSize || 0,
              data: chat.fileData || '',
            };
          }
          // Strip the "📎 " prefix from text if it's a file message
          const text = attachment ? (chat.text?.replace(/^📎\s*/, '') === chat.fileName ? '' : (chat.text?.replace(/^📎\s*/, '') || '')) : (chat.text || '');
          return [...p, {
            messageId: chat.messageId, text, username: chat.username || 'Unknown',
            sourceDevice: msg.payload?.sourceDevice || '', sentAt: chat.sentAt || Date.now(),
            delivered: true, seen: true,
            replyTo: chat.replyTo, edited: chat.edited,
            attachment,
          }];
        });
        if (ws.readyState === WebSocket.OPEN && session) {
          ws.send(JSON.stringify({ type: 'chat_seen', sessionId: session.id, deviceId, payload: { messageId: chat.messageId, targetDevice: msg.payload?.sourceDevice }, timestamp: Date.now() }));
        }
        scrollToBottom();
      }
      if (msg.type === 'chat_delivered') setMessages(p => p.map(m => m.messageId === msg.payload?.messageId ? { ...m, delivered: true } : m));
      if (msg.type === 'chat_seen') setMessages(p => p.map(m => m.messageId === msg.payload?.messageId ? { ...m, seen: true } : m));
      if (msg.type === 'chat_typing') setTyping(p => ({ ...p, [msg.payload?.sourceDevice || '']: Boolean(msg.payload?.isTyping) }));
      if (msg.type === 'session_joined' && msg.payload?.chatHistory) {
        setMessages(msg.payload.chatHistory.map((item: any) => {
          let attachment = item.attachment;
          if (!attachment && item.fileId && item.fileName) {
            attachment = { name: item.fileName, type: item.fileType || 'application/octet-stream', size: item.fileSize || 0, data: item.fileData || '' };
          }
          const text = attachment ? (item.text?.replace(/^📎\s*/, '') === item.fileName ? '' : (item.text?.replace(/^📎\s*/, '') || '')) : (item.text || '');
          return {
            messageId: item.messageId || `c-${item.sentAt}`, text,
            username: item.username || 'Unknown', sourceDevice: item.sourceDevice || '',
            sentAt: item.sentAt || Date.now(), delivered: true, seen: false,
            attachment,
          };
        }));
        scrollToBottom();
      }
    };

    const chatHandler = (e: Event) => {
      const m = (e as CustomEvent).detail?.message;
      if (m) handler({ data: JSON.stringify(m) } as MessageEvent);
    };
    ws.addEventListener('message', handler);
    window.addEventListener('chatMessage', chatHandler);
    return () => { ws.removeEventListener('message', handler); window.removeEventListener('chatMessage', chatHandler); };
  }, [session, deviceId, scrollToBottom]);

  useEffect(() => { scrollToBottom(); }, [messages.length]);

  const sendMessage = async (attachmentFile?: File) => {
    const text = input.trim();
    if (!text && !attachmentFile) return;
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    let attachment: Attachment | undefined;
    if (attachmentFile) {
      const buf = await attachmentFile.arrayBuffer();
      let bin = ''; const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
      attachment = { name: attachmentFile.name, type: attachmentFile.type, size: attachmentFile.size, data: btoa(bin) };
    }

    if (editingId) {
      // Edit: update locally and notify
      setMessages(p => p.map(m => m.messageId === editingId ? { ...m, text, edited: true } : m));
      setEditingId(null); setInput('');
      ws.send(JSON.stringify({ type: 'chat_message', sessionId: session.id, deviceId, payload: { chat: { messageId: editingId, text, username, sentAt: Date.now(), format: 'plain', edited: true } }, timestamp: Date.now() }));
      return;
    }

    const messageId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sentAt = Date.now();
    const newMsg: ChatMsg = { messageId, text, username, sourceDevice: deviceId, sentAt, delivered: false, seen: false, replyTo: replyTo?.messageId, attachment };
    setMessages(p => [...p, newMsg]);
    setInput(''); setReplyTo(null);
    ws.send(JSON.stringify({ type: 'chat_message', sessionId: session.id, deviceId, payload: { chat: { messageId, text, username, sentAt, format: 'plain', replyTo: replyTo?.messageId, attachment } }, timestamp: Date.now() }));
    scrollToBottom();
  };

  const handleInputChange = (val: string) => {
    setInput(val);
    if (!session) return;
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    ws.send(JSON.stringify({ type: 'chat_typing', sessionId: session.id, deviceId, payload: { isTyping: val.length > 0 }, timestamp: Date.now() }));
    typingTimerRef.current = window.setTimeout(() => {
      ws.send(JSON.stringify({ type: 'chat_typing', sessionId: session.id, deviceId, payload: { isTyping: false }, timestamp: Date.now() }));
    }, 1500);
  };

  const handleContextMenu = (e: React.MouseEvent, msg: ChatMsg) => {
    e.preventDefault();
    setCtxMenu({ msgId: msg.messageId, x: e.clientX, y: e.clientY, own: msg.sourceDevice === deviceId });
  };

  const closeCtxMenu = () => setCtxMenu(null);

  const ctxAction = (action: string) => {
    const msg = messages.find(m => m.messageId === ctxMenu?.msgId);
    if (!msg) { closeCtxMenu(); return; }
    if (action === 'reply') { setReplyTo(msg); inputRef.current?.focus(); }
    if (action === 'copy') navigator.clipboard.writeText(msg.text).catch(() => {});
    if (action === 'edit' && msg.sourceDevice === deviceId) { setEditingId(msg.messageId); setInput(msg.text); inputRef.current?.focus(); }
    if (action === 'delete' && msg.sourceDevice === deviceId) setMessages(p => p.filter(m => m.messageId !== msg.messageId));
    closeCtxMenu();
  };

  const renderText = (text: string) => {
    if (text.startsWith('[[CALL_ACTIVITY]]')) {
      try {
        return renderCallActivity(JSON.parse(text.replace('[[CALL_ACTIVITY]]', '')) as CallActivity);
      } catch {
        return null;
      }
    }
    if (text.startsWith('[[GROUP_CALL_START]]')) {
      try {
        const data = JSON.parse(text.replace('[[GROUP_CALL_START]]', ''));
        return renderGroupCallStart(data);
      } catch {
        return null;
      }
    }
    if (!text) return null;
    // Code block
    if (text.includes('```')) {
      const parts = text.split(/(```[\s\S]*?```)/g);
      return <>{parts.map((p, i) => p.startsWith('```') ? <pre key={i} className="msg-code">{p.replace(/```/g, '').trim()}</pre> : <span key={i}>{renderInline(p)}</span>)}</>;
    }
    return renderInline(text);
  };

  const renderInline = (text: string) => {
    const urlRe = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRe);
    return <>{parts.map((p, i) => /^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer" className="msg-link">{p}</a> : <span key={i}>{p}</span>)}</>;
  };

  const renderCallActivity = (call: CallActivity) => {
    const label = call.kind === 'started'
      ? `${call.sourceUsername} started a ${call.callType} call`
      : call.kind === 'joined'
        ? `${call.sourceUsername} joined the call`
        : `${call.sourceUsername} ended the call`;
    const joinable = call.kind === 'started' || call.kind === 'joined';
    return (
      <div className="msg-call-card">
        <div className="msg-call-title">{label}</div>
        <div className="msg-call-sub">
          {call.kind === 'started' ? 'Tap to join the ongoing call.' : 'Call activity update.'}
        </div>
        {joinable && (
          <button
            className="btn-primary msg-call-join-btn"
            onClick={() => {
              const ws = (window as any).appWebSocket as WebSocket | null;
              if (!ws || ws.readyState !== WebSocket.OPEN || !session) return;
              ws.send(JSON.stringify({
                type: 'call_accept',
                sessionId: session.id,
                deviceId,
                payload: { callId: call.callId, toDevice: '', fromUsername: username },
                timestamp: Date.now(),
              }));
            }}
          >
            Join Call
          </button>
        )}
      </div>
    );
  };

  const renderGroupCallStart = (data: { roomId: string; callType: 'audio' | 'video'; hostUsername: string }) => {
    const icon = data.callType === 'video' ? '🎥' : '📞';
    const label = data.callType === 'video' ? 'Group Video Call' : 'Group Voice Call';
    const isInCall = ctx.groupCallService?.getState() !== 'idle' && ctx.groupCallService?.getState() !== 'ended';
    const isThisRoom = ctx.groupCallService?.getRoom()?.roomId === data.roomId;
    return (
      <div className="gcall-join-now-msg">
        <span className="gcall-join-now-icon">{icon}</span>
        <div className="gcall-join-now-text">
          <strong>{label} — ongoing</strong>
          Started by {data.hostUsername}. Click to join.
        </div>
        <button
          className="gcall-join-now-btn"
          disabled={isInCall && !isThisRoom}
          onClick={() => {
            if (!ctx.groupCallService || !session) return;
            ctx.groupCallService.joinByRoomId(data.roomId, data.callType, session.id, data.hostUsername);
          }}
        >
          {isThisRoom ? 'In Call' : 'Join Now'}
        </button>
      </div>
    );
  };

  const startRecording = async () => {    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.start(100);
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingTimerRef.current = window.setInterval(() => setRecordingSeconds(s => s + 1), 1000);
    } catch {
      alert('Microphone permission denied');
    }
  };

  const stopRecording = async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    setIsRecording(false);
    setRecordingSeconds(0);

    await new Promise<void>(resolve => {
      recorder.onstop = () => resolve();
      recorder.stop();
      recorder.stream.getTracks().forEach(t => t.stop());
    });

    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(audioChunksRef.current, { type: mimeType });
    if (blob.size < 500) return; // too short

    const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
    const fileName = `voice_${Date.now()}.${ext}`;
    const buf = await blob.arrayBuffer();
    let bin = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    const file = new File([blob], fileName, { type: mimeType });
    sendMessage(file);
  };

  const cancelRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recorder.stop();
    recorder.stream.getTracks().forEach(t => t.stop());
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    setIsRecording(false);
    setRecordingSeconds(0);
  };

  const getFileIconInfo = (ext: string): { letter: string; color: string } => {    switch (ext) {
      case 'pdf':                             return { letter: 'P', color: '#F44336' };
      case 'doc': case 'docx':               return { letter: 'W', color: '#2196F3' };
      case 'xls': case 'xlsx':               return { letter: 'X', color: '#4CAF50' };
      case 'ppt': case 'pptx':               return { letter: 'P', color: '#FF5722' };
      case 'txt':                             return { letter: 'T', color: '#607D8B' };
      case 'zip': case 'rar': case '7z':     return { letter: 'Z', color: '#795548' };
      case 'mp4': case 'mkv': case 'avi':    return { letter: '▶', color: '#9C27B0' };
      case 'mp3': case 'wav': case 'm4a':    return { letter: '♪', color: '#009688' };
      default:                               return { letter: 'F', color: '#607D8B' };
    }
  };

  const renderAttachment = (att: Attachment, own: boolean) => {
    const ext = att.name.split('.').pop()?.toLowerCase() || '';
    const isImage = att.type.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp'].includes(ext);
    const isVoice = att.type.startsWith('audio/') || att.name.startsWith('voice_') || ['m4a','mp3','ogg','webm','wav'].includes(ext);

    // Inline audio player (WhatsApp style)
    if (isVoice && att.data) {
      const src = `data:${att.type};base64,${att.data}`;
      return (
        <div className={`msg-voice${own ? ' own' : ''}`}>
          <span className="msg-voice-icon">🎙</span>
          <audio controls src={src} className="msg-voice-audio" preload="metadata" />
          <span className="msg-voice-size">{Math.max(1, Math.round(att.size / 1024))} KB</span>
        </div>
      );
    }

    if (isImage) {
      const src = `data:${att.type};base64,${att.data}`;
      return (
        <div className="msg-img-wrap">
          <img
            src={src}
            alt={att.name}
            className="msg-img"
            onClick={() => {
              const w = window.open('', '_blank');
              if (w) {
                w.document.write(`<!DOCTYPE html><html><head><title>${att.name}</title>
                  <style>body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh}
                  img{max-width:100%;max-height:100vh;object-fit:contain}
                  .dl{position:fixed;top:16px;right:16px;background:#1d4ed8;color:#fff;border:none;padding:8px 18px;border-radius:8px;cursor:pointer;font-size:14px}
                  </style></head><body>
                  <img src="${src}" /><button class="dl" onclick="const a=document.createElement('a');a.href='${src}';a.download='${att.name}';a.click()">⬇ Download</button>
                  </body></html>`);
              }
            }}
          />
          <div className="msg-img-name">{att.name}</div>
        </div>
      );
    }

    // WhatsApp-style file card with colored icon
    const { letter, color } = getFileIconInfo(ext);
    const downloadAtt = () => {
      const bin = atob(att.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes.buffer], { type: att.type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = att.name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1200);
    };

    return (
      <div className={`msg-file-card${own ? ' own' : ''}`} onClick={downloadAtt}>
        <div className="msg-file-icon-box" style={{ background: color }}>
          <span className="msg-file-icon-letter">{letter}</span>
        </div>
        <div className="msg-file-info">
          <div className="msg-file-name">{att.name}</div>
          <div className="msg-file-meta">{ext.toUpperCase()} · {Math.max(1, Math.round(att.size / 1024))} KB</div>
        </div>
        <div className="msg-file-dl-btn">↓</div>
      </div>
    );
  };

  const typingUsers = Object.entries(typing).filter(([, v]) => v).map(([k]) => k);
  const replyMsg = replyTo ? messages.find(m => m.messageId === replyTo.messageId) : null;

  return (
    <div className="messages-page" onClick={closeCtxMenu}>
      <div className="messages-container card">
        <div className="msg-header">
          <div className="msg-header-icon msg-header-icon-svg" />
          <div>
            <div className="msg-header-title">Session Chat</div>
            <div className="msg-header-sub">{session ? `Session ${session.code} · ${messages.length} messages` : 'No active session'}</div>
          </div>
          {session && ctx.callService && (
            <div className="msg-header-actions">
              <button
                className="msg-call-btn"
                title="Audio call"
                onClick={() => {
                  const peers = (window as any)._sessionDevices as { id: string; username: string }[] | undefined;
                  const target = peers?.find(d => d.id !== deviceId);
                  if (target) ctx.callService!.startCall(target.username, target.id, false);
                }}
              >📞</button>
              <button
                className="msg-call-btn"
                title="Video call"
                onClick={() => {
                  const peers = (window as any)._sessionDevices as { id: string; username: string }[] | undefined;
                  const target = peers?.find(d => d.id !== deviceId);
                  if (target) ctx.callService!.startCall(target.username, target.id, true);
                }}
              >🎥</button>
            </div>
          )}
        </div>

        <div className="msg-body" ref={bodyRef}>
          {!session && <div className="msg-empty">Create or join a session to start chatting.</div>}
          {session && messages.length === 0 && <div className="msg-empty">No messages yet. Say hi! 👋</div>}

          {messages.map(m => {
            const own = m.sourceDevice === deviceId;
            const repliedMsg = m.replyTo ? messages.find(r => r.messageId === m.replyTo) : null;
            return (
              <div key={m.messageId} className={`msg-row${own ? ' own' : ''}`} onContextMenu={e => handleContextMenu(e, m)}>
                {!own && <div className="msg-avatar">{(m.username || '?')[0].toUpperCase()}</div>}
                <div className={`msg-bubble${own ? ' own' : ''}`}>
                  {!own && <div className="msg-sender">{m.username}</div>}
                  {repliedMsg && (
                    <div className="msg-reply-preview">
                      <span className="msg-reply-name">{repliedMsg.sourceDevice === deviceId ? 'You' : repliedMsg.username}</span>
                      <span className="msg-reply-text">{repliedMsg.text.slice(0, 60)}</span>
                    </div>
                  )}
                  {m.attachment && renderAttachment(m.attachment, own)}
                  {m.text && !m.attachment && <div className="msg-text">{renderText(m.text)}{m.edited && <span className="msg-edited"> (edited)</span>}</div>}
                  {m.text && m.attachment && <div className="msg-text msg-caption">{renderText(m.text)}</div>}
                  <div className="msg-footer">
                    <span className="msg-time">{new Date(m.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    {own && <span className={`msg-tick${m.seen ? ' seen' : m.delivered ? ' delivered' : ''}`}>{m.seen ? '✓✓' : m.delivered ? '✓✓' : '✓'}</span>}
                  </div>
                </div>
              </div>
            );
          })}

          {typingUsers.length > 0 && (
            <div className="msg-typing-row">
              <div className="msg-typing-bubble">
                <span className="typing-dots"><i /><i /><i /></span>
              </div>
            </div>
          )}
        </div>

        {/* Reply bar */}
        {replyMsg && (
          <div className="msg-reply-bar">
            <div className="msg-reply-bar-content">
              <span className="msg-reply-bar-name">{replyMsg.sourceDevice === deviceId ? 'You' : replyMsg.username}</span>
              <span className="msg-reply-bar-text">{replyMsg.text.slice(0, 80)}</span>
            </div>
            <button className="msg-reply-bar-close" onClick={() => setReplyTo(null)}>✕</button>
          </div>
        )}

        {/* Edit bar */}
        {editingId && (
          <div className="msg-edit-bar">
            <span>Editing message</span>
            <button onClick={() => { setEditingId(null); setInput(''); }}>Cancel</button>
          </div>
        )}

        <div className="msg-input-row">
          {isRecording ? (
            <>
              <button className="msg-attach-btn recording-cancel" title="Cancel" onClick={cancelRecording}>✕</button>
              <div className="msg-recording-bar">
                <span className="msg-recording-dot" />
                <span className="msg-recording-time">
                  {String(Math.floor(recordingSeconds / 60)).padStart(2,'0')}:{String(recordingSeconds % 60).padStart(2,'0')}
                </span>
                <span className="msg-recording-label">Recording…</span>
              </div>
              <button className="btn-primary msg-send-btn" onClick={stopRecording}>Send</button>
            </>
          ) : (
            <>
              <button className="msg-attach-btn" title="Attach file" onClick={() => fileInputRef.current?.click()}>📎</button>
              <input ref={fileInputRef} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) sendMessage(f); e.currentTarget.value = ''; }} />
              <textarea
                ref={inputRef}
                className="msg-input"
                value={input}
                onChange={e => handleInputChange(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder={session ? 'Type a message… (Enter to send, Shift+Enter for newline)' : 'Join a session to chat'}
                disabled={!session}
                rows={1}
              />
              {input.trim() ? (
                <button className="btn-primary msg-send-btn" onClick={() => sendMessage()} disabled={!session}>Send</button>
              ) : (
                <button className="msg-attach-btn msg-mic-btn" title="Hold to record voice" disabled={!session}
                  onMouseDown={startRecording} onTouchStart={startRecording}>🎙</button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div className="msg-ctx-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }} onClick={e => e.stopPropagation()}>
          <button onClick={() => ctxAction('reply')}>Reply</button>
          <button onClick={() => ctxAction('copy')}>Copy</button>
          {ctxMenu.own && <button onClick={() => ctxAction('edit')}>Edit</button>}
          {ctxMenu.own && <button className="danger" onClick={() => ctxAction('delete')}>Delete</button>}
        </div>
      )}
    </div>
  );
}
