-- Adds the 'void' match_history result value (QA finding #2,
-- docs/qa/online-pvp-milestone.md: simultaneous double-disconnect). Neither
-- side is present to award a forfeit win to when BOTH players drop within
-- the same grace window and neither reconnects -- 'void' records a
-- clear, queryable outcome for both accounts instead of leaving the match
-- unresolved/unrecorded. Deliberately not 'win'/'loss' for either side (a
-- forfeit-style winner would be arbitrary here -- see server/src/ws/
-- server.js's onDisconnectGraceExpired for the reasoning) and deliberately
-- not a brand new table/column -- same `result` enum, just one more legal
-- value, per the "small team, don't over-abstract" migration convention
-- 001_init.sql already established.

BEGIN;

ALTER TABLE match_history DROP CONSTRAINT match_history_result_check;
ALTER TABLE match_history ADD CONSTRAINT match_history_result_check
  CHECK (result IN ('win', 'loss', 'win_forfeit', 'void'));

COMMIT;
