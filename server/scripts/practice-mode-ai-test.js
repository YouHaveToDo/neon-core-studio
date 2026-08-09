/* Node vm-harness test for the practice-mode AI engine + local timer
 * (docs/design/practice-mode-proposal.md §3-§5, Track A of the practice-mode
 * milestone -- js/ai.js, js/practice.js). Same loading pattern as
 * weaken-status-test.js (js/data.js + js/state.js are plain global <script>
 * files with no browser-only globals, loadable directly into a `vm`
 * context) -- extended here to also load js/ai.js and js/practice.js, and to
 * inject setInterval/clearInterval alongside setTimeout/clearTimeout since
 * js/practice.js's local turn timer uses all four.
 *
 * No server/DB required. Usage: node scripts/practice-mode-ai-test.js
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.log(`  FAIL  ${msg}`);
    failures += 1;
  }
}

// Returns { AL, AI, Practice, cardDefById } all sharing one fresh vm context,
// so each test section below gets a fully independent match/AI-brain/timer
// state. cardDefById is returned too (rather than assuming a global of the
// same name in THIS file, which does not exist outside the vm context) since
// several assertions below need to look up a card's cost/type directly.
function loadModules() {
  const repoRoot = path.join(__dirname, '..', '..');
  const files = ['data.js', 'state.js', 'ai.js', 'practice.js'].map((f) =>
    fs.readFileSync(path.join(repoRoot, 'js', f), 'utf8'));
  const sandbox = { setTimeout, clearTimeout, setInterval, clearInterval, console };
  vm.createContext(sandbox);
  const filenames = ['js/data.js', 'js/state.js', 'js/ai.js', 'js/practice.js'];
  files.forEach((src, i) => vm.runInContext(src, sandbox, { filename: filenames[i] }));
  return {
    AL: vm.runInContext('AL', sandbox),
    AI: vm.runInContext('AI', sandbox),
    Practice: vm.runInContext('Practice', sandbox),
    cardDefById: vm.runInContext('cardDefById', sandbox),
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Polls `predicate()` every `intervalMs` until it returns true or
// `maxWaitMs` elapses. Used instead of a single blind sleep() for the local
// timer tests below: js/practice.js's own countdown only gets RE-CHECKED on
// its 250ms setInterval tick (same cadence js/battle.js's real timer UI
// uses), and once it fires, the AI's reply turn (and a brand new player
// timer for the turn after that) can complete within the same wall-clock
// window a single long sleep() would also cover -- polling lets a test catch
// the transient state at the moment a condition FIRST becomes true, rather
// than racing a fixed delay against however many turn-boundaries happen to
// fit inside it.
async function waitUntil(predicate, intervalMs, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

// A deterministic (non-random) rng for tests that care about exact card
// choice among ties -- always picks the first candidate.
function fixedRng() { return 0; }

// =============================================================================
// Section 1: decideNextCard() -- pure heuristic, real numbers, no engine
// =============================================================================

console.log('\n== Section 1: AI.decideNextCard() priority heuristic (§3.2), real numbers ==');
{
  const { AI, cardDefById } = loadModules();

  console.log('-- 1a: self-preservation (own HP% <= 30%) picks Skill over Power/Attack, highest-cost Skill among ties --');
  {
    // hp 15/50 = 30% exactly -- boundary is "<=", so this must trigger self-preservation.
    const choice = AI.decideNextCard({
      hand: ['strike', 'heavySlash', 'defend', 'fortify', 'bloodlust'],
      // strike(1,atk) heavySlash(2,atk) defend(1,skill) fortify(2,skill) bloodlust(1,power)
      mana: 3,
      blockAttack: false,
      selfHp: 15, selfMaxHp: 50,
      oppHp: 50, oppMaxHp: 50,
      cardDefById,
      rng: fixedRng,
    });
    assert(choice === 'fortify', `self-preservation at exactly 30% HP picks the highest-cost Skill (fortify, cost 2) over cheaper Skill/Power/Attack (got ${choice})`);
  }

  console.log('-- 1b: self-preservation cascades to Power when no Skill is affordable --');
  {
    const choice = AI.decideNextCard({
      hand: ['strike', 'heavySlash', 'fortify', 'bloodlust', 'hoarder'],
      mana: 1, // fortify (cost 2) and heavySlash (cost 2) unaffordable -- only cost-1 cards playable
      blockAttack: false,
      selfHp: 10, selfMaxHp: 50, // 20% <= 30%
      oppHp: 50, oppMaxHp: 50,
      cardDefById,
      rng: fixedRng,
    });
    // Affordable: strike(atk,1), bloodlust(power,1), hoarder is cost 2 -> unaffordable.
    // No Skill affordable at cost<=1 mana in this hand -> cascades past skill tier straight to power.
    assert(choice === 'bloodlust', `self-preservation cascades past an empty Skill tier straight to Power (bloodlust) rather than jumping to Attack (got ${choice})`);
  }

  console.log('-- 1c: HP-race behind by >=15pp (not self-preservation) pools Skill+Power into one tier, picks highest cost across both --');
  {
    // self 40% (not <=30%), opp 60% -> diff = -20pp < -15pp -> "behind" branch.
    const choice = AI.decideNextCard({
      hand: ['strike', 'defend', 'bloodlust', 'fortify'],
      // strike(atk,1) defend(skill,1) bloodlust(power,1) fortify(skill,2)
      mana: 3,
      blockAttack: false,
      selfHp: 20, selfMaxHp: 50, // 40%
      oppHp: 30, oppMaxHp: 50, // 60%
      cardDefById,
      rng: fixedRng,
    });
    assert(choice === 'fortify', `HP-race-behind picks the highest-cost card across the POOLED skill+power tier (fortify, cost 2) over the cost-1 attack (got ${choice})`);
  }

  console.log('-- 1d: just short of the -15pp threshold (e.g. -10pp) is NOT "behind" -- falls through to default attack-first --');
  // (Deliberately not testing the exact -15pp boundary with real HP/maxHp
  // division: 17.5/50 - 25/50 evaluates to -0.15000000000000002 in IEEE 754
  // double math, not exactly -0.15, which would make a boundary assertion
  // depend on float rounding rather than on the heuristic's actual "<" vs
  // "<=" behavior. -10pp is unambiguously on the "not behind" side of either
  // interpretation, so it isolates the behavior this test actually cares
  // about.)
  {
    const choice = AI.decideNextCard({
      hand: ['strike', 'fortify'],
      mana: 3,
      blockAttack: false,
      selfHp: 20, selfMaxHp: 50, // 40%
      oppHp: 25, oppMaxHp: 50, // 50% -- diff = -10pp, short of the -15pp threshold
      cardDefById,
      rng: fixedRng,
    });
    assert(choice === 'strike', `-10pp behind does not trigger the HP-race branch, so default attack-first applies (got ${choice})`);
  }

  console.log('-- 1e: default (ahead or within 15pp) picks Attack first, highest cost, even with a pricier Skill/Power available --');
  {
    const choice = AI.decideNextCard({
      hand: ['strike', 'heavySlash', 'fortify', 'hoarder'],
      // heavySlash(atk,2) fortify(skill,2) hoarder(power,2) -- all same cost, only type differs, plus strike(atk,1)
      mana: 3,
      blockAttack: false,
      selfHp: 40, selfMaxHp: 50, // 80%, clearly ahead
      oppHp: 40, oppMaxHp: 50,
      cardDefById,
      rng: fixedRng,
    });
    assert(choice === 'heavySlash', `default branch prefers Attack tier first even though Skill/Power cards of equal cost exist (got ${choice})`);
  }

  console.log('-- 1f: default branch cascades to Skill/Power when no Attack is affordable --');
  {
    // heavySlash would be affordable at cost 2 <= mana 2, so blockAttack is
    // used here to force "no Attack playable" the same way the real turn-1
    // lock does, isolating the cascade behavior from an affordability gap.
    const choice = AI.decideNextCard({
      hand: ['heavySlash', 'fortify', 'hoarder'],
      mana: 2,
      blockAttack: true, // simulates "no attack playable" via the turn-1 lock rather than an affordability gap
      selfHp: 40, selfMaxHp: 50,
      oppHp: 40, oppMaxHp: 50,
      cardDefById,
      rng: fixedRng,
    });
    assert(choice === 'fortify' || choice === 'hoarder', `default branch falls through to the pooled skill/power tier when Attack is unavailable (got ${choice})`);
    assert(cardDefById(choice).cost === 2, `and picks the highest-cost card within that tier (got cost ${cardDefById(choice).cost})`);
  }

  console.log('-- 1g: no affordable/legal card at all returns null (never crashes) --');
  {
    const choice = AI.decideNextCard({
      hand: ['strike'], // attack, cost 1
      mana: 0,
      blockAttack: false,
      selfHp: 40, selfMaxHp: 50,
      oppHp: 40, oppMaxHp: 50,
      cardDefById,
      rng: fixedRng,
    });
    assert(choice === null, `unaffordable hand returns null instead of crashing/choosing an illegal card (got ${choice})`);
  }

  console.log('-- 1h: blockAttack=true removes Attack cards from consideration even when affordable --');
  {
    const choice = AI.decideNextCard({
      hand: ['strike'],
      mana: 3,
      blockAttack: true,
      selfHp: 40, selfMaxHp: 50,
      oppHp: 40, oppMaxHp: 50,
      cardDefById,
      rng: fixedRng,
    });
    assert(choice === null, `the ONLY affordable card being a blocked Attack correctly yields null, not the illegal Attack (got ${choice})`);
  }

  console.log('-- 1i: equal-cost tie-break is genuinely randomized across many trials --');
  {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const choice = AI.decideNextCard({
        hand: ['heavySlash', 'execute'], // both cost 2, both attack
        mana: 2,
        blockAttack: false,
        selfHp: 40, selfMaxHp: 50,
        oppHp: 40, oppMaxHp: 50,
        cardDefById,
        rng: Math.random,
      });
      seen.add(choice);
    }
    assert(seen.has('heavySlash') && seen.has('execute'), `200 trials with equal-cost tied candidates produced both options (got ${[...seen].join(', ')})`);
  }
}

// =============================================================================
// Section 2: engine-integrated AI turns (js/ai.js's createBrain + AL together)
// =============================================================================

function freshMatch(AL, opts) {
  AL.startMatch(Object.assign({ opponentName: 'TestBot' }, opts));
  AL.closeHowto();
  return AL;
}

(async () => {
  console.log('\n== Section 2: AI.createBrain() driving a real match through AL.applyRemoteAction() ==');

  console.log('-- 2a: AI as first player never plays an Attack card on its own turn 1, even with only Attack cards drawable --');
  {
    const { AL, AI } = loadModules();
    freshMatch(AL, { isFirstPlayer: false, deck: ['strike', 'strike', 'strike', 'strike', 'strike', 'defend'] });
    // isFirstPlayer:false means the LOCAL player is second -> the AI (opponent) goes first.
    assert(AL.state.turn === 'opponent', `opponent (AI) correctly starts as the first player when isFirstPlayer:false (got turn=${AL.state.turn})`);

    const brain = AI.createBrain(['strike', 'strike', 'strike', 'strike', 'strike', 'defend'], {
      isFirstPlayer: true, pacingMs: 0, maxIterations: 10,
    });
    const oppHpBefore = AL.state.player.hp; // AI's target is the local player
    brain.onTurnStart(AL);
    await brain.playTurn(AL);
    const dealt = oppHpBefore - AL.state.player.hp;
    assert(dealt === 0, `AI's first turn as first player deals 0 damage to the player -- no Attack card was played despite the hand being mostly Strike (got ${dealt} damage dealt)`);
    assert(AL.state.turn === 'player', `turn correctly passed back to the local player after the AI's locked turn 1 (got ${AL.state.turn})`);
  }

  console.log('-- 2b: AI as SECOND player is NOT locked on its first turn (lock only ever applies to whichever side is first) --');
  {
    const { AL, AI } = loadModules();
    freshMatch(AL, { isFirstPlayer: true, deck: ['strike', 'strike', 'strike', 'strike', 'strike', 'defend'] });
    // isFirstPlayer:true -> local player goes first; AI is the second player.
    AL.state.player.hand = [];
    AL.endTurn(); // local player's turn 1 ends with nothing played -> AI's (second player's) turn 1 begins

    const brain = AI.createBrain(['strike', 'strike', 'strike', 'strike', 'strike', 'defend'], {
      isFirstPlayer: false, pacingMs: 0, maxIterations: 10,
    });
    const oppHpBefore = AL.state.player.hp;
    brain.onTurnStart(AL);
    await brain.playTurn(AL);
    const dealt = oppHpBefore - AL.state.player.hp;
    assert(dealt > 0, `AI's first turn as the SECOND player is free to play Attack cards -- the lock only ever binds whichever side went first (got ${dealt} damage dealt, expected > 0)`);
  }

  console.log('-- 2c: the AI never plays a card it cannot afford (mana never goes negative across a full multi-card turn) --');
  {
    const { AL, AI } = loadModules();
    freshMatch(AL, { isFirstPlayer: true, deck: ['strike', 'strike', 'defend', 'defend', 'heavySlash', 'fortify'] });
    AL.state.player.hand = [];
    AL.endTurn();
    const brain = AI.createBrain(['strike', 'strike', 'defend', 'defend', 'heavySlash', 'fortify'], {
      isFirstPlayer: false, pacingMs: 0,
    });
    brain.onTurnStart(AL);
    await brain.playTurn(AL);
    assert(AL.state.opponent.mana >= 0, `opponent mana never goes negative after a full AI turn (got ${AL.state.opponent.mana})`);
    assert(AL.state.turn === 'player', `AI turn correctly ends and passes control back (got ${AL.state.turn})`);
  }

  console.log('-- 2d: safety cap (maxIterations) actually stops a pathological hand from looping forever --');
  {
    const { AL, AI } = loadModules();
    // 20 copies of Quick Guard: cost 0, draws 1 card each play -- can refill
    // its own hand faster than mana ever runs out, so without a hard cap
    // this would never naturally terminate.
    const bigDeck = new Array(20).fill('quickGuard');
    freshMatch(AL, { isFirstPlayer: true, deck: bigDeck });
    AL.state.player.hand = [];
    AL.endTurn();
    const brain = AI.createBrain(bigDeck, { isFirstPlayer: false, pacingMs: 0, maxIterations: 10 });
    brain.onTurnStart(AL);
    const startedAt = Date.now();
    await brain.playTurn(AL);
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs < 5000, `a self-replenishing 0-cost hand terminates quickly under the safety cap instead of hanging (took ${elapsedMs}ms)`);
    assert(AL.state.turn === 'player', `turn still correctly passes back to the player once the cap is hit (got ${AL.state.turn})`);
  }

  console.log('-- 2e: self-preservation branch drives an actual card choice with real HP numbers, end-to-end through AL --');
  {
    const { AL, AI, cardDefById } = loadModules();
    freshMatch(AL, { isFirstPlayer: true, deck: ['strike', 'strike', 'defend', 'fortify', 'bloodlust', 'heavySlash'] });
    AL.state.player.hand = [];
    AL.endTurn();
    AL.state.opponent.hp = 10; // 10/50 = 20% -- well under the 30% self-preservation threshold
    const brain = AI.createBrain(['strike', 'strike', 'defend', 'fortify', 'bloodlust', 'heavySlash'], {
      isFirstPlayer: false, pacingMs: 0, rng: fixedRng,
    });
    brain.onTurnStart(AL);
    assert(brain.hand.some((id) => cardDefById(id).type === 'skill'), 'sanity: AI actually drew at least one Skill card into its shadow hand for this scenario');
    await brain.playTurn(AL);
    assert(AL.state.opponent.block > 0, `at 20% HP, the AI plays its defensive Skill (block) rather than only attacking -- opponent gained block (got ${AL.state.opponent.block})`);
  }

  // ===========================================================================
  // Section 2 (integration): the REAL js/practice.js -> AI.createBrain() wiring
  // ===========================================================================
  //
  // 2a/2b above call AI.createBrain() directly with an already-correct,
  // pre-inverted `isFirstPlayer` -- that's a legitimate unit test of
  // createBrain()'s own §3.3 contract in isolation, but it does NOT exercise
  // js/practice.js's start(), the one place in the real app that actually
  // computes the value passed into createBrain(). A prior integration bug
  // (docs/qa/practice-mode-milestone.md, follow-up #3) had practice.js
  // passing its player-relative `isFirstPlayer` straight into createBrain()
  // unchanged, even though createBrain()'s own doc comment/blockAttack logic
  // expect the AI-relative sense -- silently disabling the turn-1 lock
  // whenever the AI was genuinely first, while 2a/2b kept passing because
  // they never went through practice.js's start() at all. These two tests
  // close that gap by driving the lock entirely through Practice.start()
  // (opts.isFirstPlayer in its documented player-relative sense, exactly like
  // a real caller), so they fail against the buggy wiring and pass once the
  // js/practice.js call site correctly inverts the value.

  console.log('\n== Section 2 (integration): js/practice.js -> AI.createBrain() wiring, the real production call path ==');

  console.log('-- 2f: [INTEGRATION] AI as the genuine first player (Practice.start({isFirstPlayer:false})) deals 0 damage on its real first turn --');
  {
    const { AL, Practice } = loadModules();
    Practice.init();
    Practice.start(['strike', 'strike', 'strike', 'strike', 'strike', 'defend'], {
      isFirstPlayer: false, // player-relative, same meaning as AL.startMatch(): the LOCAL player is NOT first -> the AI is genuinely first.
      aiPacingMs: 0,
    });
    AL.closeHowto();
    assert(AL.state.turn === 'opponent', `sanity: the AI is genuinely first (got turn=${AL.state.turn})`);
    const playerHpBefore = AL.state.player.hp;
    const finished = await waitUntil(() => AL.state.turn === 'player', 10, 2000);
    assert(finished, "the AI's genuine first turn, run through the real Practice.start() wiring, completed and returned control to the player");
    const dealt = playerHpBefore - AL.state.player.hp;
    assert(dealt === 0, `REGRESSION CHECK (docs/qa/practice-mode-milestone.md follow-up #3): the AI's real first turn, driven through Practice.start() rather than a direct AI.createBrain() call, deals 0 damage -- confirms the isFirstPlayer inversion at the js/practice.js call site is correct (got ${dealt} damage dealt)`);
    Practice.stop();
  }

  console.log('-- 2g: [INTEGRATION] AI as the genuine SECOND player (Practice.start({isFirstPlayer:true})) is NOT locked on its real first turn --');
  {
    const { AL, Practice } = loadModules();
    Practice.init();
    Practice.start(['strike', 'strike', 'strike', 'strike', 'strike', 'defend'], {
      isFirstPlayer: true, // the LOCAL player is first -> the AI is genuinely second.
      aiPacingMs: 0,
    });
    AL.closeHowto();
    assert(AL.state.turn === 'player', `sanity: the local player is genuinely first (got turn=${AL.state.turn})`);
    AL.state.player.hand = [];
    AL.endTurn(); // player's turn 1 ends with nothing played -> the AI's own real first turn (as the second player) begins
    const playerHpBefore = AL.state.player.hp;
    const finished = await waitUntil(() => AL.state.turn === 'player', 10, 2000);
    assert(finished, "the AI's genuine first turn as the second player, run through Practice.start(), completed and returned control to the player");
    const dealt = playerHpBefore - AL.state.player.hp;
    assert(dealt > 0, `the AI, as the genuine SECOND player, is free to attack on its own first turn when driven through the real Practice.start() wiring -- the lock must not accidentally bind the wrong side (got ${dealt} damage dealt, expected > 0)`);
    Practice.stop();
  }

  // ===========================================================================
  // Section 3: local player-turn timer (design doc §5) via js/practice.js
  // ===========================================================================

  console.log('\n== Section 3: js/practice.js local timer expiry == ');

  console.log('-- 3a: expiry discards the local player\'s hand and passes the turn, same consequence as AL.endTurn() --');
  {
    const { AL, Practice } = loadModules();
    Practice.init();
    Practice.start(['strike', 'strike', 'defend', 'defend', 'heavySlash', 'fortify'], {
      isFirstPlayer: true, // local player goes first -> the timer should be running on state.player's own turn 1
      turnSeconds: 0.08, // 80ms -- fast enough for a test, long enough to be reliably distinguishable from 0
      // Non-zero on purpose (unlike most other tests' pacingMs:0): gives the
      // AI's OWN reply turn a real, measurable duration, so the poll below
      // has a wide enough window to reliably observe the transient
      // just-expired state before the AI's turn (and a brand new player
      // timer after it) has a chance to also complete.
      aiPacingMs: 60,
    });
    AL.closeHowto(); // reveals the battle screen, which is when Practice's timer actually starts counting (mirrors real onboarding flow)
    assert(AL.state.turn === 'player', `sanity: local player is first, so it's their turn while the local timer counts down (got ${AL.state.turn})`);
    const handSizeBeforeExpiry = AL.state.player.hand.length;
    assert(handSizeBeforeExpiry > 0, 'sanity: local player has a real hand to lose on timeout');

    const expired = await waitUntil(() => AL.state.turn !== 'player', 10, 1000);
    // AL.endTurn()'s discard-hand step and its state.turn flip happen inside
    // the SAME synchronous call (js/state.js's endTurn()), so the instant
    // this poll observes turn !== 'player' it is also observing the
    // post-discard hand -- no separate race between the two checks.
    assert(expired, 'the local timer actually expired and moved the turn away from the player within the poll window');
    assert(AL.state.player.hand.length === 0, `local player's hand was discarded at the exact moment of expiry, exactly like a real PvP turn_timeout (had ${handSizeBeforeExpiry}, now ${AL.state.player.hand.length})`);
    Practice.stop();
  }

  console.log('-- 3b: the AI\'s own turn is never subject to the local timer (no expiry-driven interruption of its turn) --');
  {
    const { AL, Practice } = loadModules();
    Practice.init();
    Practice.start(['strike', 'strike', 'defend', 'defend'], {
      isFirstPlayer: false, // AI goes first
      turnSeconds: 0.05, // deliberately shorter than the AI's own pacing below -- if the timer wrongly applied to the AI's turn, it would try to force an endTurn almost immediately
      aiPacingMs: 120, // long enough that the AI's turn is still clearly in progress at the 50ms mark
    });
    AL.closeHowto();
    // Immediately after entering battle, the AI's first turn is underway and
    // is expected to still be mid-flight past its own (irrelevant) 50ms
    // turnSeconds value -- the local timer never arms during an opponent
    // turn (js/practice.js's onStateChange only calls startPlayerTimer() for
    // state.turn === 'player'), so nothing should force it to end early.
    await sleep(80);
    assert(AL.state.turn === 'opponent', `50ms after entering battle, the AI's turn (paced at 120ms/card) has NOT been force-ended by the local timer despite turnSeconds being shorter than that pacing (got ${AL.state.turn})`);

    const returned = await waitUntil(() => AL.state.turn === 'player', 10, 2000);
    assert(returned, 'the AI eventually finishes its own turn on its own pacing and hands control back to the player');
    Practice.stop();
  }
}
)().then(() => {
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
