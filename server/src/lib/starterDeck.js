/* 24-card starter deck seeded into slot 1 on account creation.
 * Source of truth: docs/design/spec-online-pvp.md §5.4 table.
 *
 * Card ids must match `CARD_DEFS` in js/data.js exactly (strike, defend,
 * heavySlash, ...). js/data.js is a browser <script> global, not a Node
 * module (no module.exports, no package.json in js/), so it can't be
 * `require()`-d from the server as-is -- this list is a manually
 * synced copy of just the ids+counts needed for the seed. If card ids in
 * js/data.js ever change, this list needs a matching update.
 */
const { CARD_ID_SET, MAX_COPIES_PER_CARD } = require('./cardCatalog');

const STARTER_DECK_SLOT1 = {
  strike: 3,
  defend: 3,
  heavySlash: 2,
  twinStrike: 2,
  piercingStrike: 2,
  execute: 1,
  recklessSwing: 1,
  quickGuard: 2,
  secondWind: 2,
  adrenaline: 1,
  fortify: 2,
  ironSkin: 1,
  bloodlust: 1,
  hoarder: 1,
};

const STARTER_DECK_TOTAL = Object.values(STARTER_DECK_SLOT1).reduce((a, b) => a + b, 0);
if (STARTER_DECK_TOTAL !== 24) {
  // Fail loudly at require-time rather than silently seeding a wrong deck.
  throw new Error(`STARTER_DECK_SLOT1 must total 24 cards per spec §5.4, got ${STARTER_DECK_TOTAL}`);
}

// Same fail-loudly-at-startup principle for the deck-composition rules
// (spec §5.2) that also apply to routes/decks.js's PUT validation -- a
// starter deck that would itself be rejected by the deck editor's own rules
// is a bug, not just a data-entry typo.
for (const [cardId, count] of Object.entries(STARTER_DECK_SLOT1)) {
  if (!CARD_ID_SET.has(cardId)) {
    throw new Error(`STARTER_DECK_SLOT1 references unknown card id "${cardId}"`);
  }
  if (count > MAX_COPIES_PER_CARD) {
    throw new Error(`STARTER_DECK_SLOT1 has ${count}x "${cardId}", exceeds max ${MAX_COPIES_PER_CARD} copies (spec §5.2)`);
  }
}

const STARTER_DECK_NAME = '스타터 덱';

module.exports = { STARTER_DECK_SLOT1, STARTER_DECK_NAME, STARTER_DECK_TOTAL };
