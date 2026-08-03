require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy server/.env.example to server/.env and fill it in ' +
      '(local Postgres connection string for dev, or a Neon/Supabase URL for real use).'
  );
}

module.exports = {
  DATABASE_URL,
  PORT: Number(process.env.PORT) || 3001,
  NODE_ENV: process.env.NODE_ENV || 'development',
  IS_PRODUCTION: process.env.NODE_ENV === 'production',
  // Session lifetime: spec §4.2 only requires "no re-auth needed until
  // explicit logout" -- exact duration is left to programmer discretion.
  // 30 days is a generous MVP default.
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  SESSION_COOKIE_NAME: 'al_session',
  // The client (js/ + index.html) is a static file set with no dev server
  // of its own and no shared origin with this API (Phase 4.1 hasn't wired
  // any client->server integration before this). Comma-separated list of
  // allowed origins for CORS with credentials (cookies) in production; in
  // development, cors.js reflects whatever origin the browser sends instead
  // (see app.js) so a local static server on any port can be used without
  // extra config. Left unset by default -- production deploys must set this
  // explicitly (see app.js: unset + production = no cross-origin access at
  // all, a safe default over silently allowing everything).
  CLIENT_ORIGIN: process.env.CLIENT_ORIGIN || null,

  // PvP relay timing (plan.md Phase 2.5-2.7, spec §7.3/§8). Spec values are
  // the defaults; the env overrides exist ONLY so scripts/pvp-smoke-test.js
  // can run against much shorter windows (a real test run at 24s/45s/10s
  // would take minutes) -- production always uses the spec numbers below
  // unless someone explicitly sets these env vars, which nothing in normal
  // deployment does.
  TURN_TIMEOUT_MS: Number(process.env.PVP_TURN_TIMEOUT_MS) || 24000, // spec §7.3: 24s
  DISCONNECT_GRACE_MS: Number(process.env.PVP_DISCONNECT_GRACE_MS) || 45000, // spec §8.1: 45s
  CLAIM_FORFEIT_FLOOR_MS: Number(process.env.PVP_CLAIM_FORFEIT_FLOOR_MS) || 10000, // spec §8.2: 10s
  // Heartbeat interval for the ping/pong liveness check (not spec'd -- added
  // to close the "hard network drop without a close frame" gap flagged by
  // the earlier session). Well under the 45s grace window so a dead socket
  // is detected and disconnect bookkeeping starts promptly.
  WS_HEARTBEAT_INTERVAL_MS: Number(process.env.PVP_WS_HEARTBEAT_INTERVAL_MS) || 10000,
};
