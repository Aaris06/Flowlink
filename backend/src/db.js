import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('DB pool error:', err.message);
});

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        username    TEXT UNIQUE NOT NULL,
        email       TEXT UNIQUE,
        password    TEXT NOT NULL,
        role        TEXT NOT NULL DEFAULT 'user',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        last_active TIMESTAMPTZ DEFAULT NOW(),
        is_active   BOOLEAN DEFAULT TRUE
      );

      -- Add columns to existing tables if missing
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

      CREATE TABLE IF NOT EXISTS friends (
        id              SERIAL PRIMARY KEY,
        user_username   TEXT NOT NULL,
        friend_username TEXT NOT NULL,
        friend_device_id TEXT DEFAULT '',
        added_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_username, friend_username)
      );

      CREATE TABLE IF NOT EXISTS inbox (
        id              SERIAL PRIMARY KEY,
        to_username     TEXT NOT NULL,
        from_username   TEXT NOT NULL,
        from_device_id  TEXT DEFAULT '',
        request_id      TEXT UNIQUE NOT NULL,
        status          TEXT DEFAULT 'pending',
        sent_at         TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        code        TEXT UNIQUE NOT NULL,
        created_by  TEXT NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id          SERIAL PRIMARY KEY,
        session_id  TEXT NOT NULL,
        message_id  TEXT UNIQUE NOT NULL,
        text        TEXT DEFAULT '',
        username    TEXT NOT NULL,
        source_device TEXT NOT NULL,
        sent_at     TIMESTAMPTZ NOT NULL,
        attachment  JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id            SERIAL PRIMARY KEY,
        from_username TEXT NOT NULL,
        type          TEXT NOT NULL,
        text          TEXT NOT NULL,
        sent_at       TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_username);
      CREATE INDEX IF NOT EXISTS idx_inbox_to ON inbox(to_username);
      CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id);

      -- Add role column to existing tables if missing
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    `);
    console.log('✅ Database schema ready');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
  } finally {
    client.release();
  }
}

export default pool;
