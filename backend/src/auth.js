import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'flowlink_jwt_secret_2024';
const JWT_EXPIRY = '30d';

// Track active sessions: username -> { deviceType, loginAt, token }
// Allows website + extension to be logged in simultaneously
// but blocks two websites or two mobile apps
const activeSessions = new Map();

export function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

export async function handleAuthRoutes(req, res) {
  const url = req.url;
  const method = req.method;

  // ── POST /auth/signup ──────────────────────────────────────────────────
  if (url === '/auth/signup' && method === 'POST') {
    const body = await readBody(req);
    const { username, email, password } = body;

    if (!username || !password) {
      return json(res, 400, { error: 'Username and password required' });
    }
    if (username.length < 2 || username.length > 30) {
      return json(res, 400, { error: 'Username must be 2-30 characters' });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
      return json(res, 400, { error: 'Username can only contain letters, numbers, _ . -' });
    }
    if (password.length < 6) {
      return json(res, 400, { error: 'Password must be at least 6 characters' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(res, 400, { error: 'Invalid email address' });
    }

    try {
      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        'INSERT INTO users (username, email, password, role) VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, created_at',
        [username.trim(), email?.trim().toLowerCase() || null, hash, 'user']
      );
      const user = result.rows[0];
      const token = signToken({ id: user.id, username: user.username, role: user.role });
      return json(res, 201, { token, username: user.username, email: user.email, role: user.role });
    } catch (err) {
      if (err.code === '23505') {
        const detail = err.detail || '';
        if (detail.includes('email')) return json(res, 409, { error: 'Email already registered' });
        return json(res, 409, { error: 'Username already taken' });
      }
      console.error('Signup error:', err.message);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // ── POST /auth/login ───────────────────────────────────────────────────
  if (url === '/auth/login' && method === 'POST') {
    const body = await readBody(req);
    // Accept username or email for login identifier
    const { username, email, password, deviceType = 'web', force = false } = body;
    const identifier = (username || email || '').trim();

    if (!identifier || !password) {
      return json(res, 400, { error: 'Username/email and password required' });
    }

    try {
      // Look up by username OR email
      const result = await pool.query(
        `SELECT id, username, email, password, role, is_active FROM users 
         WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)`,
        [identifier]
      );
      const user = result.rows[0];

      if (!user) return json(res, 401, { error: 'Invalid username/email or password' });
      if (!user.is_active) return json(res, 403, { error: 'Account deactivated. Contact admin.' });

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return json(res, 401, { error: 'Invalid username/email or password' });

      // Fix 3: Check if already logged in on same device type
      // Allow: website + extension simultaneously
      // Block: two websites, two mobiles, two extensions (unless force=true)
      const sessionKey = `${user.username.toLowerCase()}:${deviceType}`;
      const existing = activeSessions.get(sessionKey);
      if (existing && !force) {
        const minutesAgo = Math.floor((Date.now() - existing.loginAt) / 60000);
        return json(res, 409, {
          error: `Already logged in on another ${deviceType} device (${minutesAgo}m ago). Use force=true to override.`,
          alreadyLoggedIn: true,
          deviceType,
        });
      }

      await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [user.id]);

      const token = signToken({ id: user.id, username: user.username, role: user.role, deviceType });
      // Track this session
      activeSessions.set(sessionKey, { loginAt: Date.now(), token });

      return json(res, 200, { token, username: user.username, email: user.email, role: user.role });
    } catch (err) {
      console.error('Login error:', err.message);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // ── POST /auth/logout ──────────────────────────────────────────────────
  if (url === '/auth/logout' && method === 'POST') {
    const token = extractToken(req);
    const payload = verifyToken(token);
    if (payload) {
      const deviceType = payload.deviceType || 'web';
      const sessionKey = `${payload.username.toLowerCase()}:${deviceType}`;
      activeSessions.delete(sessionKey);
    }
    return json(res, 200, { success: true });
  }

  // ── GET /auth/me ───────────────────────────────────────────────────────
  if (url === '/auth/me' && method === 'GET') {
    const token = extractToken(req);
    const payload = verifyToken(token);
    if (!payload) return json(res, 401, { error: 'Unauthorized' });

    try {
      const result = await pool.query(
        'SELECT id, username, email, role, created_at, last_active, is_active FROM users WHERE id = $1',
        [payload.id]
      );
      const user = result.rows[0];
      if (!user || !user.is_active) return json(res, 401, { error: 'Account not found or deactivated' });
      await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [user.id]);
      return json(res, 200, { username: user.username, email: user.email, role: user.role, createdAt: user.created_at });
    } catch (err) {
      return json(res, 500, { error: 'Server error' });
    }
  }

  return null; // not an auth route
}

// ── User data routes ───────────────────────────────────────────────────────
export async function handleUserDataRoutes(req, res) {
  const url = req.url;
  const method = req.method;
  const token = extractToken(req);
  const payload = verifyToken(token);
  if (!payload) return json(res, 401, { error: 'Unauthorized' });

  const username = payload.username;

  if (url === '/user/friends' && method === 'GET') {
    const r = await pool.query('SELECT friend_username, friend_device_id, added_at FROM friends WHERE user_username = $1', [username]);
    return json(res, 200, { friends: r.rows });
  }
  if (url === '/user/friends' && method === 'POST') {
    const { friendUsername, friendDeviceId } = await readBody(req);
    await pool.query('INSERT INTO friends (user_username, friend_username, friend_device_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [username, friendUsername, friendDeviceId || '']);
    return json(res, 200, { success: true });
  }
  if (url.startsWith('/user/friends/') && method === 'DELETE') {
    const friendUsername = decodeURIComponent(url.replace('/user/friends/', ''));
    await pool.query('DELETE FROM friends WHERE user_username = $1 AND friend_username = $2', [username, friendUsername]);
    return json(res, 200, { success: true });
  }
  if (url === '/user/inbox' && method === 'GET') {
    const r = await pool.query('SELECT * FROM inbox WHERE to_username = $1 ORDER BY sent_at DESC', [username]);
    return json(res, 200, { inbox: r.rows });
  }
  if (url === '/user/inbox' && method === 'POST') {
    const { fromUsername, fromDeviceId, requestId, status } = await readBody(req);
    await pool.query('INSERT INTO inbox (to_username, from_username, from_device_id, request_id, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (request_id) DO UPDATE SET status = $5', [username, fromUsername, fromDeviceId || '', requestId, status || 'pending']);
    return json(res, 200, { success: true });
  }
  if (url.startsWith('/user/inbox/') && method === 'PATCH') {
    const requestId = url.replace('/user/inbox/', '');
    const { status } = await readBody(req);
    await pool.query('UPDATE inbox SET status = $1 WHERE request_id = $2 AND to_username = $3', [status, requestId, username]);
    return json(res, 200, { success: true });
  }
  if (url.startsWith('/user/chat/') && method === 'GET') {
    const sessionId = url.replace('/user/chat/', '');
    const r = await pool.query('SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY sent_at ASC LIMIT 200', [sessionId]);
    return json(res, 200, { messages: r.rows });
  }

  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}
