/* Canonical list of valid card ids for PvP deck-building (spec §5.1: all 14
 * `CARD_DEFS` entries are open from the start, no unlocks) plus the numeric
 * deck-building rules from spec §5.2.
 *
 * Centralized here (rather than letting each consumer keep its own copy) so
 * `starterDeck.js`'s seed list and `routes/decks.js`'s validation can't drift
 * apart from EACH OTHER. They can still drift from the real source of truth,
 * `js/data.js`'s `CARD_DEFS` -- that file is a browser <script> global with
 * no package.json/module system, so it can't be `require()`-d from Node (see
 * the same note already in starterDeck.js). If a card id is ever added,
 * renamed, or removed in js/data.js, this list needs a matching manual
 * update. Chose one shared file over duplicating the id list a second time
 * inside routes/decks.js, which is the more likely place for the two lists
 * to silently drift if kept separate.
 */
const CARD_IDS = [
  'strike', 'defend', 'heavySlash', 'twinStrike', 'piercingStrike', 'execute',
  'recklessSwing', 'quickGuard', 'secondWind', 'adrenaline', 'fortify',
  'ironSkin', 'bloodlust', 'hoarder',
];

const CARD_ID_SET = new Set(CARD_IDS);

// spec §5.2
const DECK_MIN_SIZE = 20;
const DECK_MAX_SIZE = 30;
const MAX_COPIES_PER_CARD = 3;

function isValidCardId(id) {
  return CARD_ID_SET.has(id);
}

module.exports = {
  CARD_IDS,
  CARD_ID_SET,
  DECK_MIN_SIZE,
  DECK_MAX_SIZE,
  MAX_COPIES_PER_CARD,
  isValidCardId,
};
