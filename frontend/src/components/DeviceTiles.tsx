import { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { QRCodeSVG } from 'qrcode.react';
import { Session, Device, Intent, Group, FileTransferStatus } from '@shared/types';
import DeviceTile from './DeviceTile';
import GroupManager from './GroupManager';
import GroupTile from './GroupTile';
import IntentRouter from '../services/IntentRouter';
import WebRTCManager from '../services/WebRTCManager';
import FileBridge from '../services/FileBridge';
import ContinuityEngine from '../services/ContinuityEngine';
import PermissionEngine from '../services/PermissionEngine';
import MediaDetector from '../services/MediaDetector';
import { groupService } from '../services/GroupService';
import InvitationService from '../services/InvitationService';
import InvitationPanel from './InvitationPanel';
import './DeviceTiles.css';

interface DeviceTilesProps {
  session: Session;
  deviceId: string;
  deviceName: string;
  deviceType: 'phone' | 'laptop' | 'desktop' | 'tablet';
  username: string;
  invitationService: InvitationService | null;
  onLeaveSession: () => void;
}

interface ChatMessageItem {
  messageId: string;
  text: string;
  username: string;
  sourceDevice: string;
  targetDevice: string;
  sentAt: number;
  delivered: boolean;
  seen: boolean;
}

interface StudyStoreFile {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
  uploadedBy?: string;
  uploadedAt?: number;
}

interface StudyHighlightAnchor {
  id: string;
  page: number;
  xPercent?: number;
  yPercent: number;
  widthPercent?: number;
  heightPercent?: number;
  text: string;
  sourceDevice?: string;
}

interface StudySyncState {
  page?: number;
  scrollPx?: number;
  zoom?: number;
  highlight?: string;
  selectedFileId?: string;
  anchors?: StudyHighlightAnchor[];
}

export default function DeviceTiles({
  session,
  deviceId,
  deviceName,
  deviceType,
  username,
  invitationService,
  onLeaveSession,
}: DeviceTilesProps) {
  const [devices, setDevices] = useState<Map<string, Device>>(() => {
    // Initialize with devices from session, excluding self
    const initialDevices = new Map<string, Device>();
    console.log('🚀 DeviceTiles initializing');
    console.log('Session ID:', session.id);
    console.log('Session code:', session.code);
    console.log('Session createdBy:', session.createdBy);
    console.log('Session devices size:', session.devices.size);
    console.log('Current deviceId (self):', deviceId);
    
    session.devices.forEach((device, id) => {
      console.log(`Device in session: ${id} = ${device.name} (${device.type})`);
      if (id !== deviceId) {
        console.log(`  ✅ Adding to initial map`);
        initialDevices.set(id, device);
      } else {
        console.log(`  ⏭️ Skipping (self)`);
      }
    });
    
    console.log('Initial devices map size:', initialDevices.size);
    console.log('Initial devices:', Array.from(initialDevices.entries()).map(([id, d]) => `${id.substring(0, 8)}...: ${d.name}`));
    return initialDevices;
  });
  const [groups, setGroups] = useState<Group[]>([]);
  const [draggedItem, setDraggedItem] = useState<any>(null);
  const [showInvitationPanel, setShowInvitationPanel] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<ChatMessageItem[]>([]);
  const [chatUnreadCount, setChatUnreadCount] = useState(0);
  const [typingByDevice, setTypingByDevice] = useState<Record<string, boolean>>({});
  const [transferStatuses, setTransferStatuses] = useState<Record<string, FileTransferStatus | null>>({});
  const [isStudyOpen, setIsStudyOpen] = useState(false);
  const [activeStudyTab, setActiveStudyTab] = useState<'store' | 'room'>('store');
  const [studyFiles, setStudyFiles] = useState<StudyStoreFile[]>([]);
  const [studyPage, setStudyPage] = useState(1);
  const [studyScroll, setStudyScroll] = useState(0);
  const [studyZoom, setStudyZoom] = useState(1.2);
  const [studyHighlight, setStudyHighlight] = useState('');
  const [studySelectedFileId, setStudySelectedFileId] = useState<string>('');
  const [studyPdfPageCount, setStudyPdfPageCount] = useState(0);
  const [studyPdfDataUrl, setStudyPdfDataUrl] = useState<string>('');
  const [studyHighlights, setStudyHighlights] = useState<StudyHighlightAnchor[]>([]);
  const [isCollaboratedView, setIsCollaboratedView] = useState(false);
  const [isCollabQrOpen, setIsCollabQrOpen] = useState(false);
  const [isStudyFullscreen, setIsStudyFullscreen] = useState(false);
  const [showPermissionsPanel, setShowPermissionsPanel] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const webrtcManagerRef = useRef<WebRTCManager | null>(null);
  const intentRouterRef = useRef<IntentRouter | null>(null);
  const fileBridgeRef = useRef<FileBridge | null>(null);
  const continuityEngineRef = useRef<ContinuityEngine | null>(null);
  const permissionEngineRef = useRef<PermissionEngine | null>(null);
  const mediaDetectorRef = useRef<MediaDetector | null>(null);
  const transferTimersRef = useRef<Map<string, number>>(new Map());
  const incomingTransferBuffersRef = useRef<Map<string, { fileName: string; fileType: string; totalBytes: number; startedAt: number; chunks: Uint8Array[]; sourceDevice: string; transferredBytes: number; lastAckBytes: number }>>(new Map());
  const chatBodyRef = useRef<HTMLDivElement | null>(null);
  const chatTypingStopTimerRef = useRef<number | null>(null);
  const transferUiTickRef = useRef<Map<string, number>>(new Map());
  const pdfScrollRef = useRef<HTMLDivElement | null>(null);
  const collabChatFileInputRef = useRef<HTMLInputElement | null>(null);
  const pdfPageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const suppressStudyScrollSyncRef = useRef(false);
  const localStudyInteractionAtRef = useRef(0);

  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();

  const estimateTransferRate = (bytes: number) => Math.max(256 * 1024, 4 * 1024 * 1024 - Math.min(3 * 1024 * 1024, bytes / 8));

  const clearTransferTimer = (deviceId: string) => {
    const timer = transferTimersRef.current.get(deviceId);
    if (timer) {
      window.clearInterval(timer);
      transferTimersRef.current.delete(deviceId);
    }
  };

  const startTransferStatus = (deviceId: string, fileName: string, direction: 'sending' | 'receiving', totalBytes: number) => {
    clearTransferTimer(deviceId);
    const speedBytesPerSec = estimateTransferRate(totalBytes);
    const etaSeconds = Math.max(1, Math.ceil(totalBytes / speedBytesPerSec));
    const startedAt = Date.now();

    setTransferStatuses((prev) => ({
      ...prev,
      [deviceId]: {
        fileName,
        direction,
        progress: 0,
        totalBytes,
        transferredBytes: 0,
        speedBytesPerSec,
        etaSeconds,
        startedAt,
      },
    }));

    const timer = window.setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const progress = Math.min(95, Math.floor((elapsed / etaSeconds) * 100));
      const transferredBytes = Math.min(totalBytes, Math.floor((totalBytes * progress) / 100));
      const remaining = Math.max(0, Math.ceil(etaSeconds - elapsed));

      setTransferStatuses((prev) => {
        const current = prev[deviceId];
        if (!current) return prev;
        return {
          ...prev,
          [deviceId]: {
            ...current,
            progress,
            transferredBytes,
            etaSeconds: remaining,
          },
        };
      });
    }, 250);

    transferTimersRef.current.set(deviceId, timer);
  };

  const completeTransferStatus = (deviceId: string) => {
    clearTransferTimer(deviceId);
    setTransferStatuses((prev) => {
      const current = prev[deviceId];
      if (!current) return prev;
      return {
        ...prev,
        [deviceId]: {
          ...current,
          progress: 100,
          transferredBytes: current.totalBytes,
          etaSeconds: 0,
          completed: true,
        },
      };
    });
    window.setTimeout(() => {
      setTransferStatuses((prev) => {
        if (!prev[deviceId]) return prev;
        const next = { ...prev };
        delete next[deviceId];
        return next;
      });
    }, 1800);
  };

  const deriveTransferMeta = (intent: Intent) => {
    if (intent.intent_type === 'file_handoff' && intent.payload.file) {
      return { fileName: intent.payload.file.name || 'File', totalBytes: intent.payload.file.size || 0 };
    }

    if (intent.intent_type === 'batch_file_handoff' && intent.payload.files) {
      return { fileName: `${intent.payload.files.totalFiles} files`, totalBytes: intent.payload.files.totalSize || 0 };
    }

    return null;
  };

  const base64ToUint8Array = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };

  const applyStudyState = (state?: StudySyncState | null) => {
    if (!state) return;
    if (Number.isFinite(state.page)) {
      setStudyPage(Math.max(1, Number(state.page)));
    }
    if (Number.isFinite(state.scrollPx)) {
      setStudyScroll(Math.max(0, Number(state.scrollPx)));
    }
    if (Number.isFinite(state.zoom)) {
      setStudyZoom(Math.max(0.6, Math.min(2.4, Number(state.zoom))));
    }
    if (typeof state.highlight === 'string') {
      setStudyHighlight(state.highlight);
    }
    if (typeof state.selectedFileId === 'string') {
      setStudySelectedFileId(state.selectedFileId);
    }
    if (Array.isArray(state.anchors)) {
      setStudyHighlights(state.anchors.slice(-120));
    }
  };

  const downloadReceivedFile = (fileName: string, fileType: string, chunks: Uint8Array[]) => {
    const blob = new Blob(chunks as unknown as BlobPart[], { type: fileType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName || 'flowlink-file';
    a.click();
    // Delay revoke so browser can finish download handoff.
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  };

  const applyTransferStats = (deviceId: string, stats: FileTransferStatus) => {
    const now = Date.now();
    const lastTick = transferUiTickRef.current.get(deviceId) || 0;
    const shouldForce = stats.completed || Math.abs((stats.progress || 0) - ((transferStatuses[deviceId]?.progress) || 0)) >= 5;
    if (!shouldForce && now - lastTick < 220) {
      return;
    }
    transferUiTickRef.current.set(deviceId, now);
    setTransferStatuses((prev) => ({
      ...prev,
      [deviceId]: stats,
    }));

    if (stats.completed) {
      clearTransferTimer(deviceId);
      window.setTimeout(() => {
        setTransferStatuses((prev) => {
          if (!prev[deviceId]) return prev;
          const next = { ...prev };
          delete next[deviceId];
          transferUiTickRef.current.delete(deviceId);
          return next;
        });
      }, 1800);
    }
  };

  const toFile = (fileLike: any): File | null => {
    if (!fileLike?.name) return null;
    if (fileLike.localRef instanceof File) {
      return fileLike.localRef;
    }
    if (!fileLike?.data) return null;
    const raw = fileLike.data;
    const bytes = raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : Array.isArray(raw)
        ? new Uint8Array(raw)
        : raw?.byteLength
          ? new Uint8Array(raw)
          : null;
    if (!bytes) return null;
    return new File([bytes], fileLike.name, { type: fileLike.type || 'application/octet-stream' });
  };

  const sendFileWithProgress = async (deviceId: string, intent: Intent) => {
    if (!fileBridgeRef.current) {
      throw new Error('File bridge not ready');
    }

    if (intent.intent_type === 'file_handoff' && intent.payload.file) {
      const file = toFile(intent.payload.file);
      if (!file) throw new Error('Invalid file payload');
      await fileBridgeRef.current.sendFile(file, deviceId, (stats) => applyTransferStats(deviceId, stats));
      return;
    }

    if (intent.intent_type === 'batch_file_handoff' && intent.payload.files) {
      const files = intent.payload.files.files.map((f) => toFile(f)).filter((f): f is File => Boolean(f));
      if (!files.length) throw new Error('Invalid batch file payload');

      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      let transferredBytes = 0;
      const startedAt = Date.now();

      for (const file of files) {
        await fileBridgeRef.current.sendFile(file, deviceId, (stats) => {
          const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
          const combinedTransferred = transferredBytes + stats.transferredBytes;
          const speedBytesPerSec = combinedTransferred / elapsed;
          const etaSeconds = Math.max(0, Math.ceil((totalBytes - combinedTransferred) / Math.max(1, speedBytesPerSec)));
          applyTransferStats(deviceId, {
            fileName: intent.payload.files?.batchId ? `${intent.payload.files.totalFiles} files` : file.name,
            direction: 'sending',
            progress: Math.min(99, Math.round((combinedTransferred / totalBytes) * 100)),
            totalBytes,
            transferredBytes: combinedTransferred,
            speedBytesPerSec,
            etaSeconds,
            startedAt,
            completed: false,
          });
        });
        transferredBytes += file.size;
      }

      applyTransferStats(deviceId, {
        fileName: intent.payload.files.batchId ? `${intent.payload.files.totalFiles} files` : 'Files',
        direction: 'sending',
        progress: 100,
        totalBytes,
        transferredBytes: totalBytes,
        speedBytesPerSec: totalBytes / Math.max(0.001, (Date.now() - startedAt) / 1000),
        etaSeconds: 0,
        startedAt,
        completed: true,
      });
    }
  };

  useEffect(() => {
    // Store session info for RemoteAccess component
    sessionStorage.setItem('sessionId', session.id);
    sessionStorage.setItem('sessionCode', session.code);
    sessionStorage.setItem('deviceId', deviceId);
    sessionStorage.setItem('username', username);
    sessionStorage.setItem('deviceName', deviceName);
    sessionStorage.setItem('deviceType', deviceType);
    
    // Use the App-level WebSocket instead of creating a new one
    const ws = (window as any).appWebSocket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('DeviceTiles using App-level WebSocket, rejoining session:', session.code);
      wsRef.current = ws;
      
      // Re-join session to get updates
      ws.send(JSON.stringify({
        type: 'session_join',
        payload: {
          code: session.code,
          deviceId,
          deviceName,
          deviceType,
          username,
        },
        timestamp: Date.now(),
      }));
    } else {
      console.error('App-level WebSocket not available in DeviceTiles');
    }

    // Add message listener for DeviceTiles-specific messages
    const handleDeviceTilesMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data);
      // Only handle messages that DeviceTiles cares about
      if (['device_connected', 'device_disconnected', 'device_status_update', 
           'intent_received', 'intent_accepted', 'intent_rejected',
           'file_transfer_progress', 'file_transfer_start', 'file_transfer_chunk', 'file_transfer_complete', 'file_transfer_cancel', 'file_transfer_ack',
           'group_created', 'group_updated', 'group_deleted', 'chat_typing',
           'study_store_list', 'study_sync'].includes(message.type)) {
        handleWebSocketMessage(message);
      }
    };

    const handleChatEvent = (event: Event) => {
      const customEvent = event as CustomEvent;
      const message = customEvent.detail?.message;
      if (!message || !['chat_message', 'chat_delivered', 'chat_seen', 'chat_typing'].includes(message.type)) return;
      handleWebSocketMessage(message);
    };

    if (ws) {
      ws.addEventListener('message', handleDeviceTilesMessage);
    }
    window.addEventListener('chatMessage', handleChatEvent);

    // Initialize WebRTC Manager
    webrtcManagerRef.current = new WebRTCManager(ws, deviceId, session.id);

    // Initialize services
    fileBridgeRef.current = new FileBridge(webrtcManagerRef.current);
    continuityEngineRef.current = new ContinuityEngine(webrtcManagerRef.current, deviceId);
    permissionEngineRef.current = new PermissionEngine();
    mediaDetectorRef.current = new MediaDetector();

    // Initialize Intent Router (WebRTC manager may fall back to WebSocket)
    intentRouterRef.current = new IntentRouter(
      deviceId,
      webrtcManagerRef.current,
      handleIntentSent
    );

    // Initialize Group Service
    groupService.initialize(ws, session.id, deviceId);
    groupService.subscribe(setGroups);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'study_store_list',
        sessionId: session.id,
        deviceId,
        payload: {},
        timestamp: Date.now(),
      }));
    }

    return () => {
      if (ws) {
        ws.removeEventListener('message', handleDeviceTilesMessage);
      }
      window.removeEventListener('chatMessage', handleChatEvent);
      webrtcManagerRef.current?.cleanup();
      permissionEngineRef.current?.revokeAll();
      mediaDetectorRef.current?.cleanup();
      transferTimersRef.current.forEach((timer) => window.clearInterval(timer));
      transferTimersRef.current.clear();
      if (chatTypingStopTimerRef.current) {
        window.clearTimeout(chatTypingStopTimerRef.current);
        chatTypingStopTimerRef.current = null;
      }
      groupService.cleanup();
    };
  }, [session.code, deviceId, deviceName, deviceType, username]);

  useEffect(() => {
    if (isChatOpen) {
      setChatUnreadCount(0);
      chatBodyRef.current?.scrollTo({ top: chatBodyRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [isChatOpen, chatMessages.length]);

  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const targetDevice = Array.from(devices.values()).find((d) => d.id !== deviceId)?.id;
    if (!targetDevice) return;

    if (chatTypingStopTimerRef.current) {
      window.clearTimeout(chatTypingStopTimerRef.current);
      chatTypingStopTimerRef.current = null;
    }

    const isTyping = chatInput.trim().length > 0;
    wsRef.current.send(JSON.stringify({
      type: 'chat_typing',
      sessionId: session.id,
      deviceId,
      payload: {
        targetDevice,
        isTyping,
      },
      timestamp: Date.now(),
    }));

    if (isTyping) {
      chatTypingStopTimerRef.current = window.setTimeout(() => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        wsRef.current.send(JSON.stringify({
          type: 'chat_typing',
          sessionId: session.id,
          deviceId,
          payload: {
            targetDevice,
            isTyping: false,
          },
          timestamp: Date.now(),
        }));
        chatTypingStopTimerRef.current = null;
      }, 1400);
    }
  }, [chatInput, deviceId, devices, session.id]);

  const handleWebSocketMessage = (message: any) => {
    console.log('DeviceTiles received message:', message.type, message);
    switch (message.type) {
      case 'file_transfer_progress': {
        const payload = message.payload || {};
        const deviceId = payload.deviceId || message.deviceId || payload.sourceDevice;
        if (deviceId) {
          applyTransferStats(deviceId, {
            fileName: payload.fileName || 'File',
            direction: payload.direction === 'receive' ? 'receiving' : 'sending',
            progress: payload.progress || 0,
            totalBytes: payload.totalBytes || 0,
            transferredBytes: payload.transferredBytes || 0,
            speedBytesPerSec: payload.speedBytesPerSec || 0,
            etaSeconds: payload.etaSeconds || 0,
            startedAt: payload.startedAt || Date.now(),
            completed: (payload.progress || 0) >= 100,
          });
        }
        break;
      }
      case 'file_transfer_start': {
        const payload = message.payload || {};
        const transferId = payload.transferId || `${message.timestamp}`;
        if (transferId) {
          incomingTransferBuffersRef.current.set(transferId, {
            fileName: payload.fileName || 'File',
            fileType: payload.fileType || 'application/octet-stream',
            totalBytes: payload.totalBytes || 0,
            startedAt: Date.now(),
            chunks: [],
            sourceDevice: payload.sourceDevice || message.deviceId || '',
            transferredBytes: 0,
            lastAckBytes: 0,
          });
          const deviceId = payload.sourceDevice || message.deviceId || '';
          if (deviceId) {
            applyTransferStats(deviceId, {
              fileName: payload.fileName || 'File',
              direction: 'receiving',
              progress: 0,
              totalBytes: payload.totalBytes || 0,
              transferredBytes: 0,
              speedBytesPerSec: 0,
              etaSeconds: 0,
              startedAt: Date.now(),
              completed: false,
            });
          }
        }
        break;
      }
      case 'file_transfer_chunk': {
        const payload = message.payload || {};
        const transferId = payload.transferId;
        const bufferState = incomingTransferBuffersRef.current.get(transferId);
        if (!bufferState) break;

        const chunk = base64ToUint8Array(payload.data || '');
        bufferState.chunks.push(chunk);
        bufferState.transferredBytes += chunk.byteLength;
        const transferredBytes = bufferState.transferredBytes;
        const elapsed = Math.max(0.001, (Date.now() - bufferState.startedAt) / 1000);
        const speedBytesPerSec = transferredBytes / elapsed;
        const etaSeconds = Math.max(0, Math.ceil((bufferState.totalBytes - transferredBytes) / Math.max(1, speedBytesPerSec)));
        const progress = bufferState.totalBytes > 0 ? Math.min(99, Math.round((transferredBytes / bufferState.totalBytes) * 100)) : 0;
        const deviceId = bufferState.sourceDevice;

        if (deviceId) {
          applyTransferStats(deviceId, {
            fileName: bufferState.fileName,
            direction: 'receiving',
            progress,
            totalBytes: bufferState.totalBytes,
            transferredBytes,
            speedBytesPerSec,
            etaSeconds,
            startedAt: bufferState.startedAt,
            completed: false,
          });
        }
        if (
          wsRef.current?.readyState === WebSocket.OPEN &&
          transferId &&
          transferredBytes - bufferState.lastAckBytes >= 512 * 1024
        ) {
          bufferState.lastAckBytes = transferredBytes;
          wsRef.current.send(JSON.stringify({
            type: 'file_transfer_ack',
            sessionId: session.id,
            deviceId,
            payload: {
              transferId,
              targetDevice: bufferState.sourceDevice,
              transferredBytes,
              totalBytes: bufferState.totalBytes,
              progress,
            },
            timestamp: Date.now(),
          }));
        }
        break;
      }
      case 'file_transfer_complete': {
        const payload = message.payload || {};
        const transferId = payload.transferId;
        const bufferState = incomingTransferBuffersRef.current.get(transferId);
        if (!bufferState) break;
        incomingTransferBuffersRef.current.delete(transferId);

        const deviceId = bufferState.sourceDevice;
        downloadReceivedFile(bufferState.fileName, bufferState.fileType, bufferState.chunks);

        if (deviceId) {
          applyTransferStats(deviceId, {
            fileName: bufferState.fileName,
            direction: 'receiving',
            progress: 100,
            totalBytes: bufferState.totalBytes,
            transferredBytes: bufferState.totalBytes,
            speedBytesPerSec: bufferState.totalBytes / Math.max(0.001, (Date.now() - bufferState.startedAt) / 1000),
            etaSeconds: 0,
            startedAt: bufferState.startedAt,
            completed: true,
          });
        }
        if (wsRef.current?.readyState === WebSocket.OPEN && transferId) {
          wsRef.current.send(JSON.stringify({
            type: 'file_transfer_ack',
            sessionId: session.id,
            deviceId,
            payload: {
              transferId,
              targetDevice: bufferState.sourceDevice,
              transferredBytes: bufferState.totalBytes,
              totalBytes: bufferState.totalBytes,
              progress: 100,
              completed: true,
            },
            timestamp: Date.now(),
          }));
        }

        break;
      }
      case 'file_transfer_ack': {
        const payload = message.payload || {};
        if (payload.transferId && typeof payload.transferredBytes === 'number') {
          fileBridgeRef.current?.handleTransferAck(
            payload.transferId,
            payload.transferredBytes,
            Boolean(payload.completed)
          );
        }
        const source = payload.sourceDevice || message.deviceId || payload.targetDevice;
        if (!source) break;
        const totalBytes = payload.totalBytes || 0;
        const transferredBytes = payload.transferredBytes || 0;
        const progress = totalBytes > 0 ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100)) : (payload.progress || 0);
        const current = transferStatuses[source];
        applyTransferStats(source, {
          fileName: current?.fileName || payload.fileName || 'File',
          direction: 'sending',
          progress,
          totalBytes: totalBytes || current?.totalBytes || 0,
          transferredBytes: transferredBytes || current?.transferredBytes || 0,
          speedBytesPerSec: current?.speedBytesPerSec || 0,
          etaSeconds: payload.completed ? 0 : (current?.etaSeconds || 0),
          startedAt: current?.startedAt || Date.now(),
          completed: Boolean(payload.completed) || progress >= 100,
        });
        break;
      }
      case 'file_transfer_cancel': {
        const payload = message.payload || {};
        const source = payload.sourceDevice || message.deviceId;
        if (source) {
          clearTransferTimer(source);
          setTransferStatuses((prev) => {
            if (!prev[source]) return prev;
            const next = { ...prev };
            delete next[source];
            return next;
          });
        }
        break;
      }
      case 'device_connected':
        const newDevice: Device = message.payload.device;
        console.log('Device connected:', newDevice);
        setDevices((prev) => {
          const updated = new Map(prev);
          updated.set(newDevice.id, newDevice);
          console.log('Updated devices map:', Array.from(updated.keys()));
          return updated;
        });
        
        // Show notification for new device
        if (newDevice.username && invitationService) {
          invitationService.showDeviceJoined(newDevice.username, newDevice.name);
        }
        break;

      case 'device_disconnected':
        setDevices((prev) => {
          const updated = new Map(prev);
          const deviceId = message.payload.deviceId;
          // Remove the device tile entirely when it disconnects
          updated.delete(deviceId);
          console.log('Device disconnected and removed:', deviceId);
          return updated;
        });
        clearTransferTimer(message.payload.deviceId);
        setTransferStatuses((prev) => {
          if (!prev[message.payload.deviceId]) return prev;
          const next = { ...prev };
          delete next[message.payload.deviceId];
          return next;
        });
        break;

      case 'device_status_update':
        setDevices((prev) => {
          const updated = new Map(prev);
          const device = message.payload.device;
          updated.set(device.id, device);
          return updated;
        });
        break;

      case 'intent_received':
        handleIncomingIntent(message.payload.intent, message.payload.sourceDevice);
        break;
      case 'chat_message': {
        const chat = message.payload?.chat;
        if (!chat?.messageId || !chat?.text) break;
        if (message.payload?.sourceDevice) {
          setTypingByDevice((prev) => ({ ...prev, [message.payload.sourceDevice]: false }));
        }
        setChatMessages((prev) => prev.concat({
          messageId: chat.messageId,
          text: chat.text,
          username: chat.username || 'Unknown',
          sourceDevice: message.payload?.sourceDevice || '',
          targetDevice: deviceId,
          sentAt: chat.sentAt || Date.now(),
          delivered: true,
          seen: isChatOpen,
        }));
        if (!isChatOpen) {
          setChatUnreadCount((prev) => prev + 1);
        }
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: isChatOpen ? 'chat_seen' : 'chat_delivered',
            sessionId: session.id,
            deviceId,
            payload: {
              messageId: chat.messageId,
              targetDevice: message.payload?.sourceDevice,
            },
            timestamp: Date.now(),
          }));
        }
        break;
      }
      case 'chat_delivered': {
        const messageId = message.payload?.messageId;
        if (!messageId) break;
        setChatMessages((prev) => prev.map((item) => item.messageId === messageId ? { ...item, delivered: true } : item));
        break;
      }
      case 'chat_seen': {
        const messageId = message.payload?.messageId;
        if (!messageId) break;
        setChatMessages((prev) => prev.map((item) => item.messageId === messageId ? { ...item, delivered: true, seen: true } : item));
        break;
      }
      case 'chat_typing': {
        const source = message.payload?.sourceDevice || '';
        if (!source) break;
        const isTyping = Boolean(message.payload?.isTyping);
        setTypingByDevice((prev) => ({ ...prev, [source]: isTyping }));
        break;
      }
      case 'study_store_list': {
        setStudyFiles(message.payload?.files || []);
        applyStudyState(message.payload?.state || null);
        break;
      }
      case 'study_sync': {
        const payload = message.payload || {};
        applyStudyState(payload.state || null);
        if (payload.mode === 'page' && Number.isFinite(payload.value)) {
          setStudyPage(Math.max(1, Number(payload.value)));
        }
        if (payload.mode === 'scroll_px' && Number.isFinite(payload.value)) {
          const now = Date.now();
          if (now - localStudyInteractionAtRef.current > 180) {
            setStudyScroll(Math.max(0, Number(payload.value)));
          }
        } else if (payload.mode === 'scroll' && Number.isFinite(payload.value)) {
          setStudyScroll(Math.max(0, Math.min(100, Number(payload.value))));
        }
        if (payload.mode === 'zoom' && Number.isFinite(payload.value)) {
          const nextZoom = Math.max(0.6, Math.min(2.4, Number(payload.value)));
          setStudyZoom(nextZoom);
        }
        if (payload.mode === 'highlight' && typeof payload.value === 'string') {
          setStudyHighlight(payload.value);
        }
        if (payload.mode === 'open_pdf' && typeof payload.value === 'string') {
          setStudySelectedFileId(payload.value);
          setIsStudyOpen(true);
          setActiveStudyTab('room');
          setIsStudyFullscreen(true);  // Auto-open fullscreen for readable view
        }
        if (payload.mode === 'highlight_anchor' && payload.value?.id) {
          setStudyHighlights((prev) => {
            const next = prev.filter((item) => item.id !== payload.value.id);
            next.push(payload.value as StudyHighlightAnchor);
            return next.slice(-120);
          });
        }
        break;
      }

      case 'session_invitation':
        // Handle incoming session invitation
        const invitation = message.payload.invitation;
        if (invitationService) {
          invitationService.handleIncomingInvitation(invitation);
          // Store invitation data for potential acceptance
          invitationService.storeInvitationData(invitation.sessionId, invitation.sessionCode);
        }
        break;

      case 'nearby_session_broadcast':
        // Handle nearby session notification
        const nearbySession = message.payload.nearbySession;
        if (invitationService) {
          invitationService.handleNearbySession(nearbySession);
          // Store session data for potential joining
          invitationService.storeInvitationData(nearbySession.sessionId, nearbySession.sessionCode);
        }
        break;

      case 'invitation_response':
        // Handle invitation response (accepted/rejected)
        const response = message.payload;
        if (invitationService) {
          if (response.accepted) {
            invitationService.notificationService.showToast({
              type: 'success',
              title: 'Invitation Accepted',
              message: `${response.inviteeUsername} accepted your invitation`,
              duration: 4000,
            });
          } else {
            invitationService.notificationService.showToast({
              type: 'info',
              title: 'Invitation Declined',
              message: `${response.inviteeUsername} declined your invitation`,
              duration: 3000,
            });
          }
        }
        break;

      case 'invitation_sent':
        // Handle invitation sent confirmation
        const sentResponse = message.payload;
        if (invitationService) {
          invitationService.notificationService.showToast({
            type: 'success',
            title: 'Invitation Sent',
            message: `Invitation sent to ${sentResponse.targetUsername || sentResponse.targetIdentifier}`,
            duration: 3000,
          });
        }
        break;

      case 'session_expired':
        alert('Session has expired. Returning to session manager.');
        // Clear all devices immediately
        setDevices(new Map());
        handleLeaveSession();
        break;
      
      case 'session_joined':
        // Update devices list from backend response
        if (message.payload && message.payload.devices) {
          const deviceMap = new Map<string, Device>();
          message.payload.devices.forEach((d: any) => {
            // Include all devices except self
            if (d.id !== deviceId) {
              deviceMap.set(d.id, {
                id: d.id,
                name: d.name,
                username: d.username || 'Unknown',
                type: d.type,
                online: d.online,
                permissions: d.permissions || {
                  files: false,
                  media: false,
                  prompts: false,
                  clipboard: false,
                  remote_browse: false,
                },
                joinedAt: d.joinedAt || Date.now(),
                lastSeen: d.lastSeen || Date.now(),
              });
            }
          });
          setDevices(deviceMap);
          console.log('Updated devices from session_joined:', Array.from(deviceMap.keys()));
        }
        // Update groups list
        if (message.payload && message.payload.groups) {
          groupService.setGroups(message.payload.groups);
        }
        if (message.payload?.studyStore) {
          setStudyFiles(message.payload.studyStore);
        }
        if (message.payload?.studyState) {
          applyStudyState(message.payload.studyState);
        }
        if (Array.isArray(message.payload?.chatHistory) && message.payload.chatHistory.length) {
          setChatMessages(message.payload.chatHistory.map((item: any) => ({
            messageId: item.messageId || `chat-${item.sentAt || Date.now()}`,
            text: item.text || '',
            username: item.username || 'Unknown',
            sourceDevice: item.sourceDevice || '',
            targetDevice: item.targetDevice || '',
            sentAt: item.sentAt || Date.now(),
            delivered: true,
            seen: false,
          })));
        }
        break;

      case 'group_created':
        groupService.addGroup(message.payload.group);
        break;

      case 'group_updated':
        groupService.updateGroup(message.payload.group);
        break;

      case 'group_deleted':
        groupService.removeGroup(message.payload.groupId);
        break;
    }
  };

  const handleIncomingIntent = async (intent: Intent, sourceDevice: string) => {
    console.log('📨 Incoming intent');
    console.log('  Intent type:', intent.intent_type);
    console.log('  Source device ID:', sourceDevice);
    console.log('  Current devices map size:', devices.size);
    console.log('  Devices in map:', Array.from(devices.entries()).map(([id, d]) => `${id.substring(0, 8)}...: ${d.name}`));

    const transferMeta = deriveTransferMeta(intent);
    if (transferMeta) {
      startTransferStatus(sourceDevice, transferMeta.fileName, 'receiving', transferMeta.totalBytes);
    }
    
    // Show permission request UI
    const granted = await requestPermission(intent, sourceDevice);
    
    if (granted) {
      // Grant permission based on intent type
      grantPermissionForIntent(intent, sourceDevice);
      
      // Process intent
      await processIntent(intent, sourceDevice);

      if (transferMeta) {
        completeTransferStatus(sourceDevice);
      }
      
      // Send acknowledgment
      if (wsRef.current) {
        wsRef.current.send(JSON.stringify({
          type: 'intent_accepted',
          sessionId: session.id,
          deviceId,
          payload: {
            intentId: intent.timestamp.toString(),
            sourceDevice,
          },
          timestamp: Date.now(),
        }));
      }
    } else {
      if (transferMeta) {
        completeTransferStatus(sourceDevice);
      }
      // Send rejection
      if (wsRef.current) {
        wsRef.current.send(JSON.stringify({
          type: 'intent_rejected',
          sessionId: session.id,
          deviceId,
          payload: {
            intentId: intent.timestamp.toString(),
            sourceDevice,
          },
          timestamp: Date.now(),
        }));
      }
    }
  };

  const grantPermissionForIntent = (intent: Intent, targetDeviceId: string) => {
    console.log('🔐 grantPermissionForIntent called');
    console.log('Intent type:', intent.intent_type);
    console.log('Target device ID:', targetDeviceId);
    console.log('Current devices:', Array.from(devices.keys()));
    
    setDevices((prev) => {
      const updated = new Map(prev);
      const device = updated.get(targetDeviceId);
      
      if (!device) {
        console.error('❌ Device not found in map:', targetDeviceId);
        console.log('Available devices:', Array.from(prev.keys()));
        return prev; // Return unchanged if device not found
      }
      
      console.log('✅ Device found:', device.name);
      const newDevice = { ...device };
      const currentPerms = { ...device.permissions };
      
      switch (intent.intent_type) {
        case 'file_handoff':
          currentPerms.files = true;
          console.log('Granting FILES permission');
          break;
        case 'batch_file_handoff':
          currentPerms.files = true;
          console.log('Granting FILES permission for batch transfer');
          break;
        case 'media_continuation':
          currentPerms.media = true;
          console.log('Granting MEDIA permission');
          break;
        case 'prompt_injection':
          currentPerms.prompts = true;
          console.log('Granting PROMPTS permission');
          break;
      case 'clipboard_sync':
        // Check if this is a remote access toggle request
        const clipboardText = intent.payload.clipboard?.text;
        if (clipboardText === 'ENABLE_REMOTE_ACCESS') {
          currentPerms.remote_browse = true;
          console.log('Granting REMOTE_BROWSE permission');
        } else if (clipboardText === 'DISABLE_REMOTE_ACCESS') {
          currentPerms.remote_browse = false;
          console.log('Revoking REMOTE_BROWSE permission');
        } else {
          currentPerms.clipboard = true;
          console.log('Granting CLIPBOARD permission');
        }
        break;
      case 'remote_access_request':
        // Remote access request doesn't grant a permission, it triggers screen sharing
        break;
        case 'link_open':
          // Links don't need special permission
          break;
      }
      
      newDevice.permissions = currentPerms;
      updated.set(targetDeviceId, newDevice);
      
      console.log('✅ Updated device permissions:', newDevice.permissions);
      console.log('✅ Device map after update:', Array.from(updated.keys()));
      
      // Notify backend of permission update
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'device_status_update',
          sessionId: session.id,
          deviceId,
          payload: {
            device: newDevice,
          },
          timestamp: Date.now(),
        }));
        console.log('✅ Sent device_status_update to backend');
      } else {
        // Fallback to App-level WebSocket
        const appWs = (window as any).appWebSocket;
        if (appWs && appWs.readyState === WebSocket.OPEN) {
          appWs.send(JSON.stringify({
            type: 'device_status_update',
            sessionId: session.id,
            deviceId,
            payload: {
              device: newDevice,
            },
            timestamp: Date.now(),
          }));
          console.log('✅ Sent device_status_update to backend via App WebSocket');
        } else {
          console.warn('⚠️ No WebSocket available, cannot send device_status_update');
        }
      }
      
      return updated;
    });
  };

  const requestPermission = (intent: Intent, sourceDevice: string): Promise<boolean> => {
    return new Promise((resolve) => {
      console.log('🔐 Requesting permission');
      console.log('  Source device ID:', sourceDevice);
      console.log('  Looking up in devices map...');
      
      const device = devices.get(sourceDevice);
      console.log('  Device found:', device ? `${device.name} (${device.type})` : 'NOT FOUND ❌');
      
      if (!device) {
        console.log('  Available devices in map:');
        devices.forEach((d, id) => {
          console.log(`    ${id.substring(0, 8)}...: ${d.name} (${d.type})`);
        });
      }
      
      const deviceName = device?.name || 'Unknown Device';
      
      const message = getPermissionMessage(intent, deviceName);
      const granted = window.confirm(message);
      resolve(granted);
    });
  };

  const getPermissionMessage = (intent: Intent, deviceName: string): string => {
    switch (intent.intent_type) {
      case 'file_handoff':
        return `${deviceName} wants to send you a file: ${intent.payload.file?.name}. Allow?`;
      case 'batch_file_handoff': {
        const files = intent.payload.files;
        if (!files) return `${deviceName} wants to send files. Allow?`;
        const totalSizeMB = (files.totalSize / 1024 / 1024).toFixed(2);
        const fileList = files.files.slice(0, 3).map(f => f.name).join(', ');
        const moreText = files.files.length > 3 ? ` and ${files.files.length - 3} more` : '';
        return `${deviceName} wants to send ${files.totalFiles} files (${totalSizeMB} MB):\n${fileList}${moreText}. Allow?`;
      }
      case 'media_continuation': {
        const rawMedia = intent.payload.media as any;
        let url = '';
        if (typeof rawMedia === 'string') {
          try {
            const mediaObj = JSON.parse(rawMedia);
            url = mediaObj.url || '';
          } catch {}
        } else {
          url = rawMedia?.url || '';
        }
        return `${deviceName} wants to continue playing media: ${url}. Allow?`;
      }
      case 'link_open': {
        const rawLink = intent.payload.link as any;
        let url = '';
        if (typeof rawLink === 'string') {
          try {
            const linkObj = JSON.parse(rawLink);
            url = linkObj.url || '';
          } catch {}
        } else {
          url = rawLink?.url || '';
        }
        return `${deviceName} wants to open a link: ${url}. Allow?`;
      }
      case 'prompt_injection':
        return `${deviceName} wants to send you a prompt: "${intent.payload.prompt?.text.substring(0, 50)}...". Allow?`;
      case 'clipboard_sync':
        return `${deviceName} wants to sync clipboard. Allow?`;
      case 'remote_access_request':
        return `${deviceName} wants to view your screen remotely. Allow screen sharing?`;
      default:
        return `${deviceName} wants to perform an action. Allow?`;
    }
  };

  const processIntent = async (intent: Intent, sourceDevice: string) => {
    switch (intent.intent_type) {
      case 'file_handoff':
        await handleFileHandoff(intent);
        break;
      case 'batch_file_handoff':
        await handleBatchFileHandoff(intent);
        break;
      case 'media_continuation':
        await handleMediaContinuation(intent);
        break;
      case 'link_open':
        await handleLinkOpen(intent);
        break;
      case 'prompt_injection':
        await handlePromptInjection(intent);
        break;
      case 'clipboard_sync':
        await handleClipboardSync(intent);
        break;
      case 'remote_access_request':
        await handleRemoteAccessRequest(intent, sourceDevice);
        break;
    }
  };

  const handleFileHandoff = async (intent: Intent) => {
    if (!intent.payload.file) return;
    
    // If file data is included, download it
    if (intent.payload.file.data) {
      // Convert array to Uint8Array
      let uint8Array: Uint8Array;
      if (intent.payload.file.data instanceof ArrayBuffer) {
        uint8Array = new Uint8Array(intent.payload.file.data);
      } else if (intent.payload.file.data instanceof Blob) {
        // For Blob, we need to read it as ArrayBuffer first
        const arrayBuffer = await intent.payload.file.data.arrayBuffer();
        uint8Array = new Uint8Array(arrayBuffer);
      } else {
        // It's a number array
        uint8Array = new Uint8Array(intent.payload.file.data);
      }
      const arrayBuffer = new ArrayBuffer(uint8Array.length);
      new Uint8Array(arrayBuffer).set(uint8Array);
      const blob = new Blob([arrayBuffer], { type: intent.payload.file.type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = intent.payload.file.name;
      a.click();
      URL.revokeObjectURL(url);
      
      // Auto-open if permission granted
      if (intent.auto_open) {
        // Try to open file based on type
        if (intent.payload.file.type.startsWith('image/')) {
          window.open(url, '_blank');
        } else if (intent.payload.file.type.startsWith('text/')) {
          // For text files, open in new tab
          const reader = new FileReader();
          reader.onload = (e) => {
            const newWindow = window.open('', '_blank');
            if (newWindow) {
              newWindow.document.write(`
                <html>
                  <head><title>${intent.payload.file?.name || 'File'}</title></head>
                  <body style="font-family:monospace;padding:20px;white-space:pre-wrap;">${e.target?.result}</body>
                </html>
              `);
            }
          };
          reader.readAsText(blob);
        }
      }
    }
  };

  const handleBatchFileHandoff = async (intent: Intent) => {
    if (!intent.payload.files) return;
    
    const { totalFiles, totalSize, files } = intent.payload.files;
    
    console.log(`📦 Batch file transfer received: ${totalFiles} files, ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    
    // Show batch download confirmation
    const confirmed = window.confirm(
      `Receive ${totalFiles} files (${(totalSize / 1024 / 1024).toFixed(2)} MB)?\n\n` +
      `Files: ${files.slice(0, 3).map(f => f.name).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more...` : ''}`
    );
    
    if (!confirmed) {
      console.log('Batch file transfer cancelled by user');
      return;
    }
    
    // Create a folder structure for batch downloads
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const folderName = `FlowLink-Batch-${timestamp}`;
    
    // Process each file in the batch
    let successCount = 0;
    let errorCount = 0;
    
    for (const file of files) {
      try {
        if (file.data) {
          // Convert array to Uint8Array
          let uint8Array: Uint8Array;
          if (file.data instanceof ArrayBuffer) {
            uint8Array = new Uint8Array(file.data);
          } else if (file.data instanceof Blob) {
            const arrayBuffer = await file.data.arrayBuffer();
            uint8Array = new Uint8Array(arrayBuffer);
          } else {
            // It's a number array
            uint8Array = new Uint8Array(file.data);
          }
          
          const arrayBuffer = new ArrayBuffer(uint8Array.length);
          new Uint8Array(arrayBuffer).set(uint8Array);
          const blob = new Blob([arrayBuffer], { type: file.type });
          const url = URL.createObjectURL(blob);
          
          // Download with folder prefix
          const a = document.createElement('a');
          a.href = url;
          a.download = `${folderName}/${file.name}`;
          a.click();
          URL.revokeObjectURL(url);
          
          successCount++;
          
          // Small delay between downloads to avoid browser blocking
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        console.error(`Failed to download file ${file.name}:`, error);
        errorCount++;
      }
    }
    
    // Show completion status
    if (errorCount === 0) {
      console.log(`✅ Batch download complete: ${successCount} files downloaded`);
      // Show a brief success message
      const statusDiv = document.createElement('div');
      statusDiv.style.cssText = `
        position: fixed; top: 20px; right: 20px; z-index: 10000;
        background: #4CAF50; color: white; padding: 12px 20px;
        border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        font-family: system-ui; font-size: 14px;
      `;
      statusDiv.textContent = `✅ ${successCount} files downloaded successfully`;
      document.body.appendChild(statusDiv);
      setTimeout(() => statusDiv.remove(), 3000);
    } else {
      alert(`Batch download completed with errors:\n✅ ${successCount} successful\n❌ ${errorCount} failed`);
    }
  };

  const handleMediaContinuation = async (intent: Intent) => {
    if (!intent.payload.media) return;
    
    const { url, timestamp, state } = intent.payload.media;
    
    // If file data is included, create blob URL
    if (intent.payload.file && intent.payload.file.data) {
      let uint8Array: Uint8Array;
      if (intent.payload.file.data instanceof ArrayBuffer) {
        uint8Array = new Uint8Array(intent.payload.file.data);
      } else if (intent.payload.file.data instanceof Blob) {
        // For Blob, we need to read it as ArrayBuffer first
        const arrayBuffer = await intent.payload.file.data.arrayBuffer();
        uint8Array = new Uint8Array(arrayBuffer);
      } else {
        // It's a number array
        uint8Array = new Uint8Array(intent.payload.file.data);
      }
      const arrayBuffer = new ArrayBuffer(uint8Array.length);
      new Uint8Array(arrayBuffer).set(uint8Array);
      const blob = new Blob([arrayBuffer], { type: intent.payload.file.type });
      const blobUrl = URL.createObjectURL(blob);
      
      // Create video/audio element to play with timestamp
      if (intent.payload.media.type === 'video') {
        const video = document.createElement('video');
        video.src = blobUrl;
        video.controls = true;
        video.currentTime = timestamp || 0;
        if (state === 'play') {
          video.play().catch(console.error);
        }
        // Open in new window
        const newWindow = window.open('', '_blank');
        if (newWindow) {
          newWindow.document.write(`
            <html>
              <head><title>${intent.payload.file.name}</title></head>
              <body style="margin:0;padding:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;">
                <video controls autoplay style="max-width:100%;max-height:100%;" src="${blobUrl}"></video>
                <script>
                  document.querySelector('video').currentTime = ${timestamp || 0};
                  ${state === 'play' ? "document.querySelector('video').play();" : ''}
                </script>
              </body>
            </html>
          `);
        }
      } else {
        // Audio
        const audio = new Audio(blobUrl);
        audio.currentTime = timestamp || 0;
        if (state === 'play') {
          audio.play().catch(console.error);
        }
        // For audio, we can play in background or show a simple player
        window.open(blobUrl, '_blank');
      }
      return;
    }
    
    // For URLs, open with timestamp
    let mediaUrl = url;
    if (timestamp && timestamp > 0) {
      // Add timestamp to URL
      const separator = url.includes('?') ? '&' : '#';
      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        mediaUrl = `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(timestamp)}`;
      } else if (url.includes('spotify.com')) {
        // Spotify doesn't support timestamp in URL, but we can try
        mediaUrl = url;
      } else {
        mediaUrl = `${url}${separator}t=${timestamp}`;
      }
    }
    
    window.open(mediaUrl, '_blank');
  };

  const handleLinkOpen = async (intent: Intent) => {
    const rawLink = intent.payload.link as any;
    if (!rawLink) {
      console.warn('handleLinkOpen: missing link payload', intent);
      return;
    }

    try {
      // Android may send link payload as a JSON string; web sends it as an object.
      const linkObj =
        typeof rawLink === 'string'
          ? JSON.parse(rawLink)
          : rawLink;

      if (!linkObj.url) {
        console.warn('handleLinkOpen: link payload missing url', rawLink);
        return;
      }

      console.log('handleLinkOpen: opening URL from intent in new tab', linkObj.url);
      // Always try to open in a new tab so the FlowLink session page
      // stays open and connected. If the browser blocks the popup,
      // we intentionally do NOT navigate this tab, so the session
      // is not lost.
      window.open(linkObj.url, '_blank');
    } catch (e) {
      console.error('handleLinkOpen: failed to parse or open link payload', e, intent.payload.link);
    }
  };

  const handlePromptInjection = async (intent: Intent) => {
    if (!intent.payload.prompt) return;
    
    const { text, target_app } = intent.payload.prompt;
    
    // Try to open in code editor (Cursor/VS Code)
    if (target_app === 'editor') {
      // Copy to clipboard first (most reliable)
      try {
        await navigator.clipboard.writeText(text);
        console.log('✅ Prompt copied to clipboard');
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
      }
      
      // Try multiple protocols to open Cursor/VS Code
      const protocols = [
        'cursor://',  // Cursor protocol
        'vscode://',  // VS Code protocol
      ];
      
      let opened = false;
      for (const protocol of protocols) {
        try {
          // Try to open with protocol handler
          const url = `${protocol}file/${encodeURIComponent(text)}`;
          window.location.href = url;
          
          // Give it a moment to see if it opens
          await new Promise(resolve => setTimeout(resolve, 500));
          opened = true;
          break;
        } catch (err) {
          console.log(`Failed to open with ${protocol}:`, err);
        }
      }
      
      // Show notification that prompt is ready
      if (opened) {
        alert(`Prompt sent to Cursor!\n\n"${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"\n\nIt's also copied to your clipboard.`);
      } else {
        alert(`Prompt copied to clipboard!\n\n"${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"\n\nPaste it into Cursor/VS Code (Cmd/Ctrl+V).`);
      }
    } else {
      // Default: open in browser search or new tab
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
      window.open(searchUrl, '_blank');
    }
  };

  const handleClipboardSync = async (intent: Intent) => {
    const rawClipboard = intent.payload.clipboard as any;
    if (!rawClipboard) {
      console.warn('handleClipboardSync: missing clipboard payload', intent);
      return;
    }

    try {
      // Android may send clipboard payload as a JSON string; web sends it as an object.
      const clipboardObj =
        typeof rawClipboard === 'string'
          ? JSON.parse(rawClipboard)
          : rawClipboard;

      const text = clipboardObj.text;
      if (typeof text !== 'string' || !text.length) {
        console.warn('handleClipboardSync: clipboard payload missing text', rawClipboard);
        return;
      }

      // Copy to clipboard with best-effort fallbacks.
      // Modern browsers may require a user gesture for the async
      // Clipboard API, so this can fail when triggered from a
      // WebSocket event. If it does, fall back to the older
      // execCommand("copy") path so we still give the user a chance
      // to get the text into their clipboard.
      try {
        await navigator.clipboard.writeText(text);
        console.log('Clipboard synced from intent via navigator.clipboard');
      } catch (err) {
        console.warn('navigator.clipboard.writeText failed, trying execCommand fallback', err);
        try {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          const succeeded = document.execCommand('copy');
          document.body.removeChild(textarea);
          console.log('Clipboard sync via execCommand result:', succeeded);
        } catch (fallbackErr) {
          console.error('Failed to sync clipboard via any method:', fallbackErr);
        }
      }
    } catch (e) {
      console.error('handleClipboardSync: failed to parse clipboard payload', e, intent.payload.clipboard);
    }
  };

  const handleRemoteAccessRequest = async (intent: Intent, viewerDeviceId: string) => {
    if (!intent.payload.request) return;
    
    const { action } = intent.payload.request;
    
    if (action === 'start_screen_share') {
      try {
        // Import RemoteDesktopManager dynamically
        const RemoteDesktopManager = (await import('../services/RemoteDesktopManager')).default;
        
        // Get viewer device ID from intent payload
        const actualViewerDeviceId = intent.payload.request.viewerDeviceId || viewerDeviceId;
        
        // Create manager as source device
        const manager = new RemoteDesktopManager(
          wsRef.current!,
          session.id,
          deviceId, // source device (this device)
          actualViewerDeviceId, // viewer device (requesting device)
          true // isSource = true (we're sharing our screen)
        );
        
        // Start screen sharing
        await manager.startScreenShare();
        console.log('Screen sharing started');
      } catch (err) {
        console.error('Failed to start screen sharing:', err);
        alert('Failed to start screen sharing: ' + (err instanceof Error ? err.message : 'Unknown error'));
      }
    }
  };

  const handleIntentSent = (intent: Intent) => {
    console.log('Intent sent:', intent);
    // Could show toast notification
  };

  const sendChatMessage = () => {
    const text = chatInput.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const targetDevice = deviceArray[0]?.id;
    if (!targetDevice) return;
    const messageId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sentAt = Date.now();
    setChatMessages((prev) => prev.concat({
      messageId,
      text,
      username,
      sourceDevice: deviceId,
      targetDevice,
      sentAt,
      delivered: false,
      seen: false,
    }));
    setChatInput('');
    setTypingByDevice((prev) => ({ ...prev, [deviceId]: false }));
    wsRef.current.send(JSON.stringify({
      type: 'chat_message',
      sessionId: session.id,
      deviceId,
      payload: {
        targetDevice,
        chat: {
          messageId,
          text,
          username,
          sentAt,
          format: 'plain',
        },
      },
      timestamp: Date.now(),
    }));
  };

  const renderChatText = (text: string) => {
    const lines = text.split('\n');
    const isCodeBlock = text.includes('```') || lines.length > 4;
    if (isCodeBlock) {
      return <pre className="chat-code">{text.replace(/```/g, '')}</pre>;
    }
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);
    return (
      <span>
        {parts.map((part, index) => (
          /^https?:\/\//.test(part)
            ? <a key={`chat-link-${index}`} href={part} target="_blank" rel="noreferrer">{part}</a>
            : <span key={`chat-text-${index}`}>{part}</span>
        ))}
      </span>
    );
  };

  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  const downloadStudyFile = (file: StudyStoreFile) => {
    const bytes = base64ToUint8Array(file.data);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy.buffer], { type: file.type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  };

  const uploadStudyFile = async (file: File) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const data = arrayBufferToBase64(await file.arrayBuffer());
    wsRef.current.send(JSON.stringify({
      type: 'study_store_upload',
      sessionId: session.id,
      deviceId,
      payload: {
        file: {
          id: `study-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          type: file.type || 'application/octet-stream',
          size: file.size,
          data,
        },
      },
      timestamp: Date.now(),
    }));
  };

  const sendStudySync = (mode: 'page' | 'scroll' | 'scroll_px' | 'zoom' | 'highlight' | 'open_pdf' | 'highlight_anchor', value: number | string | object) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'study_sync',
      sessionId: session.id,
      deviceId,
      payload: { mode, value },
      timestamp: Date.now(),
    }));
  };

  const sendStudyAnchor = (anchor: StudyHighlightAnchor) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'study_sync',
      sessionId: session.id,
      deviceId,
      payload: { mode: 'highlight_anchor', value: anchor },
      timestamp: Date.now(),
    }));
  };

  const selectedStudyFile = studyFiles.find((file) => file.id === studySelectedFileId);

  useEffect(() => {
    if (!selectedStudyFile || selectedStudyFile.type !== 'application/pdf') {
      setStudyPdfDataUrl('');
      setStudyPdfPageCount(0);
      return;
    }
    const bytes = base64ToUint8Array(selectedStudyFile.data);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy.buffer], { type: selectedStudyFile.type });
    const url = URL.createObjectURL(blob);
    setStudyPdfDataUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedStudyFile?.id]);

  useEffect(() => {
    const container = pdfScrollRef.current;
    if (!container) return;
    const onScroll = () => {
      if (suppressStudyScrollSyncRef.current) return;
      localStudyInteractionAtRef.current = Date.now();
      const scrollPx = Math.max(0, Math.round(container.scrollTop));
      setStudyScroll(scrollPx);
      sendStudySync('scroll_px', scrollPx);
      let closestPage = 1;
      let minDistance = Number.POSITIVE_INFINITY;
      pdfPageRefs.current.forEach((node, page) => {
        const distance = Math.abs(node.offsetTop - container.scrollTop);
        if (distance < minDistance) {
          minDistance = distance;
          closestPage = page;
        }
      });
      if (closestPage !== studyPage) {
        setStudyPage(closestPage);
        sendStudySync('page', closestPage);
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [studyPage]);

  useEffect(() => {
    const container = pdfScrollRef.current;
    if (!container) return;
    suppressStudyScrollSyncRef.current = true;
    container.scrollTop = Math.max(0, studyScroll);
    window.setTimeout(() => {
      suppressStudyScrollSyncRef.current = false;
    }, 140);
  }, [studyScroll]);

  useEffect(() => {
    if (!studyPdfDataUrl || activeStudyTab !== 'room') return;
    const container = pdfScrollRef.current;
    if (!container) return;
    let cancelled = false;
    // Save scroll position before re-render
    const savedScroll = container.scrollTop;
    const render = async () => {
      container.innerHTML = '';
      pdfPageRefs.current.clear();
      const loadingTask = pdfjsLib.getDocument(studyPdfDataUrl);
      const pdf = await loadingTask.promise;
      if (cancelled) return;
      setStudyPdfPageCount(pdf.numPages);
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: studyZoom });
        const wrapper = document.createElement('div');
        wrapper.className = 'study-pdf-page';
        wrapper.dataset.page = String(pageNum);
        wrapper.style.position = 'relative';
        wrapper.style.marginBottom = '12px';
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        canvas.addEventListener('mouseup', (evt) => {
          const rect = canvas.getBoundingClientRect();
          const xPercent = Math.max(0, Math.min(100, ((evt.clientX - rect.left) / rect.width) * 100));
          const yPercent = Math.max(0, Math.min(100, ((evt.clientY - rect.top) / rect.height) * 100));
          const anchor: StudyHighlightAnchor = {
            id: `anchor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            page: pageNum,
            xPercent,
            yPercent,
            widthPercent: 10,
            heightPercent: 2.4,
            text: studyHighlight || 'Highlight',
            sourceDevice: deviceId,
          };
          setStudyHighlights((prev) => prev.concat(anchor).slice(-120));
          sendStudyAnchor(anchor);
        });
        wrapper.appendChild(canvas);
        container.appendChild(wrapper);
        pdfPageRefs.current.set(pageNum, wrapper);
      }
      // Restore scroll position after re-render
      if (savedScroll > 0) {
        suppressStudyScrollSyncRef.current = true;
        container.scrollTop = savedScroll;
        window.setTimeout(() => { suppressStudyScrollSyncRef.current = false; }, 200);
      }
    };
    void render();
    return () => {
      cancelled = true;
      if (container) container.innerHTML = '';
      pdfPageRefs.current.clear();
    };
    // Only re-render when URL, tab, or zoom changes — NOT on highlight/note/anchor changes
  }, [studyPdfDataUrl, activeStudyTab, studyZoom, deviceId]);

  // Separate effect: update highlight anchors on top of existing canvases without re-rendering
  useEffect(() => {
    if (!studyPdfDataUrl || activeStudyTab !== 'room') return;
    // Remove old anchor markers and re-add without clearing canvases
    pdfPageRefs.current.forEach((wrapper, pageNum) => {
      // Remove existing anchor markers
      const existing = wrapper.querySelectorAll('.study-highlight-anchor');
      existing.forEach((el) => el.remove());
      // Add current anchors
      studyHighlights
        .filter((anchor) => anchor.page === pageNum)
        .forEach((anchor) => {
          const marker = document.createElement('div');
          marker.className = 'study-highlight-anchor';
          marker.style.left = `${anchor.xPercent ?? 50}%`;
          marker.style.top = `${anchor.yPercent}%`;
          marker.style.width = `${anchor.widthPercent ?? 10}%`;
          marker.style.height = `${anchor.heightPercent ?? 2.4}%`;
          marker.title = anchor.text;
          wrapper.appendChild(marker);
        });
    });
  }, [studyHighlights, studyPdfDataUrl, activeStudyTab]);

  const handleDragStart = (e: React.DragEvent, item: any) => {
    setDraggedItem(item);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
  };

  const handleLeaveSession = () => {
    void fileBridgeRef.current?.cancelAllActiveTransfers('session_left');
    // Don't close the App-level WebSocket, just leave the session
    const appWs = (window as any).appWebSocket;
    if (appWs && appWs.readyState === WebSocket.OPEN) {
      appWs.send(JSON.stringify({
        type: 'session_leave',
        sessionId: session.id,
        deviceId,
        timestamp: Date.now(),
      }));
    }
    
    // Cleanup
    webrtcManagerRef.current?.cleanup();
    // Clear session
    onLeaveSession();
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Stop event from bubbling to device tiles
    const deviceArray = Array.from(devices.values()).filter(d => d.id !== deviceId);
    // If dropped on empty area, show message
    if (deviceArray.length === 0) {
      alert('No devices connected. Wait for a device to join first.');
      return;
    }
    // Otherwise, let DeviceTile handle it (don't prevent default here)
  };

  const handleGroupDrop = async (groupId: string, intent: Intent) => {
    if (!intentRouterRef.current) {
      alert('Intent router not ready. Please refresh the page.');
      return;
    }

    const group = groups.find(g => g.id === groupId);
    if (!group) {
      alert('Group not found');
      return;
    }

    console.log(`Broadcasting ${intent.intent_type} to group "${group.name}"`);

    // Broadcast to group
    groupService.broadcastToGroup(groupId, intent);
    
    const intentTypeNames: Record<string, string> = {
      'file_handoff': 'File',
      'batch_file_handoff': 'Files',
      'media_continuation': 'Media',
      'link_open': 'Link',
      'prompt_injection': 'Prompt',
      'clipboard_sync': 'Text'
    };
    const typeName = intentTypeNames[intent.intent_type] || 'Item';
    console.log(`✅ ${typeName} broadcast to group "${group.name}" (${group.deviceIds.length} devices)`);
  };

  const deviceArray = Array.from(devices.values()).filter(d => d.id !== deviceId);
  const activeTypingDevice = deviceArray.find((d) => typingByDevice[d.id]);
  const connectedCount = deviceArray.length + 1;

  return (
    <div className="device-tiles-container">
      {/* Header */}
      <div className="device-tiles-header">
        <div>
          <h2>Connected Devices</h2>
          <div style={{ fontSize: '0.78rem', color: '#B8B5D4', marginTop: '2px' }}>
            Collaborate and connect seamlessly
          </div>
        </div>
        <div className="session-info">
          <div className="session-code-badge">
            <span>🔑</span>
            <span>{session.code}</span>
          </div>
          <button className="btn-chat" style={{ background: 'rgba(108,99,255,0.15)', color: '#A78BFA', border: '1px solid rgba(108,99,255,0.3)' }} onClick={() => setShowInvitationPanel(true)}>
            + Invite
          </button>
          <button className="btn-chat" onClick={() => setIsStudyOpen((prev) => !prev)}>
            📚 Study
          </button>
          <button className="btn-chat" onClick={() => setIsChatOpen((prev) => !prev)} style={{ position: 'relative' }}>
            💬 Chat
            {chatUnreadCount > 0 && !isChatOpen && (
              <span className="chat-unread-badge">{chatUnreadCount}</span>
            )}
          </button>
          <button className="btn-leave" onClick={handleLeaveSession}>
            Leave
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="session-stats">
        <div className="stat-card">
          <div className="stat-value" style={{ color: '#22C55E' }}>{Array.from(devices.values()).filter(d => d.online).length}</div>
          <div className="stat-label">Online</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: '#F59E0B' }}>{studyFiles.length}</div>
          <div className="stat-label">Files</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: '#3B82F6' }}>{chatMessages.length}</div>
          <div className="stat-label">Messages</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: '#A78BFA' }}>{groups.length}</div>
          <div className="stat-label">Groups</div>
        </div>
      </div>
      {!isCollaboratedView && (
        <>
          <div className={`chat-split-panel ${isChatOpen ? 'open' : ''}`}>
            <div className="chat-inline-header">
              <h3>Session Chat</h3>
              <button className="chat-close-btn" onClick={() => setIsChatOpen(false)}>×</button>
            </div>
            <div className="chat-panel">
              <div className="chat-messages" ref={chatBodyRef}>
                {chatMessages.map((item) => {
                  const own = item.sourceDevice === deviceId;
                  return (
                    <div key={item.messageId} className={`chat-bubble ${own ? 'own' : 'other'}`}>
                      <div className="chat-meta">
                        <span>{own ? 'You' : item.username}</span>
                        <span>{new Date(item.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className="chat-text">{renderChatText(item.text)}</div>
                      {own && (
                        <div className={`chat-tick ${item.seen ? 'seen' : item.delivered ? 'delivered' : ''}`}>
                          {item.seen ? '✓✓' : item.delivered ? '✓✓' : '✓'}
                        </div>
                      )}
                    </div>
                  );
                })}
                {activeTypingDevice && (
                  <div className="chat-typing-indicator">
                    <span>{activeTypingDevice.name} is typing</span>
                    <span className="typing-dots"><i /><i /><i /></span>
                  </div>
                )}
              </div>
              <div className="chat-input-row">
                <textarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Type message, code, or link..."
                />
                <button onClick={sendChatMessage}>Send</button>
              </div>
            </div>
          </div>
          <div className={`study-panel ${isStudyOpen ? 'open' : ''}`}>
            <div className="chat-inline-header">
              <h3>Study</h3>
              <button className="chat-close-btn" onClick={() => setIsStudyOpen(false)}>×</button>
            </div>
            <div className="study-tabs">
              <button className={activeStudyTab === 'store' ? 'active' : ''} onClick={() => setActiveStudyTab('store')}>Store</button>
              <button className={activeStudyTab === 'room' ? 'active' : ''} onClick={() => setActiveStudyTab('room')}>Study Room</button>
            </div>
            {activeStudyTab === 'store' ? (
              <div className="study-store">
                <label className="study-upload-btn">
                  Upload Docs
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.txt,.ppt,.pptx"
                    hidden
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadStudyFile(file);
                      e.currentTarget.value = '';
                    }}
                  />
                </label>
                <div className="study-store-list">
                  {studyFiles.map((file) => (
                    <div key={file.id} className="study-file-row">
                      <div>
                        <strong>{file.name}</strong>
                        <small>{Math.max(1, Math.round(file.size / 1024))} KB</small>
                      </div>
                      <div className="study-file-actions">
                        <button onClick={() => downloadStudyFile(file)}>Download</button>
                        {file.type === 'application/pdf' && (
                          <button
                            onClick={() => {
                              setActiveStudyTab('room');
                              setStudySelectedFileId(file.id);
                              setIsStudyFullscreen(true);
                              sendStudySync('open_pdf', file.id);
                            }}
                          >
                            Open
                          </button>
                        )}
                        {session.createdBy === deviceId && (
                          <button
                            className="danger"
                            onClick={() => wsRef.current?.send(JSON.stringify({
                              type: 'study_store_delete',
                              sessionId: session.id,
                              deviceId,
                              payload: { fileId: file.id },
                              timestamp: Date.now(),
                            }))}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="study-room">
                <label>Page</label>
                <input
                  type="number"
                  min={1}
                  value={studyPage}
                  onChange={(e) => {
                    const value = Math.max(1, Number(e.target.value) || 1);
                    setStudyPage(value);
                    sendStudySync('page', value);
                  }}
                />
                <label>Scroll Sync (px): {Math.round(studyScroll)}</label>
                <input
                  type="range"
                  min={0}
                  max={Math.max(100, pdfScrollRef.current?.scrollHeight || 100)}
                  value={Math.max(0, Math.min(Math.max(100, pdfScrollRef.current?.scrollHeight || 100), studyScroll))}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    localStudyInteractionAtRef.current = Date.now();
                    setStudyScroll(value);
                    sendStudySync('scroll_px', value);
                  }}
                />
                <label>Zoom: {studyZoom.toFixed(2)}x</label>
                <input
                  type="range"
                  min={0.6}
                  max={2.4}
                  step={0.05}
                  value={studyZoom}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    setStudyZoom(value);
                    sendStudySync('zoom', value);
                  }}
                />
                <label>Highlight</label>
                <textarea
                  value={studyHighlight}
                  placeholder="Shared highlight/note"
                  onChange={(e) => {
                    setStudyHighlight(e.target.value);
                    sendStudySync('highlight', e.target.value);
                  }}
                />
                <div className="study-pdf-toolbar">
                  <span>{selectedStudyFile ? selectedStudyFile.name : 'No PDF selected'}</span>
                  <span>{studyPdfPageCount > 0 ? `${studyPdfPageCount} pages` : ''}</span>
                  <button className="study-open-full" onClick={() => setIsStudyFullscreen(true)}>Open Full Page</button>
                </div>
                <div className="study-pdf-scroll" ref={pdfScrollRef} />
                <div className="study-anchor-list">
                  {studyHighlights.slice(-8).map((anchor) => (
                    <button
                      key={anchor.id}
                      onClick={() => {
                        const target = pdfPageRefs.current.get(anchor.page);
                        const container = pdfScrollRef.current;
                        if (!target || !container) return;
                        container.scrollTop = target.offsetTop + ((anchor.yPercent / 100) * target.clientHeight) - 120;
                      }}
                    >
                      P{anchor.page} - {anchor.text || 'Highlight'}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
      <div className={`study-fullscreen ${isStudyFullscreen ? 'open' : ''}`}>
        <div className="study-fullscreen-header">
          <div>
            <strong>{selectedStudyFile?.name || 'Study Room'}</strong>
            <span>Page {studyPage} · Zoom {studyZoom.toFixed(2)}x</span>
          </div>
          <button className="chat-close-btn" onClick={() => setIsStudyFullscreen(false)}>×</button>
        </div>
        <div className="study-fullscreen-body">
          <div className="study-fullscreen-left">
            <div className="study-pdf-scroll study-pdf-scroll-full" ref={pdfScrollRef} />
          </div>
          <div className="study-fullscreen-right">
            <h4>Anchors</h4>
            <div className="study-anchor-list">
              {studyHighlights.slice(-20).map((anchor) => (
                <button
                  key={anchor.id}
                  onClick={() => {
                    const target = pdfPageRefs.current.get(anchor.page);
                    const container = pdfScrollRef.current;
                    if (!target || !container) return;
                    container.scrollTop = target.offsetTop + ((anchor.yPercent / 100) * target.clientHeight) - 140;
                  }}
                >
                  P{anchor.page} - {anchor.text || 'Highlight'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className={`collab-view ${isCollaboratedView ? 'open' : ''}`}>
        <div className="chat-inline-header">
          <h3>Collaboration Workspace</h3>
          <button className="chat-close-btn" onClick={() => setIsCollaboratedView(false)}>×</button>
        </div>
        <div className="collab-controls">
          <div className="collab-pill">Session Code: {session.code}</div>
          <div className="collab-pill">{connectedCount} Active</div>
          <div className="collab-pill warm">{studyFiles.length} Shared Files</div>
          <div className="collab-pill soft">{chatMessages.length} Messages</div>
          <button className="collab-pill collab-pill-btn" onClick={() => setIsCollabQrOpen((prev) => !prev)}>
            {isCollabQrOpen ? 'Hide QR' : 'Show QR'}
          </button>
        </div>
        <div className="collab-grid collab-grid-workspace">
          <section className="collab-chat-card">
            <div className="collab-card-head">
              <h4>Room Chat</h4>
              <button className="collab-mini-btn" onClick={() => setIsChatOpen(true)}>Pop Out</button>
            </div>
            <div className="collab-chat-stream">
              {chatMessages.length === 0 ? (
                <div className="collab-empty-state">Say hi to start the chat.</div>
              ) : chatMessages.slice(-10).map((item) => {
                const own = item.sourceDevice === deviceId;
                return (
                  <div key={item.messageId} className={`collab-chat-message ${own ? 'own' : 'other'}`}>
                    <div className="collab-chat-author">{own ? 'YOU' : (item.username || 'AARIS').toUpperCase()}</div>
                    <div className="collab-chat-copy">{item.text}</div>
                  </div>
                );
              })}
            </div>
            <div className="collab-chat-compose">
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Type a message or paste a link..."
              />
              <input
                ref={collabChatFileInputRef}
                type="file"
                accept=".pdf,.doc,.docx,.txt,.ppt,.pptx"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadStudyFile(file);
                  e.currentTarget.value = '';
                }}
              />
              <button
                className="collab-attach-btn"
                title="Attach file"
                onClick={() => collabChatFileInputRef.current?.click()}
              >
                📎
              </button>
              <button onClick={sendChatMessage}>Send</button>
            </div>
          </section>

          <section className="collab-files-card">
            <div className="collab-card-head">
              <h4>Shared Files</h4>
              <label className="collab-upload-btn">
                Select Files
                <input
                  type="file"
                  accept=".pdf,.doc,.docx,.txt,.ppt,.pptx"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void uploadStudyFile(file);
                    e.currentTarget.value = '';
                  }}
                />
              </label>
            </div>
            <div className="collab-file-list">
              {studyFiles.length === 0 ? (
                <div className="collab-empty-state">No shared files yet.</div>
              ) : studyFiles.map((file) => (
                <article key={file.id} className={`collab-file-card ${studySelectedFileId === file.id ? 'active' : ''}`}>
                  <div>
                    <strong>{file.name}</strong>
                    <small>{Math.max(1, Math.round(file.size / 1024))} KB</small>
                  </div>
                  <div className="collab-file-actions">
                    <button onClick={() => downloadStudyFile(file)}>Download</button>
                    {file.type === 'application/pdf' && (
                      <button onClick={() => {
                        setActiveStudyTab('room');
                        setStudySelectedFileId(file.id);
                        setIsStudyFullscreen(true);
                        sendStudySync('open_pdf', file.id);
                      }}>Open</button>
                    )}
                    {session.createdBy === deviceId && (
                      <button className="danger" onClick={() => wsRef.current?.send(JSON.stringify({
                        type: 'study_store_delete',
                        sessionId: session.id,
                        deviceId,
                        payload: { fileId: file.id },
                        timestamp: Date.now(),
                      }))}>Delete</button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="collab-sidebar-card">
            <div className="collab-card-head">
              <h4>Devices</h4>
              <span>{connectedCount} online</span>
            </div>
            <div className="collab-device-list">
              {deviceArray.length === 0 ? (
                <div className="collab-empty-state">No connected peers yet.</div>
              ) : deviceArray.map((device) => (
                <div key={device.id} className="collab-device-row">
                  <div>
                    <strong>{device.username || device.name}</strong>
                    <small>{device.name}</small>
                  </div>
                  <span>{transferStatuses[device.id] ? `${Math.round(transferStatuses[device.id]?.progress || 0)}%` : 'Ready'}</span>
                </div>
              ))}
            </div>
            <div className="collab-study-state">
              <h5>Study Room</h5>
              <p>{selectedStudyFile?.name || 'No file open'}</p>
              <small>Page {studyPage} · Zoom {studyZoom.toFixed(2)}x · {studyHighlights.length} highlights</small>
            </div>
          </section>

          <section className="collab-self-card">
            {deviceArray.length === 0 ? (
              <div className="collab-empty-state">No connected device tile yet.</div>
            ) : (
              <div className="collab-live-device-stack">
                {deviceArray.map((device) => (
                  <DeviceTile
                    key={`collab-live-${device.id}`}
                    device={device}
                    draggedItem={draggedItem}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    transferStatus={transferStatuses[device.id]}
                    onDrop={async (intent) => {
                      if (!intentRouterRef.current) {
                        alert('Intent router not ready. Please refresh the page.');
                        return;
                      }
                      try {
                        const transferMeta = deriveTransferMeta(intent);
                        if (transferMeta && (intent.intent_type === 'file_handoff' || intent.intent_type === 'batch_file_handoff')) {
                          await sendFileWithProgress(device.id, intent);
                        } else {
                          grantPermissionForIntent(intent, device.id);
                          await intentRouterRef.current.routeIntent(intent, device.id);
                        }
                      } catch (error) {
                        if (intent.intent_type === 'file_handoff' || intent.intent_type === 'batch_file_handoff') {
                          clearTransferTimer(device.id);
                          setTransferStatuses((prev) => {
                            if (!prev[device.id]) return prev;
                            const next = { ...prev };
                            delete next[device.id];
                            return next;
                          });
                        }
                        alert('Failed to send: ' + error);
                      }
                    }}
                  />
                ))}
              </div>
            )}
          </section>

          {isCollabQrOpen && (
            <section className="collab-qr-card">
              <p>Share this QR code to connect devices:</p>
              <div className="qr-container-small">
                <QRCodeSVG value={session.code} size={118} />
              </div>
              <p className="session-code-display-small">
                Session Code: <strong>{session.code}</strong>
              </p>
            </section>
          )}

          <section className="collab-groups-card">
            <div className="collab-card-head">
              <h4>Device Groups</h4>
              <button
                className="collab-mini-btn"
                onClick={() => {
                  const peers = deviceArray.map((d) => d.id);
                  if (!peers.length) {
                    alert('No connected devices to add to a group yet.');
                    return;
                  }
                  const name = window.prompt('Group name', `Group ${groups.length + 1}`)?.trim();
                  if (!name) return;
                  groupService.createGroup(name, peers, '#6d4aff');
                }}
              >
                + Create Group
              </button>
            </div>
            <p className="collab-drop-hint">Create one group to broadcast to multiple devices.</p>
            {groups.length === 0 && (
              <div className="collab-empty-state">No groups yet. Create one to broadcast to multiple devices.</div>
            )}
            {groups.length > 0 && (
              <div className="collab-group-tiles">
                {groups.map((group) => (
                  <GroupTile
                    key={`collab-group-${group.id}`}
                    group={group}
                    devices={deviceArray}
                    onDrop={handleGroupDrop}
                  />
                ))}
              </div>
            )}
            {groups.length > 0 && (
              <div className="collab-device-list">
                {groups.map((group) => (
                  <div key={`meta-${group.id}`} className="collab-device-row">
                    <div>
                      <strong>{group.name}</strong>
                      <small>{group.deviceIds.length} devices</small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
      <div className="floating-chat-button-wrap">
        {!isCollaboratedView && (
          <button className="floating-chat-button" onClick={() => setIsChatOpen((prev) => !prev)}>
            Chat {chatUnreadCount > 0 ? `(${chatUnreadCount})` : ''}
          </button>
        )}
        <button className="floating-collab-button" onClick={() => setShowPermissionsPanel(true)}>
          🔒 Permissions
        </button>
        <button className="floating-collab-button" onClick={() => setIsCollaboratedView((prev) => !prev)}>
          Collaborated View
        </button>
      </div>

      {/* Show QR code for session creator */}
      {!isCollaboratedView && session.createdBy === deviceId && (
        <div className="qr-code-section">
          <p className="qr-label">Share this QR code to connect devices:</p>
          <div className="qr-container-small">
            <QRCodeSVG value={session.code} size={150} />
          </div>
          <p className="session-code-display-small">
            Code: <strong>{session.code}</strong>
          </p>
        </div>
      )}

      {/* Group Manager */}
      {!isCollaboratedView && deviceArray.length > 0 && (
        <GroupManager
          devices={deviceArray}
          groups={groups}
          currentDeviceId={deviceId}
          onCreateGroup={(name, deviceIds, color) => {
            groupService.createGroup(name, deviceIds, color);
          }}
          onUpdateGroup={(groupId, updates) => {
            groupService.updateGroupDetails(groupId, updates);
          }}
          onDeleteGroup={(groupId) => {
            groupService.deleteGroup(groupId);
          }}
        />
      )}

      {!isCollaboratedView && (
      <div className="drag-drop-zone">
        <p className="drag-instructions">
          Drag files, links, or text here, then drop onto a device tile
        </p>
        <div 
          className="drop-area"
          onDragOver={(e) => {
            // Only prevent default if not over a device tile
            const target = e.target as HTMLElement;
            if (!target.closest('.device-tile')) {
              e.preventDefault();
            }
          }}
          onDrop={(e) => {
            // Only handle drop if not on a device tile
            const target = e.target as HTMLElement;
            if (!target.closest('.device-tile')) {
              handleDrop(e);
            }
          }}
        >
          {deviceArray.length === 0 ? (
            <div className="no-devices">
              <p>Waiting for other devices to join...</p>
              <p className="session-code-hint">Share code: <strong>{session.code}</strong></p>
            </div>
          ) : (
            <div className="device-tiles-grid">
              {/* Group Tiles */}
              {groups.map((group) => (
                <GroupTile
                  key={group.id}
                  group={group}
                  devices={deviceArray}
                  onDrop={handleGroupDrop}
                />
              ))}
              
              {/* Device Tiles */}
              {deviceArray.map((device) => (
                <DeviceTile
                  key={device.id}
                  device={device}
                  draggedItem={draggedItem}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  transferStatus={transferStatuses[device.id]}
                  onDrop={async (intent) => {
                    console.log('=== DeviceTiles onDrop Handler ===');
                    console.log('Intent received:', intent.intent_type);
                    console.log('Target device:', device.id, device.name);
                    
                    if (!intentRouterRef.current) {
                      console.error('❌ IntentRouter not initialized');
                      alert('Intent router not ready. Please refresh the page.');
                      return;
                    }
                    
                    try {
                      const transferMeta = deriveTransferMeta(intent);

                      if (transferMeta && (intent.intent_type === 'file_handoff' || intent.intent_type === 'batch_file_handoff')) {
                        console.log('Sending file via chunked transfer to device:', device.id);
                        await sendFileWithProgress(device.id, intent);
                        console.log('✅ File transfer completed');
                      } else {
                        // Grant permission on TARGET device when sending intent
                        // This shows that we're sending this type of content to them
                        console.log('Granting permission for intent type:', intent.intent_type, 'on target device:', device.id);
                        grantPermissionForIntent(intent, device.id); // Grant permission on TARGET device

                        console.log('Routing intent to device:', device.id);
                        await intentRouterRef.current.routeIntent(intent, device.id);
                        console.log('✅ Intent routed successfully');
                      }
                      
                      // Show success feedback
                      const intentTypeNames: Record<string, string> = {
                        'file_handoff': 'File',
                        'batch_file_handoff': 'Files',
                        'media_continuation': 'Media',
                        'link_open': 'Link',
                        'prompt_injection': 'Prompt',
                        'clipboard_sync': 'Clipboard'
                      };
                      const typeName = intentTypeNames[intent.intent_type] || 'Item';
                      console.log(`✅ ${typeName} sent to ${device.name}`);
                    } catch (error) {
                      console.error('❌ Error routing intent:', error);
                      if (intent.intent_type === 'file_handoff' || intent.intent_type === 'batch_file_handoff') {
                        clearTransferTimer(device.id);
                        setTransferStatuses((prev) => {
                          if (!prev[device.id]) return prev;
                          const next = { ...prev };
                          delete next[device.id];
                          return next;
                        });
                      }
                      alert('Failed to send: ' + error);
                    }
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      )}

      {/* Invitation Panel */}
      <InvitationPanel
        sessionId={session.id}
        sessionCode={session.code}
        invitationService={invitationService}
        isOpen={showInvitationPanel}
        onClose={() => setShowInvitationPanel(false)}
      />

      {/* Permissions Panel */}
      {showPermissionsPanel && (
        <div className="invitation-panel-overlay" onClick={() => setShowPermissionsPanel(false)}>
          <div
            style={{
              background: 'rgba(255,255,255,0.97)',
              border: '1px solid rgba(148,163,184,0.35)',
              borderRadius: '20px',
              padding: '1.75rem',
              width: 'min(420px, 92vw)',
              backdropFilter: 'blur(16px)',
              boxShadow: '0 20px 50px rgba(30,41,59,0.18)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#0f172a', fontWeight: 700 }}>🔒 Browser Permissions</h3>
              <button
                onClick={() => setShowPermissionsPanel(false)}
                style={{ border: 'none', background: 'rgba(148,163,184,0.15)', borderRadius: '8px', width: '28px', height: '28px', cursor: 'pointer', fontSize: '1rem', color: '#475569' }}
              >×</button>
            </div>
            <p style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '1rem', marginTop: 0 }}>
              Grant browser permissions for FlowLink features
            </p>
            {[
              { key: 'notifications', label: '🔔 Notifications', desc: 'Receive alerts for invitations and messages', api: () => Notification.requestPermission() },
              { key: 'camera', label: '📷 Camera', desc: 'For QR code scanning', api: () => navigator.mediaDevices.getUserMedia({ video: true }) },
              { key: 'microphone', label: '🎤 Microphone', desc: 'For voice messages and calls', api: () => navigator.mediaDevices.getUserMedia({ audio: true }) },
              { key: 'storage', label: '📁 Storage', desc: 'For saving received files', api: null },
              { key: 'location', label: '📍 Location', desc: 'For SOS alerts', api: () => new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej)) },
            ].map(({ key, label, desc, api }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', padding: '0.85rem', background: 'rgba(248,250,252,0.9)', border: '1px solid rgba(148,163,184,0.22)', borderRadius: '12px', marginBottom: '0.6rem' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#0f172a' }}>{label}</div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '2px' }}>{desc}</div>
                </div>
                {key === 'storage' ? (
                  <span style={{ fontSize: '0.75rem', color: '#16a34a', fontWeight: 600 }}>✅ Auto</span>
                ) : (
                  <button
                    onClick={async () => {
                      try {
                        await api?.();
                        alert(`${label} permission granted!`);
                      } catch {
                        alert(`${label} permission denied or not available.`);
                      }
                    }}
                    style={{ background: 'linear-gradient(135deg, #6C63FF, #4A42CC)', color: '#fff', border: 'none', borderRadius: '9px', padding: '0.4rem 0.85rem', fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer' }}
                  >
                    Request
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
