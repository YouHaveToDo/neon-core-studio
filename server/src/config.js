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
};
