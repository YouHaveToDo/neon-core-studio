const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/requireAuth');

// spec §6.5: match history screen. Single read-only endpoint -- rows are
// only ever written by the WS relay (matchHistory.js's recordMatchResult,
// called from ws/server.js on report_result / forfeit), never through this
// HTTP route.
const router = express.Router();
router.use(requireAuth);

// "최근 100경기까지만 화면에 표시" (spec §6.5) -- older rows stay in the DB
// (no delete/archive job) but are never returned to a client.
const MAX_ROWS = 100;

// YYYY-MM-DD only, per spec §6.5 ("정확한 시각까지는 표시하지 않는다").
// played_at is TIMESTAMPTZ; toISOString() is always UTC, which is a
// deliberate simplification (no per-account timezone stored anywhere in
// this schema) -- acceptable for a date-only display field.
function formatDate(playedAt) {
  return new Date(playedAt).toISOString().slice(0, 10);
}

// GET /api/match-history -- spec §6.5. Most recent first, capped at 100.
// The win/loss count header is intentionally NOT computed here: spec §6.5
// describes it as "아래 리스트에서 계산되는 파생값" (a derived value from the
// list below), i.e. the same capped list the screen already renders, not an
// all-time total -- so the client (js/history.js) derives it by tallying
// this response, matching the mockup's framing of the header as "a summary
// of the list", not a separate lifetime counter.
router.get('/', async (req, res) => {
  const result = await pool.query(
    `SELECT opponent_display_name, result, played_at
     FROM match_history
     WHERE account_id = $1
     ORDER BY played_at DESC
     LIMIT $2`,
    [req.account.id, MAX_ROWS]
  );
  const matches = result.rows.map((row) => ({
    opponentDisplayName: row.opponent_display_name,
    result: row.result, // 'win' | 'loss' | 'win_forfeit'
    playedAt: formatDate(row.played_at),
  }));
  res.json({ matches });
});

module.exports = router;
