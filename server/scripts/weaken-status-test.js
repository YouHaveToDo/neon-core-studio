/* Node vm-harness test for the Weaken status-effect engine (docs/design/
 * card-shop-currency-proposal.md §3, Phase 1 of the card-shop-currency
 * milestone). No prior script in this directory used a `vm`-loaded copy of
 * the pure client state module before (the other scripts here are either
 * plain fetch()-against-a-running-server smoke tests, e.g. smoke-test.js,
 * or full Playwright browser tests, e.g. frozen-client-turn-timeout-test.js)
 * -- this is a lighter-weight option that fits better for a pure,
 * network-free rules-engine check: js/state.js and js/data.js are plain
 * global `<script>` files (no bundler, per project convention, see
 * index.html's script order) with no browser-only globals (no window/
 * document/require usage -- confirmed by grep), so they can be loaded
 * directly into a `vm` context and exercised exactly like a real page would
 * load them, without spinning up a server, Postgres, or a browser.
 *
 * No card grants Weaken yet (that's Phase 3, out of scope here per the
 * task) -- stacks are granted the same way the two existing Playwright
 * tests already poke setup state directly for determinism (e.g.
 * frozen-client-turn-timeout-test.js's `AL.state.player.hand = [...]`):
 * this test sets `AL.state.player.weaken` / `AL.state.opponent.weaken`
 * directly, which is exactly what the (still-unwired-to-any-card)
 * `applyWeaken()` primitive itself does internally (`target.weaken +=
 * stacks`) -- functionally identical, and avoids depending on a not-yet-
 * built card. `applyWeaken()` itself is intentionally not part of AL's
 * returned public API (see the bottom of js/state.js), so this is the only
 * available way to set it up from outside the module without adding a new,
 * speculative export nobody else needs yet.
 *
 * ---- 2026-08 update: docs/design/fractional-damage-proposal.md §5/§7,
 * Option B (CEO-approved) ----
 * `applyWeakenToDamage()` no longer floors its `x0.75` result (was
 * `Math.floor(rawDamage * 0.75)`, now just `rawDamage * 0.75`) -- the
 * doc's §2.2 proves that with the current card pool (every Attack card's
 * pre-Weaken total is always even) this multiply can only ever produce a
 * whole number or exactly a ".5", never ".25"/".75". That fractional result
 * now flows through dealDamage() untouched and can persist in
 * target.hp/target.block indefinitely (§5.2/§5.3) rather than being
 * truncated at the moment of calculation. Every assertion below that used
 * to expect a floored integer (`floor(X*0.75)`) has been updated to expect
 * the exact, un-floored fractional value instead; Tests G/H/I below are new,
 * added specifically to cover the fractional-persistence/accumulation/
 * display behavior this change introduces that the old floor-based engine
 * never had to handle. `js/ui.js`'s display layer still rounds for the
 * player-facing text (§5.4) -- Test I covers that separately, through the
 * real js/ui.js render path (not just js/state.js).
 *
 * Usage: node scripts/weaken-status-test.js
 * No server/DB required.
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

function loadAL() {
  const repoRoot = path.join(__dirname, '..', '..');
  const dataSrc = fs.readFileSync(path.join(repoRoot, 'js', 'data.js'), 'utf8');
  const stateSrc = fs.readFileSync(path.join(repoRoot, 'js', 'state.js'), 'utf8');
  // js/state.js's maybeAutoEndTurn() uses the standard setTimeout/
  // clearTimeout globals (available in a real page, not auto-injected into
  // a bare vm sandbox) -- pass Node's real timer functions through so that
  // unrelated feature keeps working exactly as it does in the browser
  // rather than needing to be special-cased around in this test.
  const sandbox = { setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'js/data.js' });
  vm.runInContext(stateSrc, sandbox, { filename: 'js/state.js' });
  // Top-level `const AL = ...` (like a real <script> tag) lands in the
  // context's global LEXICAL scope, not as an own property of the sandbox
  // object itself (same as `window.AL` being undefined for a top-level
  // `const` in a real browser) -- so it has to be read back via one more
  // runInContext() name lookup rather than `sandbox.AL`.
  return vm.runInContext('AL', sandbox);
}

// ---- Minimal DOM stub, used only by Test I (display-formatting) --------
// js/ui.js is a plain global <script> too (same convention as js/state.js,
// confirmed by grep -- no window usage, document usage only via
// getElementById/createElement/querySelectorAll, all covered below), so it
// can be loaded into the SAME kind of vm sandbox as loadAL() above, given a
// fake `document` just complete enough for cache()/renderBattle()/
// handleFx() to run without throwing -- no real browser/jsdom dependency
// needed for what Test I actually checks (rendered text content).
function makeDomStub() {
  function makeClassList() {
    const set = new Set();
    return {
      add(c) { set.add(c); },
      remove(c) { set.delete(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c); else set.delete(c);
        return force;
      },
      contains(c) { return set.has(c); },
    };
  }

  function makeNode(id) {
    // A real DOM element's `.textContent = <anything>` setter always
    // coerces the assigned value to a string (e.g. `.textContent = 16`
    // reads back as `"16"`, never the number 16) -- js/ui.js relies on that
    // (assigns fmtStat()'s numeric Math.round() return straight to
    // `.textContent` and to template-literal string interpolation both).
    // Mirror that coercion here via a real getter/setter rather than a
    // plain property, so Test I's string-equality checks below are testing
    // the same string js/ui.js would actually put on a real page, not an
    // artifact of this stub being looser than a real DOM.
    let _text = '';
    const node = {
      id: id || '',
      innerHTML: '',
      title: '',
      disabled: false,
      dataset: {},
      style: { setProperty() {}, removeProperty() {} },
      children: [],
      classList: makeClassList(),
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter((c) => c !== child); },
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
      setAttribute() {},
      getAttribute() { return null; },
    };
    Object.defineProperty(node, 'textContent', {
      get() { return _text; },
      set(v) { _text = String(v); },
      enumerable: true,
    });
    return node;
  }

  const byId = new Map();
  return {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeNode(id));
      return byId.get(id);
    },
    createElement() { return makeNode(); },
    querySelectorAll() { return []; }, // only used by js/screens.js's Screens.show()
  };
}

// Loads AL (js/data.js + js/state.js) AND the real js/ui.js + js/screens.js
// against the DOM stub above, then wires them together exactly like
// index.html does (UI.init() subscribes UI.render/handleFx to AL's
// onChange/onFx) -- so every AL.* mutation the test makes below drives a
// real render through the actual, unmodified rendering code, and `document`
// (returned here too) can be used to read back exactly what a real page's
// DOM would contain.
function loadALWithUI() {
  const repoRoot = path.join(__dirname, '..', '..');
  const dataSrc = fs.readFileSync(path.join(repoRoot, 'js', 'data.js'), 'utf8');
  const stateSrc = fs.readFileSync(path.join(repoRoot, 'js', 'state.js'), 'utf8');
  const screensSrc = fs.readFileSync(path.join(repoRoot, 'js', 'screens.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(repoRoot, 'js', 'ui.js'), 'utf8');
  const document = makeDomStub();
  const sandbox = { setTimeout, clearTimeout, document };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'js/data.js' });
  vm.runInContext(stateSrc, sandbox, { filename: 'js/state.js' });
  vm.runInContext(screensSrc, sandbox, { filename: 'js/screens.js' });
  vm.runInContext(uiSrc, sandbox, { filename: 'js/ui.js' });
  const AL = vm.runInContext('AL', sandbox);
  const UI = vm.runInContext('UI', sandbox);
  UI.init();
  return { AL, UI, document };
}

// Fresh match, first player, tutorial overlay dismissed, turn-1 attack lock
// cleared (that lock is an unrelated spec §6.3.1 feature — clearing it here
// just lets this test play Attack cards on turn 1 without tripping over it).
function freshBattle(AL) {
  AL.startMatch({ isFirstPlayer: true, opponentName: 'TestBot' });
  AL.closeHowto();
  AL.state.firstTurnAttackLock = false;
  return AL;
}

function setHand(AL, side, cards) {
  side.hand = cards.slice();
  side.handKeys = cards.map((_, i) => `test-${i}`);
}

function playSelfOrTarget(AL, handIndex) {
  AL.selectCard(handIndex);
  // target === 'self' cards resolve immediately inside selectCard(); target
  // === 'enemy' cards need the follow-up click.
  if (AL.state.selected === handIndex) AL.targetOpponent();
}

console.log('\n== Test A: Weaken reduces an Attack card\'s damage by exactly 25%, un-floored (Option B: fractional result persists, no Bloodlust involved) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']); // base 6, no bonus
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  const dealt = hpBefore - AL.state.opponent.hp;
  assert(dealt === 4.5, `Strike (6 base) with Weaken 1 deals 6*0.75=4.5 damage, un-floored (got ${dealt})`);
  assert(AL.state.opponent.hp === 45.5, `opponent's HP itself now persists the fractional value (50 - 4.5 = 45.5) (got ${AL.state.opponent.hp})`);
}

console.log('\n== Test A2: Weaken does NOT affect Skill cards ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['defend']); // 5 block, skill
  playSelfOrTarget(AL, 0);
  assert(AL.state.player.block === 5, `Defend still grants the full 5 block while Weakened (Skill cards are untouched) (got ${AL.state.player.block})`);
}

console.log('\n== Test A3: Weaken does NOT affect Power cards or non-Attack effects (Bloodlust power itself) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 3;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['bloodlust']); // power, self, no damage
  playSelfOrTarget(AL, 0);
  assert(AL.state.player.powers.bloodlust === 1, `Bloodlust power still gains its stack while Weakened (got ${AL.state.player.powers.bloodlust})`);
}

console.log('\n== Test A4: Weaken does NOT reduce self-inflicted recoil damage (Reckless Swing), only the damage dealt to the target ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['recklessSwing']); // 12 base to target, 3 self-recoil
  const oppHpBefore = AL.state.opponent.hp;
  const selfHpBefore = AL.state.player.hp;
  playSelfOrTarget(AL, 0);
  const dealtToTarget = oppHpBefore - AL.state.opponent.hp;
  const selfRecoil = selfHpBefore - AL.state.player.hp;
  // 12 is a multiple of 4, so 12*0.75=9 lands exactly on a whole number even
  // un-floored (fractional-damage-proposal.md §2.2/§4.2's mod-4 table: this
  // is one of the "b=0 loss 0" rows) -- this assertion's value is unchanged
  // by the floor removal, but it's still worth keeping as the "no fraction
  // here" control case alongside Test A's "fraction here" case.
  assert(dealtToTarget === 9, `Reckless Swing's 12 target damage x0.75 = 9 exactly (no fraction, target is a multiple of 4) (got ${dealtToTarget})`);
  assert(selfRecoil === 3, `Reckless Swing's fixed 3 self-recoil is NOT reduced by Weaken (it's not Attack-card damage dealt to a target) (got ${selfRecoil})`);
}

console.log('\n== Test B: Bloodlust + Weaken interaction, un-floored (base 10 + Bloodlust 4 = 14, x0.75 = 10.5) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.powers.bloodlust = 2; // attackBonus() = stacks * 2 = 4
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['piercingStrike']); // base 10, ignoreBlock=true
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  const dealt = hpBefore - AL.state.opponent.hp;
  assert(dealt === 10.5, `Piercing Strike: base 10 + Bloodlust bonus 4 = 14, x0.75 = 10.5, un-floored (got ${dealt})`);
}

console.log('\n== Test C: Weaken order also holds with block present (steps 3 then 4, not the other way around), block fully depleted ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']); // base 6
  AL.state.opponent.block = 3;
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  const dealt = hpBefore - AL.state.opponent.hp;
  const blockLeft = AL.state.opponent.block;
  // Step 3 first: 6*0.75 = 4.5 (no floor). Step 4: 4.5 - 3 block = 1.5 to
  // HP, block fully depleted to exactly 0 (block was smaller than the
  // fractional hit, so it happens to land on a whole number here -- Test H
  // below covers the opposite case, where block absorbs the fractional hit
  // WITHOUT fully depleting and is left holding a fractional remainder
  // itself, fractional-damage-proposal.md §5.3 Example 2).
  assert(dealt === 1.5, `Weaken applies BEFORE block (6*0.75=4.5, then -3 block = 1.5 to HP), not after (got ${dealt} dealt)`);
  assert(blockLeft === 0, `all 3 block consumed, landing on exactly 0 in this case (got ${blockLeft} left)`);
}

console.log('\n== Test D: turn-END decay removes exactly 1 stack, on the WEAKENED character\'s own turn boundary, never the opponent\'s ==');
// Fixed 2026-08 per docs/qa/card-shop-currency-milestone.md finding #3: this
// test used to assert decay fires at the weakened side's own turn-START
// boundary (localTurnStart()/applyRemoteTurnStart()) -- that was the actual
// (buggy) behavior at the time the test was written, not the spec's literal
// wording (§3.1: "-25% for this character's NEXT N turns", with decay
// happening at "자기 턴이 끝날 때마다", i.e. when THEIR OWN turn ends). QA
// caught that the old timing meant a stack decayed before the weakened side
// ever got to act on it -- see Test F below for a real-number check of the
// exact scenario this broke (Crippling Blow's Weaken 1 becoming a no-op).
// This test now asserts decay at the corrected boundary: endTurn() (local
// player's own turn ending) / applyRemoteEndTurn() (opponent's own turn
// ending, learned via their peer action or server reconciliation).
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 2;
  AL.state.opponent.weaken = 3;
  setHand(AL, AL.state.player, []); // nothing to play this turn

  AL.endTurn(); // player's own turn ends -> turn becomes 'opponent'
  assert(
    AL.state.player.weaken === 1,
    `player's Weaken decays by 1 (2 -> 1) the instant THEIR OWN turn ends (endTurn()), not at their next turn's start (got ${AL.state.player.weaken})`
  );
  assert(
    AL.state.opponent.weaken === 3,
    `opponent's Weaken is untouched by the player's own turn-end boundary (still 3) (got ${AL.state.opponent.weaken})`
  );

  // The opponent's real client now starts ITS OWN turn -- no decay should
  // happen here anymore (decay no longer lives in applyRemoteTurnStart()).
  AL.applyRemoteAction({ type: 'turnStart', drawCount: 0 });
  assert(
    AL.state.opponent.weaken === 3,
    `opponent's Weaken is UNCHANGED right when their own turn starts -- decay fires at their own turn-END boundary, not at turn-start (got ${AL.state.opponent.weaken})`
  );

  // Opponent ends their turn -> this IS the opponent's own turn-end
  // boundary, so opponent.weaken should decay here (applyRemoteEndTurn()),
  // and player's own turn starts (localTurnStart(), no decay there anymore).
  AL.applyRemoteAction({ type: 'endTurn' });
  assert(
    AL.state.opponent.weaken === 2,
    `opponent's Weaken decays by 1 (3 -> 2) on the OPPONENT's own turn-END boundary (got ${AL.state.opponent.weaken})`
  );
  assert(
    AL.state.player.weaken === 1,
    `player's Weaken is untouched by the opponent's own turn-end boundary (still 1) (got ${AL.state.player.weaken})`
  );

  // Run one more full cycle to bring player's Weaken down to 0, then confirm
  // it floors at 0 (never negative) and stops reducing damage.
  AL.endTurn(); // player's turn ends -> weaken 1 -> 0
  AL.applyRemoteAction({ type: 'turnStart', drawCount: 0 });
  AL.applyRemoteAction({ type: 'endTurn' });
  assert(AL.state.player.weaken === 0, `player's Weaken reaches exactly 0 after its own turn-end boundary fires again (got ${AL.state.player.weaken})`);

  // One more full cycle beyond that: must not go negative.
  AL.endTurn();
  AL.applyRemoteAction({ type: 'turnStart', drawCount: 0 });
  AL.applyRemoteAction({ type: 'endTurn' });
  assert(AL.state.player.weaken === 0, `player's Weaken does not decay below 0 (got ${AL.state.player.weaken})`);

  // With Weaken at 0, an Attack card should deal its full, unreduced damage.
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']);
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  const dealt = hpBefore - AL.state.opponent.hp;
  assert(dealt === 6, `once Weaken hits 0, Strike deals its full, unreduced 6 damage again (got ${dealt})`);
}

console.log('\n== Test F: a real Weaken-1 grant (Crippling Blow) delivers exactly 1 effective turn of reduced damage -- the exact scenario docs/qa/card-shop-currency-milestone.md finding #3 found was a complete no-op ==');
// This is the real-number regression check for finding #3: before that fix,
// this entire test failed at the `dealt === 4.5` assertion below (Strike
// dealt a full, unreduced 6, because the Weaken 1 Crippling Blow had just
// granted was already decayed away by localTurnStart() before the player
// got to act).
{
  const AL = freshBattle(loadAL()); // player is first player, turn 1 is theirs
  setHand(AL, AL.state.player, []);
  AL.endTurn(); // player's turn 1 ends with nothing played -> opponent's turn starts

  // Opponent's own turn starts, they play Crippling Blow (real card, real
  // applyCardEffect() path, not a hand-set stack like the other tests) on
  // the player -- exactly QA's repro methodology.
  AL.applyRemoteAction({ type: 'turnStart', drawCount: 0 });
  AL.state.opponent.mana = 3;
  setHand(AL, AL.state.opponent, ['cripplingBlow']);
  const playerHpBeforeCB = AL.state.player.hp;
  AL.applyRemoteAction({ type: 'playCard', cardId: 'cripplingBlow' });
  assert(AL.state.player.weaken === 1, `Crippling Blow grants exactly Weaken 1 to the player (got ${AL.state.player.weaken})`);
  assert(
    AL.state.player.hp === playerHpBeforeCB - 8,
    `Crippling Blow's own 8 damage lands on the player in full (unaffected by the Weaken IT grants, which applies to the player's own FUTURE Attack damage, not damage the player takes) (hp ${AL.state.player.hp}, expected ${playerHpBeforeCB - 8})`
  );

  // Opponent ends their turn -> player's own turn starts.
  AL.applyRemoteAction({ type: 'endTurn' });
  assert(
    AL.state.player.weaken === 1,
    `player's Weaken 1 is STILL 1 the instant their own turn starts -- this is exactly the off-by-one QA caught (it used to already be 0 here) (got ${AL.state.player.weaken})`
  );

  // Player plays Strike on their very next turn -- the one turn Weaken 1 is
  // supposed to cover.
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']);
  const oppHpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  const dealt = oppHpBefore - AL.state.opponent.hp;
  assert(dealt === 4.5, `Strike (6 base) is reduced by the still-active Weaken 1 to 6*0.75=4.5, un-floored -- Crippling Blow's Weaken grant is NOT a no-op (got ${dealt})`);

  // That was the character's one effective turn -- decay fires when THIS turn ends.
  AL.endTurn();
  assert(AL.state.player.weaken === 0, `Weaken decays to 0 once the player's own turn (during which it was active) ends (got ${AL.state.player.weaken})`);

  // Confirm there's no SECOND effective turn -- a Weaken-1 grant covers
  // exactly 1 turn, not 2.
  AL.applyRemoteAction({ type: 'turnStart', drawCount: 0 });
  AL.applyRemoteAction({ type: 'endTurn' });
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']);
  const oppHpBefore2 = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  const dealt2 = oppHpBefore2 - AL.state.opponent.hp;
  assert(dealt2 === 6, `the player's NEXT turn after that deals full, unreduced damage -- Weaken 1 delivered exactly 1 effective turn, not more (got ${dealt2})`);
}

console.log('\n== Test E: Weaken is public/mirrored state on BOTH sides, wired symmetrically regardless of which side is "actor" ==');
{
  const AL = freshBattle(loadAL());
  // Force it to be the opponent's turn so applyRemoteCardPlay() (the path a
  // real opponent client's played card takes on THIS client) is reachable.
  AL.state.turn = 'opponent';
  AL.state.opponent.weaken = 1;
  AL.state.opponent.mana = 3;
  setHand(AL, AL.state.opponent, ['strike']);
  const hpBefore = AL.state.player.hp;
  AL.applyRemoteAction({ type: 'playCard', cardId: 'strike' });
  const dealt = hpBefore - AL.state.player.hp;
  assert(
    dealt === 4.5,
    `opponent's own Weaken (public/mirrored, exactly like block/hp) reduces THEIR Attack-card damage against the local player the same way (6*0.75=4.5, un-floored) (got ${dealt})`
  );
  assert(
    typeof AL.state.opponent.weaken === 'number' && AL.state.player.hp === hpBefore - 4.5,
    'weaken stacks and their damage effect are visible on state.opponent directly (no HIDDEN-style masking, unlike hand contents)'
  );
}

console.log('\n== Test G (new, Option B): a second .5-damage hit accumulates to a whole number, not floating-point drift ==');
// docs/design/fractional-damage-proposal.md §5.2: HP can persist as .5
// across turns/plays. This checks the specific real-number concern the task
// flagged -- does a SECOND fractional hit compound correctly (4.5 + 4.5 = 9
// exactly), rather than accumulating IEEE754 rounding error. In practice
// this domain is safe by construction: every value Weaken ever produces is
// an integer or an exact multiple of 0.5 (§2.2), and 0.5 is 2^-1 -- exactly
// representable in binary floating point -- so sums/differences of these
// values can never drift, but this is worth proving with a real two-hit
// sequence rather than just asserting it from the math.
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike', 'strike']); // two independent 4.5 hits
  const hpBefore = AL.state.opponent.hp; // 50

  playSelfOrTarget(AL, 0); // first Strike (now at hand index 0 again after splice)
  const afterFirst = AL.state.opponent.hp;
  assert(afterFirst === hpBefore - 4.5, `first Weakened Strike leaves HP at exactly ${hpBefore - 4.5} (got ${afterFirst})`);

  playSelfOrTarget(AL, 0); // second Strike
  const afterSecond = AL.state.opponent.hp;
  assert(afterSecond === hpBefore - 9, `two consecutive Weakened Strikes (4.5 each) land on the exact whole number ${hpBefore - 9}, no drift (got ${afterSecond})`);
  assert(Number.isInteger(afterSecond), `the accumulated result is a real, exact integer in JS (not e.g. 40.99999999999999) (got ${afterSecond})`);
}

console.log('\n== Test H (new, Option B): block partially absorbing a fractional hit WITHOUT fully depleting leaves block itself fractional (fractional-damage-proposal.md §5.3 Example 2) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']); // base 6 -> 4.5 after Weaken
  AL.state.opponent.block = 20; // deliberately overkill block, per §5.3 Example 2
  const hpBefore = AL.state.opponent.hp;

  playSelfOrTarget(AL, 0);

  assert(AL.state.opponent.hp === hpBefore, `HP is completely untouched -- block alone absorbed the whole 4.5 hit (got ${AL.state.opponent.hp}, expected unchanged ${hpBefore})`);
  assert(AL.state.opponent.block === 15.5, `block itself is left holding the fractional remainder (20 - 4.5 = 15.5), the case the original task framing didn't anticipate (got ${AL.state.opponent.block})`);
}

console.log('\n== Test I (new, Option B): the display layer (real js/ui.js, not a re-implementation) renders fractional HP/block/damage-popup values rounded, per §5.4 ==');
{
  const { AL, document } = loadALWithUI();
  freshBattle(AL);

  // --- I.1: opponent HP text + damage popup rounding, HP ends fractional ---
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']); // 6*0.75 = 4.5 unblocked
  playSelfOrTarget(AL, 0); // triggers a real emit() -> UI.render() -> real DOM writes

  const hpText = document.getElementById('opponent-hp-text').textContent;
  assert(
    hpText === '46 / 50',
    `opponent HP text renders the internal 45.5 rounded to a whole number ("46 / 50", round-half-up per §5.4) while state stays fractional (got "${hpText}", internal hp ${AL.state.opponent.hp})`
  );
  assert(AL.state.opponent.hp === 45.5, `internal state itself is NOT touched by the display rounding -- still the real 45.5 (got ${AL.state.opponent.hp})`);

  const popups = document.getElementById('dmg-popup-layer').children;
  const lastPopup = popups[popups.length - 1];
  assert(
    !!lastPopup && lastPopup.textContent === '-5',
    `the damage popup for this same 4.5 hit also renders rounded ("-5", Math.round(4.5)=5), through the same fmtStat() wrapper as the HP text (got "${lastPopup && lastPopup.textContent}")`
  );

  // --- I.2: block text rounds a fractional block value (§5.3 Example 2 seen through the UI) ---
  AL.state.opponent.block = 15.5; // as Test H established this can happen; the
  // next state-mutating action below (a self-targeted Defend) fires the same
  // real emit() -> UI.render() path used everywhere else, forcing a fresh
  // render against this manually-set value.
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['defend']); // any self-targeted no-op-ish action just to force a fresh emit()/render()
  playSelfOrTarget(AL, 0);

  const blockText = document.getElementById('opponent-block-text').textContent;
  assert(
    blockText === '16',
    `opponent block text renders the fractional 15.5 rounded to "16" (round-half-up) (got "${blockText}")`
  );
  const blockWrapHidden = document.getElementById('opponent-block-wrap').classList.contains('hidden');
  assert(!blockWrapHidden, `the block wrap is visible (not hidden) while block is a positive fractional value (15.5 > 0) (hidden=${blockWrapHidden})`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
