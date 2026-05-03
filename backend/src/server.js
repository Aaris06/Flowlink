import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createServer } from 'http';
import { config } from 'dotenv';
config();
import pool, { initDb } from './db.js';
import { handleAuthRoutes, handleUserDataRoutes, verifyToken } from './auth.js';

// Session utilities (inline for Node.js compatibility)
function generateSessionCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function isSessionExpired(expiresAt) {
  return Date.now() > expiresAt;
}

const SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

/**
 * FlowLink Backend Server
 * 
 * Responsibilities:
 * - Session creation and management
 * - Device connection tracking
 * - WebRTC signaling (offer/answer/ICE candidates)
 * - Session expiry
 * 
 * Does NOT:
 * - Store or transfer files
 * - Access device data
 * - Maintain persistent connections
 */

const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';

// In-memory session store (for MVP)
// In production, use Redis or similar
const sessions = new Map();

// WebSocket connections by device ID - now supports multiple connections per device
const deviceConnections = new Map();

// Global device registry (tracks all devices regardless of session)
// Structure: deviceId -> { device: DeviceInfo, connections: Set<WebSocket>, lastSeen: timestamp }
const globalDevices = new Map();

// Clipboard dedupe cache to prevent repeated sends
// Structure: deviceId|username -> { fingerprint: string, timestamp: number }
const clipboardDedupeCache = new Map();
const CLIPBOARD_DEDUPE_TTL_MS = 5000; // 5 second dedupe window

// Admin config
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'flowlink_admin';
const ADMIN_SECRET   = process.env.ADMIN_SECRET   || 'flowlink_admin_2024';

// In-memory feedback store (persists until server restart)
const feedbackStore = [];
// In-memory announcement store
const announcementStore = [];

// Cleanup old clipboard dedupe entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of clipboardDedupeCache.entries()) {
    if (now - entry.timestamp > CLIPBOARD_DEDUPE_TTL_MS) {
      clipboardDedupeCache.delete(key);
    }
  }
}, 10000); // Cleanup every 10 seconds

// Create HTTP server for health checks
const server = createServer(async (req, res) => {
  // CORS headers for all routes
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Auth routes (no token required)
  if (req.url?.startsWith('/auth/')) {
    const handled = await handleAuthRoutes(req, res);
    if (handled) return;
  }

  // User data routes (token required)
  if (req.url?.startsWith('/user/')) {
    const handled = await handleUserDataRoutes(req, res);
    if (handled) return;
  }

  // ── Admin auth helper ──────────────────────────────────────────────────
  // Accept either the legacy secret header OR a valid admin JWT
  const adminSecret = req.headers['x-admin-secret'] === ADMIN_SECRET;
  const adminToken = (() => {
    const auth = req.headers['authorization'] || '';
    const t = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!t) return false;
    const p = verifyToken(t);
    return p?.role === 'admin';
  })();
  const isAdmin = adminSecret || adminToken;

  if (req.url === '/health' || req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok',
      service: 'flowlink-backend',
      sessions: sessions.size,
      connections: deviceConnections.size,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }));

  // ── DB ping - keeps Supabase active ───────────────────────────────────
  } else if (req.url === '/db-ping' && req.method === 'GET') {
    try {
      const start = Date.now();
      await pool.query('SELECT 1');
      const ms = Date.now() - start;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', db: 'connected', latencyMs: ms, timestamp: new Date().toISOString() }));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', db: 'disconnected', error: err.message }));
    }

  // ── Admin: list all users (from DB, deduplicated by username) ──────────
  } else if (req.url === '/admin/devices' && req.method === 'GET') {
    if (!isAdmin) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const now = Date.now();
    const INACTIVE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

    try {
      // Get all registered users from DB
      const dbResult = await pool.query(
        'SELECT id, username, role, created_at, last_active, is_active FROM users ORDER BY last_active DESC'
      );

      // Build a map of username -> online status from globalDevices (most recent connection)
      const onlineByUsername = new Map();
      for (const [, entry] of globalDevices.entries()) {
        const uname = (entry.device?.username || '').toLowerCase();
        if (!uname) continue;
        const existing = onlineByUsername.get(uname);
        // Keep the most recently seen / online entry
        if (!existing || entry.device.online || entry.lastSeen > (existing.lastSeen || 0)) {
          onlineByUsername.set(uname, {
            online: entry.device.online && entry.connections.size > 0,
            deviceName: entry.device.name,
            lastSeen: entry.lastSeen,
          });
        }
      }

      const devices = dbResult.rows.map(user => {
        const live = onlineByUsername.get(user.username.toLowerCase());
        const lastActive = live?.lastSeen
          ? new Date(Math.max(live.lastSeen, new Date(user.last_active).getTime())).toISOString()
          : user.last_active;
        return {
          id: String(user.id),
          username: user.username,
          name: live?.deviceName || 'Unknown',
          role: user.role,
          online: live?.online || false,
          isActive: user.is_active,
          lastSeen: lastActive,
          inactive: (now - new Date(user.last_active).getTime()) > INACTIVE_MS,
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ devices, total: devices.length }));
    } catch (err) {
      // Fallback to in-memory if DB fails
      const devices = Array.from(globalDevices.entries()).map(([id, entry]) => ({
        id, username: entry.device.username, name: entry.device.name,
        online: entry.device.online, lastSeen: new Date(entry.lastSeen).toISOString(),
        inactive: (now - entry.lastSeen) > INACTIVE_MS,
      }));
      // Deduplicate by username
      const seen = new Set();
      const deduped = devices.filter(d => {
        const key = d.username?.toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key); return true;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ devices: deduped, total: deduped.length }));
    }

  // ── Admin: deactivate user account ────────────────────────────────────
  } else if (req.url.startsWith('/admin/devices/') && req.method === 'DELETE') {
    if (!isAdmin) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const targetId = req.url.replace('/admin/devices/', '');

    // Try DB deactivation first (targetId can be DB id or username)
    try {
      const isNumeric = /^\d+$/.test(targetId);
      const query = isNumeric
        ? 'UPDATE users SET is_active = FALSE WHERE id = $1'
        : 'UPDATE users SET is_active = FALSE WHERE LOWER(username) = LOWER($1)';
      await pool.query(query, [targetId]);
    } catch (_) {}

    // Also kick from in-memory connections
    for (const [devId, entry] of globalDevices.entries()) {
      const uname = (entry.device?.username || '').toLowerCase();
      if (uname === targetId.toLowerCase() || devId === targetId) {
        entry.connections.forEach(ws => { try { ws.close(); } catch (_) {} });
        globalDevices.delete(devId);
        deviceConnections.delete(devId);
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, deactivated: targetId }));

  // ── Admin: list active sessions ───────────────────────────────────────
  } else if (req.url === '/admin/sessions' && req.method === 'GET') {
    if (!isAdmin) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const activeSessions = Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      code: session.code,
      createdBy: session.createdBy,
      deviceCount: session.devices ? session.devices.size : 0,
      devices: session.devices ? Array.from(session.devices.values()).map(d => ({
        id: d.id, username: d.username, name: d.name, online: d.online
      })) : [],
      createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
      expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
      reportCount: (session.reports || []).length,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: activeSessions, total: activeSessions.length }));

  // ── Admin: deactivate a session ────────────────────────────────────────
  } else if (req.url.startsWith('/admin/sessions/') && req.method === 'DELETE') {
    if (!isAdmin) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const targetSessionId = req.url.replace('/admin/sessions/', '');
    const session = sessions.get(targetSessionId);
    if (!session) { res.writeHead(404); res.end(JSON.stringify({ error: 'Session not found' })); return; }
    // Notify all devices in session
    broadcastToSession(targetSessionId, {
      type: 'session_terminated',
      payload: { reason: 'Session deactivated by admin' },
      timestamp: Date.now()
    }, null);
    sessions.delete(targetSessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));

  // ── Admin: send announcement to all connected devices ─────────────────
  } else if (req.url === '/admin/announce' && req.method === 'POST') {
    if (!isAdmin) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const body = await new Promise(resolve => {
      let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    const { title, message, type = 'info' } = body;
    if (!title || !message) { res.writeHead(400); res.end(JSON.stringify({ error: 'title and message required' })); return; }
    const announcement = { title, message, type, sentAt: Date.now() };
    // Store in memory
    announcementStore.push(announcement);
    announcementStore.splice(0, Math.max(0, announcementStore.length - 50));
    // Broadcast to ALL connected devices
    for (const [, ws] of deviceConnections.entries()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'admin_announcement', payload: announcement, timestamp: Date.now() }));
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, reached: deviceConnections.size }));

  // ── Admin: get announcements ───────────────────────────────────────────
  } else if (req.url === '/admin/announcements' && req.method === 'GET') {
    if (!isAdmin) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ announcements: announcementStore }));
    if (!isAdmin) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    try {
      const r = await pool.query('SELECT * FROM feedback ORDER BY sent_at DESC LIMIT 500');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ feedback: r.rows, total: r.rows.length }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ feedback: feedbackStore, total: feedbackStore.length }));
    }

  // ── Admin: delete feedback entry ──────────────────────────────────────
  } else if (req.url.startsWith('/admin/feedback/') && req.method === 'DELETE') {
    if (!isAdmin) { res.writeHead(403); res.end(JSON.stringify({ error: 'Forbidden' })); return; }
    const idx = parseInt(req.url.replace('/admin/feedback/', ''));
    if (isNaN(idx) || idx < 0 || idx >= feedbackStore.length) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return;
    }
    feedbackStore.splice(idx, 1);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));

  } else if (req.url === '/debug') {
    // Debug endpoint to see device registry state
    const debugInfo = {
      sessions: Array.from(sessions.entries()).map(([id, session]) => ({
        id,
        code: session.code,
        createdBy: session.createdBy,
        deviceCount: session.devices.size,
        devices: Array.from(session.devices.values()).map(d => ({
          id: d.id,
          username: d.username,
          name: d.name,
          online: d.online
        }))
      })),
      globalDevices: Array.from(globalDevices.entries()).map(([id, entry]) => ({
        id,
        username: entry.device.username,
        name: entry.device.name,
        online: entry.device.online,
        connections: entry.connections.size,
        sessionId: entry.sessionId,
        lastSeen: new Date(entry.lastSeen).toISOString()
      })),
      deviceConnections: deviceConnections.size
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(debugInfo, null, 2));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const wss = new WebSocketServer({ server });

function sendError(ws, errorMessage) {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(JSON.stringify({
    type: 'error',
    payload: { message: errorMessage },
    timestamp: Date.now()
  }));
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`FlowLink backend server running on port ${PORT}`);
  console.log(`Environment: ${NODE_ENV}`);
  console.log(`Server ready for WebSocket connections`);
  console.log(`Health check available at /health`);
  await initDb();
  if (NODE_ENV === 'production') {
    console.log('Production mode: Railway deployment detected');
  }
});

wss.on('connection', (ws, req) => {
  let deviceId = null;
  let sessionId = null;

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      switch (message.type) {
        case 'device_register':
          handleDeviceRegister(ws, message);
          break;
          
        case 'session_create':
          handleSessionCreate(ws, message);
          break;
          
        case 'session_join':
          handleSessionJoin(ws, message);
          break;
          
        case 'session_leave':
          handleSessionLeave(ws, message);
          break;
          
        case 'webrtc_offer':
        case 'webrtc_answer':
        case 'webrtc_ice_candidate':
          handleWebRTCSignal(ws, message);
          break;
          
        case 'device_status_update':
          handleDeviceStatusUpdate(ws, message);
          break;
          
        case 'intent_send':
          handleIntentSend(ws, message);
          break;

        case 'file_transfer_start':
        case 'file_transfer_chunk':
        case 'file_transfer_complete':
        case 'file_transfer_cancel':
        case 'file_transfer_ack':
          handleFileTransferMessage(ws, message);
          break;
          
        case 'media_handoff':
          handleMediaHandoff(ws, message);
          break;

        case 'tab_handoff':
          handleTabHandoff(ws, message);
          break;
           
        case 'device_connected_notification':
          handleDeviceConnectedNotification(ws, message);
          break;
          
        case 'clipboard_broadcast':
          handleClipboardBroadcast(ws, message);
          break;

        case 'target_connection_ping':
          handleTargetConnectionPing(ws, message);
          break;

        case 'target_connection_ack':
          handleTargetConnectionAck(ws, message);
          break;
          
        case 'group_create':
          handleGroupCreate(ws, message);
          break;
          
        case 'group_update':
          handleGroupUpdate(ws, message);
          break;
          
        case 'group_delete':
          handleGroupDelete(ws, message);
          break;

        case 'browser_sync':
          // Broadcast to all other devices in session
          if (message.sessionId) {
            broadcastToSession(message.sessionId, { ...message, timestamp: Date.now() }, message.deviceId);
          }
          break;

        case 'sos_alert': {
          // Route to specific target device OR broadcast to session
          const targetDeviceId = message.payload?.targetDeviceId;
          if (targetDeviceId) {
            const tw = deviceConnections.get(targetDeviceId);
            if (tw && tw.readyState === tw.OPEN) {
              tw.send(JSON.stringify({ ...message, timestamp: Date.now() }));
            }
          } else if (message.sessionId) {
            broadcastToSession(message.sessionId, { ...message, timestamp: Date.now() }, message.deviceId);
          }
          break;
        }

        case 'friend_request':
        case 'friend_request_response': {
          // Route directly to target device via global registry (works outside session)
          const targetUsername = message.payload?.toUsername;
          const targetDeviceId = message.payload?.toDeviceId;
          let routed = false;

          // Try direct device ID first
          if (targetDeviceId) {
            const targetWs = deviceConnections.get(targetDeviceId);
            if (targetWs && targetWs.readyState === targetWs.OPEN) {
              targetWs.send(JSON.stringify({ ...message, timestamp: Date.now() }));
              routed = true;
            }
          }

          // Try username lookup (case-insensitive) across ALL connected devices
          if (!routed && targetUsername) {
            const normalizedTarget = targetUsername.trim().toLowerCase();
            for (const [devId, entry] of globalDevices.entries()) {
              if (devId === deviceId) continue; // skip sender
              const storedUsername = (entry.device?.username || '').toLowerCase();
              if (storedUsername === normalizedTarget) {
                const targetWs = deviceConnections.get(devId);
                if (targetWs && targetWs.readyState === targetWs.OPEN) {
                  targetWs.send(JSON.stringify({ ...message, timestamp: Date.now() }));
                  console.log(`Routed ${message.type} to ${targetUsername} (${devId.substring(0,8)})`);
                  routed = true;
                  break;
                }
              }
            }
          }

          // Fallback: broadcast to session
          if (!routed && message.sessionId) {
            broadcastToSession(message.sessionId, { ...message, timestamp: Date.now() }, message.deviceId);
            console.log(`Fallback: broadcast ${message.type} to session ${message.sessionId}`);
            routed = true;
          }

          if (!routed) {
            console.warn(`Could not route ${message.type} to ${targetUsername} - device not found or offline`);
          }
          break;
        }
          
        case 'session_invitation':
          console.log('📨 Received session_invitation:', message);
          handleSessionInvitation(ws, message);
          break;
          
        case 'invitation_response':
          console.log('📨 Received invitation_response:', message);
          handleInvitationResponse(ws, message);
          break;
          
        case 'nearby_session_broadcast':
          console.log('📨 Received nearby_session_broadcast:', message);
          handleNearbySessionBroadcast(ws, message);
          break;
          
        case 'group_broadcast':
          handleGroupBroadcast(ws, message);
          break;

        case 'chat_message':
        case 'chat_delivered':
        case 'chat_seen':
        case 'chat_typing':
          handleChatMessage(ws, message);
          break;
        case 'study_store_upload':
        case 'study_store_delete':
        case 'study_store_list':
        case 'study_sync':
          handleStudyMessage(ws, message);
          break;
          
        case 'ping':
          // Keepalive ping from extension
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          }
          break;

        case 'session_report': {
          // User reports a session - flag it for admin review
          const { reason, sessionIdToReport } = message.payload || {};
          const reportedSession = sessions.get(sessionIdToReport || sessionId);
          if (reportedSession) {
            reportedSession.reports = reportedSession.reports || [];
            reportedSession.reports.push({ from: deviceId, reason: reason || 'No reason', at: Date.now() });
          }
          // Also store as feedback
          const entry = { type: 'session_report', text: `Session ${sessionIdToReport || sessionId}: ${reason || 'No reason'}`, fromUsername: message.deviceId || 'unknown', sentAt: Date.now() };
          feedbackStore.push(entry);
          pool.query('INSERT INTO feedback (from_username, type, text) VALUES ($1,$2,$3)', [entry.fromUsername, 'session_report', entry.text]).catch(() => {});
          ws.send(JSON.stringify({ type: 'report_ack', payload: { success: true }, timestamp: Date.now() }));
          break;
        }

        case 'feedback_submit': {          const { type: fbType, text, fromUsername } = message.payload || {};
          if (text && text.trim()) {
            const entry = {
              id: feedbackStore.length,
              type: fbType || 'feedback',
              text: text.trim().slice(0, 2000),
              fromUsername: fromUsername || message.deviceId || 'anonymous',
              deviceId: message.deviceId || '',
              sentAt: Date.now(),
            };
            feedbackStore.push(entry);
            feedbackStore.splice(0, Math.max(0, feedbackStore.length - 500));
            // Persist to DB
            pool.query(
              'INSERT INTO feedback (from_username, type, text) VALUES ($1,$2,$3)',
              [entry.fromUsername, entry.type, entry.text]
            ).catch(err => console.error('Feedback persist error:', err.message));
            // Route to admin if online
            for (const [, entry2] of globalDevices.entries()) {
              if ((entry2.device?.username || '').toLowerCase() === ADMIN_USERNAME.toLowerCase()) {
                const adminWs = deviceConnections.get(entry2.device.id);
                if (adminWs && adminWs.readyState === adminWs.OPEN) {
                  adminWs.send(JSON.stringify({ type: 'admin_feedback', payload: entry, timestamp: Date.now() }));
                }
              }
            }
            ws.send(JSON.stringify({ type: 'feedback_ack', payload: { success: true }, timestamp: Date.now() }));
          }
          break;
        }
          
        default:
          sendError(ws, `Unknown message type: ${message.type}`);
      }
      // Keep local connection metadata in sync with handler updates.
      deviceId = ws.deviceId || message.deviceId || deviceId;
      sessionId = ws.sessionId || message.sessionId || sessionId;
    } catch (error) {
      console.error('Error processing message:', error);
      sendError(ws, 'Invalid message format');
    }
  });

  ws.on('close', () => {
    // Use the latest metadata stored on the socket first.
    deviceId = ws.deviceId || deviceId;
    sessionId = ws.sessionId || sessionId;
    console.log(`WebSocket closed for device ${deviceId}, session ${sessionId}`);
    
    // Handle device connection cleanup in global registry
    if (deviceId) {
      const deviceEntry = globalDevices.get(deviceId);
      if (deviceEntry) {
        // Remove this specific WebSocket connection
        deviceEntry.connections.delete(ws);
        console.log(`WebSocket connection removed for device ${deviceId}. Remaining connections: ${deviceEntry.connections.size}`);
        
        // Only mark device as offline if no connections remain
        if (deviceEntry.connections.size === 0) {
          deviceEntry.device.online = false;
          deviceEntry.lastSeen = Date.now();
          console.log(`Device ${deviceId} marked as offline (no active connections)`);
          
          // Remove from deviceConnections map
          deviceConnections.delete(deviceId);
          
          // IMPORTANT: Don't remove from globalDevices - keep device registered for invitations
          // This allows devices to receive invitations even when temporarily disconnected
          console.log(`Device ${deviceId} kept in global registry for future invitations`);
          
          // Only handle session disconnect if device was in a session AND has no other connections
          if (sessionId) {
            handleDeviceDisconnect(deviceId, sessionId);
          }
        } else {
          // Device still has other connections, update primary connection
          const remainingConnections = Array.from(deviceEntry.connections);
          if (remainingConnections.length > 0) {
            deviceConnections.set(deviceId, remainingConnections[0]);
            console.log(`Updated primary connection for device ${deviceId}`);
          }
          
          // Don't call handleDeviceDisconnect if device still has active connections
          console.log(`Device ${deviceId} still has ${deviceEntry.connections.size} active connections, not disconnecting from session`);
        }
      }
    } else if (sessionId) {
      // Fallback: if deviceId wasn't set but sessionId was, handle disconnect
      handleDeviceDisconnect(deviceId, sessionId);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  // Helper to send message
  function sendMessage(type, payload) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type,
        sessionId,
        deviceId,
        payload,
        timestamp: Date.now()
      }));
    }
  }

  function sendError(ws, errorMessage) {
    sendMessage('error', { message: errorMessage });
  }
});

/**
 * Handle device registration for invitation listening
 */
function handleDeviceRegister(ws, message) {
  const { deviceId, deviceName, deviceType, username } = message.payload;
  
  if (!deviceId || !deviceName || !deviceType || !username) {
    sendError(ws, 'Missing required fields: deviceId, deviceName, deviceType, username');
    return;
  }

  // Issue 2: Kick any existing connections for the same username on a DIFFERENT deviceId
  // This enforces single-device login per username
  for (const [existingDeviceId, entry] of globalDevices.entries()) {
    if (existingDeviceId === deviceId) continue; // same device reconnecting - OK
    if ((entry.device?.username || '').toLowerCase() === username.toLowerCase()) {
      // Same username, different device - kick the old one
      entry.connections.forEach(oldWs => {
        try {
          oldWs.send(JSON.stringify({
            type: 'session_terminated',
            payload: { reason: 'Your account was logged in from another device.' },
            timestamp: Date.now()
          }));
          oldWs.close();
        } catch (_) {}
      });
      globalDevices.delete(existingDeviceId);
      deviceConnections.delete(existingDeviceId);
      console.log(`Kicked old device ${existingDeviceId} for username ${username} (new login from ${deviceId})`);
    }
  }

  // Create or update device info
  const device = {
    id: deviceId,
    name: deviceName,
    username: username,
    type: deviceType,
    online: true,
    permissions: {
      files: false,
      media: false,
      prompts: false,
      clipboard: false,
      remote_browse: false
    },
    joinedAt: Date.now(),
    lastSeen: Date.now()
  };

  // Get or create device entry in global registry
  let deviceEntry = globalDevices.get(deviceId);
  if (!deviceEntry) {
    deviceEntry = {
      device: device,
      connections: new Set(),
      lastSeen: Date.now(),
      sessionId: null
    };
    globalDevices.set(deviceId, deviceEntry);
    console.log(`New device registered: ${deviceId} (${username})`);
  } else {
    // Update device info but preserve connections
    deviceEntry.device = { ...deviceEntry.device, ...device };
    deviceEntry.lastSeen = Date.now();
    console.log(`Device updated: ${deviceId} (${username})`);
  }

  // Add this WebSocket connection to the device's connection set
  deviceEntry.connections.add(ws);
  deviceEntry.device.online = true;

  // Also maintain the old deviceConnections map for backward compatibility
  // Use the most recent connection as the "primary" connection
  deviceConnections.set(deviceId, ws);
  
  // Store device info on WebSocket for cleanup
  ws.deviceId = deviceId;
  ws.sessionId = null;

  console.log(`Device ${deviceId} (${username}) registered globally`);
  console.log(`  Total connections for this device: ${deviceEntry.connections.size}`);
  console.log(`  Global devices now: ${globalDevices.size} total`);
  
  // Log all devices for debugging
  globalDevices.forEach((entry, id) => {
    console.log(`  - ${id.substring(0, 8)}...: ${entry.device.username} (${entry.device.name}) - Connections: ${entry.connections.size}, Session: ${entry.sessionId || 'none'}`);
  });

  // Send confirmation
  ws.send(JSON.stringify({
    type: 'device_registered',
    deviceId,
    payload: {
      deviceId,
      username,
      registered: true
    },
    timestamp: Date.now()
  }));
}

/**
 * Handle session creation
 */
function handleSessionCreate(ws, message) {
  const { deviceId, deviceName, deviceType, username } = message.payload;
  
  if (!deviceId || !deviceName || !deviceType || !username) {
    sendError(ws, 'Missing required fields: deviceId, deviceName, deviceType, username');
    return;
  }

  // Generate session
  const sessionId = uuidv4();
  const code = generateSessionCode();
  const now = Date.now();
  
  const session = {
    id: sessionId,
    code,
    createdBy: deviceId,
    createdAt: now,
    expiresAt: now + SESSION_EXPIRY_MS,
    devices: new Map(),
    groups: new Map() // Initialize groups
  };

  // Add creator device
  const device = {
    id: deviceId,
    name: deviceName,
    username: username,
    type: deviceType,
    online: true,
    permissions: {
      files: false,
      media: false,
      prompts: false,
      clipboard: false,
      remote_browse: false
    },
    joinedAt: now,
    lastSeen: now
  };

  session.devices.set(deviceId, device);
  sessions.set(sessionId, session);
  deviceConnections.set(deviceId, ws);
  
  // Register device globally
  let deviceEntry = globalDevices.get(deviceId);
  if (!deviceEntry) {
    deviceEntry = {
      device: device,
      connections: new Set(),
      lastSeen: Date.now(),
      sessionId: sessionId
    };
    globalDevices.set(deviceId, deviceEntry);
  } else {
    // Update existing device entry
    deviceEntry.device = { ...deviceEntry.device, ...device };
    deviceEntry.sessionId = sessionId;
    deviceEntry.lastSeen = Date.now();
  }

  // Add this WebSocket connection to the device's connection set
  deviceEntry.connections.add(ws);

  console.log(`Device ${deviceId} (${device.username}) registered globally`);
  console.log(`Global devices now: ${globalDevices.size} total`);
  globalDevices.forEach((entry, id) => {
    console.log(`  - ${id.substring(0, 8)}...: ${entry.device.username} (${entry.device.name})`);
  });

  // Store device info on WebSocket
  ws.deviceId = deviceId;
  ws.sessionId = sessionId;

  // Send confirmation
  ws.send(JSON.stringify({
    type: 'session_created',
    sessionId,
    deviceId,
    payload: {
      sessionId,
      code,
      expiresAt: session.expiresAt
    },
    timestamp: Date.now()
  }));

  console.log(`Session created: ${sessionId} (code: ${code}) by device ${deviceId}`);
  
  // Auto-broadcast to nearby devices
  broadcastNearbySession(sessionId);
}

/**
 * Handle session join
 */
function handleSessionJoin(ws, message) {
  const { code, deviceId, deviceName, deviceType, username } = message.payload;
  
  if (!code || !deviceId || !deviceName || !deviceType || !username) {
    sendError(ws, 'Missing required fields: code, deviceId, deviceName, deviceType, username');
    return;
  }

  // Find session by code
  let session = null;
  for (const [sid, s] of sessions.entries()) {
    if (s.code === code) {
      session = s;
      break;
    }
  }

  if (!session) {
    sendError(ws, 'Invalid session code');
    return;
  }

  // Check expiry
  if (isSessionExpired(session.expiresAt)) {
    sessions.delete(session.id);
    // For clients, an expired session should behave the same as an
    // unknown/non-existent session. Always report it as an invalid
    // code so users don’t get confused by old/unused codes.
    sendError(ws, 'Invalid session code');
    return;
  }

  // If device already in session, just update connection and send current state
  if (session.devices.has(deviceId)) {
    const existingDevice = session.devices.get(deviceId);
    existingDevice.online = true;
    existingDevice.lastSeen = Date.now();
    deviceConnections.set(deviceId, ws);
    ws.deviceId = deviceId;
    ws.sessionId = session.id;
    
    // If this is the session owner reconnecting, clear the disconnect timer
    if (deviceId === session.createdBy && session.ownerDisconnectTimer) {
      console.log(`Session owner ${deviceId} reconnected to session ${session.id}, canceling expiry timer`);
      clearTimeout(session.ownerDisconnectTimer);
      delete session.ownerDisconnectTimer;
      delete session.ownerDisconnectedAt;
    }
    
    // Send current session state
    ws.send(JSON.stringify({
      type: 'session_joined',
      sessionId: session.id,
      deviceId,
      payload: {
        sessionId: session.id,
        devices: Array.from(session.devices.values()).map(d => ({
          id: d.id,
          name: d.name,
          username: d.username,
          type: d.type,
          online: d.online,
          permissions: d.permissions,
          joinedAt: d.joinedAt
        })),
        groups: Array.from(session.groups.values()),
        studyStore: session.studyStore || [],
        studyState: session.studyState || null,
        chatHistory: session.chatHistory || []
      },
      timestamp: Date.now()
    }));

    // Also notify all OTHER devices that this device is (back) online so
    // their UIs (e.g. laptop DeviceTiles) can recreate the tile.
    broadcastToSession(session.id, {
      type: 'device_connected',
      sessionId: session.id,
      payload: {
        device: {
          id: existingDevice.id,
          name: existingDevice.name,
          username: existingDevice.username,
          type: existingDevice.type,
          online: true,
          permissions: existingDevice.permissions,
          joinedAt: existingDevice.joinedAt
        }
      },
      timestamp: Date.now()
    }, deviceId);

    console.log(`Device ${deviceId} reconnected to session ${session.id}`);
    return;
  }

  // Add device to session
  const device = {
    id: deviceId,
    name: deviceName,
    username: username,
    type: deviceType,
    online: true,
    permissions: {
      files: false,
      media: false,
      prompts: false,
      clipboard: false,
      remote_browse: false
    },
    joinedAt: Date.now(),
    lastSeen: Date.now()
  };

  session.devices.set(deviceId, device);
  deviceConnections.set(deviceId, ws);
  
  // Register device globally
  let deviceEntry = globalDevices.get(deviceId);
  if (!deviceEntry) {
    deviceEntry = {
      device: device,
      connections: new Set(),
      lastSeen: Date.now(),
      sessionId: session.id
    };
    globalDevices.set(deviceId, deviceEntry);
  } else {
    // Update existing device entry
    deviceEntry.device = { ...deviceEntry.device, ...device };
    deviceEntry.sessionId = session.id;
    deviceEntry.lastSeen = Date.now();
  }

  // Add this WebSocket connection to the device's connection set
  deviceEntry.connections.add(ws);

  console.log(`Device ${deviceId} (${device.username}) registered globally`);
  console.log(`Global devices now: ${globalDevices.size} total`);
  globalDevices.forEach((entry, id) => {
    console.log(`  - ${id.substring(0, 8)}...: ${entry.device.username} (${entry.device.name})`);
  });

  // Store device info on WebSocket
  ws.deviceId = deviceId;
  ws.sessionId = session.id;

  // Send join confirmation to new device (this includes all devices in the session)
  ws.send(JSON.stringify({
    type: 'session_joined',
    sessionId: session.id,
    deviceId,
    payload: {
      sessionId: session.id,
      devices: Array.from(session.devices.values()).map(d => ({
        id: d.id,
        name: d.name,
        username: d.username,
        type: d.type,
        online: d.online,
        permissions: d.permissions,
        joinedAt: d.joinedAt
      })),
      groups: Array.from(session.groups.values()),
      studyStore: session.studyStore || [],
      studyState: session.studyState || null,
      chatHistory: session.chatHistory || []
    },
    timestamp: Date.now()
  }));

  // Only notify OTHER devices about the new device joining
  // (The new device gets the full device list in session_joined above)
  broadcastToSession(session.id, {
    type: 'device_connected',
    sessionId: session.id,
    payload: {
      device: {
        id: device.id,
        name: device.name,
        username: device.username,
        type: device.type,
        online: true,
        permissions: device.permissions,
        joinedAt: device.joinedAt
      }
    },
    timestamp: Date.now()
  }, deviceId); // Exclude the new device from this broadcast

  console.log(`Device ${deviceId} joined session ${session.id}`);
}

/**
 * Handle session leave
 */
function handleSessionLeave(ws, message) {
  const { deviceId, sessionId } = message;
  
  if (!deviceId || !sessionId) {
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) return;

  // If the session owner explicitly leaves, immediately expire the session
  if (deviceId === session.createdBy) {
    console.log(`Session owner ${deviceId} explicitly left session ${sessionId}, expiring immediately`);
    
    // Clear any pending disconnect timer
    if (session.ownerDisconnectTimer) {
      clearTimeout(session.ownerDisconnectTimer);
      delete session.ownerDisconnectTimer;
      delete session.ownerDisconnectedAt;
    }
    
    // Notify all devices that the session has ended
    broadcastToSession(sessionId, {
      type: 'session_expired',
      sessionId,
      payload: { reason: 'owner_left' },
      timestamp: Date.now()
    });

    // Close all device connections in this session
    for (const [otherDeviceId] of session.devices.entries()) {
      const ws = deviceConnections.get(otherDeviceId);
      if (ws && ws.readyState === ws.OPEN) {
        try {
          ws.close(1000, 'Session owner left');
        } catch {
          // Ignore close errors
        }
      }
      deviceConnections.delete(otherDeviceId);
      
      // Update global registry - mark as not in session but don't delete
      const deviceEntry = globalDevices.get(otherDeviceId);
      if (deviceEntry) {
        deviceEntry.sessionId = null;
        deviceEntry.lastSeen = Date.now();
      }
    }

    sessions.delete(sessionId);
    console.log(`Session ${sessionId} fully cleaned up after owner explicitly left`);
  } else {
    // Normal device leave
    handleDeviceDisconnect(deviceId, sessionId);
  }
}

/**
 * Handle device disconnect
 */
function handleDeviceDisconnect(deviceId, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const device = session.devices.get(deviceId);
  if (device) {
    device.online = false;
    device.lastSeen = Date.now();

    // If the session creator disconnects, give them a grace period to reconnect
    // instead of immediately expiring the session
    if (deviceId === session.createdBy) {
      console.log(`Session owner ${deviceId} disconnected from session ${sessionId}, starting grace period`);

      // Mark session as "owner disconnected" with a timestamp
      if (!session.ownerDisconnectedAt) {
        session.ownerDisconnectedAt = Date.now();
        
        // Set a timer to expire the session if owner doesn't reconnect within 30 seconds
        session.ownerDisconnectTimer = setTimeout(() => {
          // Check if owner is still offline after grace period
          const currentSession = sessions.get(sessionId);
          if (currentSession && currentSession.ownerDisconnectedAt) {
            const ownerDevice = currentSession.devices.get(currentSession.createdBy);
            if (ownerDevice && !ownerDevice.online) {
              console.log(`Session owner ${deviceId} did not reconnect within grace period, expiring session ${sessionId}`);
              
              // Notify all devices that the session has ended
              broadcastToSession(sessionId, {
                type: 'session_expired',
                sessionId,
                payload: { reason: 'owner_left' },
                timestamp: Date.now()
              });

              // Close all device connections in this session
              for (const [otherDeviceId] of currentSession.devices.entries()) {
                const ws = deviceConnections.get(otherDeviceId);
                if (ws && ws.readyState === ws.OPEN) {
                  try {
                    ws.close(1000, 'Session owner left');
                  } catch {
                    // Ignore close errors
                  }
                }
                deviceConnections.delete(otherDeviceId);
                
                // Update global registry - mark as not in session but don't delete
                const deviceEntry = globalDevices.get(otherDeviceId);
                if (deviceEntry) {
                  deviceEntry.sessionId = null;
                  deviceEntry.lastSeen = Date.now();
                }
              }

              sessions.delete(sessionId);
              console.log(`Session ${sessionId} fully cleaned up after owner failed to reconnect`);
            } else {
              console.log(`Session owner ${deviceId} reconnected, session ${sessionId} remains active`);
            }
          }
        }, 30000); // 30 second grace period
      }
      
      // Notify other devices that owner is temporarily offline
      broadcastToSession(sessionId, {
        type: 'device_disconnected',
        sessionId,
        payload: { 
          deviceId,
          isOwner: true,
          temporary: true
        },
        timestamp: Date.now()
      }, deviceId);
      
      return; // Don't delete from deviceConnections yet, allow reconnection
    }

    // Normal device disconnect: notify other devices
    broadcastToSession(sessionId, {
      type: 'device_disconnected',
      sessionId,
      payload: { deviceId },
      timestamp: Date.now()
    }, deviceId);

    deviceConnections.delete(deviceId);
    
    // Update global registry - mark as not in session but don't delete
    const deviceEntry = globalDevices.get(deviceId);
    if (deviceEntry) {
      deviceEntry.sessionId = null;
      deviceEntry.lastSeen = Date.now();
    }
    
    console.log(`Device ${deviceId} disconnected from session ${sessionId}`);
  }

  // Clean up empty sessions (only if no devices are online)
  const onlineDevices = Array.from(session.devices.values()).filter(d => d.online);
  if (onlineDevices.length === 0) {
    console.log(`Session ${sessionId} has no online devices, will expire if no reconnections`);
  }
}

/**
 * Handle WebRTC signaling (offer/answer/ICE candidates)
 */
function handleWebRTCSignal(ws, message) {
  const { sessionId, deviceId } = message;
  const { toDevice } = message.payload;

  if (!sessionId || !deviceId || !toDevice) {
    sendError(ws, 'Missing required fields for WebRTC signal');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(ws, 'Session not found');
    return;
  }

  const targetWs = deviceConnections.get(toDevice);
  if (!targetWs || targetWs.readyState !== targetWs.OPEN) {
    sendError(ws, 'Target device not connected');
    return;
  }

  // Forward signal to target device
  targetWs.send(JSON.stringify({
    type: message.type,
    sessionId,
    deviceId,
    payload: {
      fromDevice: deviceId,
      toDevice,
      data: message.payload.data
    },
    timestamp: Date.now()
  }));
}

/**
 * Handle device status update
 */
function handleDeviceStatusUpdate(ws, message) {
  const { sessionId, deviceId } = message;
  const { online, permissions } = message.payload;

  const session = sessions.get(sessionId);
  if (!session) return;

  const device = session.devices.get(deviceId);
  if (device) {
    if (online !== undefined) device.online = online;
    if (permissions) device.permissions = { ...device.permissions, ...permissions };
    device.lastSeen = Date.now();

    // Broadcast update to other devices
    broadcastToSession(sessionId, {
      type: 'device_status_update',
      sessionId,
      payload: {
        deviceId,
        device: {
          id: device.id,
          name: device.name,
          type: device.type,
          online: device.online,
          permissions: device.permissions,
          lastSeen: device.lastSeen
        }
      },
      timestamp: Date.now()
    }, deviceId);
  }
}

/**
 * Handle intent send (routing)
 */
function handleIntentSend(ws, message) {
  const { sessionId, deviceId } = message;
  const { targetDevice, intent } = message.payload;

  console.log(`handleIntentSend: Device ${deviceId} sending intent ${intent?.intent_type} to ${targetDevice}`);

  if (!targetDevice) {
    console.error('Missing targetDevice in intent_send');
    sendError(ws, 'Missing targetDevice');
    return;
  }

  if (!intent) {
    console.error('Missing intent in intent_send');
    sendError(ws, 'Missing intent');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    console.error(`Session ${sessionId} not found`);
    sendError(ws, 'Session not found');
    return;
  }

  const targetWs = deviceConnections.get(targetDevice);
  if (!targetWs || targetWs.readyState !== targetWs.OPEN) {
    console.error(`Target device ${targetDevice} not connected or WebSocket not open`);
    sendError(ws, 'Target device not connected');
    return;
  }

  console.log(`Forwarding intent to device ${targetDevice}`);

  // Forward intent to target device
  targetWs.send(JSON.stringify({
    type: 'intent_received',
    sessionId,
    deviceId: targetDevice,
    payload: {
      intent: intent,
      sourceDevice: deviceId
    },
    timestamp: Date.now()
  }));

  // Acknowledge to sender
  ws.send(JSON.stringify({
    type: 'intent_sent',
    sessionId,
    deviceId,
    payload: { targetDevice },
    timestamp: Date.now()
  }));
}

function handleFileTransferMessage(ws, message) {
  const { sessionId, deviceId } = message;
  let targetDevice = message.payload?.targetDevice;
  const targetUsername = message.payload?.targetUsername;

  if (!deviceId || (!targetDevice && !targetUsername)) {
    sendError(ws, 'Missing file transfer routing data');
    return;
  }

  if (!targetDevice && targetUsername) {
    const matches = getOpenConnectionsForUsername(targetUsername.trim(), deviceId);
    if (matches.length > 0) {
      targetDevice = matches[0].targetDeviceId;
    }
  }

  if (!targetDevice) {
    sendError(ws, 'Target device not connected');
    return;
  }

  const targetWs = deviceConnections.get(targetDevice);
  if (!targetWs || targetWs.readyState !== targetWs.OPEN) {
    sendError(ws, 'Target device not connected');
    return;
  }

  targetWs.send(JSON.stringify({
    ...message,
    deviceId: targetDevice,
    payload: {
      ...message.payload,
      sourceDevice: deviceId,
      targetDevice,
    },
    timestamp: Date.now(),
  }));

  if (message.type !== 'file_transfer_chunk') {
    ws.send(JSON.stringify({
      type: 'file_transfer_forwarded',
      sessionId,
      deviceId,
      payload: {
        targetDevice,
        transferId: message.payload?.transferId,
        type: message.type,
      },
      timestamp: Date.now(),
    }));
  }
}

/**
 * Handle device connected notification (notify other devices)
 */
function handleDeviceConnectedNotification(ws, message) {
  const { deviceId } = message;
  const { deviceName, deviceType, username } = message.payload;

  console.log(`handleDeviceConnectedNotification: ${deviceName} (${deviceType}) connected for user ${username}`);

  // Broadcast to all other devices with same username
  const senderDevice = globalDevices.get(deviceId);
  if (senderDevice && senderDevice.device.username) {
    const notifyUsername = senderDevice.device.username;
    console.log(`Notifying all devices with username: ${notifyUsername}`);

    for (const [targetDeviceId, deviceEntry] of globalDevices.entries()) {
      if (targetDeviceId === deviceId) continue; // Skip sender
      if (deviceEntry.device.username !== notifyUsername) continue; // Only same username

      sendToSingleDevice(targetDeviceId, {
        type: 'device_connected',
        sessionId: null,
        deviceId: targetDeviceId,
        payload: {
          deviceName,
          deviceType,
          username: notifyUsername
        },
        timestamp: Date.now()
      });
      console.log(`Device connected notification sent to device ${targetDeviceId}`);
    }
  }
}

/**
 * Handle media handoff (smart handoff from browser extension)
 */
function handleMediaHandoff(ws, message) {
  const { sessionId, deviceId } = message;
  const { action, title, url, timestamp, platform, targetUsername } = message.payload;

  console.log(`handleMediaHandoff: Device ${deviceId} - ${action} on ${platform}: ${title}`);

  // If device is in a session, broadcast to session devices
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      broadcastToSession(sessionId, {
        type: 'media_handoff_offer',
        sessionId,
        payload: {
          title,
          url,
          timestamp,
          platform,
          fromDeviceId: deviceId
        },
        timestamp: Date.now()
      }, deviceId); // Exclude sender

      console.log(`Media handoff broadcast to session ${sessionId}`);
      return;
    }
  }

  // If not in session, broadcast to target username or fall back to sender username
  const senderDevice = globalDevices.get(deviceId);
  if (senderDevice && senderDevice.device.username) {
    const username = typeof targetUsername === 'string' && targetUsername.trim()
      ? targetUsername.trim()
      : senderDevice.device.username;
    console.log(`Broadcasting media handoff to all devices with username: ${username}`);

    for (const [targetDeviceId, deviceEntry] of globalDevices.entries()) {
      if (targetDeviceId === deviceId) continue; // Skip sender
      if (deviceEntry.device.username !== username) continue; // Only same username

      sendToSingleDevice(targetDeviceId, {
        type: 'media_handoff_offer',
        sessionId: null,
        deviceId: targetDeviceId,
        payload: {
          title,
          url,
          timestamp,
          platform,
          fromDeviceId: deviceId
        },
        timestamp: Date.now()
      });
      console.log(`Media handoff sent to device ${targetDeviceId}`);
    }
  }
}

function handleTabHandoff(ws, message) {
  const { sessionId, deviceId } = message;
  const { tabs, activeIndex, collectionTitle, sentAt, sourceUsername, sourceDeviceName, targetUsername } = message.payload || {};

  if (!Array.isArray(tabs) || !tabs.length) {
    sendError(ws, 'Missing tabs for tab_handoff');
    return;
  }

  const senderDevice = globalDevices.get(deviceId);
  const username = typeof targetUsername === 'string' && targetUsername.trim()
    ? targetUsername.trim()
    : senderDevice?.device.username;

  if (!username) {
    sendError(ws, 'Missing target username for tab_handoff');
    return;
  }

  const payload = {
    tabs: tabs.map((tab) => ({
      url: typeof tab?.url === 'string' ? tab.url : '',
      title: typeof tab?.title === 'string' ? tab.title : '',
      favIconUrl: typeof tab?.favIconUrl === 'string' ? tab.favIconUrl : '',
      scrollX: Number.isFinite(tab?.scrollX) ? tab.scrollX : 0,
      scrollY: Number.isFinite(tab?.scrollY) ? tab.scrollY : 0,
      scrollProgress: Number.isFinite(tab?.scrollProgress) ? tab.scrollProgress : 0,
      viewportHeight: Number.isFinite(tab?.viewportHeight) ? tab.viewportHeight : 0,
      documentHeight: Number.isFinite(tab?.documentHeight) ? tab.documentHeight : 0,
      mediaTimestamp: Number.isFinite(tab?.mediaTimestamp) ? tab.mediaTimestamp : 0,
      mediaPaused: typeof tab?.mediaPaused === 'boolean' ? tab.mediaPaused : true,
      selectionText: typeof tab?.selectionText === 'string' ? tab.selectionText : '',
      pageTitle: typeof tab?.pageTitle === 'string' ? tab.pageTitle : '',
      capturedAt: Number.isFinite(tab?.capturedAt) ? tab.capturedAt : Date.now()
    })),
    activeIndex: Number.isInteger(activeIndex) ? activeIndex : 0,
    collectionTitle: typeof collectionTitle === 'string' ? collectionTitle : 'Tab handoff',
    sentAt: Number.isFinite(sentAt) ? sentAt : Date.now(),
    sourceUsername: typeof sourceUsername === 'string' && sourceUsername ? sourceUsername : senderDevice?.device.username || '',
    sourceDeviceName: typeof sourceDeviceName === 'string' && sourceDeviceName ? sourceDeviceName : senderDevice?.device.name || 'Browser Extension'
  };

  if (sessionId) {
    broadcastToSession(sessionId, {
      type: 'tab_handoff_offer',
      sessionId,
      payload,
      timestamp: Date.now()
    }, deviceId);
    return;
  }

  for (const [targetDeviceId, deviceEntry] of globalDevices.entries()) {
    if (targetDeviceId === deviceId) continue;
    if (deviceEntry.device.username !== username) continue;

    sendToSingleDevice(targetDeviceId, {
      type: 'tab_handoff_offer',
      sessionId: null,
      deviceId: targetDeviceId,
      payload,
      timestamp: Date.now()
    });
  }
}

/**
 * Handle clipboard broadcast (universal clipboard sync)
 */
function handleClipboardBroadcast(ws, message) {
  const { sessionId, deviceId } = message;
  const { clipboard, targetUsername } = message.payload;

  console.log(`handleClipboardBroadcast: Device ${deviceId} broadcasting clipboard`);

  // Create fingerprint for dedupe
  const clipboardFingerprint = JSON.stringify([
    clipboard?.text || '',
    clipboard?.url || '',
    clipboard?.html || '',
    clipboard?.image ? clipboard.image.slice(0, 96) : ''
  ]);
  
  // Get sender device for username
  const senderDevice = globalDevices.get(deviceId);
  const username = targetUsername && typeof targetUsername === 'string' 
    ? targetUsername.trim()
    : senderDevice?.device.username;
  
  const dedupeKey = `${deviceId}|${username}`;
  const cacheEntry = clipboardDedupeCache.get(dedupeKey);
  
  // Skip if same fingerprint was sent recently
  if (cacheEntry && cacheEntry.fingerprint === clipboardFingerprint && Date.now() - cacheEntry.timestamp < CLIPBOARD_DEDUPE_TTL_MS) {
    console.log(`[DEDUPE] Skipping duplicate clipboard from ${deviceId} - sent within 5s`);
    return;
  }
  
  // Update dedupe cache
  clipboardDedupeCache.set(dedupeKey, { fingerprint: clipboardFingerprint, timestamp: Date.now() });

  // If device is in a session, broadcast to session devices
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      broadcastToSession(sessionId, {
        type: 'clipboard_sync',
        sessionId,
        payload: {
          clipboard: clipboard
        },
        timestamp: Date.now()
      }, deviceId); // Exclude sender

      console.log(`Clipboard broadcast to session ${sessionId}`);
      return;
    }
  }

  // If not in session, broadcast to target username or fall back to sender username
  if (senderDevice && username) {
    console.log(`Broadcasting clipboard to all devices with username: ${username}`);

    for (const [targetDeviceId, deviceEntry] of globalDevices.entries()) {
      if (targetDeviceId === deviceId) continue; // Skip sender
      if (deviceEntry.device.username !== username) continue; // Only same username

      sendToSingleDevice(targetDeviceId, {
        type: 'clipboard_sync',
        sessionId: null,
        deviceId: targetDeviceId,
        payload: {
          clipboard: clipboard
        },
        timestamp: Date.now()
      });
      console.log(`Clipboard sync sent to device ${targetDeviceId}`);
    }
  }
}

function sendToSingleDevice(targetDeviceId, message) {
  const primaryConnection = deviceConnections.get(targetDeviceId);
  if (primaryConnection && primaryConnection.readyState === primaryConnection.OPEN) {
    primaryConnection.send(JSON.stringify(message));
    return true;
  }

  const deviceEntry = globalDevices.get(targetDeviceId);
  if (!deviceEntry) {
    return false;
  }

  for (const targetWs of deviceEntry.connections) {
    if (targetWs.readyState === targetWs.OPEN) {
      targetWs.send(JSON.stringify(message));
      return true;
    }
  }

  return false;
}

function getOpenConnectionsForUsername(targetUsername, excludeDeviceId = null) {
  const matches = [];

  for (const [targetDeviceId, deviceEntry] of globalDevices.entries()) {
    if (targetDeviceId === excludeDeviceId) continue;
    if (deviceEntry.device.username !== targetUsername) continue;

    for (const targetWs of deviceEntry.connections) {
      if (targetWs.readyState === targetWs.OPEN) {
        matches.push({ targetDeviceId, deviceEntry, targetWs });
      }
    }
  }

  return matches;
}

function handleTargetConnectionPing(ws, message) {
  const { deviceId } = message;
  const { targetUsername, sourceUsername, sourceDeviceName } = message.payload || {};

  if (!targetUsername) {
    sendError(ws, 'Missing targetUsername');
    return;
  }

  const matches = getOpenConnectionsForUsername(targetUsername.trim(), deviceId);

  if (matches.length === 0) {
    ws.send(JSON.stringify({
      type: 'target_connection_result',
      deviceId,
      payload: {
        connected: false,
        targetUsername: targetUsername.trim()
      },
      timestamp: Date.now()
    }));
    return;
  }

  for (const { targetDeviceId, targetWs, deviceEntry } of matches) {
    sendToSingleDevice(targetDeviceId, {
      type: 'target_connection_request',
      deviceId: targetDeviceId,
      payload: {
        sourceDeviceId: deviceId,
        sourceUsername: sourceUsername || globalDevices.get(deviceId)?.device.username || 'Unknown',
        sourceDeviceName: sourceDeviceName || globalDevices.get(deviceId)?.device.name || 'Unknown Device',
        targetUsername: deviceEntry.device.username,
        targetDeviceName: deviceEntry.device.name
      },
      timestamp: Date.now()
    });
  }

  ws.send(JSON.stringify({
    type: 'target_connection_result',
    deviceId,
    payload: {
      connected: true,
      targetUsername: targetUsername.trim(),
      targetDeviceName: matches[0].deviceEntry.device.name,
      targetDeviceId: matches[0].targetDeviceId
    },
    timestamp: Date.now()
  }));
}

function handleTargetConnectionAck(ws, message) {
  const { deviceId } = message;
  const { sourceDeviceId, sourceUsername, targetUsername, targetDeviceName } = message.payload || {};

  if (!sourceDeviceId) {
    return;
  }

  const sourceWs = deviceConnections.get(sourceDeviceId);
  if (!sourceWs || sourceWs.readyState !== sourceWs.OPEN) {
    return;
  }

  sourceWs.send(JSON.stringify({
    type: 'target_connection_result',
    deviceId: sourceDeviceId,
    payload: {
      connected: true,
      targetUsername: targetUsername || globalDevices.get(deviceId)?.device.username || '',
      targetDeviceName: targetDeviceName || globalDevices.get(deviceId)?.device.name || 'Unknown Device',
      sourceUsername: sourceUsername || ''
    },
    timestamp: Date.now()
  }));
}

function handleChatMessage(ws, message) {
  const { sessionId, deviceId, type } = message;
  const targetDevice = message.payload?.targetDevice;

  if (!sessionId || !deviceId) {
    sendError(ws, 'Missing chat routing data');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(ws, 'Invalid chat session');
    return;
  }

  if (type === 'chat_message') {
    session.chatHistory = Array.isArray(session.chatHistory) ? session.chatHistory : [];
    const chatEntry = { ...message.payload?.chat, sourceDevice: deviceId, targetDevice: null };
    session.chatHistory.push(chatEntry);
    session.chatHistory = session.chatHistory.slice(-200);

    // Persist to DB
    if (chatEntry.messageId && sessionId) {
      pool.query(
        'INSERT INTO chat_messages (session_id, message_id, text, username, source_device, sent_at, attachment) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (message_id) DO NOTHING',
        [sessionId, chatEntry.messageId, chatEntry.text || '', chatEntry.username || '', deviceId, new Date(chatEntry.sentAt || Date.now()), chatEntry.attachment ? JSON.stringify(chatEntry.attachment) : null]
      ).catch(err => console.error('Chat persist error:', err.message));
    }

    broadcastToSession(sessionId, {
      ...message,
      sessionId,
      payload: {
        ...message.payload,
        sourceDevice: deviceId,
      },
      timestamp: Date.now()
    }, deviceId);

    ws.send(JSON.stringify({
      type: 'chat_delivered',
      sessionId,
      deviceId,
      payload: {
        messageId: message.payload?.chat?.messageId,
        sourceDevice: targetDevice,
        targetDevice: deviceId
      },
      timestamp: Date.now()
    }));
    return;
  }

  if (!targetDevice) {
    sendError(ws, 'Missing targetDevice for chat receipt');
    return;
  }

  const targetWs = deviceConnections.get(targetDevice);
  if (!targetWs || targetWs.readyState !== targetWs.OPEN) {
    sendError(ws, 'Target device not connected');
    return;
  }

  targetWs.send(JSON.stringify({
    ...message,
    sessionId,
    deviceId: targetDevice,
    payload: {
      ...message.payload,
      sourceDevice: deviceId,
      targetDevice
    },
    timestamp: Date.now()
  }));
}

function handleStudyMessage(ws, message) {
  const { sessionId, deviceId, type } = message;
  const session = sessions.get(sessionId);
  if (!session || !deviceId) {
    sendError(ws, 'Invalid study session');
    return;
  }

  if (!session.studyStore) {
    session.studyStore = [];
  }

  if (!session.studyState) {
    session.studyState = {
      page: 1,
      scrollPx: 0,
      zoom: 1,
      highlight: '',
      selectedFileId: '',
      anchors: [],
      updatedAt: Date.now(),
      updatedBy: ''
    };
  }

  if (type === 'study_store_list') {
    ws.send(JSON.stringify({
      type: 'study_store_list',
      sessionId,
      deviceId,
      payload: { files: session.studyStore, state: session.studyState },
      timestamp: Date.now()
    }));
    return;
  }

  if (type === 'study_store_upload') {
    const file = message.payload?.file;
    if (!file?.id || !file?.name || !file?.data) {
      sendError(ws, 'Invalid store file payload');
      return;
    }
    const next = session.studyStore.filter((item) => item.id !== file.id);
    next.push({
      ...file,
      uploadedBy: deviceId,
      uploadedAt: Date.now()
    });
    session.studyStore = next;
    broadcastToSession(sessionId, {
      type: 'study_store_list',
      sessionId,
      payload: { files: session.studyStore, state: session.studyState },
      timestamp: Date.now()
    });
    return;
  }

  if (type === 'study_store_delete') {
    const fileId = message.payload?.fileId;
    if (!fileId) {
      sendError(ws, 'Missing fileId');
      return;
    }
    // Only host can delete for everyone.
    if (deviceId !== session.createdBy) {
      sendError(ws, 'Only host can delete store files');
      return;
    }
    session.studyStore = session.studyStore.filter((item) => item.id !== fileId);
    if (session.studyState.selectedFileId === fileId) {
      session.studyState = {
        ...session.studyState,
        selectedFileId: '',
        page: 1,
        scrollPx: 0,
        anchors: []
      };
    }
    broadcastToSession(sessionId, {
      type: 'study_store_list',
      sessionId,
      payload: { files: session.studyStore, state: session.studyState },
      timestamp: Date.now()
    });
    return;
  }

  if (type === 'study_sync') {
    const mode = message.payload?.mode;
    const value = message.payload?.value;
    if (mode === 'page' && Number.isFinite(value)) {
      session.studyState.page = Math.max(1, Number(value));
    } else if (mode === 'scroll_px' && Number.isFinite(value)) {
      session.studyState.scrollPx = Math.max(0, Number(value));
    } else if (mode === 'zoom' && Number.isFinite(value)) {
      session.studyState.zoom = Math.max(0.6, Math.min(3, Number(value)));
    } else if (mode === 'highlight' && typeof value === 'string') {
      session.studyState.highlight = value;
    } else if (mode === 'open_pdf' && typeof value === 'string') {
      session.studyState.selectedFileId = value;
      session.studyState.page = 1;
      session.studyState.scrollPx = 0;
    } else if (mode === 'highlight_anchor' && value?.id) {
      const anchors = Array.isArray(session.studyState.anchors) ? session.studyState.anchors.filter((item) => item.id !== value.id) : [];
      anchors.push(value);
      session.studyState.anchors = anchors.slice(-120);
    }
    session.studyState.updatedAt = Date.now();
    session.studyState.updatedBy = deviceId;

    broadcastToSession(sessionId, {
      type: 'study_sync',
      sessionId,
      payload: {
        ...message.payload,
        state: session.studyState,
        sourceDevice: deviceId
      },
      timestamp: Date.now()
    }, deviceId);
  }
}

/**
 * Broadcast message to all devices in session (except sender)
 */
function broadcastToSession(sessionId, message, excludeDeviceId = null) {
  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`broadcastToSession: Session ${sessionId} not found`);
    return;
  }

  console.log(`broadcastToSession: Broadcasting to ${session.devices.size} devices, excluding: ${excludeDeviceId}`);
  for (const [deviceId, device] of session.devices.entries()) {
    if (deviceId === excludeDeviceId || !device.online) {
      console.log(`broadcastToSession: Skipping device ${deviceId} (excluded: ${deviceId === excludeDeviceId}, online: ${device.online})`);
      continue;
    }
    
    const ws = deviceConnections.get(deviceId);
    if (ws && ws.readyState === ws.OPEN) {
      console.log(`broadcastToSession: Sending to device ${deviceId}`);
      ws.send(JSON.stringify(message));
    } else {
      console.log(`broadcastToSession: Device ${deviceId} has no WebSocket or connection not open (state: ${ws?.readyState})`);
    }
  }
}

/**
 * Cleanup expired sessions periodically
 */
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (isSessionExpired(session.expiresAt)) {
      console.log(`Session ${sessionId} expired, cleaning up`);
      
      // Notify all devices
      broadcastToSession(sessionId, {
        type: 'session_expired',
        sessionId,
        payload: {},
        timestamp: now
      });
      
      // Remove all device connections
      for (const deviceId of session.devices.keys()) {
        deviceConnections.delete(deviceId);
      }
      
      sessions.delete(sessionId);
    }
  }
}, 60000); // Check every minute

/**
 * Handle group creation
 */
function handleGroupCreate(ws, message) {
  const { sessionId, deviceId } = message;
  const { name, deviceIds, color } = message.payload;

  console.log(`handleGroupCreate: Device ${deviceId} creating group "${name}" with devices:`, deviceIds);

  if (!name || !deviceIds || !Array.isArray(deviceIds)) {
    sendError(ws, 'Missing required fields: name, deviceIds');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(ws, 'Session not found');
    return;
  }

  // Validate all device IDs exist in session
  for (const devId of deviceIds) {
    if (!session.devices.has(devId)) {
      sendError(ws, `Device ${devId} not found in session`);
      return;
    }
  }

  // Create group
  const groupId = uuidv4();
  const group = {
    id: groupId,
    name,
    deviceIds,
    createdBy: deviceId,
    createdAt: Date.now(),
    color: color || generateRandomColor()
  };

  session.groups.set(groupId, group);

  // Broadcast to all devices in session
  broadcastToSession(sessionId, {
    type: 'group_created',
    sessionId,
    payload: { group },
    timestamp: Date.now()
  });

  console.log(`Group ${groupId} created: "${name}" with ${deviceIds.length} devices`);
}

/**
 * Handle group update
 */
function handleGroupUpdate(ws, message) {
  const { sessionId, deviceId } = message;
  const { groupId, name, deviceIds, color } = message.payload;

  console.log(`handleGroupUpdate: Device ${deviceId} updating group ${groupId}`);

  if (!groupId) {
    sendError(ws, 'Missing required field: groupId');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(ws, 'Session not found');
    return;
  }

  const group = session.groups.get(groupId);
  if (!group) {
    sendError(ws, 'Group not found');
    return;
  }

  // Update group properties
  if (name) group.name = name;
  if (color) group.color = color;
  if (deviceIds && Array.isArray(deviceIds)) {
    // Validate all device IDs
    for (const devId of deviceIds) {
      if (!session.devices.has(devId)) {
        sendError(ws, `Device ${devId} not found in session`);
        return;
      }
    }
    group.deviceIds = deviceIds;
  }

  // Broadcast update to all devices
  broadcastToSession(sessionId, {
    type: 'group_updated',
    sessionId,
    payload: { group },
    timestamp: Date.now()
  });

  console.log(`Group ${groupId} updated`);
}

/**
 * Handle group deletion
 */
function handleGroupDelete(ws, message) {
  const { sessionId, deviceId } = message;
  const { groupId } = message.payload;

  console.log(`handleGroupDelete: Device ${deviceId} deleting group ${groupId}`);

  if (!groupId) {
    sendError(ws, 'Missing required field: groupId');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(ws, 'Session not found');
    return;
  }

  if (!session.groups.has(groupId)) {
    sendError(ws, 'Group not found');
    return;
  }

  session.groups.delete(groupId);

  // Broadcast deletion to all devices
  broadcastToSession(sessionId, {
    type: 'group_deleted',
    sessionId,
    payload: { groupId },
    timestamp: Date.now()
  });

  console.log(`Group ${groupId} deleted`);
}

/**
 * Handle group broadcast (send intent to all devices in group)
 */
function handleGroupBroadcast(ws, message) {
  const { sessionId, deviceId } = message;
  const { groupId, intent } = message.payload;

  console.log(`handleGroupBroadcast: Device ${deviceId} broadcasting to group ${groupId}`);

  if (!groupId || !intent) {
    sendError(ws, 'Missing required fields: groupId, intent');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(ws, 'Session not found');
    return;
  }

  const group = session.groups.get(groupId);
  if (!group) {
    sendError(ws, 'Group not found');
    return;
  }

  // Send intent to all devices in group
  let successCount = 0;
  for (const targetDeviceId of group.deviceIds) {
    const targetWs = deviceConnections.get(targetDeviceId);
    if (targetWs && targetWs.readyState === targetWs.OPEN) {
      targetWs.send(JSON.stringify({
        type: 'intent_received',
        sessionId,
        deviceId: targetDeviceId,
        payload: {
          intent: {
            ...intent,
            target_device: targetDeviceId,
            source_device: deviceId
          },
          sourceDevice: deviceId,
          fromGroup: groupId
        },
        timestamp: Date.now()
      }));
      successCount++;
    }
  }

  // Acknowledge to sender
  ws.send(JSON.stringify({
    type: 'group_broadcast_sent',
    sessionId,
    deviceId,
    payload: { 
      groupId,
      devicesReached: successCount,
      totalDevices: group.deviceIds.length
    },
    timestamp: Date.now()
  }));

  console.log(`Group broadcast sent to ${successCount}/${group.deviceIds.length} devices in group ${groupId}`);
}

/**
 * Generate random color for group
 */
function generateRandomColor() {
  const colors = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', 
    '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
    '#F8B739', '#52B788', '#E76F51', '#2A9D8F'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

/**
 * Handle session invitation
 */
function handleSessionInvitation(ws, message) {
  const { sessionId, deviceId } = message;
  const { targetIdentifier, invitation } = message.payload;

  console.log(`handleSessionInvitation: Device ${deviceId} inviting ${targetIdentifier} to session ${sessionId}`);

  if (!targetIdentifier || !invitation) {
    sendError(ws, 'Missing required fields: targetIdentifier, invitation');
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(ws, 'Session not found');
    return;
  }

  console.log(`Looking for target: ${targetIdentifier}`);
  console.log(`Global devices available:`, Array.from(globalDevices.entries()).map(([id, entry]) => `${id}:${entry.device.username}`));

  // Search in global device registry first (most efficient)
  let targetDevice = null;
  let targetWs = null;

  // Try to find by username in global registry
  for (const [devId, deviceEntry] of globalDevices) {
    if ((deviceEntry.device.username === targetIdentifier || devId === targetIdentifier) && devId !== deviceId) {
      // Make sure device is online and has working connections
      if (deviceEntry.device.online && deviceEntry.connections.size > 0) {
        // Find a working WebSocket connection
        for (const ws of deviceEntry.connections) {
          if (ws && ws.readyState === ws.OPEN) {
            targetDevice = deviceEntry.device;
            targetWs = ws;
            console.log(`✅ Found target device in global registry: ${deviceEntry.device.username} (${devId})`);
            break;
          }
        }
        if (targetDevice) break;
      }
    }
  }

  // If not found in global registry, search all sessions (fallback)
  if (!targetDevice) {
    console.log(`Target not found in global registry. Searching all sessions...`);
    
    for (const [sid, sess] of sessions) {
      for (const [devId, device] of sess.devices) {
        if ((device.username === targetIdentifier || devId === targetIdentifier) && devId !== deviceId) {
          const ws = deviceConnections.get(devId);
          if (ws && ws.readyState === ws.OPEN) {
            targetDevice = device;
            targetWs = ws;
            console.log(`✅ Found target device in session ${sid}: ${device.username} (${devId})`);
            break;
          }
        }
      }
      if (targetDevice) break;
    }
  }

  if (!targetDevice || !targetWs) {
    console.log(`❌ User "${targetIdentifier}" not found or not online`);
    sendError(ws, `User "${targetIdentifier}" not found or not online`);
    return;
  }

  // Send invitation to target device
  console.log(`📨 Sending invitation to ${targetDevice.username} (${targetDevice.id})`);
  targetWs.send(JSON.stringify({
    type: 'session_invitation',
    sessionId: invitation.sessionId,
    deviceId: targetDevice.id,
    payload: { invitation },
    timestamp: Date.now()
  }));

  // Send confirmation to sender
  ws.send(JSON.stringify({
    type: 'invitation_sent',
    sessionId,
    deviceId,
    payload: { 
      targetIdentifier,
      targetUsername: targetDevice.username,
      targetDeviceName: targetDevice.name
    },
    timestamp: Date.now()
  }));

  console.log(`✅ Session invitation sent to ${targetIdentifier}`);
}

/**
 * Handle invitation response
 */
function handleInvitationResponse(ws, message) {
  const { sessionId, deviceId } = message;
  const { accepted, inviteeUsername, inviteeDeviceName } = message.payload;

  console.log(`handleInvitationResponse: Device ${deviceId} ${accepted ? 'accepted' : 'rejected'} invitation to session ${sessionId}`);

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(ws, 'Session not found');
    return;
  }

  // Find the session creator to notify them
  const creatorDevice = session.devices.get(session.createdBy);
  const creatorWs = deviceConnections.get(session.createdBy);

  if (creatorWs && creatorWs.readyState === creatorWs.OPEN) {
    creatorWs.send(JSON.stringify({
      type: 'invitation_response',
      sessionId,
      deviceId: session.createdBy,
      payload: {
        accepted,
        inviteeUsername,
        inviteeDeviceName,
        inviteeDeviceId: deviceId
      },
      timestamp: Date.now()
    }));
  }

  if (accepted) {
    // If accepted, the invitee will join via normal session_join flow
    console.log(`${inviteeUsername} accepted invitation to session ${sessionId}`);
  } else {
    console.log(`${inviteeUsername} rejected invitation to session ${sessionId}`);
  }
}

/**
 * Handle nearby session broadcast
 */
function handleNearbySessionBroadcast(ws, message) {
  const { sessionId, deviceId } = message;
  const { range } = message.payload || {};

  console.log(`handleNearbySessionBroadcast: Device ${deviceId} broadcasting session ${sessionId} to nearby devices`);

  const session = sessions.get(sessionId);
  if (!session) {
    sendError(ws, 'Session not found');
    return;
  }

  const creatorDevice = session.devices.get(session.createdBy);
  if (!creatorDevice) {
    sendError(ws, 'Session creator not found');
    return;
  }

  // Broadcast to all connected devices (simulating nearby discovery)
  // In a real implementation, this would use location/network-based discovery
  let notificationsSent = 0;
  
  // Use globalDevices for better coverage
  for (const [devId, deviceEntry] of globalDevices) {
    // Only send to online devices that are not the broadcaster and not in this session
    if (devId !== deviceId && deviceEntry.device.online && !session.devices.has(devId)) {
      // Try to send to any available connection for this device
      let messageSent = false;
      
      for (const ws of deviceEntry.connections) {
        if (ws && ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify({
              type: 'nearby_session_broadcast',
              sessionId: null, // Don't expose the actual session ID
              deviceId: devId,
              payload: {
                nearbySession: {
                  sessionId: sessionId,
                  sessionCode: session.code,
                  creatorUsername: creatorDevice.username,
                  creatorDeviceName: creatorDevice.name,
                  deviceCount: session.devices.size
                }
              },
              timestamp: Date.now()
            }));
            notificationsSent++;
            messageSent = true;
            console.log(`Manual broadcast sent to ${deviceEntry.device.username} (${devId})`);
            break; // Only send once per device
          } catch (error) {
            console.warn(`Failed to send to connection for device ${devId}:`, error.message);
            // Try next connection
          }
        }
      }
      
      if (!messageSent) {
        console.warn(`No working connections found for device ${devId} (${deviceEntry.device.username})`);
        // Mark device as offline since no connections work
        deviceEntry.device.online = false;
      }
    }
  }

  // Acknowledge to sender
  ws.send(JSON.stringify({
    type: 'nearby_broadcast_sent',
    sessionId,
    deviceId,
    payload: { notificationsSent },
    timestamp: Date.now()
  }));

  console.log(`Nearby session broadcast sent to ${notificationsSent} devices`);
}

/**
 * Find session by device ID
 */
function findSessionByDeviceId(deviceId) {
  for (const [sessionId, session] of sessions) {
    if (session.devices.has(deviceId)) {
      return session;
    }
  }
  return null;
}

/**
 * Auto-broadcast nearby sessions when a session is created
 */
function broadcastNearbySession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const creatorDevice = session.devices.get(session.createdBy);
  if (!creatorDevice) return;

  // Auto-broadcast to nearby devices after a short delay
  setTimeout(() => {
    let notificationsSent = 0;
    
    // Use globalDevices for better coverage
    for (const [devId, deviceEntry] of globalDevices) {
      // Only send to online devices that are not the creator and not in this session
      if (devId !== session.createdBy && deviceEntry.device.online && !session.devices.has(devId)) {
        // Try to send to any available connection for this device
        let messageSent = false;
        
        for (const ws of deviceEntry.connections) {
          if (ws && ws.readyState === ws.OPEN) {
            try {
              ws.send(JSON.stringify({
                type: 'nearby_session_broadcast',
                sessionId: null,
                deviceId: devId,
                payload: {
                  nearbySession: {
                    sessionId: sessionId,
                    sessionCode: session.code,
                    creatorUsername: creatorDevice.username,
                    creatorDeviceName: creatorDevice.name,
                    deviceCount: session.devices.size
                  }
                },
                timestamp: Date.now()
              }));
              notificationsSent++;
              messageSent = true;
              console.log(`Sent nearby session notification to ${deviceEntry.device.username} (${devId})`);
              break; // Only send once per device, using first available connection
            } catch (error) {
              console.warn(`Failed to send to connection for device ${devId}:`, error.message);
              // Try next connection
            }
          }
        }
        
        if (!messageSent) {
          console.warn(`No working connections found for device ${devId} (${deviceEntry.device.username})`);
          // Mark device as offline since no connections work
          deviceEntry.device.online = false;
        }
      }
    }
    console.log(`Auto-broadcast nearby session ${sessionId} to ${notificationsSent} devices`);
  }, 1000); // 1 second delay for faster notifications
}
