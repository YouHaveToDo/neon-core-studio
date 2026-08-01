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
