/* Canonical list of valid card ids for PvP deck-building (spec §5.1: all 14
 * core `CARD_DEFS` entries are open from the start, no unlocks) plus the
 * numeric deck-building rules from spec §5.2.
 *
 * Centralized here (rather than letting each consumer keep its own copy) so
 * `starterDeck.js`'s seed list and `routes/decks.js`'s validation can't drift
 * apart from EACH OTHER. They can still drift from the real source of truth,
 * `js/data.js`'s `CARD_DEFS`/`EXPANSION_CARD_DEFS` -- that file is a browser
 * <script> global with no package.json/module system, so it can't be
 * `require()`-d from Node (see the same note already in starterDeck.js). If
 * a card id is ever added, renamed, or removed in js/data.js, this list
 * needs a matching manual update.
 *
 * ---- Expansion pool (docs/design/card-shop-currency-proposal.md §4, Phase
 * 3 of the card-shop-currency milestone) ----
 * `EXPANSION_CARD_IDS` is kept as its own list, separate from
 * `CORE_CARD_IDS`, NOT because expansion ids are somehow less "valid" (they
 * ARE real, playable card ids, so `isValidCardId`/`CARD_ID_SET` below
 * include both) -- but because the two pools are subject to a DIFFERENT
 * deck-building rule (§2.2/§7): core cards are free/unlimited for every
 * account (spec §5.1, unchanged), while an expansion card can only be put in
 * a deck up to how many copies the account actually owns
 * (`accounts.expansion_cards`, migrations/003_add_ink_and_expansion_cards.
 * sql). `routes/decks.js`'s validateCards() needs to know which of the two
 * rules applies to a given card id, which is exactly what
 * `isExpansionCardId()` below answers -- keeping the ownership check itself
 * out of this file (this file has no DB access; it's pure static data).
 */
const CORE_CARD_IDS = [
  'strike', 'defend', 'heavySlash', 'twinStrike', 'piercingStrike', 'execute',
  'recklessSwing', 'quickGuard', 'secondWind', 'adrenaline', 'fortify',
  'ironSkin', 'bloodlust', 'hoarder',
];

const EXPANSION_CARD_IDS = [
  'enfeeble', 'cripplingBlow', 'exploitWeakness', 'overextend',
  'steadyBreath', 'corrosiveAura', 'crushingCurse', 'opportunist',
];

// All 22 real card ids across both pools -- this is what "does this card id
// exist at all" (isValidCardId) checks against. Existence is NOT the same
// question as ownership -- see EXPANSION_CARD_ID_SET/isExpansionCardId below
// for the ownership-relevant check routes/decks.js layers on top.
const CARD_IDS = [...CORE_CARD_IDS, ...EXPANSION_CARD_IDS];

const CARD_ID_SET = new Set(CARD_IDS);
const CORE_CARD_ID_SET = new Set(CORE_CARD_IDS);
const EXPANSION_CARD_ID_SET = new Set(EXPANSION_CARD_IDS);

// spec §5.2
const DECK_MIN_SIZE = 20;
const DECK_MAX_SIZE = 30;
const MAX_COPIES_PER_CARD = 3;

function isValidCardId(id) {
  return CARD_ID_SET.has(id);
}

function isExpansionCardId(id) {
  return EXPANSION_CARD_ID_SET.has(id);
}

module.exports = {
  CARD_IDS,
  CORE_CARD_IDS,
  EXPANSION_CARD_IDS,
  CARD_ID_SET,
  CORE_CARD_ID_SET,
  EXPANSION_CARD_ID_SET,
  DECK_MIN_SIZE,
  DECK_MAX_SIZE,
  MAX_COPIES_PER_CARD,
  isValidCardId,
  isExpansionCardId,
};
