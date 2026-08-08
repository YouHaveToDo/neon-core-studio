const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/requireAuth');

// docs/design/card-shop-currency-proposal.md Phase 2 (this milestone): a
// single read-only endpoint for the account's Ink balance + expansion-pool
// card ownership. Same "read-only, rows/columns are only ever written
// elsewhere" convention as routes/matchHistory.js -- ink_balance and
// expansion_cards are only ever mutated by lib/matchHistory.js's
// recordMatchResult (Ink award) and, in a later phase, the not-yet-built
// shop/pull endpoint (expansion_cards writes) -- never through this route.
const router = express.Router();
router.use(requireAuth);

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

module.exports = router;
