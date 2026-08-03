/* ARCANE LEDGER — game state and rules engine.
 * Pure logic; UI (ui.js) reads this state and re-renders after every mutation.
 *
 * ---- PvP restructure (online-pvp-plan.md task 2.4, spec-online-pvp.md) ----
 * The opponent used to be a scripted-AI-pattern shape (`state.enemy`, driven
 * by `ENEMY_DEFS`/`runEnemyTurn()`'s fixed attack/block cycle). Real PvP
 * means the opponent is a second human player, so `state.opponent` is now
 * built from the SAME `createPlayerState()` factory as `state.player` —
 * both sides are structurally symmetric (spec §7.1: PLAYER_START mirrored
 * for both). `runEnemyTurn()` is gone; `applyRemoteAction()` is the seam
 * js/battle.js (Phase 4.7) calls into with whatever the opponent's client
 * reported it did. Nothing in this file opens a socket or knows about the
 * wire format — js/battle.js owns that translation in both directions: it
 * feeds parsed `{type, ...}` action objects into applyRemoteAction() below,
 * and subscribes to this file's onAction()/onMatchEnd() buses to learn when
 * a LOCAL action (card played, turn ended, our own turn started) needs to be
 * broadcast to the opponent, or when a local win/loss needs reporting to the
 * relay (report_result). This file stays 100% synchronous/local either way —
 * it never awaits a network round-trip for anything.
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
    // True while the match is fully paused because the opponent is
    // disconnected (spec §8.2: "이 배너가 떠 있는 동안 자신의 카드도
    // 선택/플레이 불가"). Set/cleared by js/battle.js in response to the
    // relay's opponent_disconnected/opponent_reconnected/match_ended
    // messages — this file has no socket of its own, so it only exposes the
    // gate (setFrozen) and honors it in every local input entry point below.
    frozen: false,
    matchResult: null, // null | 'win' | 'loss' | 'win_forfeit' | 'void' — set on match end (spec §6.4; 'void' is QA finding #2's simultaneous-double-disconnect no-contest outcome, never locally detected, only ever arrives via endMatchByResult)
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

  // ---- Outgoing network seam (online-pvp-plan.md 4.7) -----------------------
  // This file still never opens a socket (see file header) — but a real PvP
  // match needs to tell the OTHER client what just happened locally, so this
  // is the mirror-image seam of applyRemoteAction() below: every place a
  // LOCAL action changes state.player in a way the opponent's client needs to
  // mirror (resolveCard/endTurn/localTurnStart) also calls emitAction(type,
  // payload) here. js/battle.js is the only subscriber — it wraps whatever
  // arrives into a wire `action` message and sends it over Net. The three
  // action types emitted below are exactly the three applyRemoteAction()
  // understands (playCard/endTurn/turnStart), so the two clients' state
  // machines stay in lockstep without this file ever knowing a network
  // exists. Named emitAction (not just `action`) specifically to avoid
  // shadowing applyRemoteAction()'s own `action` parameter below.
  const actionListeners = [];
  function onAction(fn) { actionListeners.push(fn); }
  function emitAction(type, payload) { actionListeners.forEach((f) => f(type, payload || {})); }

  // ---- Match-end network seam ------------------------------------------------
  // Fired ONLY by winMatch()/loseMatch() below (i.e. only when THIS client is
  // the one that just locally detected the match is over by HP reaching 0 —
  // spec §6.4's "즉시 판정" rule). js/battle.js listens for this to send
  // report_result to the relay. Deliberately NOT fired by endMatchByResult()
  // (below) — that path handles the match_ended message arriving from the
  // network (opponent's own report, a forfeit, etc.), which must never
  // itself trigger ANOTHER report_result, or two clients could each report
  // a result forever.
  const matchEndListeners = [];
  function onMatchEnd(fn) { matchEndListeners.push(fn); }
  function emitMatchEnd(result) { matchEndListeners.forEach((f) => f(result)); }

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
  //   isFirstPlayer  — result of the coin flip (spec §6.3 step 1). Since
  //                    Phase 4.6, js/match.js always passes this explicitly
  //                    (derived from the relay's TURN_STARTED broadcast --
  //                    never locally guessed, see js/match.js's file header
  //                    for why). Left undefined here still falls back to a
  //                    local Math.random() flip, which now only matters for
  //                    the no-args devtools/"New Run" smoke-test path (see
  //                    js/main.js).
  //   opponentName   — display name to show for the opponent (spec §7.2);
  //                    left null until the lobby (Phase 4.5) supplies it.
  //   opponentDeckSize — how many cards are in the opponent's deck, so the
  //                    public deck-count UI (spec §7.2) has a real number to
  //                    show. Supplied by js/match.js from the relay's real
  //                    opponent.deckSize (room_joined/opponent_joined,
  //                    server/src/ws/protocol.js -- QA finding #3, docs/qa/
  //                    online-pvp-milestone.md). Falls back to this client's
  //                    OWN deck length only as a last resort (e.g. the
  //                    no-args devtools/"New Run" smoke-test path, js/main.js,
  //                    which never goes through the relay at all) -- in any
  //                    real match this is always the server-relayed value.
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
    // Cosmetic only (art-direction.md §8.5 rev.4, spec §9) — which of the 3
    // generic opponent-bust variants ui.js renders. Not gameplay-affecting;
    // defaults to 'a' if the match-start flow (js/match.js) doesn't supply
    // one (e.g. the no-args devtools smoke-test path).
    state.opponent.portraitVariant = opts.opponentPortrait || 'a';

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
    state.frozen = false;
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
    return state.turn === 'player' && !state.turnBusy && !state.frozen && state.player.mana >= card.cost;
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
    if (state.turn !== 'player' || state.turnBusy || state.frozen) return;
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
    if (state.turn !== 'player' || state.turnBusy || state.frozen) return;
    if (state.selected === null) return;
    resolveCard(state.selected);
  }

  function resolveCard(handIndex) {
    if (state.turn !== 'player' || state.frozen) return;
    const cardId = state.player.hand[handIndex];
    const card = cardById(cardId);
    if (!card || state.player.mana < card.cost) return;

    state.player.mana -= card.cost;
    state.player.hand.splice(handIndex, 1);
    state.player.handKeys.splice(handIndex, 1);
    state.selected = null;

    applyCardEffect(card, state.player, state.opponent);
    // Tell the opponent's client what we just played (spec §7.2: a played
    // card is revealed the instant it's played) — always fires, even if the
    // effect below is about to end the match, so the fatal card still shows
    // up on the loser's screen too.
    emitAction('playCard', { cardId });

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
  }

  function endTurn() {
    if (state.turnBusy || state.turn !== 'player' || state.frozen) return;
    state.selected = null;
    state.player.discardPile.push(...state.player.hand);
    state.player.hand = [];
    state.player.handKeys = [];
    state.turnBusy = true;
    state.turn = 'opponent';
    emit();
    // Tell the opponent's client our turn just ended (spec §7.2 strict
    // alternation) — js/battle.js relays this as an `action` message AND, if
    // this was a manual click (not a server-fired timeout, which already
    // advanced the server's own turn clock), also sends `end_turn` to the
    // relay so the server's 24s clock hands off to the opponent. See
    // js/battle.js for exactly which callers do which.
    emitAction('endTurn');
    // Nothing here drives the opponent's turn forward on THIS client — that
    // is a mirrored effect of the OTHER client applying our 'endTurn' action
    // via applyRemoteAction() below, and vice versa when they end theirs.
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

  // ---- Server-authoritative turn reconciliation (QA finding #1 fix) --------
  // docs/qa/online-pvp-milestone.md's Blocker: before this, the ONLY way
  // either side's turn-boundary state (state.turn, hand discard/draw) ever
  // actually advanced was via the peer `action` channel's endTurn/turnStart
  // messages -- which are sent by the ACTIVE player's own client. If that
  // client is frozen/unresponsive, or simply hasn't dismissed its own
  // How-to-Play overlay yet, those messages never arrive, and the relay's
  // server-authoritative turn_started broadcast (which DOES always arrive,
  // independent of the other client's JS ever running -- that's the entire
  // point of server-side timer enforcement, spec §7.3) was only ever used to
  // update the timer's numbers, never the actual game state.
  //
  // js/battle.js calls exactly one of these two functions every time a
  // turn_started message arrives, based on whether the server says it's now
  // THIS client's turn or the opponent's -- regardless of which screen is
  // currently showing (a frozen/slow client isn't going to be looking at the
  // right screen anyway) and regardless of whether the normal peer action
  // for the same boundary has arrived yet. Both are idempotent no-ops if
  // local state already agrees with the server (checked via state.turn),
  // so whichever of "the real peer action" or "this server-driven
  // reconciliation" happens to arrive first for a given turn boundary just
  // wins -- the other is a harmless no-op, no double-discard/double-draw
  // risk (see also localTurnStart()'s own hand.length===0 guard above,
  // which independently protects against a double draw either way).

  // Server says MY turn is starting now. If my own local state doesn't
  // already reflect that, the opponent's real 'endTurn' peer action hasn't
  // reached me yet -- most likely because they're frozen/unresponsive
  // (QA's Repro A). Apply exactly the same transition a real peer endTurn
  // action would (discard my mirrored view of their hand, start my own turn
  // for real) instead of waiting for a message that, in the failure mode
  // this exists to fix, may never come.
  function reconcileMyTurnStart() {
    if (state.turn === 'player') return; // already there -- nothing to reconcile
    applyRemoteEndTurn();
  }

  // Server says it's now the OPPONENT's turn, but my own local state still
  // says it's mine -- most likely because I'm the client whose turn just
  // timed out and I was frozen, or parked on a sub-screen (How-to-Play, QA's
  // Repro B) when the server's turn_timeout/turn_started messages arrived.
  // Force the same local transition a manual End Turn does (cancel any
  // unresolved selection with no mana spent, discard my hand, pass the
  // turn -- spec §7.3) WITHOUT sending another end_turn to the server: it
  // already advanced its own clock when it decided my turn was over, so a
  // second end_turn from me would just bounce off as NOT_YOUR_TURN (see
  // endTurn()'s emitAction, which only ever notifies the OPPONENT's client,
  // never the relay's own turn clock).
  function reconcileOpponentTurnStart() {
    if (state.turn !== 'player') return; // already advanced -- nothing to reconcile
    endTurn();
  }

  // Local player's turn starting again after the opponent ends theirs
  // (mirrors the old playerTurnStart()). Only ever called from
  // applyRemoteEndTurn() above — i.e. this always means "my real turn is
  // genuinely starting right now, because I just heard the opponent end
  // theirs" (turn 1 is the one exception, handled directly by startMatch()'s
  // own draw, which needs no network round-trip — see spec §6.3 step 2).
  function localTurnStart() {
    state.player.block = 0;
    state.player.mana = state.player.maxMana;
    state.selected = null;
    state.turn = 'player';
    state.turnBusy = false;
    // QA finding #1's hand-count corruption (docs/qa/online-pvp-milestone.md:
    // "hand grew from 6 to 11 cards"): the second player's OPENING hand
    // (spec §6.3 step 3's "후공 6장 드로우") is dealt directly into
    // state.player.hand by startMatch() and IS their full turn-1 hand --
    // spec §7.1's draw table is explicit the 6-card opening draw *replaces*
    // the normal 5-per-turn draw for that one turn, it does not stack an
    // additional draw on top. Every OTHER call of localTurnStart() always
    // finds state.player.hand already emptied by this same player's own
    // preceding endTurn() (which discards the full hand before the turn
    // passes) -- so "hand still has cards right now" uniquely identifies
    // this one first-turn case, without needing a separate one-shot flag.
    // Skipping the draw here (rather than skipping the whole function) still
    // correctly performs the turn-start bookkeeping (turn flips, selected
    // clears, turnBusy resets) for that first turn.
    const drawCount = state.player.hand.length === 0
      ? PLAYER_START.drawPerTurn + state.player.powers.hoarder
      : 0;
    if (drawCount > 0) drawCards(state.player, drawCount);
    emit();
    // Mirror image of applyRemoteTurnStart(): tell the opponent's client
    // exactly how many cards we (the newly active player) drew, so their
    // state.opponent (mirroring us) can reset block/mana and draw the same
    // count of HIDDEN placeholders without ever needing to know our real
    // hoarder-adjusted math themselves. drawCount is legitimately 0 for the
    // second player's first turn (see above) -- applyRemoteTurnStart(0) is a
    // harmless no-op draw on the other client, exactly mirroring reality.
    emitAction('turnStart', { drawCount });
  }

  // ---- Match end ------------------------------------------------------------
  // spec §6.4: HP hitting 0 ends the match IMMEDIATELY on whichever client
  // detects it — no waiting for a server round-trip. winMatch()/loseMatch()
  // are that immediate local transition, and are the only two places that
  // fire onMatchEnd() (js/battle.js reports the result to the relay from
  // there). The eventual match_ended broadcast from the relay is handled by
  // endMatchByResult() below instead, which is deliberately a no-op replay
  // of the same transition if we already got here locally, and the ONLY way
  // to reach the victory/defeat screen for an outcome this client couldn't
  // have detected itself (win_forfeit, or "opponent reported before I did").
  function winMatch() {
    state.turnBusy = false;
    state.matchResult = 'win';
    state.screen = 'victory';
    emit();
    emitMatchEnd('win');
  }

  function loseMatch() {
    state.turnBusy = false;
    state.matchResult = 'loss';
    state.screen = 'defeat';
    emit();
    emitMatchEnd('loss');
  }

  // Driven by the relay's match_ended message (js/battle.js) — result is one
  // of 'win' | 'loss' | 'win_forfeit' | 'void'. Never calls emitMatchEnd (see
  // doc comment above): this function only ever REACTS to a result that
  // either this client already reported itself, the opponent reported, or
  // the server decided via forfeit/void — it must never trigger a fresh
  // report of its own no matter which of those it was. 'void' (QA finding
  // #2's simultaneous-double-disconnect no-contest) can ONLY arrive this
  // way — there is no local winMatch()/loseMatch()-style detection for it,
  // since by definition neither client is in a position to detect it live
  // (both are disconnected when it happens; this only fires at all for the
  // rare case a socket reconnects just as the server resolves it).
  function endMatchByResult(result) {
    if (state.screen === 'victory' || state.screen === 'defeat') {
      // Already transitioned locally (winMatch/loseMatch already ran) — just
      // make sure matchResult reflects the authoritative server-confirmed
      // value in case it's more specific than our optimistic local guess
      // (e.g. plain 'win' -> 'win_forfeit').
      if (state.matchResult !== result) { state.matchResult = result; emit(); }
      return;
    }
    state.turnBusy = false;
    state.frozen = false;
    state.matchResult = result;
    // No dedicated third screen for 'void' (small-team scope call, see
    // js/ui.js's renderMatchEnd) — it reuses the 'defeat' screen shell with
    // distinct copy, since it's neither a real win nor a real loss.
    state.screen = (result === 'loss' || result === 'void') ? 'defeat' : 'victory';
    emit();
  }

  function setFrozen(value) {
    const next = !!value;
    if (state.frozen === next) return;
    state.frozen = next;
    emit();
  }

  return {
    state,
    onChange,
    onFx,
    onAction,
    onMatchEnd,
    startMatch,
    openHowto,
    closeHowto,
    selectCard,
    targetOpponent,
    endTurn,
    endMatchByResult,
    setFrozen,
    applyRemoteAction,
    reconcileMyTurnStart,
    reconcileOpponentTurnStart,
    canPlay,
    cardById,
  };
})();
