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
};
