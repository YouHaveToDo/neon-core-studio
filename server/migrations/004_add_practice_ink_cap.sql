-- Track B of docs/design/practice-mode-proposal.md (CEO-approved) §6/§7:
-- daily Ink cap tracking for practice-mode (vs-AI) matches, plus a
-- SEPARATE audit log for practice Ink awards.
--
-- practice_ink_today / practice_ink_reset_date live on `accounts` as plain
-- counter columns (not a transaction-log-derived sum) -- per the task
-- brief, `ink_balance` is already a blind `UPDATE ... = ink_balance + $n`
-- column (matchHistory.js's recordMatchResult, economy.js's /pull) with no
-- ledger/transaction-log table anywhere in the schema to piggyback a
-- "sum today's awards" query on. Building that ledger infrastructure just
-- to answer "how much practice Ink today" would be new scope the design
-- doc explicitly leaves to programmer discretion (§6.5) and the simple
-- counter is the cheaper of the two options it names.
--
-- practice_ink_reset_date is a DATE (not TIMESTAMPTZ) storing the UTC
-- calendar day the counter was last reset for. The design doc (§6.1) is
-- explicit that day-boundary must be server/UTC-based, not client-local
-- time (a client could otherwise wind its clock forward to bypass the
-- cap multiple times a day) -- comparing against `(now() AT TIME ZONE
-- 'utc')::date` in application code side-steps whatever the server
-- process's local TZ config happens to be, since DATE has no timezone
-- component once computed.
BEGIN;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS practice_ink_today INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS practice_ink_reset_date DATE;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_practice_ink_today_range
    CHECK (practice_ink_today >= 0 AND practice_ink_today <= 20);

-- §7.2: a SEPARATE audit-log table for practice Ink awards, deliberately
-- NOT a `type`/`is_practice` column bolted onto `match_history`. The
-- design doc argues explicitly against that shape (§7.2): a shared table
-- would need every match_history reader (history.js's aggregate/list
-- queries) to remember a `WHERE type != 'practice'` filter forever, and a
-- single missed filter site would leak practice matches into real
-- win/loss stats. A fully separate table makes that failure mode
-- structurally impossible -- nothing reads practice_ink_log except this
-- audit path, so there's no filter to forget. This table is NOT read by
-- any match-history route/query (server/src/routes/matchHistory.js) --
-- confirmed by grep at implementation time, see
-- server/src/routes/economy.js's POST /practice-result handler comments.
CREATE TABLE IF NOT EXISTS practice_ink_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  result        TEXT NOT NULL CHECK (result IN ('win', 'loss')),
  ink_awarded   INT NOT NULL CHECK (ink_awarded >= 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_practice_ink_log_account_created
  ON practice_ink_log(account_id, created_at DESC);

COMMIT;
