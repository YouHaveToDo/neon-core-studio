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

console.log('\n== Test A: Weaken reduces an Attack card\'s damage by 25% (floored), no Bloodlust involved ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']); // base 6, no bonus
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  const dealt = hpBefore - AL.state.opponent.hp;
  assert(dealt === 4, `Strike (6 base) with Weaken 1 deals floor(6*0.75)=4 damage (got ${dealt})`);
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
  assert(dealtToTarget === 9, `Reckless Swing's 12 target damage is reduced by Weaken to floor(12*0.75)=9 (got ${dealtToTarget})`);
  assert(selfRecoil === 3, `Reckless Swing's fixed 3 self-recoil is NOT reduced by Weaken (it's not Attack-card damage dealt to a target) (got ${selfRecoil})`);
}

console.log('\n== Test B: Bloodlust + Weaken interaction, exact numbers from the task spec (base 10 + Bloodlust 4 = 14, x0.75 floored = 10) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.powers.bloodlust = 2; // attackBonus() = stacks * 2 = 4
  AL.state.player.weaken = 1;
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['piercingStrike']); // base 10, ignoreBlock=true
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  const dealt = hpBefore - AL.state.opponent.hp;
  assert(dealt === 10, `Piercing Strike: base 10 + Bloodlust bonus 4 = 14, x0.75 floored = 10 (got ${dealt})`);
}

console.log('\n== Test C: Weaken order also holds with block present (steps 3 then 4, not the other way around) ==');
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
  // Step 3 first: floor(6*0.75) = 4. Step 4: 4 - 3 block = 1 to HP, block -> 0.
  // (If block were subtracted BEFORE Weaken instead, wrong order would give
  // floor((6-3)*0.75) = 2 to HP with block at 0 -- a different, wrong number,
  // so this also catches an accidental step-3/step-4 swap.)
  assert(dealt === 1, `Weaken applies BEFORE block (floor(6*0.75)=4, then -3 block = 1 to HP), not after (got ${dealt} dealt)`);
  assert(blockLeft === 0, `all 3 block consumed (got ${blockLeft} left)`);
}

console.log('\n== Test D: turn-end decay removes exactly 1 stack, on the WEAKENED character\'s own turn boundary, never the opponent\'s ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.weaken = 2;
  AL.state.opponent.weaken = 3;
  setHand(AL, AL.state.player, []); // nothing to play this turn

  AL.endTurn(); // player's own turn ends -> turn becomes 'opponent'
  assert(
    AL.state.player.weaken === 2,
    `player's Weaken is UNCHANGED right when their own turn ends -- decay fires at their own next turn-START boundary, not at endTurn() itself (got ${AL.state.player.weaken})`
  );

  // The opponent's real client now starts ITS OWN turn -- this is the
  // OPPONENT's own turn boundary, so only opponent.weaken should decay.
  AL.applyRemoteAction({ type: 'turnStart', drawCount: 0 });
  assert(
    AL.state.opponent.weaken === 2,
    `opponent's Weaken decays by 1 (3 -> 2) on the OPPONENT's own turn-start boundary (got ${AL.state.opponent.weaken})`
  );
  assert(
    AL.state.player.weaken === 2,
    `player's Weaken is untouched by the OPPONENT's turn boundary (still 2) -- decay never fires on the other side's boundary (got ${AL.state.player.weaken})`
  );

  // Opponent ends their turn -> player's own turn starts again (localTurnStart()).
  AL.applyRemoteAction({ type: 'endTurn' });
  assert(
    AL.state.player.weaken === 1,
    `player's Weaken decays by 1 (2 -> 1) on the PLAYER's own turn-start boundary (got ${AL.state.player.weaken})`
  );
  assert(
    AL.state.opponent.weaken === 2,
    `opponent's Weaken is untouched by the player's own turn boundary (still 2) (got ${AL.state.opponent.weaken})`
  );

  // Run one more full cycle to bring player's Weaken down to 0, then confirm
  // it floors at 0 (never negative) and stops reducing damage.
  AL.endTurn();
  AL.applyRemoteAction({ type: 'turnStart', drawCount: 0 });
  AL.applyRemoteAction({ type: 'endTurn' });
  assert(AL.state.player.weaken === 0, `player's Weaken reaches exactly 0 after a second full cycle (got ${AL.state.player.weaken})`);

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
    dealt === 4,
    `opponent's own Weaken (public/mirrored, exactly like block/hp) reduces THEIR Attack-card damage against the local player the same way (floor(6*0.75)=4) (got ${dealt})`
  );
  assert(
    typeof AL.state.opponent.weaken === 'number' && AL.state.player.hp === hpBefore - 4,
    'weaken stacks and their damage effect are visible on state.opponent directly (no HIDDEN-style masking, unlike hand contents)'
  );
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
