/* ARCANE LEDGER — game state and rules engine.
 * Pure logic; UI (ui.js) reads this state and re-renders after every mutation.
 *
 * ---- PvP restructure (online-pvp-plan.md task 2.4, spec-online-pvp.md) ----
 * The opponent used to be a scripted-AI-pattern shape (`state.enemy`, driven
 * by `ENEMY_DEFS`/`runEnemyTurn()`'s fixed attack/block cycle). Real PvP
 * means the opponent is a second human player, so `state.opponent` is now
 * built from the SAME `createPlayerState()` factory as `state.player` —
 * both sides are structurally symmetric (spec §7.1: PLAYER_START mirrored
 * for both). `runEnemyTurn()` is gone; `applyRemoteAction()` is the new
 * seam a future networking module (Phase 2.1-2.3's relay) will call into
 * with whatever the opponent's client reports it did. Nothing in this file
 * opens a socket or knows about the wire format — that's deliberately left
 * for the phase that actually wires the relay in.
 *
 * ---- Hidden information / RNG authority (spec §6.3 step 2) ----
 * This client is the sole authority over ITS OWN deck: it shuffles and
 * draws from `state.player`'s piles locally, using real card ids. It never
 * has (and must never fabricate) the opponent's actual deck contents or
 * shuffle order — a client computing or syncing the opponent's deck is
 * exactly the desync risk flagged in the plan. So `state.opponent`'s
 * drawPile/hand/discardPile/masterDeck arrays never hold real card ids;
 * they hold the `HIDDEN` sentinel. `.length` on those arrays is still real
 * (deck/discard/hand counts are public per spec §7.2), but the *contents*
 * are unknown to this client until a card is actually played, at which
 * point the network message that plays it (future work) carries the real
 * `cardId` and `applyRemoteCardPlay()` runs the identical effect logic used
 * for the local player. `drawCards()` is the single function used for both
 * sides' draws; it only calls the real `shuffle()` (Math.random-based, and
 * therefore only ever meaningful as a LOCAL presentation-order concern) for
 * `state.player`'s own pile — the opponent's hidden pile is "reshuffled" by
 * plain concatenation, since there is no order to preserve for cards whose
 * identities are already unknown.
 *
 * ---- Kept from the single-player engine, unchanged ----
 *  - Block persists through the opponent's turn and resets at the start of
 *    this side's OWN next turn (before the draw phase) — spec §7.1.
 *  - Power cards exhaust (leave the deck permanently) the instant they are
 *    played; their effect is already permanent for the match.
 *  - Bloodlust/Iron Skin trigger once per card played (not once per hit).
 *  - A side's deck is shuffled at match start and whenever its draw pile
 *    empties mid-draw.
 */

const AL = (() => {
  // Sentinel for "a card is here but this client does not know its
  // identity" — used for every array slot on `state.opponent` until that
  // specific card is revealed by being played. See file header.
  const HIDDEN = null;

  function createPlayerState() {
    return {
      name: null, // display name (spec §4.1) — filled in by the lobby/match-start flow (Phase 4), not this task
      hp: PLAYER_START.maxHp,
      maxHp: PLAYER_START.maxHp,
      mana: PLAYER_START.maxMana,
      maxMana: PLAYER_START.maxMana,
      block: 0,
      powers: { ironSkin: 0, bloodlust: 0, hoarder: 0 },
      masterDeck: [],
      drawPile: [],
      hand: [],
      // Parallel to `hand`: a stable per-instance key for each card
      // currently in hand (index-matched), used by ui.js for keyed DOM
      // reconciliation. Present on both sides for shape symmetry, though
      // only the local player's hand is actually rendered card-by-card
      // today (the opponent's is shown as a count, per spec §7.2).
      handKeys: [],
      discardPile: [],
      exhaustPile: [],
    };
  }

  const state = {
    screen: 'start', // start | howto | battle | victory | defeat
    player: createPlayerState(),
    opponent: createPlayerState(),
    turn: 'player', // 'player' | 'opponent' — whose turn is currently active (spec §7.2: strict alternation, no simultaneous actions)
    selected: null, // index into player.hand of the card awaiting a target
    turnBusy: false, // true while a turn-boundary action is resolving (input locked)
    matchResult: null, // null | 'win' | 'loss' — set on match end; win_forfeit (spec §6.4) is future work (disconnect handling, Phase 2.7/4.7)
    // How-to-play overlay (docs/design/onboarding.md): 'first' = shown once
    // automatically before the first battle; 'reopen' = opened via the ?
    // button mid-match and must return to whatever screen was behind it.
    howtoContext: null,
    howtoReturnScreen: 'battle',
  };

  let handKeyCounter = 0;
  function nextHandKey() { return 'c' + (handKeyCounter++); }

  const listeners = [];
  function onChange(fn) { listeners.push(fn); }
  function emit() { listeners.forEach((fn) => fn(state)); }

  // Lightweight event bus for transient visual feedback (damage numbers,
  // shake, heal pop) that ui.js listens to separately from full re-renders.
  const fxListeners = [];
  function onFx(fn) { fxListeners.push(fn); }
  function fx(name, payload) { fxListeners.forEach((f) => f(name, payload)); }

  function sideOf(sideState) { return sideState === state.player ? 'player' : 'opponent'; }

  // Real, local-only shuffle. Only ever called on state.player's own pile —
  // see the RNG-authority note in the file header. Unseeded Math.random()
  // is fine here precisely BECAUSE it's never used to keep two clients in
  // sync: each client only ever shuffles the deck it is itself authoritative
  // over.
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Single draw function for both sides. For state.player, empties the
  // discard pile back into the draw pile with a real shuffle. For
  // state.opponent, does the same but WITHOUT shuffling — there is no
  // ordering to preserve among HIDDEN placeholders, and calling shuffle()
  // on the opponent's pile would be a pointless RNG call that could invite
  // exactly the "client computes opponent's shuffle" mistake this refactor
  // is meant to rule out.
  function drawCards(sideState, n) {
    for (let i = 0; i < n; i++) {
      if (sideState.drawPile.length === 0) {
        if (sideState.discardPile.length === 0) return; // deck fully exhausted, nothing left to draw (spec §6.4: not a loss condition)
        const reclaimed = sideState.discardPile.splice(0);
        sideState.drawPile = sideState === state.player ? shuffle(reclaimed) : reclaimed;
      }
      sideState.hand.push(sideState.drawPile.pop());
      sideState.handKeys.push(nextHandKey());
    }
  }

  // ---- Match lifecycle ----------------------------------------------------
  // Replaces the old startRun()/enterRoom()/startCombat() dungeon-room flow
  // (spec §2: dungeon-run structure removed entirely — a match is one
  // standalone battle, not a room sequence).
  //
  // opts:
  //   deck           — this client's own card-id list (defaults to
  //                    STARTER_DECK until Phase 3's deck slots exist)
  //   isFirstPlayer  — result of the coin flip (spec §6.3 step 1). Left
  //                    undefined here defaults to a local coin flip, which
  //                    is a TEMPORARY stand-in for solo smoke-testing only —
  //                    Phase 4.6 replaces this with the relay's authoritative
  //                    result once two real clients exist.
  //   opponentName   — display name to show for the opponent (spec §7.2);
  //                    left null until the lobby (Phase 4.5) supplies it.
  //   opponentDeckSize — how many cards are in the opponent's deck, so the
  //                    public deck-count UI (spec §7.2) has a real number to
  //                    show. Defaults to the same size as `deck` as a stand-in
  //                    until match-start metadata carries the real value.
  function startMatch(opts) {
    opts = opts || {};
    const deck = (opts.deck && opts.deck.length ? opts.deck : STARTER_DECK).slice();
    const opponentDeckSize = opts.opponentDeckSize || deck.length;
    const isFirstPlayer = typeof opts.isFirstPlayer === 'boolean'
      ? opts.isFirstPlayer
      : Math.random() < 0.5; // TEMP local coin flip — see opts doc above

    state.player = createPlayerState();
    state.opponent = createPlayerState();
    state.opponent.name = opts.opponentName || null;

    // RNG/shuffle authority (spec §6.3 step 2): shuffle only the local
    // player's real deck. The opponent's piles are seeded with HIDDEN
    // placeholders — never real card ids, never shuffled here.
    state.player.masterDeck = deck.slice();
    state.player.drawPile = shuffle(state.player.masterDeck.slice());

    const opponentPlaceholders = new Array(opponentDeckSize).fill(HIDDEN);
    state.opponent.masterDeck = opponentPlaceholders.slice();
    state.opponent.drawPile = opponentPlaceholders.slice();

    state.turn = isFirstPlayer ? 'player' : 'opponent';
    state.selected = null;
    state.turnBusy = false;
    state.matchResult = null;
    handKeyCounter = 0;

    // First-turn asymmetry (spec §6.3 step 3): first player draws 5, second
    // player draws 6.
    drawCards(state.player, isFirstPlayer ? 5 : 6);
    drawCards(state.opponent, isFirstPlayer ? 6 : 5);

    // Show the "How to Play" overlay once, before the first battle
    // (docs/design/onboarding.md section 2). closeHowto() reveals the
    // already-fully-set-up battle screen once dismissed.
    state.howtoContext = 'first';
    state.screen = 'howto';
    emit();
  }

  function openHowto() {
    if (state.screen === 'howto') return;
    state.howtoReturnScreen = state.screen;
    state.howtoContext = 'reopen';
    state.selected = null;
    state.screen = 'howto';
    emit();
  }

  function closeHowto() {
    const wasFirst = state.howtoContext === 'first';
    state.howtoContext = null;
    state.screen = wasFirst ? 'battle' : (state.howtoReturnScreen || 'battle');
    emit();
  }

  function cardById(id) { return CARD_DEFS[id]; }

  // ---- Local player's turn -------------------------------------------------
  function canPlay(handIndex) {
    const cardId = state.player.hand[handIndex];
    if (!cardId) return false;
    const card = cardById(cardId);
    return state.turn === 'player' && !state.turnBusy && state.player.mana >= card.cost;
  }

  // True if at least one card left in hand is affordable right now. Used to
  // decide whether to auto-end the turn — checking "mana === 0" directly
  // would be wrong, since a 0-cost card (Quick Guard) is still playable
  // with empty mana.
  function hasPlayableCard() {
    return state.player.hand.some((_, i) => canPlay(i));
  }

  // Called after a card finishes resolving: if nothing left in hand can be
  // afforded, end the turn automatically after a short beat so the player
  // can register what the last card did. Skipped entirely if resolveCard's
  // effect already moved the game past this turn (match won/lost).
  function maybeAutoEndTurn() {
    if (state.screen !== 'battle' || state.turn !== 'player') return;
    if (hasPlayableCard()) return;
    setTimeout(() => {
      // Re-validate: the player could have reopened How to Play, or the
      // window could already be mid-opponent-turn, during this delay.
      if (state.screen !== 'battle' || state.turn !== 'player') return;
      if (hasPlayableCard()) return;
      endTurn();
    }, 500);
  }

  // Called by UI when a hand card is clicked.
  function selectCard(handIndex) {
    if (state.turn !== 'player' || state.turnBusy) return;
    const cardId = state.player.hand[handIndex];
    if (!cardId) return;
    const card = cardById(cardId);
    if (state.player.mana < card.cost) { emit(); return; }

    if (state.selected === handIndex) {
      state.selected = null; // toggle off
      emit();
      return;
    }

    if (card.target === 'self') {
      resolveCard(handIndex);
    } else {
      state.selected = handIndex; // await opponent click
      emit();
    }
  }

  // Called by UI when the opponent panel is clicked (only meaningful while a
  // targeted card is selected).
  function targetOpponent() {
    if (state.turn !== 'player' || state.turnBusy) return;
    if (state.selected === null) return;
    resolveCard(state.selected);
  }

  function resolveCard(handIndex) {
    if (state.turn !== 'player') return;
    const cardId = state.player.hand[handIndex];
    const card = cardById(cardId);
    if (!card || state.player.mana < card.cost) return;

    state.player.mana -= card.cost;
    state.player.hand.splice(handIndex, 1);
    state.player.handKeys.splice(handIndex, 1);
    state.selected = null;

    applyCardEffect(card, state.player, state.opponent);

    if (card.type === 'power') {
      state.player.exhaustPile.push(cardId);
      // Power's physical card is used up permanently for the rest of the match.
      const idx = state.player.masterDeck.indexOf(cardId);
      if (idx !== -1) state.player.masterDeck.splice(idx, 1);
    } else {
      state.player.discardPile.push(cardId);
    }

    if (state.opponent.hp <= 0) { winMatch(); return; }
    if (state.player.hp <= 0) { loseMatch(); return; }
    emit();
    maybeAutoEndTurn();
    // NOTE: sending this play to the relay (so the opponent's client can
    // reveal it) is future networking work — see applyRemoteAction below.
  }

  function endTurn() {
    if (state.turnBusy || state.turn !== 'player') return;
    state.selected = null;
    state.player.discardPile.push(...state.player.hand);
    state.player.hand = [];
    state.player.handKeys = [];
    state.turnBusy = true;
    state.turn = 'opponent';
    emit();
    // NOTE: In the wired build, this is where the local "end turn" action
    // gets sent to the relay instead of just flipping state.turn locally.
    // Nothing here drives the opponent's turn forward — that only happens
    // once applyRemoteAction() below is actually fed real network messages
    // (Phase 2.1-2.3 relay + Phase 4.7 integration).
  }

  // ---- Shared card-effect resolution ---------------------------------------
  // Used by BOTH resolveCard (local player acts) and applyRemoteCardPlay
  // (opponent acts, per a received network action) — the effect math is
  // identical either way, only which side is "actor" vs "target" differs.
  function dealDamage(target, amount, ignoreBlock) {
    let remaining = amount;
    if (!ignoreBlock && target.block > 0) {
      const absorbed = Math.min(target.block, remaining);
      target.block -= absorbed;
      remaining -= absorbed;
    }
    target.hp = Math.max(0, target.hp - remaining);
    return remaining;
  }

  function applyDamage(target, amount, ignoreBlock) {
    const dealt = dealDamage(target, amount, ignoreBlock);
    const blocked = amount - dealt;
    fx('damage', { side: sideOf(target), amount: dealt, blocked });
    return dealt;
  }

  function applyBlock(actor, amount) {
    actor.block += amount;
    fx('block', { side: sideOf(actor), amount });
  }

  function attackBonus(actor) { return actor.powers.bloodlust * 2; }
  function skillBonus(actor) { return actor.powers.ironSkin * 2; }

  function applyCardEffect(card, actor, target) {
    switch (card.id) {
      case 'strike':
        applyDamage(target, 6 + attackBonus(actor), false);
        break;
      case 'defend':
        applyBlock(actor, 5 + skillBonus(actor));
        break;
      case 'heavySlash':
        applyDamage(target, 14 + attackBonus(actor), false);
        break;
      case 'twinStrike':
        applyDamage(target, 4 + attackBonus(actor), false);
        if (target.hp > 0) applyDamage(target, 4, false);
        break;
      case 'piercingStrike':
        applyDamage(target, 10 + attackBonus(actor), true);
        break;
      case 'execute': {
        const bonus = (target.hp / target.maxHp) <= 0.3 ? 10 : 0;
        applyDamage(target, 10 + bonus + attackBonus(actor), false);
        break;
      }
      case 'recklessSwing':
        applyDamage(target, 12 + attackBonus(actor), false);
        actor.hp = Math.max(0, actor.hp - 3); // self damage bypasses block
        fx('damage', { side: sideOf(actor), amount: 3, selfInflicted: true });
        break;
      case 'quickGuard':
        applyBlock(actor, 4 + skillBonus(actor));
        drawCards(actor, 1);
        break;
      case 'secondWind':
        actor.hp = Math.min(actor.maxHp, actor.hp + 6);
        fx('heal', { side: sideOf(actor), amount: 6 });
        if (skillBonus(actor) > 0) applyBlock(actor, skillBonus(actor));
        break;
      case 'adrenaline':
        drawCards(actor, 2);
        if (skillBonus(actor) > 0) applyBlock(actor, skillBonus(actor));
        break;
      case 'fortify':
        applyBlock(actor, 10 + skillBonus(actor));
        break;
      case 'ironSkin':
        actor.powers.ironSkin += 1;
        break;
      case 'bloodlust':
        actor.powers.bloodlust += 1;
        break;
      case 'hoarder':
        actor.powers.hoarder += 1;
        break;
      default:
        break;
    }
  }

  // ---- Remote (opponent) actions --------------------------------------------
  // This is the replacement for the old runEnemyTurn() scripted-AI step.
  // applyRemoteAction() is the single seam a future networking module calls
  // into once the relay (online-pvp-plan.md 2.1-2.3) actually exists — it
  // takes an already-parsed action object (never a raw socket message) and
  // mutates local state exactly the way the equivalent local player action
  // would. Nothing in this file sends or receives anything over a network.
  //
  // Supported action shapes:
  //   { type: 'turnStart', drawCount }
  //     Opponent's turn begins: block/mana reset, draw `drawCount` cards
  //     (their own client already knows the correct count — including any
  //     Hoarder bonus — so this client just mirrors the reported number
  //     rather than re-deriving it, per the RNG-authority principle: never
  //     independently compute a fact the other side already owns).
  //   { type: 'playCard', cardId }
  //     Opponent played a card — this is the moment its identity is
  //     revealed (spec §7.2: hand is hidden, played cards are not).
  //   { type: 'endTurn' }
  //     Opponent ended their turn: remaining (still-hidden) hand discards,
  //     turn passes back to the local player.
  //
  // Deliberately NOT implemented here (later phases, once the relay exists):
  //   - actually receiving these over a WebSocket (2.1-2.3)
  //   - server-enforced turn-timer timeout forcing an end turn (2.5, §7.3)
  //   - disconnect/forfeit actions (2.7, §8)
  function applyRemoteAction(action) {
    if (!action || state.screen !== 'battle') return;
    switch (action.type) {
      case 'turnStart': applyRemoteTurnStart(action.drawCount); break;
      case 'playCard': applyRemoteCardPlay(action.cardId); break;
      case 'endTurn': applyRemoteEndTurn(); break;
      default: break;
    }
  }

  function applyRemoteTurnStart(drawCount) {
    const n = typeof drawCount === 'number'
      ? drawCount
      : PLAYER_START.drawPerTurn + state.opponent.powers.hoarder; // fallback only — see doc comment above
    state.opponent.block = 0;
    state.opponent.mana = state.opponent.maxMana;
    state.turn = 'opponent';
    state.turnBusy = false;
    drawCards(state.opponent, n);
    emit();
  }

  function applyRemoteCardPlay(cardId) {
    if (state.turn !== 'opponent') return;
    const card = cardById(cardId);
    if (!card || state.opponent.hand.length === 0) return;

    state.opponent.mana = Math.max(0, state.opponent.mana - card.cost);
    state.opponent.hand.pop(); // identity of the removed slot is irrelevant — it was HIDDEN either way
    state.opponent.handKeys.pop();

    if (card.type === 'power') {
      state.opponent.exhaustPile.push(HIDDEN);
    } else {
      state.opponent.discardPile.push(HIDDEN);
    }

    applyCardEffect(card, state.opponent, state.player);

    // Same check order as resolveCard() (opponent-defeated before
    // self-defeated) — arbitrary but kept consistent between the two paths.
    if (state.opponent.hp <= 0) { winMatch(); return; }
    if (state.player.hp <= 0) { loseMatch(); return; }
    emit();
  }

  function applyRemoteEndTurn() {
    state.opponent.discardPile.push(...state.opponent.hand.map(() => HIDDEN));
    state.opponent.hand = [];
    state.opponent.handKeys = [];
    localTurnStart();
  }

  // Local player's turn starting again after the opponent ends theirs
  // (mirrors the old playerTurnStart()).
  function localTurnStart() {
    state.player.block = 0;
    state.player.mana = state.player.maxMana;
    state.selected = null;
    state.turn = 'player';
    state.turnBusy = false;
    drawCards(state.player, PLAYER_START.drawPerTurn + state.player.powers.hoarder);
    emit();
  }

  // ---- Match end ------------------------------------------------------------
  function winMatch() {
    state.turnBusy = false;
    state.matchResult = 'win';
    state.screen = 'victory';
    emit();
  }

  function loseMatch() {
    state.turnBusy = false;
    state.matchResult = 'loss';
    state.screen = 'defeat';
    emit();
  }

  return {
    state,
    onChange,
    onFx,
    startMatch,
    openHowto,
    closeHowto,
    selectCard,
    targetOpponent,
    endTurn,
    applyRemoteAction,
    canPlay,
    cardById,
  };
})();
