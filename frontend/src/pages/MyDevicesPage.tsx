import { useState, useEffect, useRef } from 'react';
import { AppContext } from '../App';
import { Device, FileTransferStatus, Intent } from '@shared/types';
import DeviceTile from '../components/DeviceTile';
import GroupManager from '../components/GroupManager';
import GroupTile from '../components/GroupTile';
import IntentRouter from '../services/IntentRouter';
import WebRTCManager from '../services/WebRTCManager';
import FileBridge from '../services/FileBridge';
import { groupService } from '../services/GroupService';
import { Group } from '@shared/types';
import InvitationPanel from '../components/InvitationPanel';
import './MyDevicesPage.css';

interface Props { ctx: AppContext; }

export default function MyDevicesPage({ ctx }: Props) {
  const { session, deviceId, deviceName, username, invitationService } = ctx;
  // CRITICAL FIX #8: Persist transfers to sessionStorage to survive tab switches
  const [devices, setDevices] = useState<Map<string, Device>>(new Map());
  const [groups, setGroups] = useState<Group[]>([]);
  const [transfers, setTransfers] = useState<Record<string, FileTransferStatus | null>>(() => {
    const stored = sessionStorage.getItem(`flowlink_transfers_${session?.id || 'none'}`);
    return stored ? JSON.parse(stored) : {};
  });

  // Persist transfers whenever they change
  useEffect(() => {
    if (session && Object.keys(transfers).length > 0) {
      sessionStorage.setItem(`flowlink_transfers_${session.id}`, JSON.stringify(transfers));
    }
  }, [transfers, session]);
  const [draggedItem, setDraggedItem] = useState<any>(null);
  const [showInvite, setShowInvite] = useState(false);
  const webrtcRef = useRef<WebRTCManager | null>(null);
  const fileBridgeRef = useRef<FileBridge | null>(null);
  const intentRouterRef = useRef<IntentRouter | null>(null);
  const incomingBuffersRef = useRef<Map<string, any>>(new Map());

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
    if (!ws) return;

    // Seed devices from session object immediately (already known)
    const initial = new Map<string, Device>();
    session.devices.forEach((d, id) => { if (id !== deviceId) initial.set(id, d); });
    setDevices(initial);

    webrtcRef.current = new WebRTCManager(ws, deviceId, session.id);
    fileBridgeRef.current = new FileBridge(webrtcRef.current);
    intentRouterRef.current = new IntentRouter(deviceId, webrtcRef.current, () => {});
    groupService.initialize(ws, session.id, deviceId);
    groupService.subscribe(setGroups);

    // Signal to App.tsx that MyDevicesPage is handling file transfers
    (window as any)._myDevicesPageMounted = true;

    // Re-join to get fresh device list from server
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'session_join', payload: { code: session.code, deviceId, deviceName, deviceType: 'laptop', username }, timestamp: Date.now() }));
    }

    const handler = (e: MessageEvent) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case 'device_connected': {
          const device = normalizeDevice(msg.payload);
          if (!device || device.id === deviceId) break;
          setDevices(p => { const m = new Map(p); m.set(device.id, device); return m; });
          break;
        }
        case 'device_disconnected':
          setDevices(p => { const m = new Map(p); m.delete(msg.payload.deviceId); return m; });
          setTransfers(p => { const n = { ...p }; delete n[msg.payload.deviceId]; return n; });
          break;
        case 'device_status_update': {
          const device = normalizeDevice(msg.payload);
          if (!device || device.id === deviceId) break;
          setDevices(p => { const m = new Map(p); m.set(device.id, device); return m; });
          break;
        }
        case 'session_joined':
          if (msg.payload?.devices) {
            const dm = new Map<string, Device>();
            msg.payload.devices.forEach((d: any) => {
              const device = normalizeDevice(d);
              if (device && device.id !== deviceId) dm.set(device.id, device);
            });
            setDevices(dm);
          }
          if (msg.payload?.groups) groupService.setGroups(msg.payload.groups);
          break;
        case 'group_created': groupService.addGroup(msg.payload.group); break;
        case 'group_updated': groupService.updateGroup(msg.payload.group); break;
        case 'group_deleted': groupService.removeGroup(msg.payload.groupId); break;
        case 'file_transfer_ack':
          if (msg.payload?.transferId) fileBridgeRef.current?.handleTransferAck(msg.payload.transferId, msg.payload.transferredBytes, Boolean(msg.payload.completed));
          updateTransferFromAck(msg.payload);
          break;
        case 'file_transfer_start':
          startIncomingTransfer(msg.payload);
          break;
        case 'file_transfer_chunk':
          handleChunk(msg.payload);
          break;
        case 'file_transfer_complete':
          completeIncomingTransfer(msg.payload);
          break;
        case 'intent_received':
          handleIncomingIntent(msg.payload.intent, msg.payload.sourceDevice);
          break;
        case 'tab_handoff_offer': {
          // Extension sent tab(s) - open them
          const tabs = msg.payload?.tabs || [];
          tabs.forEach((tab: any) => { if (tab?.url) window.open(tab.url, '_blank', 'noopener,noreferrer'); });
          break;
        }
        case 'clipboard_broadcast':
        case 'clipboard_sync': {
          // Extension sent clipboard content
          const txt = msg.payload?.clipboard?.text || msg.payload?.clipboard?.url;
          if (txt) navigator.clipboard.writeText(txt).catch(() => {});
          break;
        }
      }
    };
    ws.addEventListener('message', handler);

    // Also handle intents arriving via WebRTC data channel
    const webrtcIntentHandler = (e: Event) => {
      const { intent, sourceDevice } = (e as CustomEvent).detail;
      if (intent) handleIncomingIntent(intent, sourceDevice);
    };
    window.addEventListener('intent_received', webrtcIntentHandler);

    return () => {
      ws.removeEventListener('message', handler);
      window.removeEventListener('intent_received', webrtcIntentHandler);
      webrtcRef.current?.cleanup();
      groupService.cleanup();
      (window as any)._myDevicesPageMounted = false;
    };
  }, [session, deviceId, deviceName, username]);

  const b64ToU8 = (b64: string) => { const bin = atob(b64); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; };

  const startIncomingTransfer = (payload: any) => {
    const id = payload.transferId;
    if (!id) return;
    incomingBuffersRef.current.set(id, { fileName: payload.fileName || 'File', fileType: payload.fileType || 'application/octet-stream', totalBytes: payload.totalBytes || 0, chunks: [], transferredBytes: 0, sourceDevice: payload.sourceDevice || '', startedAt: Date.now() });
    const src = payload.sourceDevice;
    if (src) setTransfers(p => ({ ...p, [src]: { fileName: payload.fileName || 'File', direction: 'receiving', progress: 0, totalBytes: payload.totalBytes || 0, transferredBytes: 0, speedBytesPerSec: 0, etaSeconds: 0, startedAt: Date.now(), completed: false } }));
  };

  const handleChunk = (payload: any) => {
    const buf = incomingBuffersRef.current.get(payload.transferId);
    if (!buf) return;
    const chunk = b64ToU8(payload.data || '');
    buf.chunks.push(chunk);
    buf.transferredBytes += chunk.byteLength;
    const elapsed = Math.max(0.001, (Date.now() - buf.startedAt) / 1000);
    const speed = buf.transferredBytes / elapsed;
    const progress = buf.totalBytes > 0 ? Math.min(99, Math.round((buf.transferredBytes / buf.totalBytes) * 100)) : 0;
    if (buf.sourceDevice) setTransfers(p => ({ ...p, [buf.sourceDevice]: { fileName: buf.fileName, direction: 'receiving', progress, totalBytes: buf.totalBytes, transferredBytes: buf.transferredBytes, speedBytesPerSec: speed, etaSeconds: Math.max(0, Math.ceil((buf.totalBytes - buf.transferredBytes) / Math.max(1, speed))), startedAt: buf.startedAt, completed: false } }));
    // ACK
    const ws = (window as any).appWebSocket as WebSocket | null;
    if (ws?.readyState === WebSocket.OPEN && buf.transferredBytes - (buf.lastAck || 0) >= 512 * 1024) {
      buf.lastAck = buf.transferredBytes;
      ws.send(JSON.stringify({ type: 'file_transfer_ack', sessionId: session!.id, deviceId, payload: { transferId: payload.transferId, targetDevice: buf.sourceDevice, transferredBytes: buf.transferredBytes, totalBytes: buf.totalBytes, progress }, timestamp: Date.now() }));
    }
  };

  const completeIncomingTransfer = (payload: any) => {
    const buf = incomingBuffersRef.current.get(payload.transferId);
    if (!buf) return;
    incomingBuffersRef.current.delete(payload.transferId);
    const blob = new Blob(buf.chunks, { type: buf.fileType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = buf.fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1200);
    if (buf.sourceDevice) {
      setTransfers(p => {
        const current = p[buf.sourceDevice];
        return {
          ...p,
          [buf.sourceDevice]: {
            fileName: current?.fileName || buf.fileName,
            direction: 'receiving',
            progress: 100,
            totalBytes: current?.totalBytes || buf.totalBytes,
            transferredBytes: current?.transferredBytes || buf.totalBytes,
            speedBytesPerSec: current?.speedBytesPerSec || 0,
            etaSeconds: 0,
            startedAt: current?.startedAt || buf.startedAt,
            completed: true,
          },
        };
      });
      setTimeout(() => setTransfers(p => { const n = { ...p }; delete n[buf.sourceDevice]; return n; }), 2000);
    }
  };

  const updateTransferFromAck = (payload: any) => {
    const src = payload.sourceDevice || payload.targetDevice;
    if (!src) return;
    const total = payload.totalBytes || 0;
    const transferred = payload.transferredBytes || 0;
    const progress = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : (payload.progress || 0);
    setTransfers(p => {
      const cur = p[src];
      return { ...p, [src]: { fileName: cur?.fileName || payload.fileName || 'File', direction: 'sending', progress, totalBytes: total || cur?.totalBytes || 0, transferredBytes: transferred || cur?.transferredBytes || 0, speedBytesPerSec: cur?.speedBytesPerSec || 0, etaSeconds: payload.completed ? 0 : (cur?.etaSeconds || 0), startedAt: cur?.startedAt || Date.now(), completed: Boolean(payload.completed) || progress >= 100 } };
    });
    if (Boolean(payload.completed) || progress >= 100) {
      setTimeout(() => setTransfers(p => { const n = { ...p }; delete n[src]; return n; }), 2000);
    }
  };

  const handleIncomingIntent = async (intent: Intent, sourceDevice: string) => {
    const device = devices.get(sourceDevice);
    const dName = device?.name || 'Unknown Device';
    const granted = window.confirm(getPermMsg(intent, dName));
    if (!granted) return;
    // Process basic intents
    if (intent.intent_type === 'clipboard_sync') {
      const txt = (intent.payload.clipboard as any)?.text;
      if (txt) navigator.clipboard.writeText(txt).catch(() => {});
    }
    if (intent.intent_type === 'link_open') {
      const url = (intent.payload.link as any)?.url;
      if (url) window.open(url, '_blank');
    }
  };

  const getPermMsg = (intent: Intent, dName: string) => {
    const t = intent?.intent_type;
    if (t === 'file_handoff') return `${dName} wants to send you a file: ${intent.payload?.file?.name || ''}. Allow?`;
    if (t === 'batch_file_handoff') return `${dName} wants to send ${intent.payload?.files?.totalFiles || 'multiple'} files. Allow?`;
    if (t === 'clipboard_sync') return `${dName} wants to sync clipboard. Allow?`;
    if (t === 'link_open') return `${dName} wants to open a link. Allow?`;
    if (t === 'media_continuation') return `${dName} wants to continue media playback. Allow?`;
    if (t === 'prompt_injection') return `${dName} wants to send a prompt. Allow?`;
    // Fallback: show the actual intent type so it's debuggable
    return `${dName} wants to perform an action (${t || 'unknown'}). Allow?`;
  };

  const sendFileWithProgress = async (targetId: string, intent: Intent) => {
    if (!fileBridgeRef.current || !session) return;
    if (intent.intent_type === 'file_handoff' && intent.payload.file) {
      const f = intent.payload.file as any;
      const file: File = f.localRef instanceof File ? f.localRef : new File([new Uint8Array(f.data || [])], f.name, { type: f.type });
      setTransfers(p => ({ ...p, [targetId]: { fileName: file.name, direction: 'sending', progress: 0, totalBytes: file.size, transferredBytes: 0, speedBytesPerSec: 0, etaSeconds: 0, startedAt: Date.now(), completed: false } }));
      await fileBridgeRef.current.sendFile(file, targetId, (stats) => setTransfers(p => ({ ...p, [targetId]: stats })));
    }
    if (intent.intent_type === 'batch_file_handoff' && intent.payload.files) {
      const files = (intent.payload.files as any).files.map((f: any) => f.localRef instanceof File ? f.localRef : new File([new Uint8Array(f.data || [])], f.name, { type: f.type })).filter(Boolean);
      const total = files.reduce((s: number, f: File) => s + f.size, 0);
      let sent = 0;
      for (const file of files) {
        await fileBridgeRef.current.sendFile(file, targetId, (stats) => setTransfers(p => ({ ...p, [targetId]: { ...stats, fileName: `${files.length} files`, totalBytes: total, transferredBytes: sent + stats.transferredBytes, progress: Math.round(((sent + stats.transferredBytes) / total) * 100) } })));
        sent += file.size;
      }
      setTransfers(p => {
        const current = p[targetId];
        if (!current) return p;
        return { ...p, [targetId]: { ...current, progress: 100, transferredBytes: current.totalBytes, etaSeconds: 0, completed: true } };
      });
      setTimeout(() => setTransfers(p => { const n = { ...p }; delete n[targetId]; return n; }), 2000);
    }
  };

  const handleDeviceDrop = async (intent: Intent, targetId: string) => {
    if (!intentRouterRef.current) return;
    if (intent.intent_type === 'file_handoff' || intent.intent_type === 'batch_file_handoff') {
      await sendFileWithProgress(targetId, intent);
    } else {
      await intentRouterRef.current.routeIntent(intent, targetId);
    }
  };

  const handleGroupDrop = (groupId: string, intent: Intent) => {
    groupService.broadcastToGroup(groupId, intent);
  };

  const deviceArr = Array.from(devices.values());

  if (!session) {
    return (
      <div className="md-no-session-wrap">
        <div className="card md-no-session">
          <div>🔒</div>
          <div>Create or join a session from the Overview page to see connected devices.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="my-devices-page">
      <div className="md-header card">
        <div className="md-header-left">
          <div className="md-header-title">My Devices</div>
          <div className="md-header-sub">Drag files, links, or text onto a device tile to send.</div>
        </div>
        <button className="btn-primary" style={{ fontSize: '0.8rem' }} onClick={() => setShowInvite(true)}>+ Invite Device</button>
      </div>

      {deviceArr.length === 0 ? (
        <div className="card md-waiting">
          <div className="md-waiting-icon">📱</div>
          <div className="md-waiting-title">Waiting for devices…</div>
          <div className="md-waiting-sub">Share code <strong>{session.code}</strong> with another device to connect.</div>
        </div>
      ) : (
        <>
          {groups.length > 0 && (
            <div className="md-groups-row">
              {groups.map(g => (
                <GroupTile key={g.id} group={g} devices={deviceArr} onDrop={handleGroupDrop} />
              ))}
            </div>
          )}
          <div className="md-tiles-grid">
            {deviceArr.map(device => (
              <DeviceTile
                key={device.id}
                device={device}
                draggedItem={draggedItem}
                onDragStart={(_e, item) => setDraggedItem(item)}
                onDragEnd={() => setDraggedItem(null)}
                transferStatus={transfers[device.id]}
                onDrop={(intent) => handleDeviceDrop(intent, device.id)}
                myUsername={username}
                myDeviceId={deviceId}
                sessionId={session.id}
              />
            ))}
          </div>
          <GroupManager
            devices={deviceArr}
            groups={groups}
            currentDeviceId={deviceId}
            onCreateGroup={(name, ids, color) => groupService.createGroup(name, ids, color)}
            onUpdateGroup={(gid, updates) => groupService.updateGroupDetails(gid, updates)}
            onDeleteGroup={(gid) => groupService.deleteGroup(gid)}
          />
        </>
      )}

      <InvitationPanel sessionId={session.id} sessionCode={session.code} invitationService={invitationService} isOpen={showInvite} onClose={() => setShowInvite(false)} />
    </div>
  );
}
