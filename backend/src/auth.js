import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pool from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'flowlink_jwt_secret_2024';
const JWT_EXPIRY = '30d';

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
    const { username, password } = body;

    if (!username || !password) {
      return json(res, 400, { error: 'Username and password required' });
    }
    if (username.length < 2 || username.length > 30) {
      return json(res, 400, { error: 'Username must be 2-30 characters' });
    }
    if (password.length < 6) {
      return json(res, 400, { error: 'Password must be at least 6 characters' });
    }

    try {
      const hash = await bcrypt.hash(password, 10);
      const result = await pool.query(
        'INSERT INTO users (username, password, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at',
        [username.trim(), hash, 'user']
      );
      const user = result.rows[0];
      const token = signToken({ id: user.id, username: user.username, role: user.role });
      return json(res, 201, { token, username: user.username, role: user.role });
    } catch (err) {
      if (err.code === '23505') {
        return json(res, 409, { error: 'Username already taken' });
      }
      console.error('Signup error:', err.message);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // ── POST /auth/login ───────────────────────────────────────────────────
  if (url === '/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const { username, password } = body;

    if (!username || !password) {
      return json(res, 400, { error: 'Username and password required' });
    }

    try {
      const result = await pool.query(
        'SELECT id, username, password, role, is_active FROM users WHERE LOWER(username) = LOWER($1)',
        [username.trim()]
      );
      const user = result.rows[0];

      if (!user) return json(res, 401, { error: 'Invalid username or password' });
      if (!user.is_active) return json(res, 403, { error: 'Account deactivated. Contact admin.' });

      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return json(res, 401, { error: 'Invalid username or password' });

      // Check if user is already logged in on another device
      // (skip this check - allow multiple devices for now, just update last_active)

      await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [user.id]);

      const token = signToken({ id: user.id, username: user.username, role: user.role });
      return json(res, 200, { token, username: user.username, role: user.role });
    } catch (err) {
      console.error('Login error:', err.message);
      return json(res, 500, { error: 'Server error' });
    }
  }

  // ── GET /auth/me ───────────────────────────────────────────────────────
  if (url === '/auth/me' && method === 'GET') {
    const token = extractToken(req);
    const payload = verifyToken(token);
    if (!payload) return json(res, 401, { error: 'Unauthorized' });

    try {
      const result = await pool.query(
        'SELECT id, username, role, created_at, last_active, is_active FROM users WHERE id = $1',
        [payload.id]
      );
      const user = result.rows[0];
      if (!user || !user.is_active) return json(res, 401, { error: 'Account not found or deactivated' });
      await pool.query('UPDATE users SET last_active = NOW() WHERE id = $1', [user.id]);
      return json(res, 200, { username: user.username, role: user.role, createdAt: user.created_at });
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

  // GET /user/friends
  if (url === '/user/friends' && method === 'GET') {
    const r = await pool.query('SELECT friend_username, friend_device_id, added_at FROM friends WHERE user_username = $1', [username]);
    return json(res, 200, { friends: r.rows });
  }

  // POST /user/friends
  if (url === '/user/friends' && method === 'POST') {
    const { friendUsername, friendDeviceId } = await readBody(req);
    await pool.query(
      'INSERT INTO friends (user_username, friend_username, friend_device_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [username, friendUsername, friendDeviceId || '']
    );
    return json(res, 200, { success: true });
  }

  // DELETE /user/friends/:friendUsername
  if (url.startsWith('/user/friends/') && method === 'DELETE') {
    const friendUsername = decodeURIComponent(url.replace('/user/friends/', ''));
    await pool.query('DELETE FROM friends WHERE user_username = $1 AND friend_username = $2', [username, friendUsername]);
    return json(res, 200, { success: true });
  }

  // GET /user/inbox
  if (url === '/user/inbox' && method === 'GET') {
    const r = await pool.query('SELECT * FROM inbox WHERE to_username = $1 ORDER BY sent_at DESC', [username]);
    return json(res, 200, { inbox: r.rows });
  }

  // POST /user/inbox
  if (url === '/user/inbox' && method === 'POST') {
    const { fromUsername, fromDeviceId, requestId, status } = await readBody(req);
    await pool.query(
      'INSERT INTO inbox (to_username, from_username, from_device_id, request_id, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (request_id) DO UPDATE SET status = $5',
      [username, fromUsername, fromDeviceId || '', requestId, status || 'pending']
    );
    return json(res, 200, { success: true });
  }

  // PATCH /user/inbox/:requestId
  if (url.startsWith('/user/inbox/') && method === 'PATCH') {
    const requestId = url.replace('/user/inbox/', '');
    const { status } = await readBody(req);
    await pool.query('UPDATE inbox SET status = $1 WHERE request_id = $2 AND to_username = $3', [status, requestId, username]);
    return json(res, 200, { success: true });
  }

  // GET /user/chat/:sessionId
  if (url.startsWith('/user/chat/') && method === 'GET') {
    const sessionId = url.replace('/user/chat/', '');
    const r = await pool.query(
      'SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY sent_at ASC LIMIT 200',
      [sessionId]
    );
    return json(res, 200, { messages: r.rows });
  }

  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
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
