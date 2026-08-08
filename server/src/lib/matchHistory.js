/**
 * Match-result persistence (plan.md Phase 2.6, spec §6.4-§6.5), now also
 * responsible for Ink currency awards (docs/design/card-shop-currency-
 * proposal.md §5, CEO-approved 15/5/0 numbers).
 *
 * Trusts whatever winner/loser pair it's called with -- no server-side
 * game-rule validation, per the deliberate scope boundary the plan already
 * calls out ("same spirit as the RNG-authority call"). Callers (ws/server.js)
 * decide who won based on the client's `report_result` message or a
 * disconnect/claim-forfeit timeout; this module's only job is writing both
 * sides of that decision to `match_history` (and now `accounts.ink_balance`)
 * atomically.
 *
 * Ink is awarded HERE, in the same transaction as the match_history INSERTs,
 * deliberately -- not duplicated at each of the 3 call sites in ws/server.js
 * (report_result, finalizeForfeit, finalizeVoidMatch). This is the single
 * choke point every match-end path already funnels through (that's exactly
 * why this module exists per its own original doc comment above), so it's
 * the only place a future 4th call site can't forget to award Ink -- it gets
 * it for free by calling recordMatchResult/recordVoidMatch at all. Same
 * transaction as the match_history writes (not a separate query/commit)
 * so there's no window where a match result is recorded but the Ink award
 * silently fails (or the reverse) -- a mid-write crash or query error rolls
 * both back together, consistent with the atomicity this module already
 * provided for the two match_history rows before Ink existed.
 */
const { pool } = require('../db');

// §5.2 of the currency proposal: win 15 / loss 5 (forfeit variants included --
// win_forfeit is paid exactly like a normal win, a forfeited loss exactly
// like a normal loss, per §5.3's "기권승/기권패에 별도 배율을 두지 않은 이유").
const INK_WIN = 15;
const INK_LOSS = 5;

/**
 * Writes one match_history row for each account, and credits Ink to both
 * (+15 winner, +5 loser, regardless of `forfeit`).
 *
 * winner/loser: { accountId, displayName }
 * forfeit: true  -> winner's row is 'win_forfeit', loser's row is still
 *   plain 'loss'. Per spec §6.4/§6.5, only the winning side gets the "승
 *   (기권)" distinction -- the result enum (migrations/001_init.sql) has no
 *   'loss_forfeit' value, a forfeited loss displays identically to a normal
 *   loss. Ink amounts don't vary with `forfeit` either (proposal §5.2/§5.3).
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
    await client.query('UPDATE accounts SET ink_balance = ink_balance + $2 WHERE id = $1', [
      winner.accountId,
      INK_WIN,
    ]);
    await client.query('UPDATE accounts SET ink_balance = ink_balance + $2 WHERE id = $1', [
      loser.accountId,
      INK_LOSS,
    ]);
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
 * No Ink is awarded to either side (CEO-confirmed: 'void' pays 0 Ink to both,
 * per the task brief for this milestone -- neither side "won" or "lost" a
 * match that was never really finished, so there's nothing to pay out for).
 * No ink_balance UPDATE is issued at all here (not even a +0 no-op) -- there
 * is genuinely nothing to do to the balance for this outcome.
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

module.exports = { recordMatchResult, recordVoidMatch, INK_WIN, INK_LOSS };
