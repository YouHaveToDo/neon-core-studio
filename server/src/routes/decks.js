const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/requireAuth');
const {
  isValidCardId,
  isExpansionCardId,
  DECK_MIN_SIZE,
  DECK_MAX_SIZE,
  MAX_COPIES_PER_CARD,
} = require('../lib/cardCatalog');

// spec §5: deck slot CRUD, all authenticated. Not an explicit route list in
// the spec/plan (task brief left the exact shapes to programmer judgment) --
// GET /api/decks lists all 3 slots at once (the slot-list screen, §5.4,
// always needs all 3 together), PUT /api/decks/:slot upserts a single slot
// (used for both "create the row for a brand-new slot" and every live-edit
// click, §5.5), DELETE /api/decks/:slot clears one slot (§5.4).
const router = express.Router();
router.use(requireAuth);

const VALID_SLOTS = [1, 2, 3];

function parseSlot(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || !VALID_SLOTS.includes(n)) return null;
  return n;
}

function deckTotal(cards) {
  return Object.values(cards).reduce((sum, n) => sum + n, 0);
}

function defaultDeckName(slot) {
  // spec §5.3: blank name at creation -> auto "덱 N" (slot number).
  return `덱 ${slot}`;
}

// Validates + normalizes the `cards` map from a request body into a plain
// { cardId: count } object with all-positive integer counts. Returns
// { ok: true, cards } or { ok: false, error }.
//
// `ownedExpansionCards` (docs/design/card-shop-currency-proposal.md §2.2/§7,
// Phase 3 of the card-shop-currency milestone): the calling account's
// `accounts.expansion_cards` map ({ cardId: ownedCount }), or {} if the
// caller didn't need to fetch it (e.g. an empty `cards` payload). Only
// consulted for ids `isExpansionCardId()` recognizes -- core-pool ids are
// completely unaffected by this parameter, per spec §5.1 "전체 오픈" (still
// flat max-3, no ownership check).
function validateCards(rawCards, ownedExpansionCards) {
  ownedExpansionCards = ownedExpansionCards || {};
  if (rawCards === undefined || rawCards === null) return { ok: true, cards: {} };
  if (typeof rawCards !== 'object' || Array.isArray(rawCards)) {
    return { ok: false, error: 'cards는 카드ID -> 매수 형식의 객체여야 합니다' };
  }
  const cards = {};
  for (const [cardId, rawCount] of Object.entries(rawCards)) {
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < 0) {
      return { ok: false, error: `잘못된 매수 값입니다: ${cardId}` };
    }
    if (count === 0) continue; // treat 0 same as "not in the deck" -- drop it
    if (!isValidCardId(cardId)) {
      return { ok: false, error: `존재하지 않는 카드입니다: ${cardId}` };
    }
    if (count > MAX_COPIES_PER_CARD) {
      return { ok: false, error: `카드 1종당 최대 ${MAX_COPIES_PER_CARD}장까지 가능합니다 (${cardId})` };
    }
    // Ownership cap for expansion-pool cards only (§2.2/§7): a deck can
    // include at most min(3, owned-count) copies of an expansion card. The
    // flat max-3 check above already enforces the "3" half of that min --
    // this is the additional, STRICTER cap that only bites when the account
    // owns fewer than 3 copies (including the "owns 0" case, i.e. the card
    // is entirely locked). Core-pool cards never reach this branch.
    if (isExpansionCardId(cardId)) {
      const owned = ownedExpansionCards[cardId] || 0;
      if (count > owned) {
        return {
          ok: false,
          error: `보유하지 않았거나 보유 매수를 초과한 카드입니다: ${cardId} (보유 ${owned}장, 요청 ${count}장)`,
        };
      }
    }
    cards[cardId] = count;
  }
  if (deckTotal(cards) > DECK_MAX_SIZE) {
    return { ok: false, error: `덱은 최대 ${DECK_MAX_SIZE}장까지 가능합니다` };
  }
  return { ok: true, cards };
}

function serializeDeck(row) {
  const cards = row.cards || {};
  const total = deckTotal(cards);
  return {
    slot: row.slot,
    name: row.name,
    cards,
    total,
    // spec §5.2/§5.4: a deck is "valid" (queueable, no "미완성" badge) only
    // inside the 20-30 range -- this is a derived display value, not stored.
    valid: total >= DECK_MIN_SIZE && total <= DECK_MAX_SIZE,
    updatedAt: row.updated_at,
  };
}

// GET /api/decks -- spec §5.4 slot-list screen. Always returns exactly 3
// entries (index 0 = slot 1, index 1 = slot 2, index 2 = slot 3); an empty
// slot is `null` rather than omitted, so the client never has to guess which
// slot number a missing entry corresponds to.
router.get('/', async (req, res) => {
  const result = await pool.query(
    'SELECT slot, name, cards, updated_at FROM decks WHERE account_id = $1 ORDER BY slot',
    [req.account.id]
  );
  const bySlot = new Map(result.rows.map((row) => [row.slot, row]));
  const slots = VALID_SLOTS.map((slot) => {
    const row = bySlot.get(slot);
    return row ? serializeDeck(row) : null;
  });
  res.json({ slots });
});

// PUT /api/decks/:slot -- upsert. Backs BOTH "create the row for a brand-new
// slot" (§5.4's "+ 새 덱 만들기" flow, called once with an empty `cards: {}`
// right after the name prompt) and every subsequent add/remove-card or
// rename edit (§5.5: live editing, every click/keystroke persists
// immediately). There is deliberately no separate POST-create route --
// spec §5.5 explicitly rules out a distinct save/create step ("되돌리기
// 버튼 없음").
//
// Server-side validation enforced here (per task brief, since this isn't a
// separately-spec'd route): slot must be 1-3, every card id must be a real
// CARD_IDS entry, max 3 copies per card id, deck total capped at 30.
//
// Deliberately NOT enforcing the 20-card MINIMUM here -- spec §5.2/§5.5
// explicitly describes an incomplete (<20) deck as a normal, expected,
// persisted state (shown with a "미완성" badge, still editable, and the
// editor can be exited while in this state). Rejecting a PUT that leaves a
// deck at, say, 14 cards would make it impossible to save incremental
// progress while building a deck up from zero one click at a time -- the
// live-save-per-click model has no "not yet ready to save" state to hold
// that progress in otherwise. The 20-30 *range* is enforced as a gate at a
// different layer instead: match-queue deck selection (spec §6.1, Phase 4.4)
// is what actually refuses to let an under-20 deck be used, not deck storage.
router.put('/:slot', async (req, res) => {
  const slot = parseSlot(req.params.slot);
  if (slot === null) {
    return res.status(400).json({ error: '슬롯은 1~3 사이여야 합니다' });
  }

  const { name: rawName, cards: rawCards } = req.body || {};

  // Only fetch the account's expansion-card ownership if the payload
  // actually references any card ids at all (the common empty-`cards: {}`
  // case, e.g. creating a brand-new slot, never needs it) -- avoids a wasted
  // round-trip on every save. validateCards() itself defends against a
  // malformed rawCards shape independently, so this check only needs to be
  // a cheap pre-filter, not authoritative.
  let ownedExpansionCards = {};
  if (rawCards && typeof rawCards === 'object' && !Array.isArray(rawCards) && Object.keys(rawCards).length > 0) {
    const acctResult = await pool.query('SELECT expansion_cards FROM accounts WHERE id = $1', [req.account.id]);
    ownedExpansionCards = (acctResult.rows[0] && acctResult.rows[0].expansion_cards) || {};
  }

  const cardsResult = validateCards(rawCards, ownedExpansionCards);
  if (!cardsResult.ok) {
    return res.status(400).json({ error: cardsResult.error });
  }

  let name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) name = defaultDeckName(slot);
  // spec §5.3: name max 20 chars. The client enforces this via <input
  // maxlength> as the primary UX; this truncation is only a defensive
  // backstop against a client that skips it (or a raw API call).
  name = name.slice(0, 20);

  const result = await pool.query(
    `INSERT INTO decks (account_id, slot, name, cards)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (account_id, slot)
     DO UPDATE SET name = EXCLUDED.name, cards = EXCLUDED.cards, updated_at = now()
     RETURNING slot, name, cards, updated_at`,
    [req.account.id, slot, name, JSON.stringify(cardsResult.cards)]
  );
  res.json(serializeDeck(result.rows[0]));
});

// DELETE /api/decks/:slot -- spec §5.4: "삭제" button (confirmation dialog
// itself is a client-side concern, per the mockup). Idempotent: deleting an
// already-empty slot is not an error.
router.delete('/:slot', async (req, res) => {
  const slot = parseSlot(req.params.slot);
  if (slot === null) {
    return res.status(400).json({ error: '슬롯은 1~3 사이여야 합니다' });
  }
  await pool.query('DELETE FROM decks WHERE account_id = $1 AND slot = $2', [req.account.id, slot]);
  res.status(204).end();
});

module.exports = router;
