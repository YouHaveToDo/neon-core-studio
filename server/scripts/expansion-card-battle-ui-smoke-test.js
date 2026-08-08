/* Playwright regression test for docs/qa/card-shop-currency-milestone.md
 * finding #1 (the Blocker fixed alongside this test): js/ui.js had 3 call
 * sites (buildCardNode(), the turn-1 attack-lock tooltip check, and
 * onHandCardClick()) that read `CARD_DEFS[cardId]` directly instead of the
 * shared `cardDefById()` fallback (js/data.js) that checks BOTH `CARD_DEFS`
 * and `EXPANSION_CARD_DEFS` -- any of the 8 expansion cards actually drawn
 * into a hand during a real match threw an uncaught TypeError the instant
 * the battle screen tried to render it.
 *
 * Why this needs to be a real two-client Playwright test, not just a vm-
 * harness/unit check: QA's report explicitly flags that no existing test
 * ever drove a real battle screen with an expansion card actually in a
 * hand -- weaken-status-test.js/expansion-cards-test.js load js/state.js in
 * a vm sandbox and never touch js/ui.js's render path at all, and
 * shop-ui-smoke-test.js only ever exercises the shop screen (which already
 * used cardDefById() correctly). This test drives the REAL client bundle
 * (index.html + js/*.js) through a real two-account, real-room, real-match
 * flow, forces an expansion card into a hand exactly the way a normal draw
 * from a deck containing an owned expansion card would, and then actually
 * renders/hovers/clicks it through the real DOM -- exercising all 3 fixed
 * call sites, not just one:
 *   1. buildCardNode() -- rendering ALL 8 expansion cards into a real hand
 *      in one pass (renderHand()'s normal per-card loop).
 *   2. the turn-1 attack-lock tooltip check -- read via the real card
 *      node's `title` attribute while the lock is active.
 *   3. onHandCardClick() -- a REAL DOM click (page.click(), not
 *      AL.selectCard() called directly) on an expansion card, followed by a
 *      real click on the opponent panel to fully resolve it, confirming the
 *      play actually lands (Weaken applied, HP reduced) end-to-end.
 *
 * Usage: NODE_PATH=<dir containing a 'playwright' install> node
 *   scripts/expansion-card-battle-ui-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations applied, port 3001 and 8080 free (same reasoning as
 * frozen-client-turn-timeout-test.js -- the client hard-codes
 * API_BASE_URL=http://localhost:3001).
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
      '  NODE_PATH=~/.npm/_npx/<hash>/node_modules node scripts/expansion-card-battle-ui-smoke-test.js\n' +
      `(original error: ${err.message})`
  );
  process.exit(1);
}

const SERVER_PORT = 3001; // must match js/api.js's hard-coded API_BASE_URL
const STATIC_PORT = 8080;
const REPO_ROOT = path.join(__dirname, '..', '..');

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
  const email = `expcard-${rand}@example.com`;
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

  // Capture real uncaught exceptions (this is exactly how QA's repro
  // surfaced the original bug -- a `page.evaluate` TypeError propagating out
  // of state.js's emit() with no error handling around its listener
  // forEach) and console errors, so a regression shows up as a hard test
  // failure instead of a silently broken render.
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message || String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
  });

  await page.goto(`http://localhost:${STATIC_PORT}/index.html`);
  await waitFor(page, () => !document.getElementById('screen-main-menu').classList.contains('hidden'));
  await page.click('#btn-menu-play');
  await waitFor(page, () => !document.getElementById('screen-deck-select').classList.contains('hidden'));
  await waitFor(page, () => !!document.querySelector('.deck-select-tile.selectable'));
  await page.click('.deck-select-tile.selectable');
  await waitFor(page, () => !document.getElementById('screen-lobby').classList.contains('hidden'));

  return { context, page, pageErrors };
}

async function setUpTwoClientsAtBattle(aliceName, bobName) {
  const alice = await signup(aliceName);
  const bob = await signup(bobName);

  const [browserA, browserB] = await Promise.all([chromium.launch(), chromium.launch()]);
  const [{ page: pageA, pageErrors: errorsA }, { page: pageB, pageErrors: errorsB }] = await Promise.all([
    loginAndReachLobby(browserA, alice),
    loginAndReachLobby(browserB, bob),
  ]);

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

  await pageA.click('#btn-howto-close');
  await pageB.click('#btn-howto-close');
  await waitFor(pageA, () => AL.state.screen === 'battle');
  await waitFor(pageB, () => AL.state.screen === 'battle');

  return { browserA, browserB, pageA, pageB, errorsA, errorsB };
}

async function main() {
  console.log(`\n== spawning server on port ${SERVER_PORT} ==`);
  const serverDir = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  const staticServer = await startStaticServer();
  console.log(`  static file server up on port ${STATIC_PORT}`);

  let browserA;
  let browserB;
  try {
    await waitForServerReady();
    console.log('  server is up');

    console.log('\n== signup two accounts, real room create/join, reach real battle screen ==');
    const setup = await setUpTwoClientsAtBattle('AliceExpCards', 'BobExpCards');
    browserA = setup.browserA;
    browserB = setup.browserB;
    const { pageA, pageB, errorsA, errorsB } = setup;

    const aliceIsActive = await pageA.evaluate(() => AL.state.turn === 'player');
    const activePage = aliceIsActive ? pageA : pageB;
    const activeErrors = aliceIsActive ? errorsA : errorsB;
    console.log(`  active (turn 1, firstTurnAttackLock in effect): ${aliceIsActive ? 'Alice' : 'Bob'}`);

    console.log('\n== forcing all 8 expansion cards into the active client\'s real hand (exactly what a draw from a deck containing owned expansion cards would produce) ==');
    // EXPANSION_POOL (js/data.js) lists all 8 -- 5 attack, 2 skill, 1 power,
    // deliberately using the real pool constant rather than hand-typing the
    // ids so this test can't silently drift out of sync with the real card
    // list.
    await activePage.evaluate(() => {
      AL.state.player.mana = 10;
      AL.state.player.hand = EXPANSION_POOL.slice();
      AL.state.player.handKeys = EXPANSION_POOL.map((id, i) => `exp-test-${i}`);
      // Force a real render pass over the whole hand -- selectCard() always
      // calls emit() on every branch (mana-insufficient / lock / toggle /
      // resolve), so this reliably triggers renderHand() -> buildCardNode()
      // for every one of the 8 newly-keyed cards in one shot, without
      // actually needing any of them to be playable yet.
      AL.selectCard(0);
    });

    assert(
      activeErrors.length === 0,
      `no uncaught page errors / console.error while rendering all 8 expansion cards into a real hand (this is exactly finding #1's crash -- got: ${JSON.stringify(activeErrors)})`
    );

    const cardCount = await activePage.evaluate(() => document.querySelectorAll('#hand-area .card').length);
    assert(cardCount === 8, `all 8 expansion cards actually rendered as real .card DOM nodes in #hand-area (got ${cardCount})`);

    console.log('\n== checking buildCardNode() rendered correct cost/name/text for each of the 8 (not just "didn\'t crash") ==');
    // data-index matches EXPANSION_POOL's array order (the hand was set
    // directly from EXPANSION_POOL.slice() above).
    const details = await activePage.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('#hand-area .card'))
        .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
      return nodes.map((n) => ({
        cost: n.querySelector('.card-cost').textContent,
        name: n.querySelector('.card-name').textContent,
        title: n.title,
        typeClass: Array.from(n.classList).find((c) => c.startsWith('type-')),
      }));
    });
    const expectedOrder = ['enfeeble', 'cripplingBlow', 'exploitWeakness', 'overextend', 'steadyBreath', 'corrosiveAura', 'crushingCurse', 'opportunist'];
    const expectedDefs = {
      enfeeble: { cost: '1', name: 'Enfeeble', type: 'type-attack' },
      cripplingBlow: { cost: '2', name: 'Crippling Blow', type: 'type-attack' },
      exploitWeakness: { cost: '2', name: 'Exploit Weakness', type: 'type-attack' },
      overextend: { cost: '1', name: 'Overextend', type: 'type-attack' },
      steadyBreath: { cost: '1', name: 'Steady Breath', type: 'type-skill' },
      corrosiveAura: { cost: '2', name: 'Corrosive Aura', type: 'type-power' },
      crushingCurse: { cost: '2', name: 'Crushing Curse', type: 'type-attack' },
      opportunist: { cost: '1', name: 'Opportunist', type: 'type-skill' },
    };
    expectedOrder.forEach((id, i) => {
      const got = details[i];
      const want = expectedDefs[id];
      assert(
        got && got.cost === want.cost && got.name === want.name && got.typeClass === want.type,
        `${id}: rendered cost/name/type match EXPANSION_CARD_DEFS (cost=${want.cost}, name=${want.name}, type=${want.type}) (got ${JSON.stringify(got)})`
      );
    });

    console.log('\n== checking the turn-1 attack-lock tooltip (2nd fixed call site) on a locked expansion Attack card ==');
    const isFirstPlayerTurn1 = await activePage.evaluate(() => AL.state.firstTurnAttackLock === true);
    assert(isFirstPlayerTurn1, 'active client really is the first player on turn 1 with the attack lock in effect (precondition for this check)');
    const crushingCurseTitle = details[expectedOrder.indexOf('crushingCurse')].title;
    assert(
      crushingCurseTitle === '첫 턴에는 공격 카드를 낼 수 없습니다',
      `a locked expansion Attack card (Crushing Curse) gets the real lock tooltip via cardDefById(), not a crash (got title=${JSON.stringify(crushingCurseTitle)})`
    );
    const steadyBreathTitle = details[expectedOrder.indexOf('steadyBreath')].title;
    assert(
      steadyBreathTitle === '',
      `a non-Attack expansion card (Steady Breath, Skill) gets NO lock tooltip even while the lock is active (got title=${JSON.stringify(steadyBreathTitle)})`
    );

    console.log('\n== clearing the turn-1 lock and re-rendering, so we can actually click-play an expansion Attack card ==');
    await activePage.evaluate(() => {
      AL.state.firstTurnAttackLock = false;
      // Toggle a selection on then off -- both selectCard() branches emit(),
      // so this forces a real re-render (clearing the stale lock tooltips)
      // without actually playing anything.
      AL.selectCard(0);
      AL.selectCard(0);
    });

    console.log('\n== 3rd fixed call site: a REAL DOM click on an expansion Attack card (Crippling Blow), then a real click on the opponent panel, played end-to-end ==');
    const oppHpBefore = await activePage.evaluate(() => AL.state.opponent.hp);
    const cripplingBlowIndex = await activePage.evaluate(() =>
      AL.state.player.hand.indexOf('cripplingBlow')
    );
    await activePage.click(`#hand-area .card[data-index="${cripplingBlowIndex}"]`);
    await waitFor(activePage, () => AL.state.selected !== null, { timeoutMs: 5000 });
    assert(
      activeErrors.length === 0,
      `no uncaught page errors after a real DOM click on the expansion card selects it (onHandCardClick()'s fixed call site) (got: ${JSON.stringify(activeErrors)})`
    );
    await activePage.click('#opponent-area');
    await sleep(400); // let the 240ms play animation / resolveCard settle
    const oppHpAfter = await activePage.evaluate(() => AL.state.opponent.hp);
    const playerWeakenAfter = await activePage.evaluate(() => AL.state.opponent.weaken);
    assert(
      oppHpAfter === oppHpBefore - 8,
      `Crippling Blow's real click-driven play actually landed its 8 damage on the opponent (before=${oppHpBefore}, after=${oppHpAfter})`
    );
    assert(
      playerWeakenAfter === 1,
      `Crippling Blow's real click-driven play correctly granted Weaken 1 to the opponent (got ${playerWeakenAfter})`
    );
    assert(
      activeErrors.length === 0,
      `no uncaught page errors at any point during the full render/hover/click flow for all 8 expansion cards (got: ${JSON.stringify(activeErrors)})`
    );

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    if (browserA) await browserA.close().catch(() => {});
    if (browserB) await browserB.close().catch(() => {});
    staticServer.close();
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Expansion-card battle UI smoke test crashed:', err);
  process.exit(1);
});
