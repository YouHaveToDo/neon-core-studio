/* ARCANE LEDGER — practice-mode AI (docs/design/practice-mode-proposal.md §3-§4).
 *
 * Two responsibilities, kept in one file because they're small and tightly
 * coupled (the "brain" exists only to drive the heuristic below through the
 * real engine):
 *
 *   1. decideNextCard() -- the pure §3.2 priority heuristic. Takes a plain
 *      snapshot of "what can I see right now" and returns a cardId or null.
 *      No AL/DOM/timer access at all, so it's trivially unit-testable with
 *      hand-built numbers (see server/scripts/practice-mode-ai-test.js).
 *
 *   2. createBrain() -- the stateful side: owns the AI's private "real"
 *      hand/deck/discard (design doc §4.2 -- state.opponent's own arrays stay
 *      HIDDEN for the UI, so something else has to remember what the AI
 *      actually holds) and knows how to spend a full turn by repeatedly
 *      calling decideNextCard() and routing the result through
 *      AL.applyRemoteAction() (design doc §4.1's recommended integration --
 *      see js/practice.js's file header for why that recommendation was
 *      followed as-is).
 *
 * Turn-1 attack lock (design doc §3.3, the "programmer must confirm" flag):
 * AL.state.firstTurnAttackLock is ONLY ever wired into state.player's own
 * canPlay()/selectCard()/resolveCard() path (js/state.js) -- applyRemoteAction
 * never reads it, and in practice mode there is no real second client to
 * self-enforce it on the AI's behalf the way a real opponent's own client
 * does in PvP (see js/state.js's file header, "PvP restructure" section, and
 * spec-online-pvp.md §6.3.1). So the brain below tracks its OWN copy of
 * "am I the first player, and is this still my very first turn" and folds it
 * into the affordable-card filter before the heuristic ever runs -- an
 * Attack card is never even a candidate on that turn, exactly mirroring what
 * canPlay()'s gate does for the local player.
 */
const AI = (() => {
  // §4.4: "약 0.6~0.9초" between AI card plays so a turn doesn't look
  // instantaneous. Not an exact tuned number (the design doc leaves the
  // precise value to programmer/QA judgment) -- 750ms is the midpoint of the
  // stated range.
  const DEFAULT_PACING_MS = 750;

  // §3.1's "1턴당 최대 10회" safety cap. Genuinely load-bearing, not just
  // defensive decoration: a hand full of 0-cost, draw-a-card Skill cards
  // (e.g. Quick Guard: cost 0, draws 1) can refill itself faster than mana
  // ever runs out, so "mana eventually hits 0" is NOT on its own a proof this
  // loop terminates -- see the "pathological hand" case in
  // practice-mode-ai-test.js for a constructed repro.
  const DEFAULT_MAX_ITERATIONS = 10;

  // ---- §3.2: priority-type heuristic (pure, no engine access) --------------

  // Fisher-Yates using an injectable rng so tests can seed determinism.
  // Deliberately NOT js/state.js's own shuffle() -- that one is private to
  // AL's closure (never exported) and is explicitly documented there as only
  // ever meaningful for state.player's own pile; the AI's shadow deck is a
  // separate, independent shuffle authority (design doc §4.2's "순전히 로컬
  // 연산" -- same principle real PvP already applies per-side).
  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function pickHighestCost(cardIds, cardDefById, rng) {
    if (!cardIds.length) return null;
    let bestCost = -Infinity;
    cardIds.forEach((id) => {
      const cost = cardDefById(id).cost;
      if (cost > bestCost) bestCost = cost;
    });
    // §3.1 step 4: "비용이 같은 카드가 여럿이면 무작위로 하나를 고른다" -- the
    // ONLY randomization this heuristic does; everything else is
    // deterministic given the same hand/HP snapshot.
    const tied = cardIds.filter((id) => cardDefById(id).cost === bestCost);
    return tied[Math.floor(rng() * tied.length)];
  }

  // ctx = {
  //   hand: [cardId, ...]        -- the AI's real hand (from the brain below)
  //   mana: number               -- state.opponent.mana right now
  //   blockAttack: boolean       -- true only during the AI's own first turn
  //                                 as the first player (§3.3)
  //   selfHp/selfMaxHp           -- state.opponent.hp/maxHp
  //   oppHp/oppMaxHp             -- state.player.hp/maxHp (public info either
  //                                 way, same as real PvP -- §3.2's note)
  //   cardDefById                -- js/data.js's cardDefById
  //   rng                        -- defaults to Math.random
  // }
  // Returns a cardId to play, or null if nothing in `hand` is legal right now
  // (either unaffordable, or an Attack card while blockAttack is true).
  function decideNextCard(ctx) {
    const cardDefById = ctx.cardDefById;
    const rng = ctx.rng || Math.random;

    const playable = ctx.hand.filter((id) => {
      const card = cardDefById(id);
      if (!card) return false;
      if (card.cost > ctx.mana) return false;
      if (ctx.blockAttack && card.type === 'attack') return false;
      return true;
    });
    if (!playable.length) return null;

    const selfPct = ctx.selfHp / ctx.selfMaxHp;
    const oppPct = ctx.oppHp / ctx.oppMaxHp;
    const selfPreservation = selfPct <= 0.3; // §3.2 row 1
    // §3.2 row 2 is explicitly "자기 보존이 아닐 때" -- only ever evaluated
    // when selfPreservation is false, matching the table's own branching.
    const hpRaceBehind = !selfPreservation && (selfPct - oppPct) < -0.15;

    // §3.2's three branches, expressed as an ordered list of "tiers" to try
    // in order. Self-preservation is a genuine 3-tier cascade (skill, THEN
    // power, THEN attack, each considered alone) -- the other two branches
    // are 2-tier, with skill+power pooled together into a single "same
    // priority" group per the table's "skill/power 우선(둘 중 낼 수 있는
    // 쪽)" wording (i.e. compare cost across both types together, not
    // skill-then-power in sequence).
    let tiers;
    if (selfPreservation) {
      tiers = [['skill'], ['power'], ['attack']];
    } else if (hpRaceBehind) {
      tiers = [['skill', 'power'], ['attack']];
    } else {
      tiers = [['attack'], ['skill', 'power']];
    }

    for (let i = 0; i < tiers.length; i++) {
      const types = tiers[i];
      const inTier = playable.filter((id) => types.indexOf(cardDefById(id).type) !== -1);
      const choice = pickHighestCost(inTier, cardDefById, rng);
      if (choice) return choice;
    }

    // §3.1 step 4's final fallback ("그래도 없으면 낼 수 있는 카드 전체 중
    // 비용이 가장 높은 카드"). Every card is attack/skill/power and the tier
    // lists above jointly cover all three types, so this should never
    // actually be needed -- kept anyway since the design doc states it as an
    // explicit requirement rather than an inferred consequence.
    return pickHighestCost(playable, cardDefById, rng);
  }

  // ---- §4.2/§4.4: the "real" shadow hand/deck + turn-runner ----------------

  // deckIds: the mirrored player deck (design doc §2 -- identical card-id
  // list to what AL.startMatch() was given for state.player).
  // opts:
  //   isFirstPlayer -- whether AL.startMatch() made the AI go first
  //   rng           -- injectable for deterministic tests (default Math.random)
  //   pacingMs      -- override for DEFAULT_PACING_MS (tests pass 0)
  //   sleepFn       -- override the delay implementation entirely (tests can
  //                    pass a synchronous no-op if they don't want to wait on
  //                    real timers at all)
  //   maxIterations -- override DEFAULT_MAX_ITERATIONS (tests constructing
  //                    the pathological-hand case want to see the cap bite)
  function createBrain(deckIds, opts) {
    opts = opts || {};
    const isFirstPlayer = !!opts.isFirstPlayer;
    const rng = opts.rng || Math.random;
    const pacingMs = typeof opts.pacingMs === 'number' ? opts.pacingMs : DEFAULT_PACING_MS;
    const maxIterations = typeof opts.maxIterations === 'number' ? opts.maxIterations : DEFAULT_MAX_ITERATIONS;
    const sleep = opts.sleepFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    const masterDeck = deckIds.slice();
    let drawPile = shuffle(masterDeck.slice(), rng);
    let hand = [];
    let discardPile = [];
    const exhaustPile = [];
    let turnsTaken = 0; // incremented once per completed AI turn, used for the §3.3 lock

    function drawOne() {
      if (drawPile.length === 0) {
        if (discardPile.length === 0) return; // shadow deck fully exhausted -- matches drawCards()'s own "nothing left" no-op
        drawPile = shuffle(discardPile.splice(0), rng);
      }
      hand.push(drawPile.pop());
    }

    function draw(n) {
      for (let i = 0; i < n; i++) drawOne();
    }

    // §6.3 step 3 (both sides draw their opening hand directly at match
    // start, no turnStart event involved) -- AL.startMatch() always calls
    // drawCards(state.opponent, PLAYER_START.drawPerTurn) unconditionally,
    // for BOTH the first and second player, so the shadow hand must mirror
    // that immediately at creation time rather than waiting for the brain's
    // first onTurnStart() call (see that function's doc comment for why
    // onTurnStart() must NOT re-draw on the AI's actual first turn).
    draw(PLAYER_START.drawPerTurn);

    // Mirrors js/state.js's applyRemoteTurnStart()/localTurnStart() turn-
    // boundary bookkeeping (block reset, mana reset, draw) for the AI's side,
    // fired once per real turn boundary -- must be called by the orchestrator
    // (js/practice.js) every time state.turn becomes 'opponent', INCLUDING
    // the AI's very first turn (to clear turnBusy/reset block+mana), but with
    // drawCount forced to 0 for that first call specifically: the opening
    // hand above already covers turn 1 for either side, exactly like real
    // PvP's localTurnStart() "hand.length === 0" special case (js/state.js)
    // skips the extra draw on a side's genuine turn-1 start. Every
    // subsequent call (turnsTaken >= 1) draws the normal per-turn amount,
    // reading state.opponent.powers.hoarder directly since that field is
    // real/public (mutated by applyCardEffect on the actual state.opponent
    // whenever the AI plays a Hoarder card through applyRemoteCardPlay) --
    // no separate hoarder bookkeeping needed in the shadow copy.
    function onTurnStart(AL) {
      const drawCount = turnsTaken === 0 ? 0 : (PLAYER_START.drawPerTurn + AL.state.opponent.powers.hoarder);
      AL.applyRemoteAction({ type: 'turnStart', drawCount });
      draw(drawCount);
    }

    function playCard(AL, cardId) {
      const idx = hand.indexOf(cardId);
      if (idx !== -1) hand.splice(idx, 1);
      const card = cardDefById(cardId);
      // Reuses the exact same pipeline a real opponent's playCard action
      // would run (design doc §4.1) -- mana/HIDDEN-routing/Weaken-decay/
      // win-loss-check all come from js/state.js's applyRemoteCardPlay(), not
      // reimplemented here.
      const handLenBefore = AL.state.opponent.hand.length;
      AL.applyRemoteAction({ type: 'playCard', cardId });
      const handLenAfter = AL.state.opponent.hand.length;
      // Some cards draw MORE cards as part of their own effect (Quick Guard,
      // Adrenaline, Opportunist) -- applyRemoteCardPlay() always pops exactly
      // one HIDDEN slot for the card just played, so any extra growth beyond
      // that -1 is real bonus draw(s) the shadow hand must mirror with real
      // ids, the same way onTurnStart() mirrors a turn-boundary draw. Diffing
      // the length here (rather than special-casing each draw-effect card by
      // id) keeps this correct automatically if a future card effect also
      // draws -- exactly the "don't reimplement card effects a second time"
      // principle design doc §4.1 asks for.
      const bonusDraws = handLenAfter - (handLenBefore - 1);
      if (bonusDraws > 0) draw(bonusDraws);
      if (card && card.type === 'power') {
        exhaustPile.push(cardId);
      } else {
        discardPile.push(cardId);
      }
    }

    // Runs the AI's entire turn to completion: repeatedly asks
    // decideNextCard() for the next play, applies it, waits the pacing delay
    // (§4.4), and stops when either nothing is left to play or the safety
    // cap is hit. Ends by discarding the shadow hand and ending the turn
    // through the same AL.endTurn()-equivalent path a real opponent uses
    // (applyRemoteAction({type:'endTurn'})) -- unless the match already ended
    // mid-turn (a card played lethal damage), in which case AL.applyRemoteAction
    // itself already no-ops (js/state.js: it only acts while
        // state.screen === 'battle'), so calling it again here is harmless but
    // skipped anyway for clarity.
    async function playTurn(AL) {
      const blockAttack = isFirstPlayer && turnsTaken === 0; // §3.3
      let iterations = 0;
      while (iterations < maxIterations) {
        iterations += 1;
        if (AL.state.turn !== 'opponent' || AL.state.screen !== 'battle') break;
        const cardId = decideNextCard({
          hand,
          mana: AL.state.opponent.mana,
          blockAttack,
          selfHp: AL.state.opponent.hp,
          selfMaxHp: AL.state.opponent.maxHp,
          oppHp: AL.state.player.hp,
          oppMaxHp: AL.state.player.maxHp,
          cardDefById,
          rng,
        });
        if (!cardId) break; // §3.1 step 2: nothing left to play -> stop
        playCard(AL, cardId);
        if (AL.state.screen !== 'battle') break; // match just ended (winMatch/loseMatch)
        if (iterations < maxIterations) await sleep(pacingMs);
      }
      turnsTaken += 1;
      if (AL.state.turn === 'opponent' && AL.state.screen === 'battle') {
        discardPile.push(...hand);
        hand = [];
        AL.applyRemoteAction({ type: 'endTurn' });
      }
    }

    return {
      onTurnStart,
      playTurn,
      get hand() { return hand.slice(); }, // exposed read-only for test verification only -- never surfaced to the UI (state.opponent.hand stays HIDDEN, see file header)
      get turnsTaken() { return turnsTaken; },
    };
  }

  return { decideNextCard, createBrain, DEFAULT_PACING_MS, DEFAULT_MAX_ITERATIONS };
})();
