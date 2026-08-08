-- Phase 2 of docs/design/card-shop-currency-proposal.md (approved, CEO-confirmed
-- numbers/scope -- see that doc's header for the full sign-off trail): account-level
-- Ink currency balance + expansion-pool card ownership.
--
-- ink_balance: plain int, default 0 (§2.3: "전 계정 0잉크로 시작", no retroactive
-- grant -- every existing account, including the one real player + the CEO test
-- account, starts at 0 the moment this migration runs, same as a brand-new
-- signup from here on). CHECK >= 0 enforced at the DB level rather than just in
-- application code -- this is a currency balance, and a negative value could
-- only ever be a bug (there is no "debt"/negative-balance concept anywhere in
-- the proposal), so it's worth having Postgres itself refuse that state rather
-- than trusting every future write site to remember the invariant.
--
-- expansion_cards: JSONB cardId -> count map, default '{}'. Deliberately reuses
-- decks.cards' exact shape (001_init.sql) rather than a new table/shape --
-- §2.3 of the proposal explicitly calls out that ownership tracking is simple
-- enough not to need its own relational table, and the doc comment on
-- decks.cards already establishes why this shape is convenient (max-3-copies
-- and total-count checks become direct reads). This column tracks ONLY the
-- expansion pool (§4 of the proposal) -- the existing core 14 cards remain
-- unconditionally available to every account via spec-online-pvp.md §5.1,
-- unchanged, no new column needed for them.
BEGIN;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ink_balance INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS expansion_cards JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_ink_balance_non_negative CHECK (ink_balance >= 0);

COMMIT;
