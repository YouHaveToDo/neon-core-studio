const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const { EXPANSION_CARD_IDS, MAX_COPIES_PER_CARD } = require('../lib/cardCatalog');

// docs/design/card-shop-currency-proposal.md Phase 2 (GET) + Phase 4 (POST
// /pull, this milestone) live together here: the account's Ink balance +
// expansion-pool card ownership are only ever mutated by lib/matchHistory.js's
// recordMatchResult (Ink award) and POST /pull below (expansion_cards writes,
// Ink spend) -- never anywhere else.
const router = express.Router();
router.use(requireAuth);

// §6.1: flat cost per pull, regardless of what's in the bag.
const PULL_COST = 50;

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

module.exports = router;
