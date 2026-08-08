/* ARCANE LEDGER — static game data
 * Card / enemy / dungeon definitions taken directly from docs/design/gdd-arcane-ledger.md
 * (numbers must match the GDD exactly — do not tune here).
 */

// ---- Cards -----------------------------------------------------------
// type: 'attack' | 'skill' | 'power'
// target: 'enemy' (needs a target click) | 'self' (resolves immediately)
const CARD_DEFS = {
  // Starting cards (section 6.1)
  strike: {
    id: 'strike', name: 'Strike', cost: 1, type: 'attack', target: 'enemy',
    text: '6 데미지',
  },
  defend: {
    id: 'defend', name: 'Defend', cost: 1, type: 'skill', target: 'self',
    text: '방어도 5 획득',
  },

  // Reward pool — Attack (5) (section 6.2)
  heavySlash: {
    id: 'heavySlash', name: 'Heavy Slash', cost: 2, type: 'attack', target: 'enemy',
    text: '14 데미지',
  },
  twinStrike: {
    id: 'twinStrike', name: 'Twin Strike', cost: 1, type: 'attack', target: 'enemy',
    text: '4 데미지 × 2회',
  },
  piercingStrike: {
    id: 'piercingStrike', name: 'Piercing Strike', cost: 2, type: 'attack', target: 'enemy',
    text: '10 데미지, 적 방어도 무시',
  },
  execute: {
    id: 'execute', name: 'Execute', cost: 2, type: 'attack', target: 'enemy',
    text: '10 데미지, 적 HP 30% 이하면 +10 추가',
  },
  recklessSwing: {
    id: 'recklessSwing', name: 'Reckless Swing', cost: 1, type: 'attack', target: 'enemy',
    text: '12 데미지, 자신도 3 데미지 받음',
  },

  // Reward pool — Skill (4)
  quickGuard: {
    id: 'quickGuard', name: 'Quick Guard', cost: 0, type: 'skill', target: 'self',
    text: '방어도 4 획득, 카드 1장 드로우',
  },
  secondWind: {
    id: 'secondWind', name: 'Second Wind', cost: 1, type: 'skill', target: 'self',
    text: 'HP 6 회복',
  },
  adrenaline: {
    id: 'adrenaline', name: 'Adrenaline', cost: 1, type: 'skill', target: 'self',
    text: '카드 2장 드로우',
  },
  fortify: {
    id: 'fortify', name: 'Fortify', cost: 2, type: 'skill', target: 'self',
    text: '방어도 10 획득',
  },

  // Reward pool — Power (3, permanent for the run)
  ironSkin: {
    id: 'ironSkin', name: 'Iron Skin', cost: 1, type: 'power', target: 'self',
    text: '이후 Skill 카드 플레이 시마다 방어도 +2 (영구)',
  },
  bloodlust: {
    id: 'bloodlust', name: 'Bloodlust', cost: 1, type: 'power', target: 'self',
    text: '이후 Attack 카드 플레이 시마다 데미지 +2 (영구)',
  },
  hoarder: {
    id: 'hoarder', name: 'Hoarder', cost: 2, type: 'power', target: 'self',
    text: '매 턴 시작 시 카드 1장 추가 드로우 (영구)',
  },
};

// Default deck used by both sides until Phase 3's deck-slot persistence
// (docs/design/spec-online-pvp.md §5) exists. Once deck selection (§6.1)
// lands, `startMatch()` will take the locally-selected deck as a parameter
// instead of always falling back to this.
const STARTER_DECK = ['strike', 'strike', 'strike', 'strike', 'defend', 'defend', 'defend', 'defend'];

// PvP spec §5.1: the full 14-card pool is open from the start (no more
// separate STARTER_DECK/REWARD_POOL "unlock" distinction). REWARD_POOL is
// kept only as the source list for the deck editor's card pool (Phase 3).
const REWARD_POOL = [
  'heavySlash', 'twinStrike', 'piercingStrike', 'execute', 'recklessSwing',
  'quickGuard', 'secondWind', 'adrenaline', 'fortify',
  'ironSkin', 'bloodlust', 'hoarder',
];

// ---- Expansion pool (docs/design/card-shop-currency-proposal.md §4) ------
// Phase 3 of the card-shop-currency milestone: the 8-card "expansion pool",
// kept as its own object -- deliberately NOT merged into CARD_DEFS -- because
// ownership rules differ between the two pools (§2.2): every CARD_DEFS entry
// is free/unlimited for every account (spec-online-pvp.md §5.1, unchanged),
// while an expansion card can only be put in a deck up to the number of
// copies the account owns (`accounts.expansion_cards`, server/migrations/
// 003_add_ink_and_expansion_cards.sql) -- there is currently no way to own
// any (no shop/pull endpoint yet, Phase 4), so today every account's
// deck-building view of this pool is "0 owned, all locked" until that phase
// ships. Same {id,name,cost,type,target,text} shape as CARD_DEFS so every
// existing card-rendering helper works against either pool via
// cardDefById() below.
//
// All 8 are built around the new Weaken status effect (js/state.js
// §3/applyWeaken/applyWeakenToDamage) -- see the design doc §4's table for
// the exact effect text and design rationale per card. §4.2 of that doc
// requires every card here that targets the opponent to be `type: 'attack'`
// (never `target: 'enemy'` Skill/Power) so spec §6.3.1's first-turn
// attack-lock keeps working unmodified against the expansion pool too --
// Enfeeble (0 damage) is deliberately `type: 'attack'` for exactly this
// reason, not a data error.
const EXPANSION_CARD_DEFS = {
  enfeeble: {
    id: 'enfeeble', name: 'Enfeeble', cost: 1, type: 'attack', target: 'enemy',
    text: '0 데미지, 상대에게 약화 2 부여',
  },
  cripplingBlow: {
    id: 'cripplingBlow', name: 'Crippling Blow', cost: 2, type: 'attack', target: 'enemy',
    text: '8 데미지, 상대에게 약화 1 부여',
  },
  exploitWeakness: {
    id: 'exploitWeakness', name: 'Exploit Weakness', cost: 2, type: 'attack', target: 'enemy',
    text: '8 데미지, 상대가 이미 약화 상태면 16 데미지',
  },
  overextend: {
    id: 'overextend', name: 'Overextend', cost: 1, type: 'attack', target: 'enemy',
    text: '10 데미지, 자신에게 약화 2 부여',
  },
  steadyBreath: {
    id: 'steadyBreath', name: 'Steady Breath', cost: 1, type: 'skill', target: 'self',
    text: '자신의 약화 스택을 전부 제거, 방어도 3 획득',
  },
  corrosiveAura: {
    id: 'corrosiveAura', name: 'Corrosive Aura', cost: 2, type: 'power', target: 'self',
    text: '이후 Attack 카드로 데미지를 줄 때마다 상대에게 약화 1 부여 (영구)',
  },
  crushingCurse: {
    id: 'crushingCurse', name: 'Crushing Curse', cost: 2, type: 'attack', target: 'enemy',
    text: '4 데미지, 상대에게 약화 3 부여',
  },
  opportunist: {
    id: 'opportunist', name: 'Opportunist', cost: 1, type: 'skill', target: 'self',
    text: '카드 1장 드로우, 상대가 약화 상태면 카드 1장 추가 드로우',
  },
};

// Source list for the deck editor's expansion-pool tiles (mirrors
// REWARD_POOL's role for the core pool) and for anything that needs "just
// the ids" without walking EXPANSION_CARD_DEFS's own key order.
const EXPANSION_POOL = [
  'enfeeble', 'cripplingBlow', 'exploitWeakness', 'overextend',
  'steadyBreath', 'corrosiveAura', 'crushingCurse', 'opportunist',
];

// Single shared lookup across BOTH pools -- js/state.js's cardById() and
// js/deck.js's pool/deck-list rendering all use this instead of each
// re-deriving their own `CARD_DEFS[id] || EXPANSION_CARD_DEFS[id]` fallback
// (and risking the two drifting apart if a third pool is ever added).
function cardDefById(id) { return CARD_DEFS[id] || EXPANSION_CARD_DEFS[id]; }

// NOTE: ENEMY_DEFS (scripted AI pattern data) and ROOM_SEQUENCE (dungeon-run
// room list) were removed here — docs/design/spec-online-pvp.md §2 kills
// both explicitly ("적(enemy) 스크립트 패턴 시스템", "던전 런 구조"). The
// opponent is now a real player (js/state.js's mirrored player state +
// applyRemoteAction), not a fixed pattern; the match is a standalone single
// battle, not a room sequence. See online-pvp-plan.md task 2.4.

// PLAYER_START (spec §7.1): applies identically to both sides of a match —
// there is no more an "enemy-only" stat block, so this is the single source
// of truth for HP/mana/draw for player and opponent alike.
const PLAYER_START = {
  maxHp: 50,
  maxMana: 3,
  drawPerTurn: 5,
};
