-- Phase 1 schema: accounts, sessions, decks, match_history
-- Plain SQL, no ORM (per docs/design/online-pvp-plan.md infra decision).
-- Field shapes per plan.md Phase 1 (1.2) and spec-online-pvp.md §4-§6.5.
--
-- Requires PostgreSQL 13+ (gen_random_uuid() is available in core since PG13,
-- no pgcrypto/uuid-ossp extension needed). Verified locally against PG16.

BEGIN;

-- §4: accounts. Email is the login identifier (never shown to opponents,
-- always lowercased before storage/lookup so "Foo@x.com" and "foo@x.com"
-- can't both register). display_name is what opponents see and is NOT
-- unique (spec §4.1: duplicates allowed).
CREATE TABLE IF NOT EXISTS accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Opaque, server-stored session tokens (not JWT) so logout-by-deletion is
-- trivial (spec's stated reason, see plan.md infra decision / task brief).
-- expires_at is a generous 30-day sliding-ish window (see server/src/lib/
-- session.js for how it's set/read) -- spec §4.2 leaves exact session
-- lifetime to programmer discretion, only requiring "no re-auth needed
-- until explicit logout"; 30 days is a reasonable default for an MVP.
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_account_id ON sessions(account_id);

-- §5: deck slots, 3 per account (1-3), live-saved per edit (no draft/undo
-- state to model). `cards` is a JSON object mapping cardId -> count, e.g.
-- {"strike": 3, "defend": 3, ...} -- chosen over a flat array of card ids
-- because it makes "max 3 copies per card" and "sum = deck size" checks
-- direct reads instead of client-side tallying.
CREATE TABLE IF NOT EXISTS decks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slot        SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 3),
  name        TEXT NOT NULL,
  cards       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_decks_account_id ON decks(account_id);

-- §6.5: match history. opponent_display_name is a snapshot at match-end
-- time (spec explicitly wants a name snapshot, not a live FK to the
-- opponent account, since display names aren't unique/stable identifiers).
-- result enum matches plan.md 1.2 exactly: win / loss / win_forfeit.
-- (A forfeited loss is still just "loss" per spec §6.4 -- only the winning
-- side gets the "(기권)" distinction.)
CREATE TABLE IF NOT EXISTS match_history (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  opponent_display_name  TEXT NOT NULL,
  result                 TEXT NOT NULL CHECK (result IN ('win', 'loss', 'win_forfeit')),
  played_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_match_history_account_played
  ON match_history(account_id, played_at DESC);

COMMIT;
