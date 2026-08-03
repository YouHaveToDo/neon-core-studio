/**
 * Match-result persistence (plan.md Phase 2.6, spec §6.4-§6.5).
 *
 * Trusts whatever winner/loser pair it's called with -- no server-side
 * game-rule validation, per the deliberate scope boundary the plan already
 * calls out ("same spirit as the RNG-authority call"). Callers (ws/server.js)
 * decide who won based on the client's `report_result` message or a
 * disconnect/claim-forfeit timeout; this module's only job is writing both
 * sides of that decision to `match_history` atomically.
 */
const { pool } = require('../db');

/**
 * Writes one match_history row for each account.
 *
 * winner/loser: { accountId, displayName }
 * forfeit: true  -> winner's row is 'win_forfeit', loser's row is still
 *   plain 'loss'. Per spec §6.4/§6.5, only the winning side gets the "승
 *   (기권)" distinction -- the result enum (migrations/001_init.sql) has no
 *   'loss_forfeit' value, a forfeited loss displays identically to a normal
 *   loss.
 */
async function recordMatchResult({ winner, loser, forfeit }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO match_history (account_id, opponent_display_name, result) VALUES ($1, $2, $3)`,
      [winner.accountId, loser.displayName, forfeit ? 'win_forfeit' : 'win']
    );
    await client.query(
      `INSERT INTO match_history (account_id, opponent_display_name, result) VALUES ($1, $2, $3)`,
      [loser.accountId, winner.displayName, 'loss']
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { recordMatchResult };
