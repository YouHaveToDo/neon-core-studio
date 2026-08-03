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

/**
 * Writes a 'void' match_history row for BOTH accounts (QA finding #2:
 * simultaneous double-disconnect). Used when neither player's grace period
 * ends with anyone actually present to award a forfeit win to (see
 * ws/server.js's onDisconnectGraceExpired) -- both sides get a symmetric,
 * clearly-labeled non-outcome instead of one side arbitrarily "winning" a
 * match neither of them was really connected to finish, and instead of the
 * match silently vanishing with no record at all (the bug being fixed).
 *
 * playerA/playerB: { accountId, displayName }
 */
async function recordVoidMatch({ playerA, playerB }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO match_history (account_id, opponent_display_name, result) VALUES ($1, $2, 'void')`,
      [playerA.accountId, playerB.displayName]
    );
    await client.query(
      `INSERT INTO match_history (account_id, opponent_display_name, result) VALUES ($1, $2, 'void')`,
      [playerB.accountId, playerA.displayName]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { recordMatchResult, recordVoidMatch };
