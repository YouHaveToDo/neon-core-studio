/* Node vm-harness test for the 8 expansion-pool cards (docs/design/
 * card-shop-currency-proposal.md §4, Phase 3 of the card-shop-currency
 * milestone). Same loading pattern as scripts/weaken-status-test.js (Phase
 * 1) -- js/data.js + js/state.js are plain global <script> files with no
 * browser-only globals, so they load directly into a `vm` context and can be
 * exercised exactly like a real page would, without a server/DB/browser.
 *
 * Covers, per card: the mechanical effect itself (damage/block/draw/Weaken
 * numbers matching §4's table exactly), and where relevant, its interaction
 * with the Weaken engine already covered end-to-end by weaken-status-test.js
 * (this file doesn't re-prove the general Weaken engine, only that these 8
 * specific cards are wired into it correctly). Also confirms cardById()
 * resolves expansion ids (not just core CARD_DEFS) now that js/state.js
 * looks them up via the shared cardDefById() helper.
 *
 * Usage: node scripts/expansion-cards-test.js
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
  const sandbox = { setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc, sandbox, { filename: 'js/data.js' });
  vm.runInContext(stateSrc, sandbox, { filename: 'js/state.js' });
  return vm.runInContext('AL', sandbox);
}

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
  if (AL.state.selected === handIndex) AL.targetOpponent();
}

console.log('\n== cardById() resolves expansion-pool ids (js/data.js EXPANSION_CARD_DEFS via cardDefById) ==');
{
  const AL = freshBattle(loadAL());
  const ids = ['enfeeble', 'cripplingBlow', 'exploitWeakness', 'overextend', 'steadyBreath', 'corrosiveAura', 'crushingCurse', 'opportunist'];
  ids.forEach((id) => {
    const def = AL.cardById(id);
    assert(!!def && def.id === id, `cardById('${id}') resolves to a real card def (got ${JSON.stringify(def)})`);
  });
}

console.log('\n== Enfeeble: 0 damage, grants 2 Weaken to the opponent ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['enfeeble']);
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  assert(AL.state.opponent.hp === hpBefore, `Enfeeble deals 0 damage (opponent HP unchanged, got ${hpBefore - AL.state.opponent.hp} dealt)`);
  assert(AL.state.opponent.weaken === 2, `Enfeeble grants the opponent 2 Weaken (got ${AL.state.opponent.weaken})`);
}

console.log('\n== Crippling Blow: 8 damage, grants 1 Weaken to the opponent ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['cripplingBlow']);
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  assert(hpBefore - AL.state.opponent.hp === 8, `Crippling Blow deals 8 damage (got ${hpBefore - AL.state.opponent.hp})`);
  assert(AL.state.opponent.weaken === 1, `Crippling Blow grants the opponent 1 Weaken (got ${AL.state.opponent.weaken})`);
}

console.log('\n== Exploit Weakness: 8 damage normally, 16 if the opponent is already Weakened ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['exploitWeakness']);
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  assert(hpBefore - AL.state.opponent.hp === 8, `Exploit Weakness deals 8 damage when the opponent has no Weaken (got ${hpBefore - AL.state.opponent.hp})`);
}
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  AL.state.opponent.weaken = 1; // opponent already weakened
  setHand(AL, AL.state.player, ['exploitWeakness']);
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  // Opponent has Weaken 1 but that reduces THEIR outgoing damage, not damage
  // dealt TO them -- Exploit Weakness itself is the player's own Attack
  // card, and the player has no Weaken here, so the full 16 lands.
  assert(hpBefore - AL.state.opponent.hp === 16, `Exploit Weakness deals 16 damage when the opponent already has Weaken >=1 (got ${hpBefore - AL.state.opponent.hp})`);
}

console.log('\n== Overextend: 10 damage to the opponent, grants 2 Weaken to SELF (not the opponent) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['overextend']);
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  assert(hpBefore - AL.state.opponent.hp === 10, `Overextend deals 10 damage to the opponent (got ${hpBefore - AL.state.opponent.hp})`);
  assert(AL.state.player.weaken === 2, `Overextend grants the ACTOR (self) 2 Weaken (got ${AL.state.player.weaken})`);
  assert(AL.state.opponent.weaken === 0, `Overextend does not Weaken the opponent (got ${AL.state.opponent.weaken})`);
}
console.log('\n== Overextend: self-Weaken is granted AFTER this card\'s own damage is computed (does not reduce its own hit) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  AL.state.player.weaken = 0; // starts clean
  setHand(AL, AL.state.player, ['overextend']);
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  assert(hpBefore - AL.state.opponent.hp === 10, `Overextend's own hit is the full, un-self-weakened 10 (got ${hpBefore - AL.state.opponent.hp})`);
}

console.log('\n== Steady Breath: clears all of the actor\'s own Weaken stacks, grants 3 block ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  AL.state.player.weaken = 5;
  setHand(AL, AL.state.player, ['steadyBreath']);
  playSelfOrTarget(AL, 0);
  assert(AL.state.player.weaken === 0, `Steady Breath clears the actor's Weaken stack entirely (got ${AL.state.player.weaken})`);
  assert(AL.state.player.block === 3, `Steady Breath grants 3 block (got ${AL.state.player.block})`);
}
console.log('\n== Steady Breath: does not affect the opponent\'s Weaken ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  AL.state.player.weaken = 2;
  AL.state.opponent.weaken = 4;
  setHand(AL, AL.state.player, ['steadyBreath']);
  playSelfOrTarget(AL, 0);
  assert(AL.state.opponent.weaken === 4, `opponent's Weaken is untouched by Steady Breath (got ${AL.state.opponent.weaken})`);
}

console.log('\n== Crushing Curse: 4 damage, grants 3 Weaken to the opponent ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['crushingCurse']);
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  assert(hpBefore - AL.state.opponent.hp === 4, `Crushing Curse deals 4 damage (got ${hpBefore - AL.state.opponent.hp})`);
  assert(AL.state.opponent.weaken === 3, `Crushing Curse grants the opponent 3 Weaken (got ${AL.state.opponent.weaken})`);
}

console.log('\n== Opportunist: draws 1 normally, draws 2 total if the opponent is Weakened ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['opportunist', 'strike', 'strike', 'strike']);
  const handBefore = AL.state.player.hand.length;
  playSelfOrTarget(AL, 0);
  // opportunist itself leaves the hand (played), plus however many cards it drew.
  const handAfter = AL.state.player.hand.length;
  assert(handAfter === handBefore - 1 + 1, `Opportunist draws exactly 1 card when the opponent has no Weaken (hand went ${handBefore} -> ${handAfter})`);
}
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  AL.state.opponent.weaken = 1;
  setHand(AL, AL.state.player, ['opportunist', 'strike', 'strike', 'strike']);
  const handBefore = AL.state.player.hand.length;
  playSelfOrTarget(AL, 0);
  const handAfter = AL.state.player.hand.length;
  assert(handAfter === handBefore - 1 + 2, `Opportunist draws 2 cards total when the opponent already has Weaken >=1 (hand went ${handBefore} -> ${handAfter})`);
}

console.log('\n== Corrosive Aura: grants no immediate effect itself, but every subsequent Attack card grants the opponent Weaken 1 ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['corrosiveAura']);
  playSelfOrTarget(AL, 0);
  assert(AL.state.player.powers.corrosiveAura === 1, `Corrosive Aura grants the actor 1 stack of the passive (got ${AL.state.player.powers.corrosiveAura})`);
  assert(AL.state.opponent.weaken === 0, `Corrosive Aura itself grants no Weaken on play (got ${AL.state.opponent.weaken})`);

  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']);
  playSelfOrTarget(AL, 0);
  assert(AL.state.opponent.weaken === 1, `an ordinary core-pool Strike played after Corrosive Aura grants the opponent 1 Weaken via the passive (got ${AL.state.opponent.weaken})`);
}
console.log('\n== Corrosive Aura: does not trigger off Enfeeble (0-damage Attack card) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['corrosiveAura']);
  playSelfOrTarget(AL, 0);
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['enfeeble']);
  playSelfOrTarget(AL, 0);
  // Enfeeble's own effect (2 Weaken) still applies, but Corrosive Aura's
  // extra +1 must NOT stack on top of it.
  assert(AL.state.opponent.weaken === 2, `Enfeeble's own 2 Weaken applies, but Corrosive Aura does not add a 3rd stack on top of a 0-damage Attack card (got ${AL.state.opponent.weaken})`);
}
console.log('\n== Corrosive Aura: does not trigger off Skill/Power cards (target !== enemy) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['corrosiveAura']);
  playSelfOrTarget(AL, 0);
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['defend']);
  playSelfOrTarget(AL, 0);
  assert(AL.state.opponent.weaken === 0, `playing a Skill card (Defend) after Corrosive Aura does not grant the opponent Weaken (got ${AL.state.opponent.weaken})`);
}
console.log('\n== Corrosive Aura: stacks compound (2 copies -> 2 Weaken per subsequent Attack card) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['corrosiveAura']);
  playSelfOrTarget(AL, 0);
  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['corrosiveAura']);
  playSelfOrTarget(AL, 0);
  assert(AL.state.player.powers.corrosiveAura === 2, `2 copies of Corrosive Aura compound to a stack of 2 (got ${AL.state.player.powers.corrosiveAura})`);

  AL.state.player.mana = 3;
  setHand(AL, AL.state.player, ['strike']);
  playSelfOrTarget(AL, 0);
  assert(AL.state.opponent.weaken === 2, `with 2 stacks, one Attack card grants 2 Weaken at once (got ${AL.state.opponent.weaken})`);
}

console.log('\n== Bloodlust interacts with expansion Attack cards\' base damage the same generic way it does with core cards ==');
{
  const AL = freshBattle(loadAL());
  AL.state.player.mana = 3;
  AL.state.player.powers.bloodlust = 1; // attackBonus() = +2
  setHand(AL, AL.state.player, ['cripplingBlow']);
  const hpBefore = AL.state.opponent.hp;
  playSelfOrTarget(AL, 0);
  assert(hpBefore - AL.state.opponent.hp === 10, `Crippling Blow (base 8) + Bloodlust bonus 2 = 10 damage (got ${hpBefore - AL.state.opponent.hp})`);
}

console.log('\n== spec §6.3.1 first-turn attack lock still gates every enemy-targeted expansion card (all are type:attack, §4.2) ==');
{
  const AL = freshBattle(loadAL());
  AL.state.firstTurnAttackLock = true; // re-enable the lock this test harness normally clears
  AL.state.player.mana = 3;
  ['enfeeble', 'cripplingBlow', 'exploitWeakness', 'overextend', 'crushingCurse'].forEach((id) => {
    setHand(AL, AL.state.player, [id]);
    assert(AL.canPlay(0) === false, `${id} is NOT playable during the first player's turn-1 attack lock (type:'attack') (canPlay=${AL.canPlay(0)})`);
  });
  ['steadyBreath', 'corrosiveAura', 'opportunist'].forEach((id) => {
    setHand(AL, AL.state.player, [id]);
    assert(AL.canPlay(0) === true, `${id} IS still playable during the first-turn attack lock (Skill/Power, target:'self') (canPlay=${AL.canPlay(0)})`);
  });
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
