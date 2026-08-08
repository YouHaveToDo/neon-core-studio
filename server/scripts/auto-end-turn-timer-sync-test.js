/* Playwright regression test for the production bug report (2026-08):
 * "turn label flips instantly but the countdown timer keeps counting down
 * from the previous turn's remaining time instead of resetting to a fresh
 * ~24s" -- confirmed via frame-by-frame video ("opponent's timer at 10s ->
 * next frame shows YOUR TURN 10", not a fresh 24).
 *
 * Root cause (js/state.js / js/battle.js): maybeAutoEndTurn() (auto-ending a
 * turn ~500ms after the hand has nothing left playable) called the internal
 * endTurn() directly, which correctly flipped state.turn and emitted the
 * peer `action` (so both clients' GAME state stayed in sync), but never told
 * the relay's own 24s turn-timer clock the turn was over -- only the manual
 * "End Turn" button's click handler ever called the dedicated `Net.send(
 * 'end_turn')` that actually resets the SERVER's deadline. So the label
 * (client-state-driven) flipped instantly while the timer (server-deadline-
 * driven) kept counting down from the stale original deadline until its own
 * overdue turn_timeout eventually fired.
 *
 * The fix: js/state.js's endTurn() now takes a `notifyServer` flag (default
 * true) and fires a new AL.onLocalTurnEnd() bus (mirroring the existing
 * onAction/onMatchEnd bus pattern) only when true. js/battle.js's single
 * onLocalTurnEndNotify() listener is the one place that actually calls
 * Net.send('end_turn'). Manual End Turn and maybeAutoEndTurn() both leave
 * notifyServer at its default (true); js/battle.js's handleTurnTimeout() and
 * js/state.js's reconcileOpponentTurnStart() -- both reacting to something
 * the server already told this client -- explicitly pass notifyServer=false,
 * so they do NOT send a second end_turn (which would just bounce off the
 * relay as NOT_YOUR_TURN).
 *
 * Scenario A is the actual bug repro + fix verification: drives a hand down
 * to zero playable cards so maybeAutoEndTurn() fires for real, and checks the
 * relay's own next turn_started broadcast against BOTH failure signatures the
 * video showed -- (1) it must arrive promptly, well before the ORIGINAL
 * (long) deadline would have elapsed on its own, and (2) its `deadline` must
 * be a genuinely fresh ~PVP_TURN_TIMEOUT_MS window from the moment it's
 * received, not a value that only makes sense as a continuation of the
 * previous turn's remaining time. It also checks the real timer UI
 * (#turn-timer-value) on BOTH clients reflects the fresh value shortly after.
 *
 * Scenario B confirms the manual "End Turn" click path still works with no
 * regression from the refactor (exactly one end_turn sent, fresh deadline).
 *
 * Scenario C confirms the server-forced-timeout / reconciliation path
 * (handleTurnTimeout + reconcileOpponentTurnStart, both notifyServer=false)
 * still does NOT send a second end_turn -- verified by spying on the
 * formerly-active client's own Net.send calls during a real freeze-driven
 * timeout (same genuinely-frozen-process methodology as
 * frozen-client-turn-timeout-test.js), not just asserted by reading the code.
 *
 * Usage: NODE_PATH=<dir containing a 'playwright' install> node
 *   scripts/auto-end-turn-timer-sync-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations applied, ports 3001/8080 free (see frozen-client-turn-timeout-
 * test.js's own doc comment -- same constraints, same reasons).
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
      '  NODE_PATH=~/.npm/_npx/<hash>/node_modules node scripts/auto-end-turn-timer-sync-test.js\n' +
      `(original error: ${err.message})`
  );
  process.exit(1);
}

const SERVER_PORT = 3001; // must match js/api.js's hard-coded API_BASE_URL
const STATIC_PORT = 8080;
const REPO_ROOT = path.join(__dirname, '..', '..');
// Long enough to give clear headroom between "auto-end fires almost
// immediately after turn start" and "the original stale deadline", so a
// fresh-vs-continuation deadline mixup is unambiguous either way.
const TURN_TIMEOUT_MS = 8000;

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
  const email = `autoend-${rand}@example.com`;
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

// Shared setup: two separate browser processes (not two contexts of one
// process -- see frozen-client-turn-timeout-test.js's doc comment for why
// that distinction matters once freezing is involved, Scenario C below),
// real login -> deck select -> lobby -> room create/join, landing both on
// the auto-shown How-to-Play overlay.
//
// onLobbyReady(pageA, pageB), if given, runs once BOTH clients have reached
// the lobby screen but BEFORE room create/join -- i.e. strictly before the
// match (and its turn-1 turn_started) can possibly start. installNetSpies()
// must be called from here, not after this function returns: turn 1's own
// turn_started fires the moment the coin flip resolves, which is well before
// AL.state.screen even reaches 'howto' (the point this function normally
// returns at) -- installing spies any later would silently miss it.
async function setUpTwoClientsAtHowto(aliceName, bobName, onLobbyReady) {
  const alice = await signup(aliceName);
  const bob = await signup(bobName);

  const [browserA, browserB] = await Promise.all([chromium.launch(), chromium.launch()]);
  const [{ page: pageA }, { page: pageB }] = await Promise.all([
    loginAndReachLobby(browserA, alice),
    loginAndReachLobby(browserB, bob),
  ]);

  if (onLobbyReady) await onLobbyReady(pageA, pageB);

  await pageA.click('#btn-lobby-create');
  await waitFor(pageA, () => !document.getElementById('lobby-panel-waiting').classList.contains('hidden'));

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

// Installs a collector on `page` that records every turn_started message this
// client's own Net receives (via a second listener alongside js/battle.js's
// own -- js/ws.js's Net.on() supports multiple listeners per type, see its
// own `handlers[type] = handlers[type] || []` array) as { deadline,
// activeAccountId, receivedAt }, plus a spy recording every outgoing
// Net.send() call's type (used by Scenario C to prove no stray end_turn is
// sent). Must run before the match starts to also catch turn 1's own
// turn_started.
async function installNetSpies(page) {
  await page.evaluate(() => {
    window.__turnStartedLog = [];
    window.__sentTypes = [];
    Net.on('turn_started', (msg) => {
      window.__turnStartedLog.push({ deadline: msg.deadline, activeAccountId: msg.activeAccountId, receivedAt: Date.now() });
    });
    const originalSend = Net.send;
    Net.send = function spySend(type, payload) {
      window.__sentTypes.push({ type, at: Date.now() });
      return originalSend.call(Net, type, payload);
    };
  });
}

// ---------------------------------------------------------------------------
// Scenario A: the actual bug repro + fix verification.
// ---------------------------------------------------------------------------
async function scenarioA_AutoEndTurnResetsServerTimer() {
  console.log('\n\n########## SCENARIO A: maybeAutoEndTurn() correctly resets the SERVER turn timer ##########');
  let browserA;
  let browserB;
  try {
    console.log('\n== signup two accounts, launch two SEPARATE chromium processes, install Net spies BEFORE match start, reach How-to-Play ==');
    const setup = await setUpTwoClientsAtHowto('AliceAutoEnd', 'BobAutoEnd', async (pA, pB) => {
      await installNetSpies(pA);
      await installNetSpies(pB);
    });
    browserA = setup.browserA;
    browserB = setup.browserB;
    const { pageA, pageB } = setup;

    console.log('== both clients dismiss How-to-Play ==');
    await pageA.click('#btn-howto-close');
    await pageB.click('#btn-howto-close');
    await waitFor(pageA, () => AL.state.screen === 'battle');
    await waitFor(pageB, () => AL.state.screen === 'battle');

    const aliceIsActive = await pageA.evaluate(() => AL.state.turn === 'player');
    const activePage = aliceIsActive ? pageA : pageB;
    const passivePage = aliceIsActive ? pageB : pageA;
    console.log(`  active (turn 1, to auto-end): ${aliceIsActive ? 'Alice' : 'Bob'}; passive: ${aliceIsActive ? 'Bob' : 'Alice'}`);

    const turn1StartedAt = Date.now();
    const firstDeadline = await activePage.evaluate(() => window.__turnStartedLog[0].deadline);
    console.log(`  turn 1's original deadline is ~${firstDeadline - turn1StartedAt}ms out (should be close to ${TURN_TIMEOUT_MS}ms)`);

    console.log('\n== driving the ACTIVE client\'s hand down to zero playable cards (real card play, not a direct endTurn() call) ==');
    // A single affordable card, played immediately: after resolveCard()
    // splices it out, hand.length === 0, so hasPlayableCard() (some() on an
    // empty array) is false and maybeAutoEndTurn() schedules the real
    // auto-end ~500ms later -- this exercises the exact production path, not
    // a shortcut that calls AL.endTurn()/maybeAutoEndTurn() directly. Uses
    // 'defend' (skill, self-target), not an Attack card -- this active client
    // is by definition the FIRST player on turn 1 (coin-flip winner), and
    // spec §6.3.1's turn-1 attack lock (state.firstTurnAttackLock) silently
    // refuses to play any Attack card for exactly this one turn; 'defend'
    // avoids that entirely, and self-target cards resolve straight from
    // selectCard() with no separate targetOpponent() click needed.
    await activePage.evaluate(() => {
      AL.state.player.hand = ['defend'];
      AL.state.player.handKeys = ['test-c0'];
    });
    await activePage.evaluate(() => {
      AL.selectCard(0);
    });
    assert(
      (await activePage.evaluate(() => AL.state.turn)) === 'player',
      'turn has NOT yet ended immediately after the last playable card resolves (maybeAutoEndTurn\'s ~500ms beat hasn\'t elapsed)'
    );

    console.log('  waiting for maybeAutoEndTurn()\'s ~500ms beat, plus network margin, for the auto-end to actually fire...');
    await waitFor(activePage, () => AL.state.turn === 'opponent', { timeoutMs: 4000 });
    const autoEndObservedAt = Date.now();
    assert(true, `active client's own turn flipped to 'opponent' via the real auto-end path (+${autoEndObservedAt - turn1StartedAt}ms since turn 1 started)`);

    console.log('== waiting for the relay\'s resulting turn_started broadcast to reach both clients ==');
    await waitFor(activePage, () => window.__turnStartedLog.length >= 2, { timeoutMs: 4000 });
    await waitFor(passivePage, () => window.__turnStartedLog.length >= 2, { timeoutMs: 4000 });

    const secondOnActive = await activePage.evaluate(() => window.__turnStartedLog[1]);
    const secondOnPassive = await passivePage.evaluate(() => window.__turnStartedLog[1]);

    // --- Check 1: the server actually received an end_turn for this case ---
    // (proven indirectly but unambiguously: a fresh turn_started for a NEW
    // turn boundary arrived at all, and promptly -- if maybeAutoEndTurn()'s
    // endTurn() call had NOT notified the server (the pre-fix bug), this
    // second broadcast would only ever arrive once the ORIGINAL, much later,
    // stale deadline finally timed out on its own -- i.e. not for another
    // ~(TURN_TIMEOUT_MS - elapsed) ms from turn 1's start.)
    const msSinceTurn1Start = secondOnActive.receivedAt - turn1StartedAt;
    assert(
      msSinceTurn1Start < TURN_TIMEOUT_MS - 3000,
      `second turn_started arrived promptly after the auto-end (+${msSinceTurn1Start}ms since turn 1 started), ` +
        `NOT delayed until anywhere near the original ${TURN_TIMEOUT_MS}ms deadline -- proves the server actually ` +
        `received end_turn for the auto-ended turn, matching the bug report's own repro (label flips, but pre-fix the ` +
        `timer used to keep counting down from the stale deadline until it separately timed out)`
    );

    // --- Check 2: the fresh deadline is a genuine new ~TURN_TIMEOUT_MS
    // window from now, not a continuation of turn 1's remaining time (the
    // exact bug signature: "opponent's timer at 10s -> next frame YOUR TURN
    // 10", i.e. deadline effectively unchanged from before). ---
    const freshWindowMs = secondOnActive.deadline - secondOnActive.receivedAt;
    assert(
      freshWindowMs > TURN_TIMEOUT_MS - 1500 && freshWindowMs < TURN_TIMEOUT_MS + 1500,
      `second turn_started.deadline is a genuinely fresh ~${TURN_TIMEOUT_MS}ms window from when it's received ` +
        `(computed ${freshWindowMs}ms) -- NOT a small leftover number continuing from turn 1's own deadline`
    );
    assert(
      secondOnActive.deadline !== firstDeadline,
      `second turn_started.deadline (${secondOnActive.deadline}) is a genuinely different value from turn 1's own ` +
        `deadline (${firstDeadline}), not the same stale deadline being re-broadcast`
    );
    assert(
      secondOnPassive.deadline === secondOnActive.deadline,
      `both clients received the SAME fresh deadline for the new turn (active=${secondOnActive.deadline}, passive=${secondOnPassive.deadline})`
    );

    // --- Check 3: both clients' actual timer UI reflects the fresh value ---
    await sleep(300); // let renderTimerTick() run at least once more against the new deadline
    const activeTimerText = await activePage.evaluate(() => document.getElementById('turn-timer-value').textContent);
    const passiveTimerText = await passivePage.evaluate(() => document.getElementById('turn-timer-value').textContent);
    const expectedApprox = Math.ceil(TURN_TIMEOUT_MS / 1000);
    assert(
      Number(activeTimerText) >= expectedApprox - 2,
      `active client's own #turn-timer-value UI shows a fresh countdown (${activeTimerText}s, expected close to ${expectedApprox}s), not a small leftover number`
    );
    assert(
      Number(passiveTimerText) >= expectedApprox - 2,
      `passive client's own #turn-timer-value UI shows the same fresh countdown (${passiveTimerText}s, expected close to ${expectedApprox}s)`
    );
  } finally {
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Scenario B: manual "End Turn" click -- no regression from the refactor.
// ---------------------------------------------------------------------------
async function scenarioB_ManualEndTurnStillWorks() {
  console.log('\n\n########## SCENARIO B: manual End Turn click still resets the server timer correctly (regression check) ##########');
  let browserA;
  let browserB;
  try {
    const setup = await setUpTwoClientsAtHowto('AliceManual', 'BobManual', async (pA, pB) => {
      await installNetSpies(pA);
      await installNetSpies(pB);
    });
    browserA = setup.browserA;
    browserB = setup.browserB;
    const { pageA, pageB } = setup;

    await pageA.click('#btn-howto-close');
    await pageB.click('#btn-howto-close');
    await waitFor(pageA, () => AL.state.screen === 'battle');
    await waitFor(pageB, () => AL.state.screen === 'battle');

    const aliceIsActive = await pageA.evaluate(() => AL.state.turn === 'player');
    const activePage = aliceIsActive ? pageA : pageB;
    const passivePage = aliceIsActive ? pageB : pageA;

    const turn1StartedAt = Date.now();
    await activePage.click('#btn-end-turn');
    await waitFor(activePage, () => AL.state.turn === 'opponent', { timeoutMs: 3000 });

    await waitFor(activePage, () => window.__turnStartedLog.length >= 2, { timeoutMs: 3000 });
    await waitFor(passivePage, () => window.__turnStartedLog.length >= 2, { timeoutMs: 3000 });

    const endTurnSends = await activePage.evaluate(() => window.__sentTypes.filter((s) => s.type === 'end_turn').length);
    assert(endTurnSends === 1, `exactly one end_turn message was sent for the manual click, no double-send from the refactor (got ${endTurnSends})`);

    const secondOnActive = await activePage.evaluate(() => window.__turnStartedLog[1]);
    const freshWindowMs = secondOnActive.deadline - secondOnActive.receivedAt;
    assert(
      freshWindowMs > TURN_TIMEOUT_MS - 1500 && freshWindowMs < TURN_TIMEOUT_MS + 1500,
      `manual End Turn still produces a genuinely fresh ~${TURN_TIMEOUT_MS}ms deadline (computed ${freshWindowMs}ms)`
    );
    assert(
      secondOnActive.receivedAt - turn1StartedAt < TURN_TIMEOUT_MS - 3000,
      `manual End Turn still hands off promptly, well before the original deadline (+${secondOnActive.receivedAt - turn1StartedAt}ms)`
    );
  } finally {
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Scenario C: server-forced timeout + reconciliation -- must NOT send a
// second end_turn (which would bounce off the relay as NOT_YOUR_TURN).
// Same genuinely-frozen-process methodology as frozen-client-turn-timeout-
// test.js's Scenario 1, but this test additionally spies on the formerly-
// active client's own outgoing Net.send calls, rather than only checking the
// resulting game state, to directly prove the "don't notify" path really
// sends nothing rather than merely looking harmless.
// ---------------------------------------------------------------------------
async function scenarioC_TimeoutReconciliationSendsNoDuplicateEndTurn() {
  console.log('\n\n########## SCENARIO C: server timeout + reconciliation path sends NO duplicate end_turn ##########');
  let browserA;
  let browserB;
  try {
    const setup = await setUpTwoClientsAtHowto('AliceTimeout', 'BobTimeout', async (pA, pB) => {
      await installNetSpies(pA);
      await installNetSpies(pB);
      // Also record any 'error' messages this client receives (e.g. a
      // NOT_YOUR_TURN bounce), independent of the send-side spy above -- belt
      // and suspenders in case some other, unexpected call site ever sent a
      // stray end_turn.
      await pA.evaluate(() => { window.__errorLog = []; Net.on('error', (msg) => window.__errorLog.push(msg)); });
      await pB.evaluate(() => { window.__errorLog = []; Net.on('error', (msg) => window.__errorLog.push(msg)); });
    });
    browserA = setup.browserA;
    browserB = setup.browserB;
    const { pageA, pageB } = setup;

    await pageA.click('#btn-howto-close');
    await pageB.click('#btn-howto-close');
    await waitFor(pageA, () => AL.state.screen === 'battle');
    await waitFor(pageB, () => AL.state.screen === 'battle');

    const aliceIsActive = await pageA.evaluate(() => AL.state.turn === 'player');
    const activePage = aliceIsActive ? pageA : pageB; // will be frozen -- its own turn times out server-side
    const passivePage = aliceIsActive ? pageB : pageA;
    console.log(`  active (to freeze, times out): ${aliceIsActive ? 'Alice' : 'Bob'}; passive: ${aliceIsActive ? 'Bob' : 'Alice'}`);

    const freezeMs = TURN_TIMEOUT_MS + 3000;
    console.log(`\n== freezing the ACTIVE page's JS main thread for ${freezeMs}ms (turn_timeout configured for ${TURN_TIMEOUT_MS}ms) ==`);
    const freezePromise = activePage
      .evaluate((ms) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { /* deliberately synchronous */ }
        return true;
      }, freezeMs)
      .catch((err) => {
        console.error('  freeze evaluate() rejected unexpectedly:', err.message);
        return false;
      });

    console.log('== waiting for the passive client to see the turn actually pass (server-driven, active client is frozen) ==');
    await waitFor(passivePage, () => AL.state.turn === 'player', { timeoutMs: freezeMs });

    console.log('== waiting for the frozen tab to wake up and fully process its queued turn_timeout/turn_started/endTurn messages ==');
    await freezePromise;
    await sleep(800);

    const finalActiveTurn = await activePage.evaluate(() => AL.state.turn);
    assert(finalActiveTurn === 'opponent', `formerly-active (frozen) client's own turn correctly shows as over once it wakes (got ${finalActiveTurn})`);

    const endTurnSendsFromFormerlyActive = await activePage.evaluate(() => window.__sentTypes.filter((s) => s.type === 'end_turn').length);
    assert(
      endTurnSendsFromFormerlyActive === 0,
      `formerly-active client sent ZERO end_turn messages of its own -- handleTurnTimeout()'s AL.endTurn(false) and ` +
        `reconcileOpponentTurnStart()'s endTurn(false) both correctly suppressed the dedicated relay notification, since ` +
        `the server already advanced its own clock (got ${endTurnSendsFromFormerlyActive})`
    );

    const errorsOnFormerlyActive = await activePage.evaluate(() => window.__errorLog.filter((e) => e.code === 'NOT_YOUR_TURN').length);
    assert(
      errorsOnFormerlyActive === 0,
      `formerly-active client received zero NOT_YOUR_TURN errors from the relay (confirms no stray end_turn was ever sent and bounced) (got ${errorsOnFormerlyActive})`
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

    await scenarioA_AutoEndTurnResetsServerTimer();
    await scenarioB_ManualEndTurnStillWorks();
    await scenarioC_TimeoutReconciliationSendsNoDuplicateEndTurn();

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    staticServer.close();
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Auto-end-turn timer-sync test crashed:', err);
  process.exit(1);
});
