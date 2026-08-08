/* Real-browser Playwright smoke test for the shop screen (docs/design/
 * card-shop-currency-proposal.md §6-§7, Phase 6/7 of the card-shop-currency
 * milestone -- js/shop.js, js/main.js's main-menu Ink display, index.html's
 * #screen-shop).
 *
 * Same spawn-the-real-server-on-3001 + static-file-server-on-8080 + real
 * chromium pattern as frozen-client-turn-timeout-test.js, since the client
 * hard-codes API_BASE_URL=http://localhost:3001 for localhost dev
 * (js/config.js) -- driving the actual unmodified client bundle, not a
 * mocked page.
 *
 * Covers (all via real clicks against the real client + real backend,
 * server-verified via direct GET /api/economy calls, not just assumed from
 * what the client displays):
 *   - main menu shows the account's correct Ink balance on load
 *   - clicking 상점 opens the shop screen with correct balance + a fully
 *     locked progress grid for a brand-new (0-owned) account
 *   - granting 500 Ink via direct SQL, then clicking 뽑기 in the browser:
 *     the reveal shows a real expansion-pool card, the displayed balance
 *     drops by exactly 50, and the progress grid/label reflect the new
 *     ownership -- cross-checked against GET /api/economy
 *   - a real insufficient-Ink pull (account balance forced to 10 via SQL,
 *     well under the 50 cost): clicking 뽑기 shows the server's
 *     insufficient_ink message inline, does not crash, and does not change
 *     the displayed balance
 *   - collection-complete state: draining a separate account's bag via 24
 *     direct API pulls (fast, not 24 browser clicks) to grant all 8
 *     expansion cards at 3/3, confirmed via a direct GET /api/economy call,
 *     then opening the shop screen in the browser and confirming the
 *     complete banner shows and the pull button is not present/hidden
 *   - returning to the main menu re-fetches and shows the updated Ink
 *     balance (App.returnToMainMenu's refreshInkBalance)
 *
 * Usage: NODE_PATH=<dir containing a 'playwright' install> node
 *   scripts/shop-ui-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied, port 3001 free (real API_BASE_URL) and port
 * 8080 free (this test's static file server for index.html/js/css).
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
      '  NODE_PATH=~/.npm/_npx/<hash>/node_modules node scripts/shop-ui-smoke-test.js\n' +
      `(original error: ${err.message})`
  );
  process.exit(1);
}

const SERVER_PORT = 3001; // must match js/api.js's hard-coded API_BASE_URL
const STATIC_PORT = 8080;
const REPO_ROOT = path.join(__dirname, '..', '..');
const EXPANSION_CARD_IDS = [
  'enfeeble', 'cripplingBlow', 'exploitWeakness', 'overextend',
  'steadyBreath', 'corrosiveAura', 'crushingCurse', 'opportunist',
];
const PULL_COST = 50;

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
  const email = `shopui-${rand}@example.com`;
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

async function apiAs(account, apiPath, options) {
  options = options || {};
  const headers = { 'Content-Type': 'application/json', Cookie: `${account.cookie.name}=${account.cookie.value}` };
  const res = await fetch(`http://localhost:${SERVER_PORT}${apiPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = null; }
  }
  return { res, body };
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

async function loginToMainMenu(browser, account) {
  const context = await browser.newContext();
  await context.addCookies([
    { name: account.cookie.name, value: account.cookie.value, domain: 'localhost', path: '/', httpOnly: true, secure: false },
  ]);
  const page = await context.newPage();
  await page.goto(`http://localhost:${STATIC_PORT}/index.html`);
  await waitFor(page, () => !document.getElementById('screen-main-menu').classList.contains('hidden'));
  return { context, page };
}

async function main() {
  console.log(`\n== spawning real server on port ${SERVER_PORT} ==`);
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

  let browser;
  try {
    await waitForServerReady();
    console.log('  server is up');
    const { pool } = require('../src/db');

    browser = await chromium.launch();

    // ---- Scenario 1: main menu Ink display + shop open, fresh account ----
    console.log('\n\n########## SCENARIO 1: main-menu Ink display + shop open (fresh account) ##########');
    const carol = await signup('CarolShop');
    await pool.query('UPDATE accounts SET ink_balance = $2 WHERE id = $1', [carol.accountId, 220]);

    const { page: pageC } = await loginToMainMenu(browser, carol);
    await waitFor(pageC, () => document.getElementById('main-menu-ink-amount').textContent === '220');
    assert(true, 'main menu shows the granted 220 Ink balance on load');

    await pageC.click('#btn-menu-shop');
    await waitFor(pageC, () => !document.getElementById('screen-shop').classList.contains('hidden'));
    await waitFor(pageC, () => document.getElementById('shop-ink-amount').textContent === '220');
    assert(true, 'shop screen shows the correct Ink balance on open');

    const lockedCount = await pageC.evaluate(() => document.querySelectorAll('#shop-pool-grid .pool-card-wrap.locked').length);
    assert(lockedCount === 8, `fresh account's shop progress grid shows all 8 expansion cards locked (got ${lockedCount})`);
    const progressLabel = await pageC.evaluate(() => document.getElementById('shop-progress-label').textContent);
    assert(progressLabel.includes('0/8'), `progress label reads 0/8 for a fresh account (got "${progressLabel}")`);

    // ---- Scenario 2: real pull via the actual button click ----
    console.log('\n\n########## SCENARIO 2: real pull via browser click ##########');
    const beforePull = await apiAs(carol, '/api/economy');
    assert(beforePull.body.inkBalance === 220, 'sanity: server confirms 220 Ink before pulling');

    await pageC.click('#btn-shop-pull');
    await waitFor(pageC, () => document.getElementById('shop-ink-amount').textContent === '170', { timeoutMs: 8000 });
    assert(true, 'displayed balance drops by exactly 50 (220 -> 170) after a real pull click');

    const revealTitle = await pageC.evaluate(() => document.getElementById('shop-caption-title').textContent);
    assert(revealTitle === '카드를 획득했습니다!', `reveal caption shows the success message (got "${revealTitle}")`);
    const revealedName = await pageC.evaluate(() => {
      const nameEl = document.querySelector('#shop-reveal-front .card-name');
      return nameEl ? nameEl.textContent : null;
    });
    assert(!!revealedName, `reveal stage shows a real card name (got "${revealedName}")`);
    const revealedFlipped = await pageC.evaluate(() => document.getElementById('shop-reveal-stage').classList.contains('revealed'));
    assert(revealedFlipped, 'reveal stage has flipped to the front face');

    const afterPull = await apiAs(carol, '/api/economy');
    assert(afterPull.body.inkBalance === 170, `server confirms Ink actually dropped to 170 (got ${afterPull.body.inkBalance})`);
    const ownedCount = Object.values(afterPull.body.expansionCards).reduce((a, b) => a + b, 0);
    assert(ownedCount === 1, `server confirms exactly 1 expansion card now owned (got ${JSON.stringify(afterPull.body.expansionCards)})`);

    const unlockedCount = await pageC.evaluate(() => document.querySelectorAll('#shop-pool-grid .pool-card-wrap.locked').length);
    assert(unlockedCount === 7, `progress grid now shows 7 locked / 1 unlocked after the pull (got ${unlockedCount} locked)`);

    // ---- Scenario 3: real insufficient-Ink pull ----
    console.log('\n\n########## SCENARIO 3: real insufficient Ink pull ##########');
    const dave = await signup('DaveShop');
    await pool.query('UPDATE accounts SET ink_balance = $2 WHERE id = $1', [dave.accountId, 10]);
    const { page: pageD } = await loginToMainMenu(browser, dave);
    await waitFor(pageD, () => document.getElementById('main-menu-ink-amount').textContent === '10');
    await pageD.click('#btn-menu-shop');
    await waitFor(pageD, () => !document.getElementById('screen-shop').classList.contains('hidden'));
    await waitFor(pageD, () => document.getElementById('shop-ink-amount').textContent === '10');

    await pageD.click('#btn-shop-pull');
    await waitFor(pageD, () => !document.getElementById('shop-error').classList.contains('hidden'), { timeoutMs: 8000 });
    const errorText = await pageD.evaluate(() => document.getElementById('shop-error').textContent);
    assert(errorText.includes('부족') && errorText.includes('50') && errorText.includes('10'), `insufficient-Ink error shows the real shortfall (got "${errorText}")`);
    const daveBalanceAfter = await apiAs(dave, '/api/economy');
    assert(daveBalanceAfter.body.inkBalance === 10, 'a failed insufficient-Ink pull does not touch the account balance');
    const stillOnShop = await pageD.evaluate(() => !document.getElementById('screen-shop').classList.contains('hidden'));
    assert(stillOnShop, 'client does not crash/navigate away on a 400 insufficient_ink response');

    // ---- Scenario 4: collection-complete state, server-verified ----
    console.log('\n\n########## SCENARIO 4: collection-complete state (24 real pulls via API, then real browser check) ##########');
    const erin = await signup('ErinShop');
    await pool.query('UPDATE accounts SET ink_balance = $2 WHERE id = $1', [erin.accountId, 24 * PULL_COST]);
    for (let i = 0; i < 24; i++) {
      const { res, body } = await apiAs(erin, '/api/economy/pull', { method: 'POST' });
      if (res.status !== 200) throw new Error(`pull #${i + 1} failed unexpectedly: ${res.status} ${JSON.stringify(body)}`);
    }
    const erinFinal = await apiAs(erin, '/api/economy');
    const allMaxed = EXPANSION_CARD_IDS.every((id) => erinFinal.body.expansionCards[id] === 3);
    assert(allMaxed, `server confirms all 8 expansion cards at exactly 3/3 after 24 pulls (got ${JSON.stringify(erinFinal.body.expansionCards)})`);
    assert(erinFinal.body.inkBalance === 0, `server confirms Ink balance drained to exactly 0 (got ${erinFinal.body.inkBalance})`);

    const { res: pull25Res, body: pull25Body } = await apiAs(erin, '/api/economy/pull', { method: 'POST' });
    assert(pull25Res.status === 409 && pull25Body.error === 'collection_complete', `a 25th pull attempt is rejected 409 collection_complete (got ${pull25Res.status}: ${JSON.stringify(pull25Body)})`);

    const { page: pageE } = await loginToMainMenu(browser, erin);
    await pageE.click('#btn-menu-shop');
    await waitFor(pageE, () => !document.getElementById('screen-shop').classList.contains('hidden'));
    await waitFor(pageE, () => !document.getElementById('shop-complete-banner').classList.contains('hidden'), { timeoutMs: 8000 });
    assert(true, 'shop screen shows the collection-complete banner for an account that owns all 8 at 3/3');
    const pullBtnHidden = await pageE.evaluate(() => document.getElementById('btn-shop-pull').classList.contains('hidden'));
    assert(pullBtnHidden, 'pull button is hidden/unreachable once the collection is complete (defensive per the design doc)');
    const fullBadgeCount = await pageE.evaluate(() => document.querySelectorAll('#shop-pool-grid .pool-count-badge.full').length);
    assert(fullBadgeCount === 8, `progress grid shows all 8 tiles at the "full" 3/3 badge state (got ${fullBadgeCount})`);
    const finalProgressLabel = await pageE.evaluate(() => document.getElementById('shop-progress-label').textContent);
    assert(finalProgressLabel.includes('8/8'), `progress label reads 8/8 (got "${finalProgressLabel}")`);

    // ---- Scenario 5: returning to main menu re-fetches the Ink balance ----
    console.log('\n\n########## SCENARIO 5: return-to-main-menu re-fetches Ink balance ##########');
    await pool.query('UPDATE accounts SET ink_balance = $2 WHERE id = $1', [carol.accountId, 999]);
    await pageC.click('#btn-shop-back');
    await waitFor(pageC, () => !document.getElementById('screen-main-menu').classList.contains('hidden'));
    await waitFor(pageC, () => document.getElementById('main-menu-ink-amount').textContent === '999', { timeoutMs: 8000 });
    assert(true, 'main menu re-fetches and shows the updated Ink balance after returning from the shop');

    console.log(`\n\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    if (browser) await browser.close();
    child.kill();
    staticServer.close();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
