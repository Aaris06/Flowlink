# FlowLink Backend

Lightweight WebSocket server for session management and WebRTC signaling.

## Responsibilities

- Session creation and management
- Device connection tracking
- WebRTC signaling relay (offer/answer/ICE candidates)
- Session expiry and cleanup

## Does NOT

- Store or transfer files
- Access device data
- Maintain persistent connections
- Handle actual data transfer (that's WebRTC P2P)

## Usage

```bash
npm install
npm run dev
```

Server runs on `ws://localhost:8080` by default.

## Environment Variables

- `PORT`: WebSocket server port (default: 8080)
- `DATABASE_URL`: Postgres/Supabase connection string
- `SUPABASE_KEEPALIVE_TOKEN`: optional shared secret guarding `GET /health/supabase`.
  When set, the endpoint requires `Authorization: Bearer <token>`,
  an `x-keepalive-token` header, or a `?token=<token>` query param.
  When unset, the endpoint stays public (read-only single-row query).

## Health endpoints

- `GET /health` (or `/ping`): service status, no DB touch — used by the
  Railway `healthcheckPath`. Keep public and fast.
- `GET /db-ping`: raw `SELECT 1` connectivity check.
- `GET` or `HEAD /health/supabase`: Supabase keep-alive — runs
  `SELECT id FROM users LIMIT 1` (one indexed row) to generate real database
  activity. Point an UptimeRobot HTTP(s) monitor at it every 5 minutes
  (UptimeRobot free plan uses HEAD: status + headers only, no body —
  the keep-alive query still runs, and up/down is decided by status code).

