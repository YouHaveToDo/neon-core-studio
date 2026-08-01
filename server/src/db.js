const { Pool } = require('pg');
const { DATABASE_URL } = require('./config');

// Local Postgres (Postgres.app, docker, etc.) generally doesn't speak TLS;
// managed providers like Neon/Supabase require it. Toggle based on host
// rather than hardcoding, so the same code works against both.
const isLocal = /localhost|127\.0\.0\.1|::1/.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // Idle client errors (e.g. connection dropped by the DB) shouldn't crash
  // the whole process.
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = { pool };
