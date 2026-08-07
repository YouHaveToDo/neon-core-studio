/* Playwright regression test for QA finding #1 (the Blocker), docs/qa/
 * online-pvp-milestone.md: server-enforced turn timeout didn't actually
 * force the PASSIVE (non-timed-out) player's game state to advance when the
 * active player's client was genuinely unresponsive (JS main thread frozen
 * by a synchronous busy-loop), and recovering from that produced real
 * hand-count corruption (6 -> 11 cards).
 *
 * Scenarios 1-2 cover the original Blocker fix (f157db8). Scenarios 3-4
 * (added for the Follow-up verification re-check in the same QA doc,
 * 2026-08-05) cover the regression THAT fix introduced: applyRemoteEndTurn()
 * being reachable from both the new reconciliation path and the pre-existing
 * peer `endTurn` action with no shared idempotency guard, so a stale
 * `endTurn` arriving after reconciliation already handled a turn boundary
 * silently re-ran localTurnStart() and reset the passive player's own
 * mana/block. QA's report explicitly flags why Scenarios 1-2 alone didn't
 * catch this: they only ever poll/observe the passive client during the
 * freeze, never have it actually act. Scenario 3 closes that gap (same real
 * two-process freeze methodology). Scenario 4 covers the reverse message
 * ordering directly against the state machine -- see its own doc comment for
 * why a real network race can't produce that ordering here, and why the fix
 * (and this test) don't rely on that being true.
 *
 * This deliberately reproduces QA's own methodology, not a simplified
 * happy-path stand-in:
 *   - TWO SEPARATE `chromium.launch()` browser PROCESSES, not two contexts
 *     of one instance. QA's report flags this explicitly: two contexts of
 *     one process share enough internals that the PASSIVE side's own
 *     Playwright evaluate() calls can appear to stall for the same duration
 *     as the freeze, which looks like the bug but is actually a test-
 *     harness artifact. Only fully separate processes prove the fix works
 *     against a GENUINELY unresponsive client, not just a slow one.
 *   - A real synchronous busy-loop (`while (Date.now() < end) {}`) run via
 *     page.evaluate() on the active player's page, blocking that page's
 *     entire JS main thread (including its own WS message handling) for
 *     several seconds -- not a network-level delay, not a mocked timeout.
 *   - The real client bundle (index.html + js/*.js) driven through actual
 *     signup/deck-select/lobby/room flow, talking to a real spawned server
 *     instance with a short PVP_TURN_TIMEOUT_MS override (same override
 *     mechanism scripts/pvp-smoke-test.js already uses).
 *
 * What this asserts (both must hold, matching the task's explicit ask --
 * "confirm the OTHER client's view of the match correctly advances and
 * stays desync-free", not just "looks fixed in a happy path"):
 *   1. The PASSIVE client's turn flips to 'player' close to the server's
 *      turn_timeout deadline, NOT close to when the frozen tab's busy-loop
 *      happens to end (the exact ~8537ms-matches-freeze-end signature QA's
 *      report documents as the bug).
 *   2. The passive client's hand count at that moment is the correct,
 *      un-corrupted value (their untouched opening-hand count for turn 1 --
 *      QA's exact 6->11 corruption never happens).
 * A third, softer check confirms both clients still agree on whose turn it
 * is once the frozen tab finally wakes up and catches itself up (no lasting
 * desync).
 *
 * Usage: NODE_PATH=<dir containing a 'playwright' install> node
 *   scripts/frozen-client-turn-timeout-test.js
 * (playwright is not a project dependency -- small team, don't add a
 * browser-automation dependency to the shipped server for one QA-style
 * regression script. Point NODE_PATH at any local playwright install, e.g.
 * an npx cache: `npm root -g` or `~/.npm/_npx/<hash>/node_modules`.)
 *
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations applied, port 3001 free (the client hard-codes
 * API_BASE_URL=http://localhost:3001, js/api.js -- this test spawns the
 * real server on that exact port rather than the other smoke tests'
 * dedicated-port pattern, specifically so the unmodified real client works
 * against it), and port 8080 free (this test's own static file server for
 * index.html/js/css).
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (err) {
  console.error(
    'Could not load "playwright". Point NODE_PATH at a local playwright install, e.g.:\n' +
      '  NODE_PATH=~/.npm/_npx/<hash>/node_modules node scripts/frozen-client-turn-timeout-test.js\n' +
      `(original error: ${err.message})`
  );
  process.exit(1);
}

const SERVER_PORT = 3001; // must match js/api.js's hard-coded API_BASE_URL
const STATIC_PORT = 8080;
const REPO_ROOT = path.join(__dirname, '..', '..');
const TURN_TIMEOUT_MS = 5000; // short override, see config.js's PVP_TURN_TIMEOUT_MS
const FREEZE_MS = TURN_TIMEOUT_MS + 4000; // comfortably longer than the timeout, mirrors QA's ~1.4x ratio

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.log(`  FAIL  ${msg}`);
    failures += 1;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractCookie(res) {
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) return null;
  const [nameValue] = setCookie.split(';');
  const idx = nameValue.indexOf('=');
  return { name: nameValue.slice(0, idx), value: nameValue.slice(idx + 1) };
}

async function signup(displayName) {
  const rand = Math.random().toString(36).slice(2, 8);
  const email = `frozen-${rand}@example.com`;
  const res = await fetch(`http://localhost:${SERVER_PORT}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', confirmPassword: 'password123', displayName }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  const cookie = extractCookie(res);
  return { email, cookie, accountId: body.account.id, displayName };
}

function startStaticServer() {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (reqPath === '/') reqPath = '/index.html';
    const filePath = path.join(REPO_ROOT, reqPath);
    if (!filePath.startsWith(REPO_ROOT)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('not found');
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(STATIC_PORT, () => resolve(server)));
}

async function waitForServerReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${SERVER_PORT}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error('server did not become ready in time');
}

async function waitFor(page, fn, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate(fn)) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function loginAndReachLobby(browser, account) {
  const context = await browser.newContext();
  await context.addCookies([
    { name: account.cookie.name, value: account.cookie.value, domain: 'localhost', path: '/', httpOnly: true, secure: false },
  ]);
  const page = await context.newPage();
  await page.goto(`http://localhost:${STATIC_PORT}/index.html`);

  await waitFor(page, () => !document.getElementById('screen-main-menu').classList.contains('hidden'));
  await page.click('#btn-menu-play');
  await waitFor(page, () => !document.getElementById('screen-deck-select').classList.contains('hidden'));
  await waitFor(page, () => !!document.querySelector('.deck-select-tile.selectable'));
  await page.click('.deck-select-tile.selectable'); // slot 1 = auto-created starter deck, always valid
  await waitFor(page, () => !document.getElementById('screen-lobby').classList.contains('hidden'));

  return { context, page };
}

// Shared setup for both scenarios below: two separate browser processes,
// real login -> deck select -> lobby -> room create/join, both landing on
// the auto-shown How-to-Play overlay (docs/design/onboarding.md). Does NOT
// dismiss How-to-Play itself -- Scenario 1 dismisses both immediately
// (testing the frozen-client path in isolation), Scenario 2 deliberately
// leaves the ACTIVE player's overlay open (that's the whole point of Repro
// B), so that decision is left to each scenario.
// spec-online-pvp.md §6.2 (2026-08 revision): room-code create/join was
// replaced by open room-list matchmaking (see the task report for the
// migration) -- host creates via '+ 방 만들기' and waits, the other client
// finds the room in its polled list and clicks the row to join (no code
// typed by anyone). Updated here to drive the real new UI instead of the
// retired #lobby-code/#lobby-join-input elements.
async function setUpTwoClientsAtHowto(aliceName, bobName) {
  const alice = await signup(aliceName);
  const bob = await signup(bobName);

  const [browserA, browserB] = await Promise.all([chromium.launch(), chromium.launch()]);
  const [{ page: pageA }, { page: pageB }] = await Promise.all([
    loginAndReachLobby(browserA, alice),
    loginAndReachLobby(browserB, bob),
  ]);

  await pageA.click('#btn-lobby-create');
  await waitFor(pageA, () => !document.getElementById('lobby-panel-waiting').classList.contains('hidden'));

  // pageB is already sitting on the room-list screen (loginAndReachLobby
  // waits for #screen-lobby to unhide) -- click the manual refresh button on
  // each poll iteration so this doesn't have to wait out the full 3s auto-
  // poll interval (spec §6.2.3) to see Alice's just-created room show up.
  await waitFor(pageB, () => {
    const refreshBtn = document.getElementById('btn-lobby-refresh');
    if (refreshBtn) refreshBtn.click();
    return document.querySelectorAll('#room-list .room-row').length > 0;
  }, { timeoutMs: 15000 });
  await pageB.click('.room-row');

  await waitFor(pageA, () => typeof AL !== 'undefined' && AL.state.screen === 'howto', { timeoutMs: 15000 });
  await waitFor(pageB, () => typeof AL !== 'undefined' && AL.state.screen === 'howto', { timeoutMs: 15000 });

  return { browserA, browserB, pageA, pageB };
}

async function scenario1FrozenClient() {
  console.log('\n\n########## SCENARIO 1: genuinely unresponsive (frozen JS) active client ##########');
  let browserA;
  let browserB;
  try {
    console.log('\n== signup two accounts, launch two SEPARATE chromium processes, reach How-to-Play ==');
    const setup = await setUpTwoClientsAtHowto('AliceFrozen', 'BobFrozen');
    browserA = setup.browserA;
    browserB = setup.browserB;
    const { pageA, pageB } = setup;

    console.log('== both clients dismiss How-to-Play normally (this scenario isolates the frozen-client path, not Repro B) ==');
    await pageA.click('#btn-howto-close');
    await pageB.click('#btn-howto-close');
    await waitFor(pageA, () => AL.state.screen === 'battle');
    await waitFor(pageB, () => AL.state.screen === 'battle');
    console.log('  both clients at the battle screen');

    // Determine which page is ACTIVE (turn 1's owner, to be frozen) vs.
    // PASSIVE (to be polled) -- host-vs-guest coin flip is a deterministic
    // function of the room code (js/match.js), so figure out which page won
    // it rather than assuming.
    const aliceIsActive = await pageA.evaluate(() => AL.state.turn === 'player');
    const activePage = aliceIsActive ? pageA : pageB;
    const passivePage = aliceIsActive ? pageB : pageA;
    console.log(`  active (to freeze): ${aliceIsActive ? 'Alice' : 'Bob'}; passive (to poll): ${aliceIsActive ? 'Bob' : 'Alice'}`);

    const passiveHandBefore = await passivePage.evaluate(() => AL.state.player.hand.length);
    assert(
      passiveHandBefore === 5,
      `passive client's own hand is the untouched turn-1 opening draw, 5 cards, before anything happens (got ${passiveHandBefore})`
    );
    assert(
      (await passivePage.evaluate(() => AL.state.turn)) === 'opponent',
      "passive client correctly sees it as the opponent's (active player's) turn before the freeze"
    );

    console.log(`\n== freezing the ACTIVE page's JS main thread for ${FREEZE_MS}ms (turn_timeout is configured for ${TURN_TIMEOUT_MS}ms) ==`);
    const freezeStartedAt = Date.now();
    // Deliberately NOT awaited here -- this promise only resolves once the
    // busy-loop itself finishes inside that page. Awaiting it now would
    // block THIS script's own event loop from concurrently polling the
    // other (passive) page, defeating the entire point of the test.
    const freezePromise = activePage
      .evaluate((ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          /* deliberately synchronous, blocks this page's JS thread */
        }
        return true;
      }, FREEZE_MS)
      .catch((err) => {
        console.error('  freeze evaluate() rejected unexpectedly:', err.message);
        return false;
      });

    // Poll the PASSIVE client's real game state while the active client is
    // frozen, recording the exact moment (relative to freezeStartedAt) its
    // turn flips to 'player'.
    let observedFlipAtMs = null;
    let handAtFlip = null;
    const pollUntilMs = FREEZE_MS + 2000;
    while (Date.now() - freezeStartedAt < pollUntilMs) {
      const snapshot = await passivePage.evaluate(() => ({
        turn: AL.state.turn,
        handLen: AL.state.player.hand.length,
      }));
      if (snapshot.turn === 'player' && observedFlipAtMs === null) {
        observedFlipAtMs = Date.now() - freezeStartedAt;
        handAtFlip = snapshot.handLen;
        break; // found what we need -- stop polling, let the freeze run out on its own below
      }
      await sleep(250);
    }

    assert(observedFlipAtMs !== null, 'passive client\'s turn DID flip to \'player\' at some point during the freeze window (not stuck forever)');
    if (observedFlipAtMs !== null) {
      assert(
        observedFlipAtMs < FREEZE_MS - 1500,
        `passive client's turn flipped well BEFORE the frozen tab's busy-loop ended (flipped at +${observedFlipAtMs}ms, freeze runs ${FREEZE_MS}ms) -- ` +
          `this is the actual fix: it must be driven by the server's turn_started broadcast, not by waiting for the frozen client to wake up and self-report`
      );
      assert(
        observedFlipAtMs >= TURN_TIMEOUT_MS - 500 && observedFlipAtMs <= TURN_TIMEOUT_MS + 2500,
        `passive client's turn flipped close to the server's ${TURN_TIMEOUT_MS}ms turn_timeout deadline, not at an arbitrary later point (flipped at +${observedFlipAtMs}ms)`
      );
      assert(
        handAtFlip === 5,
        `passive client's hand is STILL exactly 5 cards at the moment their turn starts -- no double-draw corruption ` +
          `(QA's original repro predates spec-online-pvp.md §6.3.2's 2026-08 revert to symmetric 5/5 opening draw, ` +
          `when the second player's opening hand was 6 and the bug grew it 6 -> 11 -- same invariant, current count; got ${handAtFlip})`
      );
    }

    console.log('\n== waiting for the frozen tab to actually wake up, then checking both clients converge with no lasting desync ==');
    await freezePromise; // now safe/expected to wait -- the busy-loop should be done or nearly done
    await sleep(500); // let any queued messages on the formerly-frozen tab actually process

    const finalActiveTurn = await activePage.evaluate(() => AL.state.turn);
    const finalPassiveTurn = await passivePage.evaluate(() => AL.state.turn);
    assert(
      finalActiveTurn === 'opponent' && finalPassiveTurn === 'player',
      `both clients agree on whose turn it is after the frozen tab recovers -- formerly-active now sees 'opponent', ` +
        `formerly-passive still sees 'player' (got active=${finalActiveTurn}, passive=${finalPassiveTurn})`
    );

    const finalActiveOwnHand = await activePage.evaluate(() => AL.state.player.hand.length);
    assert(
      finalActiveOwnHand === 0,
      `the formerly-frozen (now-inactive) client's own hand was actually discarded once it caught up, not left stale (got ${finalActiveOwnHand} cards)`
    );
  } finally {
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
  }
}

// QA's Repro B (docs/qa/online-pvp-milestone.md): the ACTIVE player simply
// never dismisses their own auto-shown How-to-Play overlay past their own
// turn_timeout deadline -- no frozen JS thread involved at all, the client
// is perfectly responsive, just parked on a sub-screen. Before the fix,
// handleTurnTimeout() in js/battle.js early-returned whenever
// AL.state.screen !== 'battle', so the timeout was silently dropped and
// BOTH players stayed stuck (the active player keeps their turn
// indefinitely, the passive player never sees it become their turn).
async function scenario2HowToPlayLeftOpen() {
  console.log('\n\n########## SCENARIO 2: active player leaves How-to-Play open past their own timeout ##########');
  let browserA;
  let browserB;
  try {
    console.log('\n== signup two accounts, launch two SEPARATE chromium processes, reach How-to-Play ==');
    const setup = await setUpTwoClientsAtHowto('AliceHowto', 'BobHowto');
    browserA = setup.browserA;
    browserB = setup.browserB;
    const { pageA, pageB } = setup;

    // Same coin-flip-driven determination as Scenario 1, but read BEFORE
    // dismissing anything -- AL.state.turn is already set by AL.startMatch()
    // even while state.screen is still 'howto'.
    const aliceIsActive = await pageA.evaluate(() => AL.state.turn === 'player');
    const activePage = aliceIsActive ? pageA : pageB;
    const passivePage = aliceIsActive ? pageB : pageA;
    console.log(`  active (leaves How-to-Play open): ${aliceIsActive ? 'Alice' : 'Bob'}; passive (dismisses normally, to poll): ${aliceIsActive ? 'Bob' : 'Alice'}`);

    // Passive dismisses their own overlay normally and reaches battle. Active
    // deliberately does NOT click #btn-howto-close at all.
    await passivePage.click('#btn-howto-close');
    await waitFor(passivePage, () => AL.state.screen === 'battle');
    assert(
      (await activePage.evaluate(() => AL.state.screen)) === 'howto',
      "active client is still sitting on the How-to-Play overlay, as this scenario intends (sanity check on the test itself)"
    );

    console.log(`  waiting ${TURN_TIMEOUT_MS + 3000}ms (well past the active player's own ${TURN_TIMEOUT_MS}ms turn_timeout) with How-to-Play still open...`);
    await sleep(TURN_TIMEOUT_MS + 3000);

    const passiveTurnAfterWait = await passivePage.evaluate(() => AL.state.turn);
    const passiveHandAfterWait = await passivePage.evaluate(() => AL.state.player.hand.length);
    assert(
      passiveTurnAfterWait === 'player',
      `passive client's turn started even though the ACTIVE player never left the How-to-Play overlay -- ` +
        `the match no longer silently stalls for BOTH sides just because one player is reading the tutorial slowly (got turn=${passiveTurnAfterWait})`
    );
    assert(
      passiveHandAfterWait === 5,
      `passive client's hand is still exactly 5 cards (their untouched turn-1 opening draw), no double-draw corruption (got ${passiveHandAfterWait})`
    );

    console.log('== active player FINALLY closes How-to-Play -- their own turn state must already reflect the timeout, not still show it as their turn ==');
    await activePage.click('#btn-howto-close');
    await waitFor(activePage, () => AL.state.screen === 'battle');
    const activeTurnAfterClose = await activePage.evaluate(() => AL.state.turn);
    assert(
      activeTurnAfterClose === 'opponent',
      `active client's own turn is correctly shown as over once they return to the battle screen -- ` +
        `before the fix this stayed 'player' indefinitely, letting a player keep their turn forever just by holding the overlay open (got ${activeTurnAfterClose})`
    );
    const activeOwnHandAfterClose = await activePage.evaluate(() => AL.state.player.hand.length);
    assert(
      activeOwnHandAfterClose === 0,
      `active client's own hand was actually discarded by the time they return (spec §7.3 timeout steps applied, not skipped) (got ${activeOwnHandAfterClose} cards)`
    );
  } finally {
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 / 4: docs/qa/online-pvp-milestone.md's Follow-up verification
// regression (re-check of f157db8, 2026-08-05) -- the reconciliation fix
// above (Scenarios 1/2) closed the original Blocker but introduced a NEW
// bug: applyRemoteEndTurn() (js/state.js) was reachable from both
// reconcileMyTurnStart() (the new server-driven path) AND the pre-existing
// real peer `endTurn` action, completely uncoordinated, and non-idempotent
// (it ends in localTurnStart(), which unconditionally resets
// state.player.block/mana). QA's own report explicitly calls out why
// Scenarios 1/2 above didn't catch this: they only ever OBSERVE the passive
// client's turn/hand during and after the freeze, never have it actually
// ACT during the reconciliation window -- which is exactly when the bug
// bites. Scenario 3 closes that gap using the same genuinely-frozen-process
// methodology as Scenarios 1/2 (not a mock/simulated freeze). Scenario 4
// covers the reverse message ordering directly against the state machine
// (see its own doc comment for why that ordering isn't reachable through a
// real network race here, and why we still test it).
// ---------------------------------------------------------------------------

async function scenario3ActDuringReconciliationWindow() {
  console.log('\n\n########## SCENARIO 3: passive client acts during the reconciliation window, then the frozen client\'s stale endTurn arrives ##########');
  let browserA;
  let browserB;
  try {
    console.log('\n== signup two accounts, launch two SEPARATE chromium processes, reach How-to-Play ==');
    const setup = await setUpTwoClientsAtHowto('AliceRace', 'BobRace');
    browserA = setup.browserA;
    browserB = setup.browserB;
    const { pageA, pageB } = setup;

    console.log('== both clients dismiss How-to-Play normally ==');
    await pageA.click('#btn-howto-close');
    await pageB.click('#btn-howto-close');
    await waitFor(pageA, () => AL.state.screen === 'battle');
    await waitFor(pageB, () => AL.state.screen === 'battle');

    const aliceIsActive = await pageA.evaluate(() => AL.state.turn === 'player');
    const activePage = aliceIsActive ? pageA : pageB;
    const passivePage = aliceIsActive ? pageB : pageA;
    console.log(`  active (to freeze): ${aliceIsActive ? 'Alice' : 'Bob'}; passive (to poll + act): ${aliceIsActive ? 'Bob' : 'Alice'}`);

    // Deterministic hand injection on the passive client, done BEFORE the
    // freeze even starts -- this only controls WHICH cards are available to
    // play (so the test reliably exercises both the mana-refund and the
    // block-wipe symptoms QA's report documents in one run, rather than
    // depending on what the real shuffled starter deck happens to draw),
    // it does not touch anything about the freeze/reconciliation mechanism
    // itself, which stays exactly as real as Scenarios 1/2.
    //   - twinStrike (cost 1, attack, targets opponent) -- exercises the
    //     mana-refund symptom (QA's Run 1).
    //   - quickGuard (cost 0, self, +4 block) -- exercises the block-wipe
    //     symptom (QA's Run 2). Also draws 1 card, which is fine.
    //   - strike (cost 1) -- deliberately left UNPLAYED. resolveCard()'s own
    //     maybeAutoEndTurn() (js/state.js, pre-existing, unrelated to this
    //     fix) auto-ends a turn 500ms after the hand has nothing left
    //     affordable -- leaving one still-affordable card in hand keeps that
    //     real feature from firing and ending the turn on its own during the
    //     test's wait below, which would otherwise be mistaken for THIS
    //     bug's "turn silently ended" symptom.
    await passivePage.evaluate(() => {
      AL.state.player.hand = ['twinStrike', 'quickGuard', 'strike'];
      AL.state.player.handKeys = ['test-c0', 'test-c1', 'test-c2'];
    });

    // Deliberately a SHORTER freeze than Scenarios 1/2's FREEZE_MS here, and
    // a short settle wait below -- not arbitrary. This test's card plays go
    // through AL.selectCard()/targetOpponent() directly (matching a real
    // player's actions), NOT through js/battle.js's onManualEndTurnClick(),
    // which is the only thing that ever sends the dedicated `end_turn`
    // message to the server. So once the passive player's own turn begins
    // (via reconciliation), the SERVER's OWN turn-timeout clock for HER turn
    // is still running underneath, independent of what she plays -- and if
    // this test's own wait ran long enough for THAT to elapse too, her own
    // real (not stale) turn_timeout would fire and end her turn for real,
    // which would look identical to this bug's symptom (turn flips, hand
    // empties) but isn't it. Same class of gotcha QA's own report flagged
    // for Scenario 1's freeze duration ("using a value too close to
    // 2xPVP_TURN_TIMEOUT_MS introduces a second, legitimate timeout that
    // confounds the result") -- here it applies to the WAIT after the freeze
    // rather than the freeze length itself, since the passive player's own
    // deadline starts counting from roughly when reconciliation happened
    // (~TURN_TIMEOUT_MS after freeze start), not from freeze end. Keeping
    // (freeze length + settle wait) comfortably under 2*TURN_TIMEOUT_MS
    // avoids it.
    const freezeMs = TURN_TIMEOUT_MS + 2000;
    console.log(`\n== freezing the ACTIVE page's JS main thread for ${freezeMs}ms (turn_timeout is configured for ${TURN_TIMEOUT_MS}ms) ==`);
    const freezeStartedAt = Date.now();
    const freezePromise = activePage
      .evaluate((ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          /* deliberately synchronous, blocks this page's JS thread */
        }
        return true;
      }, freezeMs)
      .catch((err) => {
        console.error('  freeze evaluate() rejected unexpectedly:', err.message);
        return false;
      });

    console.log('== polling the passive client until reconciliation flips its turn to \'player\' ==');
    let flipped = false;
    const pollDeadline = Date.now() + freezeMs - 1000; // stop polling with a margin before the freeze itself ends
    while (Date.now() < pollDeadline) {
      if (await passivePage.evaluate(() => AL.state.turn === 'player')) {
        flipped = true;
        break;
      }
      await sleep(150);
    }
    assert(flipped, 'passive client\'s turn flipped to \'player\' via reconciliation while the opponent is still frozen (precondition for this scenario)');

    console.log('== IMMEDIATELY playing both injected cards on the passive client, inside the reconciliation window (before the frozen client wakes up) ==');
    // twinStrike: targets the opponent, so select then target.
    await passivePage.evaluate(() => {
      const idx = AL.state.player.hand.indexOf('twinStrike');
      AL.selectCard(idx);
      AL.targetOpponent();
    });
    const afterTwinStrike = await passivePage.evaluate(() => ({ mana: AL.state.player.mana, block: AL.state.player.block }));
    assert(afterTwinStrike.mana === 2, `mana correctly spent playing twinStrike (cost 1) out of a full 3 (got ${afterTwinStrike.mana})`);

    // quickGuard: self-target, resolves immediately on selectCard().
    await passivePage.evaluate(() => {
      const idx = AL.state.player.hand.indexOf('quickGuard');
      AL.selectCard(idx);
    });
    const afterQuickGuard = await passivePage.evaluate(() => ({ mana: AL.state.player.mana, block: AL.state.player.block }));
    assert(afterQuickGuard.mana === 2, `mana unchanged by quickGuard (cost 0) (got ${afterQuickGuard.mana})`);
    assert(afterQuickGuard.block === 4, `block correctly gained from quickGuard (+4) (got ${afterQuickGuard.block})`);
    assert(
      (await passivePage.evaluate(() => AL.state.turn)) === 'player',
      'turn correctly still belongs to the passive player right after their own real actions (not silently ended)'
    );

    console.log('\n== waiting for the frozen tab to wake up and its stale queued endTurn to fully propagate and settle ==');
    await freezePromise;
    // Short settle wait -- localhost message propagation settles in well
    // under this, and staying short keeps well clear of the passive
    // player's own real second turn-timeout deadline (see the freezeMs doc
    // comment above).
    await sleep(800);

    const finalState = await passivePage.evaluate(() => ({
      mana: AL.state.player.mana,
      block: AL.state.player.block,
      turn: AL.state.turn,
      handLen: AL.state.player.hand.length,
    }));
    assert(
      finalState.mana === 2,
      `mana is STILL 2 after the frozen client's stale endTurn message finally arrives -- NOT silently refunded to full ` +
        `(QA's Run 1 regression: mana was silently restored to 3; got ${finalState.mana})`
    );
    assert(
      finalState.block === 4,
      `block is STILL 4 after the frozen client's stale endTurn message finally arrives -- NOT silently wiped to 0 ` +
        `(QA's Run 2 regression: block was silently wiped; got ${finalState.block})`
    );
    assert(
      finalState.turn === 'player',
      `turn correctly stayed 'player' throughout -- the stale endTurn did not silently re-end the passive player's own turn (got ${finalState.turn})`
    );
    assert(
      finalState.handLen === 2,
      `passive client's hand has exactly the 1 deliberately-unplayed card (strike) plus the 1 real card quickGuard's own ` +
        `effect drew when it was played (an expected, correct draw -- NOT a phantom re-draw from a duplicate turn-start, ` +
        `which is what this assertion actually guards against: a bug here would show up as a SECOND unexpected draw on ` +
        `top of these 2, i.e. a stale endTurn's localTurnStart() re-running and drawing a fresh turn's worth of cards) (got ${finalState.handLen} cards)`
    );
  } finally {
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
  }
}

// Reverse ordering: the stale peer `endTurn` action arriving BEFORE the
// server-driven reconciliation for the same turn boundary.
//
// Is this reachable via a real network race for the frozen-client scenario
// above? No -- both messages travel to the passive client over the SAME
// server<->client connection (TCP-ordered), and the server always sends its
// turn_started broadcast the instant it detects the timeout -- strictly
// BEFORE the frozen client can even wake up and generate the stale action
// that eventually gets relayed through the same server. So for Scenario 3's
// specific mechanism, "reconciliation first" is the only physically
// possible ordering, not just the common one. Scenarios 1-3 above already
// prove that ordering is safe.
//
// But applyRemoteEndTurn()'s guard (js/state.js) isn't supposed to rely on
// that ordering holding -- it's a plain state check ("is it already my
// turn"), not a race-timing assumption, so it must ALSO be correct if a
// future change (e.g. a client reconnect replaying buffered messages out of
// original order, or a different transport) ever did deliver them in the
// opposite order. This exercises that directly against the real state
// machine (AL.applyRemoteAction / AL.reconcileMyTurnStart), in a single
// ordinary page -- no freeze needed, since this is a pure ordering check on
// the two call paths, not a repro of the freeze mechanism itself.
async function scenario4ReverseOrderingIsAlsoSafe() {
  console.log('\n\n########## SCENARIO 4: reverse ordering (stale peer endTurn arrives BEFORE server reconciliation) is also a safe no-op ##########');
  let browser;
  try {
    console.log('\n== signup one account, launch a single chromium process, reach battle as the SECOND player (so it is opponent\'s turn first) ==');
    const account = await signup('CarolReverse');
    browser = await chromium.launch();
    const context = await browser.newContext();
    await context.addCookies([
      { name: account.cookie.name, value: account.cookie.value, domain: 'localhost', path: '/', httpOnly: true, secure: false },
    ]);
    const page = await context.newPage();
    await page.goto(`http://localhost:${STATIC_PORT}/index.html`);
    await waitFor(page, () => !document.getElementById('screen-main-menu').classList.contains('hidden'));

    // No relay/second client needed for this check -- it exercises AL's own
    // state machine directly (the "devtools/New Run" smoke-test path
    // js/main.js already supports, per js/state.js's own doc comments),
    // starting a match as the second player (turn = 'opponent' initially)
    // so there's a real opponent turn boundary to reconcile.
    await page.evaluate(() => {
      AL.startMatch({ deck: STARTER_DECK, isFirstPlayer: false, opponentName: 'Opponent' });
      AL.closeHowto();
    });
    await waitFor(page, () => AL.state.screen === 'battle' && AL.state.turn === 'opponent');

    console.log('== simulating the STALE peer endTurn action arriving FIRST (before reconciliation) ==');
    await page.evaluate(() => {
      AL.applyRemoteAction({ type: 'endTurn' });
    });
    const afterStaleFirst = await page.evaluate(() => ({ turn: AL.state.turn, mana: AL.state.player.mana, block: AL.state.player.block }));
    assert(afterStaleFirst.turn === 'player', `real endTurn action correctly starts my turn (got ${afterStaleFirst.turn})`);
    assert(afterStaleFirst.mana === 3, `mana correctly full at the start of a genuinely new turn (got ${afterStaleFirst.mana})`);

    console.log('== spending some mana and gaining block (simulating the passive player acting) ==');
    await page.evaluate(() => {
      AL.state.player.hand = ['twinStrike', 'quickGuard'];
      AL.state.player.handKeys = ['test-c0', 'test-c1'];
      AL.selectCard(0);
      AL.targetOpponent();
      AL.selectCard(0); // quickGuard is now at index 0 after twinStrike was spliced out
    });
    const afterActions = await page.evaluate(() => ({ mana: AL.state.player.mana, block: AL.state.player.block }));
    assert(afterActions.mana === 2, `mana correctly spent (got ${afterActions.mana})`);
    assert(afterActions.block === 4, `block correctly gained (got ${afterActions.block})`);

    console.log('== NOW the server-driven reconciliation arrives SECOND, for the SAME boundary -- must be a safe no-op ==');
    await page.evaluate(() => {
      AL.reconcileMyTurnStart();
    });
    const afterReconciliation = await page.evaluate(() => ({ mana: AL.state.player.mana, block: AL.state.player.block, turn: AL.state.turn }));
    assert(
      afterReconciliation.mana === 2,
      `mana is STILL 2 after reconciliation arrives second -- reconciliation did NOT re-run localTurnStart() and refund it (got ${afterReconciliation.mana})`
    );
    assert(
      afterReconciliation.block === 4,
      `block is STILL 4 after reconciliation arrives second -- reconciliation did NOT re-run localTurnStart() and wipe it (got ${afterReconciliation.block})`
    );
    assert(afterReconciliation.turn === 'player', `turn correctly still 'player' (got ${afterReconciliation.turn})`);

    await browser.close().catch(() => {});
    browser = null;

    // Symmetric check, opposite call order this time (reconciliation first,
    // stale action second) -- same invariant, just confirming the two
    // orderings are equally safe against the exact same guard, not two
    // different code paths.
    console.log('\n== sanity re-check: SAME invariant with the opposite call order (reconciliation first, stale action second) ==');
    browser = await chromium.launch();
    const context2 = await browser.newContext();
    const account2 = await signup('DaveReverseCheck');
    await context2.addCookies([
      { name: account2.cookie.name, value: account2.cookie.value, domain: 'localhost', path: '/', httpOnly: true, secure: false },
    ]);
    const page2 = await context2.newPage();
    await page2.goto(`http://localhost:${STATIC_PORT}/index.html`);
    await waitFor(page2, () => !document.getElementById('screen-main-menu').classList.contains('hidden'));
    await page2.evaluate(() => {
      AL.startMatch({ deck: STARTER_DECK, isFirstPlayer: false, opponentName: 'Opponent' });
      AL.closeHowto();
    });
    await waitFor(page2, () => AL.state.screen === 'battle' && AL.state.turn === 'opponent');

    await page2.evaluate(() => { AL.reconcileMyTurnStart(); });
    await page2.evaluate(() => {
      AL.state.player.hand = ['twinStrike', 'quickGuard'];
      AL.state.player.handKeys = ['test-c0', 'test-c1'];
      AL.selectCard(0);
      AL.targetOpponent();
      AL.selectCard(0);
    });
    const beforeStaleSecond = await page2.evaluate(() => ({ mana: AL.state.player.mana, block: AL.state.player.block }));
    await page2.evaluate(() => { AL.applyRemoteAction({ type: 'endTurn' }); }); // the stale message, arriving second this time
    const afterStaleSecond = await page2.evaluate(() => ({ mana: AL.state.player.mana, block: AL.state.player.block, turn: AL.state.turn }));
    assert(
      afterStaleSecond.mana === beforeStaleSecond.mana,
      `(opposite order) mana unchanged by the stale endTurn arriving second (before=${beforeStaleSecond.mana}, after=${afterStaleSecond.mana})`
    );
    assert(
      afterStaleSecond.block === beforeStaleSecond.block,
      `(opposite order) block unchanged by the stale endTurn arriving second (before=${beforeStaleSecond.block}, after=${afterStaleSecond.block})`
    );
    assert(afterStaleSecond.turn === 'player', `(opposite order) turn still 'player' (got ${afterStaleSecond.turn})`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  console.log(`\n== spawning server on port ${SERVER_PORT} with PVP_TURN_TIMEOUT_MS=${TURN_TIMEOUT_MS} ==`);
  const serverDir = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(SERVER_PORT), PVP_TURN_TIMEOUT_MS: String(TURN_TIMEOUT_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  const staticServer = await startStaticServer();
  console.log(`  static file server up on port ${STATIC_PORT}`);

  try {
    await waitForServerReady();
    console.log('  server is up');

    await scenario1FrozenClient();
    await scenario2HowToPlayLeftOpen();
    await scenario3ActDuringReconciliationWindow();
    await scenario4ReverseOrderingIsAlsoSafe();

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    staticServer.close();
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Frozen-client turn-timeout test crashed:', err);
  process.exit(1);
});
