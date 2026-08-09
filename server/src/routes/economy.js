const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const { EXPANSION_CARD_IDS, MAX_COPIES_PER_CARD } = require('../lib/cardCatalog');

// docs/design/card-shop-currency-proposal.md Phase 2 (GET) + Phase 4 (POST
// /pull, this milestone) live together here: the account's Ink balance +
// expansion-pool card ownership are only ever mutated by lib/matchHistory.js's
// recordMatchResult (Ink award), POST /pull below (expansion_cards writes,
// Ink spend), and POST /practice-result below (practice-mode Ink award,
// docs/design/practice-mode-proposal.md §6/§7) -- never anywhere else.
const router = express.Router();
router.use(requireAuth);

// §6.1: flat cost per pull, regardless of what's in the bag.
const PULL_COST = 50;

// practice-mode-proposal.md §6.1/§6.4: much-reduced rates vs. real PvP's
// 15/5 (lib/matchHistory.js's INK_WIN/INK_LOSS), plus a daily account-wide
// cap -- see POST /practice-result below.
const PRACTICE_INK_WIN = 4;
const PRACTICE_INK_LOSS = 1;
const PRACTICE_INK_DAILY_CAP = 20;

// GET /api/economy -- current Ink balance + expansion-pool ownership map.
// expansion_cards defaults to '{}' at the DB level (migrations/
// 003_add_ink_and_expansion_cards.sql), so a brand-new account (or one that
// hasn't pulled any expansion cards yet) gets back an empty object here, not
// null/undefined -- consistent with decks.js's `cards` shape, which the
// client already knows how to treat as "nothing owned yet" rather than as a
// special case.
router.get('/', async (req, res) => {
  const result = await pool.query(
    'SELECT ink_balance, expansion_cards FROM accounts WHERE id = $1',
    [req.account.id]
  );
  const row = result.rows[0];
  res.json({
    inkBalance: row.ink_balance,
    expansionCards: row.expansion_cards || {},
  });
});

// POST /api/economy/pull -- §6.2 "bag" mechanic: draws uniformly at random
// from expansion-pool card ids the account currently owns fewer than
// MAX_COPIES_PER_CARD (3) of, spending PULL_COST (50) Ink. One card per call
// (§6.1: "묶음/선택형 뽑기 없음").
//
// Order of checks is deliberate (§6.2's last bullet: once every expansion
// card is at 3/3, "잉크를 넣고도 아무것도 못 얻는 뽑기... 만들지 않는다" --
// a pull that structurally cannot happen must never touch ink_balance):
//   1. bag empty (collection complete) -> 409, no Ink check/deduction at all
//   2. insufficient Ink -> 400, no partial effect
//   3. otherwise: deduct Ink + increment ownership together
//
// Atomicity: SELECT ... FOR UPDATE takes a row lock on this account's
// `accounts` row for the duration of the transaction, so two concurrent
// pulls from the same account can't both read the same pre-pull bag/balance
// and race each other into an inconsistent state (lost update on the JSONB
// ownership map, or spending Ink twice past a balance check that only ran
// once) -- the second request simply waits for the first transaction to
// commit or roll back before it reads. This is stricter than
// matchHistory.js's recordMatchResult needs to be (that module only ever
// does a single blind `ink_balance = ink_balance + $2`, which is safe to
// interleave on its own) -- here the ownership write depends on first
// reading the current map to compute the bag and the new count, so a plain
// read-then-write without a lock would be vulnerable to that race.
router.post('/pull', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT ink_balance, expansion_cards FROM accounts WHERE id = $1 FOR UPDATE',
      [req.account.id]
    );
    const row = result.rows[0];
    const owned = row.expansion_cards || {};

    const bag = EXPANSION_CARD_IDS.filter((id) => (owned[id] || 0) < MAX_COPIES_PER_CARD);
    if (bag.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'collection_complete',
        message: '모든 확장 카드를 보유했습니다',
        expansionCards: owned,
      });
    }

    if (row.ink_balance < PULL_COST) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'insufficient_ink',
        message: `잉크가 부족합니다 (필요 ${PULL_COST}, 보유 ${row.ink_balance})`,
        inkBalance: row.ink_balance,
      });
    }

    // Uniform random pick within the eligible bag (§6.2: not independent-
    // probability gacha -- every id in `bag` is equally likely here).
    const pulledId = bag[Math.floor(Math.random() * bag.length)];
    const nextOwned = { ...owned, [pulledId]: (owned[pulledId] || 0) + 1 };

    const updated = await client.query(
      `UPDATE accounts
       SET ink_balance = ink_balance - $2, expansion_cards = $3::jsonb
       WHERE id = $1
       RETURNING ink_balance, expansion_cards`,
      [req.account.id, PULL_COST, JSON.stringify(nextOwned)]
    );
    await client.query('COMMIT');

    res.json({
      cardId: pulledId,
      inkBalance: updated.rows[0].ink_balance,
      expansionCards: updated.rows[0].expansion_cards,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/economy/practice-result -- docs/design/practice-mode-proposal.md
// §6.5/§7.2: awards Ink for a practice-mode (vs-AI) match at reduced rates
// (4 win / 1 loss vs. real PvP's 15/5), capped so the account's total
// practice-mode Ink for the current UTC calendar day never exceeds
// PRACTICE_INK_DAILY_CAP (20). The client self-reports win/loss -- per the
// design doc's explicit acknowledgment (§6.5 "결과 신뢰 문제"), a local-AI
// match's outcome can't be server-verified, so the daily cap is the
// defense-in-depth bound here, not result verification.
//
// Deliberately does NOT touch `match_history` in any way (§7.1: practice
// matches must never appear in the real match-history list/aggregate --
// the design doc argues for a structurally separate table specifically so
// no reader of match_history ever needs a `WHERE type != 'practice'`
// filter). The only persistent record of a practice match is this
// endpoint's `accounts.practice_ink_today` counter update and the
// `practice_ink_log` audit-log INSERT (migrations/
// 004_add_practice_ink_cap.sql).
//
// UTC-day boundary: computed in SQL as `(now() AT TIME ZONE 'utc')::date`,
// not in application code with `new Date()` -- `now()` is a TIMESTAMPTZ
// (an absolute instant), and `AT TIME ZONE 'utc'` explicitly converts that
// instant to UTC wall-clock time before truncating to a date, so the
// result is the same regardless of the server process's/host's configured
// local timezone (verified via scripts/practice-ink-smoke-test.js by
// simulating a stale reset_date and confirming the reset fires without
// waiting a real day).
//
// Atomicity: same `SELECT ... FOR UPDATE` row-lock pattern as POST /pull
// above -- this endpoint has the identical "read current state (today's
// counter + balance), compute the capped award, write back" shape, so two
// concurrent requests from the same account racing at the cap boundary
// could otherwise both read practice_ink_today=18, both compute "2 Ink
// still fits", and both award 2 -- pushing the account to 22/20. The row
// lock serializes the second request behind the first transaction's
// commit, so it re-reads the already-updated counter.
router.post('/practice-result', async (req, res) => {
  const { result } = req.body || {};
  if (result !== 'win' && result !== 'loss') {
    return res.status(400).json({
      error: 'invalid_result',
      message: "result must be 'win' or 'loss'",
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // `is_today` is computed entirely in SQL (never round-tripped through a
    // JS Date) to sidestep node-postgres's DATE type parser, which by
    // default constructs JS Date objects using the Node process's *local*
    // timezone -- comparing those objects for "is this the same UTC day"
    // would silently be wrong on a server not configured for UTC. Comparing
    // two SQL `date` values directly (`practice_ink_reset_date = (now() AT
    // TIME ZONE 'utc')::date`) never leaves Postgres, so it's unaffected by
    // Node's TZ. `now()` is fixed for the whole transaction (not
    // clock_timestamp()), so this SELECT and the UPDATE below necessarily
    // agree on what "today" is even if the transaction straddles real time.
    const current = await client.query(
      `SELECT ink_balance, practice_ink_today,
              (practice_ink_reset_date = (now() AT TIME ZONE 'utc')::date) AS is_today
       FROM accounts WHERE id = $1 FOR UPDATE`,
      [req.account.id]
    );
    const row = current.rows[0];

    // row.is_today is NULL (falsy) when practice_ink_reset_date was never
    // set (brand-new account) -- correctly treated as "not today", i.e. a
    // reset is due.
    const practiceInkTodayBefore = row.is_today ? row.practice_ink_today : 0;

    const baseAward = result === 'win' ? PRACTICE_INK_WIN : PRACTICE_INK_LOSS;
    const remainingCap = PRACTICE_INK_DAILY_CAP - practiceInkTodayBefore;
    const inkAwarded = Math.max(0, Math.min(baseAward, remainingCap));
    const practiceInkTodayAfter = practiceInkTodayBefore + inkAwarded;

    const updated = await client.query(
      `UPDATE accounts
       SET ink_balance = ink_balance + $2,
           practice_ink_today = $3,
           practice_ink_reset_date = (now() AT TIME ZONE 'utc')::date
       WHERE id = $1
       RETURNING ink_balance, practice_ink_today`,
      [req.account.id, inkAwarded, practiceInkTodayAfter]
    );

    await client.query(
      `INSERT INTO practice_ink_log (account_id, result, ink_awarded) VALUES ($1, $2, $3)`,
      [req.account.id, result, inkAwarded]
    );

    await client.query('COMMIT');

    res.json({
      inkAwarded,
      inkBalance: updated.rows[0].ink_balance,
      practiceInkToday: updated.rows[0].practice_ink_today,
      practiceInkDailyCap: PRACTICE_INK_DAILY_CAP,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

module.exports = router;
