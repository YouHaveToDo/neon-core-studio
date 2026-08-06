/* Playwright regression test for spec-online-pvp.md §6.2.6 (fill-race
 * handling on the room-list screen) -- drives the REAL client UI (not just
 * the raw WS protocol, which scripts/room-list-smoke-test.js already
 * covers) so this specifically proves js/match.js's client-side handling of
 * a rejected room_join: stays on the list screen, shows the exact inline
 * toast wording, and auto-refreshes so the stale row is gone -- not a crash
 * or a dead-end.
 *
 * Three browser contexts, one process (unlike scripts/frozen-client-turn-
 * timeout-test.js's genuinely-separate-process requirement for the freeze
 * test, this scenario doesn't need real process-level isolation -- it's
 * just three ordinary clients hitting the same room at once).
 *
 * Usage: NODE_PATH=<dir containing a 'playwright' install> node
 *   scripts/room-list-ui-fill-race-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL (or an
 * explicit DATABASE_URL env override -- see the task report for why that
 * matters), migrations applied, ports 3001 and 8080 free.
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
      '  NODE_PATH=~/.npm/_npx/<hash>/node_modules node scripts/room-list-ui-fill-race-test.js\n' +
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
  const email = `fillrace-${rand}@example.com`;
  const res = await fetch(`http://localhost:${SERVER_PORT}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', confirmPassword: 'password123', displayName }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const cookie = extractCookie(res);
  return { email, cookie, displayName };
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

async function main() {
  console.log('== spawning server ==');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(SERVER_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  let browser;
  try {
    await waitForServerReady();
    await startStaticServer();
    console.log('  server + static file server up');

    console.log('\n== signup host + two simultaneous joiners, launch 3 browser contexts ==');
    const host = await signup('HostFillRace');
    const joinerA = await signup('JoinerA');
    const joinerB = await signup('JoinerB');

    browser = await chromium.launch();
    const [{ page: hostPage }, { page: pageA }, { page: pageB }] = await Promise.all([
      loginAndReachLobby(browser, host),
      loginAndReachLobby(browser, joinerA),
      loginAndReachLobby(browser, joinerB),
    ]);

    console.log('\n== host creates a room ==');
    await hostPage.click('#btn-lobby-create');
    await waitFor(hostPage, () => !document.getElementById('lobby-panel-waiting').classList.contains('hidden'));

    console.log("\n== both joiners see the host's room in their (independently polled) lists ==");
    await Promise.all(
      [pageA, pageB].map((page) =>
        waitFor(page, () => {
          const btn = document.getElementById('btn-lobby-refresh');
          if (btn) btn.click();
          return document.querySelectorAll('#room-list .room-row').length > 0;
        }, { timeoutMs: 15000 })
      )
    );

    console.log('\n== both joiners click the SAME row at effectively the same time ==');
    await Promise.all([pageA.click('.room-row'), pageB.click('.room-row')]);

    // Give both requests time to round-trip and the loser's UI to settle
    // into its post-rejection state (toast shown, list auto-refreshed).
    await sleep(1500);

    const stateA = await pageA.evaluate(() => ({
      screen: typeof AL !== 'undefined' ? AL.state.screen : null,
      onLobby: !document.getElementById('screen-lobby').classList.contains('hidden'),
      toastVisible: !document.getElementById('lobby-toast').classList.contains('hidden'),
      toastText: document.getElementById('lobby-toast').textContent,
      rowCount: document.querySelectorAll('#room-list .room-row').length,
    }));
    const stateB = await pageB.evaluate(() => ({
      screen: typeof AL !== 'undefined' ? AL.state.screen : null,
      onLobby: !document.getElementById('screen-lobby').classList.contains('hidden'),
      toastVisible: !document.getElementById('lobby-toast').classList.contains('hidden'),
      toastText: document.getElementById('lobby-toast').textContent,
      rowCount: document.querySelectorAll('#room-list .room-row').length,
    }));

    console.log(`  joinerA state: ${JSON.stringify(stateA)}`);
    console.log(`  joinerB state: ${JSON.stringify(stateB)}`);

    const winners = [stateA, stateB].filter((s) => s.screen === 'howto');
    const losers = [stateA, stateB].filter((s) => s.screen !== 'howto');

    assert(winners.length === 1, `exactly one of the two simultaneous joiners actually enters the match (got ${winners.length})`);
    assert(losers.length === 1, `exactly one of the two is left behind on the lobby screen, not both stuck and not both in (got ${losers.length})`);

    if (losers.length === 1) {
      const loser = losers[0];
      assert(loser.onLobby, 'the rejected joiner is still on the room-list screen, not stranded on a broken/blank screen');
      assert(loser.toastVisible, 'the rejected joiner sees a visible inline toast');
      assert(
        loser.toastText.includes('이미 다른 플레이어가 참가한 방입니다'),
        `the toast uses spec §6.2.6's exact wording (got "${loser.toastText}")`
      );
      assert(loser.rowCount === 0, "the rejected joiner's list auto-refreshed and no longer shows the now-full room (got " + loser.rowCount + ' rows)');
    }

    if (winners.length === 1) {
      assert(
        winners[0].screen === 'howto',
        'the successful joiner proceeded all the way to the match-start sequence (How to Play overlay), not stuck mid-transition'
      );
    }

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Room-list fill-race UI test crashed:', err);
  process.exit(1);
});
