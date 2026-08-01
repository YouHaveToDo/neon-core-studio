/* Minimal migration runner: no ORM/migration-framework per the plan's
 * "small team, don't over-abstract" call. Just runs every .sql file in
 * migrations/ in filename order, tracking what's already been applied in
 * a `schema_migrations` table so re-running is safe (idempotent).
 *
 * Usage: DATABASE_URL=postgres://... npm run migrate
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. Copy server/.env.example to server/.env and fill it in.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString, ssl: sslOption(connectionString) });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`skip  ${file} (already applied)`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`apply ${file}`);
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    }

    console.log('Migrations up to date.');
  } finally {
    await pool.end();
  }
}

// Local Postgres (Postgres.app, docker, etc.) generally doesn't speak TLS;
// managed providers like Neon/Supabase require it. Toggle based on host.
function sslOption(connectionString) {
  const isLocal = /localhost|127\.0\.0\.1|::1/.test(connectionString);
  return isLocal ? false : { rejectUnauthorized: false };
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
