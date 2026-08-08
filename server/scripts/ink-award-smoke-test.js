/* Manual smoke test for Phase 2 of docs/design/card-shop-currency-proposal.md
 * (Ink currency + card-ownership schema, this milestone): confirms Ink is
 * awarded correctly for every match-end path that funnels through
 * lib/matchHistory.js's recordMatchResult/recordVoidMatch, and that
 * GET /api/economy reports the resulting balance/ownership correctly.
 *
 * Same spawn-a-dedicated-server-with-short-timing-overrides pattern as
 * pvp-smoke-test.js / double-disconnect-smoke-test.js -- reuses those two
 * scripts' own repro shapes (real WS relay, two real clients) rather than
 * writing to accounts.ink_balance directly, so this is actually exercising
 * the real match-end code path, not just the SQL.
 *
 * Covers:
 *   - a real win (report_result) -> winner +15, loser +5
 *   - a real win_forfeit (auto-forfeit after disconnect grace expires) ->
 *     winner +15, loser +5 (forfeit-loss pays the same as a normal loss)
 *   - a real simultaneous double-disconnect ('void', reusing double-
 *     disconnect-smoke-test.js's back-to-back-close repro) -> both sides +0
 *   - GET /api/economy returns the correct running inkBalance + an empty
 *     expansionCards map ({}) for every account above (no shop/pull endpoint
 *     exists yet this phase, so expansionCards must stay empty throughout)
 *
 * Usage (from server/): node scripts/ink-award-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied (npm run migrate -- specifically
 * 003_add_ink_and_expansion_cards.sql, which adds the columns this test
 * asserts on).
 */
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const TEST_PORT = 3097;
const BASE_HTTP = `http://localhost:${TEST_PORT}`;
const BASE_WS = `ws://localhost:${TEST_PORT}`;
const DISCONNECT_GRACE_MS = 3000;

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
  return setCookie.split(';')[0];
}

async function api(cookie, apiPath, options) {
  options = options || {};
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE_HTTP}${apiPath}`, {
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

async function signup(displayName) {
  const rand = Math.random().toString(36).slice(2, 8);
  const email = `inksmoke-${rand}@example.com`;
  const { res, body } = await api(null, '/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'password123', confirmPassword: 'password123', displayName },
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(body)}`);
  const cookie = extractCookie(res);
  return { email, cookie, accountId: body.account.id, displayName };
}

function connectWs(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_WS}/ws`, { headers: cookie ? { Cookie: cookie } : {} });
    ws.once('open', () => {
      ws.buffered = [];
      ws.waiters = [];
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        const waiterIndex = ws.waiters.findIndex((w) => w.predicate(msg));
        if (waiterIndex !== -1) {
          const [waiter] = ws.waiters.splice(waiterIndex, 1);
          waiter.resolve(msg);
          return;
        }
        ws.buffered.push(msg);
      });
      resolve(ws);
    });
    ws.once('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = DISCONNECT_GRACE_MS + 3000) {
  const bufferedIndex = ws.buffered.findIndex(predicate);
  if (bufferedIndex !== -1) {
    return Promise.resolve(ws.buffered.splice(bufferedIndex, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const waiter = { predicate };
    const timer = setTimeout(() => {
      const i = ws.waiters.indexOf(waiter);
      if (i !== -1) ws.waiters.splice(i, 1);
      reject(new Error('timeout waiting for message'));
    }, timeoutMs);
    waiter.resolve = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
    ws.waiters.push(waiter);
  });
}

async function waitForServerReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_HTTP}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error('server did not become ready in time');
}

async function createAndJoinRoom(aliceWs, bobWs) {
  aliceWs.send(JSON.stringify({ type: 'room_create' }));
  const created = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
  bobWs.send(JSON.stringify({ type: 'room_join', code: created.code }));
  await Promise.all([
    waitForMessage(bobWs, (m) => m.type === 'room_joined'),
    waitForMessage(aliceWs, (m) => m.type === 'opponent_joined'),
  ]);
  return created.code;
}

async function main() {
  console.log(`\n== spawning server on port ${TEST_PORT} with short DISCONNECT_GRACE_MS=${DISCONNECT_GRACE_MS} ==`);
  const serverDir = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      PVP_DISCONNECT_GRACE_MS: String(DISCONNECT_GRACE_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  try {
    await waitForServerReady();
    console.log('  server is up');

    console.log('\n== brand-new account starts at 0 Ink, empty expansionCards ==');
    const fresh = await signup('FreshInk');
    let { res, body } = await api(fresh.cookie, '/api/economy');
    assert(res.status === 200, `GET /api/economy returns 200 (got ${res.status})`);
    assert(body.inkBalance === 0, `fresh account has 0 Ink (got ${body.inkBalance})`);
    assert(
      typeof body.expansionCards === 'object' && Object.keys(body.expansionCards).length === 0,
      `fresh account has an empty expansionCards map (got ${JSON.stringify(body.expansionCards)})`
    );

    console.log('\n== Scenario 1: real win/loss via report_result -> winner +15, loser +5 ==');
    const alice = await signup('AliceInk');
    const bob = await signup('BobInk');
    let aliceWs = await connectWs(alice.cookie);
    let bobWs = await connectWs(bob.cookie);
    await createAndJoinRoom(aliceWs, bobWs);

    aliceWs.send(JSON.stringify({ type: 'report_result', result: 'win' }));
    await Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'match_ended'),
      waitForMessage(bobWs, (m) => m.type === 'match_ended'),
    ]);
    await sleep(300); // let the DB write settle

    ({ res, body } = await api(alice.cookie, '/api/economy'));
    assert(body.inkBalance === 15, `Alice (winner) has 15 Ink after her first win (got ${body.inkBalance})`);
    ({ res, body } = await api(bob.cookie, '/api/economy'));
    assert(body.inkBalance === 5, `Bob (loser) has 5 Ink after his first loss (got ${body.inkBalance})`);

    console.log('\n== Scenario 2: win_forfeit / forfeit-loss via disconnect auto-forfeit -> +15 / +5, same as a normal win/loss ==');
    await createAndJoinRoom(aliceWs, bobWs);
    const disconnectPromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_disconnected');
    bobWs.close();
    await disconnectPromise;
    const autoForfeit = await waitForMessage(aliceWs, (m) => m.type === 'match_ended', DISCONNECT_GRACE_MS + 3000);
    assert(autoForfeit.result === 'win_forfeit', `auto-forfeit match_ended is win_forfeit for Alice (got ${JSON.stringify(autoForfeit)})`);
    await sleep(300);

    ({ res, body } = await api(alice.cookie, '/api/economy'));
    assert(body.inkBalance === 30, `Alice now has 15 (first win) + 15 (win_forfeit) = 30 Ink (got ${body.inkBalance})`);
    ({ res, body } = await api(bob.cookie, '/api/economy'));
    assert(body.inkBalance === 10, `Bob now has 5 (first loss) + 5 (forfeit-loss) = 10 Ink (got ${body.inkBalance})`);

    console.log("\n== Scenario 3: real simultaneous double-disconnect ('void') -> both sides +0 Ink ==");
    bobWs = await connectWs(bob.cookie);
    const roomCode = await createAndJoinRoom(aliceWs, bobWs);
    aliceWs.send(JSON.stringify({ type: 'start_match', firstAccountId: alice.accountId }));
    await Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'turn_started'),
      waitForMessage(bobWs, (m) => m.type === 'turn_started'),
    ]);

    // Close BOTH sockets back-to-back, no gap -- same repro shape as
    // double-disconnect-smoke-test.js's Scenario A.
    aliceWs.close();
    bobWs.close();
    console.log(`  both sockets closed simultaneously, waiting ${DISCONNECT_GRACE_MS + 1500}ms for both grace periods to expire...`);
    await sleep(DISCONNECT_GRACE_MS + 1500);

    ({ res, body } = await api(alice.cookie, '/api/economy'));
    assert(body.inkBalance === 30, `Alice's Ink is UNCHANGED at 30 after a void match (got ${body.inkBalance})`);
    ({ res, body } = await api(bob.cookie, '/api/economy'));
    assert(body.inkBalance === 10, `Bob's Ink is UNCHANGED at 10 after a void match (got ${body.inkBalance})`);

    // Sanity: confirm the match really was recorded as 'void' (not silently
    // skipped for some other reason that would make the +0 assertion vacuous).
    const { pool } = require('../src/db');
    const aliceHistory = await pool.query(
      'SELECT result FROM match_history WHERE account_id = $1 ORDER BY played_at DESC LIMIT 1',
      [alice.accountId]
    );
    assert(
      aliceHistory.rows[0] && aliceHistory.rows[0].result === 'void',
      `Alice's most recent match_history row is genuinely 'void', confirming the +0 check above isn't vacuous (got ${JSON.stringify(aliceHistory.rows[0])})`
    );

    console.log('\n== final GET /api/economy sanity: expansionCards still empty for everyone (no shop/pull endpoint exists yet this phase) ==');
    ({ res, body } = await api(alice.cookie, '/api/economy'));
    assert(Object.keys(body.expansionCards).length === 0, `Alice's expansionCards is still {} (got ${JSON.stringify(body.expansionCards)})`);
    ({ res, body } = await api(bob.cookie, '/api/economy'));
    assert(Object.keys(body.expansionCards).length === 0, `Bob's expansionCards is still {} (got ${JSON.stringify(body.expansionCards)})`);

    console.log('\n== GET /api/economy without a session -> 401 ==');
    ({ res, body } = await api(null, '/api/economy'));
    assert(res.status === 401, `no-session GET /api/economy returns 401 (got ${res.status})`);

    await pool.end();

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Ink award smoke test crashed:', err);
  process.exit(1);
});
