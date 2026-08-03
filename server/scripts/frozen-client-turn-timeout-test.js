/* Playwright regression test for QA finding #1 (the Blocker), docs/qa/
 * online-pvp-milestone.md: server-enforced turn timeout didn't actually
 * force the PASSIVE (non-timed-out) player's game state to advance when the
 * active player's client was genuinely unresponsive (JS main thread frozen
 * by a synchronous busy-loop), and recovering from that produced real
 * hand-count corruption (6 -> 11 cards).
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
async function setUpTwoClientsAtHowto(aliceName, bobName) {
  const alice = await signup(aliceName);
  const bob = await signup(bobName);

  const [browserA, browserB] = await Promise.all([chromium.launch(), chromium.launch()]);
  const [{ page: pageA }, { page: pageB }] = await Promise.all([
    loginAndReachLobby(browserA, alice),
    loginAndReachLobby(browserB, bob),
  ]);

  await pageA.click('#btn-lobby-create');
  // '......' is the immediate placeholder (js/match.js's setCreateStatusWaiting
  // companion) before the server's real room_created reply lands -- also 6
  // chars, so a plain length check would false-positive on it. Wait for an
  // actual A-Z0-9 code instead.
  await waitFor(pageA, () => /^[A-Z0-9]{6}$/.test(document.getElementById('lobby-code').textContent));
  const roomCode = await pageA.$eval('#lobby-code', (el) => el.textContent);

  await pageB.click('#btn-lobby-show-join');
  await pageB.fill('#lobby-join-input', roomCode);
  await pageB.click('#btn-lobby-join-submit');

  await waitFor(pageA, () => typeof AL !== 'undefined' && AL.state.screen === 'howto', { timeoutMs: 15000 });
  await waitFor(pageB, () => typeof AL !== 'undefined' && AL.state.screen === 'howto', { timeoutMs: 15000 });

  return { browserA, browserB, pageA, pageB, roomCode };
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
      passiveHandBefore === 6,
      `passive client's own hand is the untouched turn-1 opening draw, 6 cards, before anything happens (got ${passiveHandBefore})`
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
        handAtFlip === 6,
        `passive client's hand is STILL exactly 6 cards at the moment their turn starts -- no double-draw corruption ` +
          `(QA's exact repro: hand grew 6 -> 11; got ${handAtFlip})`
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
      passiveHandAfterWait === 6,
      `passive client's hand is still exactly 6 cards (their untouched turn-1 opening draw), no double-draw corruption (got ${passiveHandAfterWait})`
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
