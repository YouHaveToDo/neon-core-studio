/* Manual smoke test for GET /api/match-history (plan.md Phase 5.1, spec
 * §6.5). Same spirit as scripts/deck-smoke-test.js / scripts/pvp-smoke-test.js
 * -- programmer's own sanity pass before handoff.
 *
 * Spawns its own server instance (same pattern as pvp-smoke-test.js) on a
 * dedicated port with the SHORT disconnect-timing overrides, so the
 * win_forfeit scenario (via a real disconnect + auto-forfeit) doesn't take
 * 45 real seconds.
 *
 * Covers, end to end through the real HTTP/WS stack (not just unit-level):
 *   - 401 without a session
 *   - empty state for a brand-new account (matches: [])
 *   - a real WS match ending via report_result -> win row for the winner,
 *     loss row for the loser, both with the correct opponent display name
 *   - a real disconnect + 45s(-equivalent) auto-forfeit -> win_forfeit for
 *     the winner (rendered client-side as "승 (기권)"), plain loss for the
 *     loser
 *   - ordering (most recent first) and the 100-row cap, via a direct SQL
 *     insert of 130 synthetic rows for a dedicated account (this part
 *     doesn't need to go through real matches -- it's testing the query's
 *     LIMIT/ORDER BY, which is deliberately not something you need 130 real
 *     matches to exercise)
 *
 * Usage (from server/): node scripts/match-history-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied (npm run migrate).
 */
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const TEST_PORT = 3098;
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

async function api(cookie, path, options) {
  options = options || {};
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE_HTTP}${path}`, {
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
  const email = `historysmoke-${rand}@example.com`;
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

function waitForMessage(ws, predicate, timeoutMs = 8000) {
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

async function main() {
  console.log(`\n== spawning server on port ${TEST_PORT} ==`);
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

    console.log('\n== GET /api/match-history without a session ==');
    let { res, body } = await api(null, '/api/match-history');
    assert(res.status === 401, `no-session GET /api/match-history returns 401 (got ${res.status})`);

    console.log('\n== signup a brand-new account: empty state ==');
    const carol = await signup('CarolFresh');
    ({ res, body } = await api(carol.cookie, '/api/match-history'));
    assert(res.status === 200, `GET /api/match-history returns 200 (got ${res.status})`);
    assert(Array.isArray(body.matches) && body.matches.length === 0, `fresh account has an empty matches list (got ${JSON.stringify(body.matches)})`);

    console.log('\n== signup Alice + Bob, play a real WS match ending via report_result ==');
    const alice = await signup('AliceHistory');
    const bob = await signup('BobHistory');
    const aliceWs = await connectWs(alice.cookie);
    let bobWs = await connectWs(bob.cookie);

    aliceWs.send(JSON.stringify({ type: 'room_create' }));
    const created = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
    bobWs.send(JSON.stringify({ type: 'room_join', code: created.code }));
    await Promise.all([
      waitForMessage(bobWs, (m) => m.type === 'room_joined'),
      waitForMessage(aliceWs, (m) => m.type === 'opponent_joined'),
    ]);

    // Alice reports herself the winner -- ws/server.js's report_result
    // handler writes both sides (spec §6.4/§6.5) from whichever report
    // arrives first, trusting the client per the documented scope boundary.
    aliceWs.send(JSON.stringify({ type: 'report_result', result: 'win' }));
    await Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'match_ended'),
      waitForMessage(bobWs, (m) => m.type === 'match_ended'),
    ]);
    await sleep(300); // let the DB write settle

    ({ res, body } = await api(alice.cookie, '/api/match-history'));
    assert(res.status === 200, `Alice's GET /api/match-history returns 200 (got ${res.status})`);
    assert(body.matches.length === 1, `Alice has exactly 1 match (got ${body.matches.length})`);
    assert(body.matches[0].result === 'win', `Alice's row is 'win' (got ${body.matches[0].result})`);
    assert(body.matches[0].opponentDisplayName === 'BobHistory', `Alice's row names BobHistory as opponent (got ${body.matches[0].opponentDisplayName})`);
    assert(/^\d{4}-\d{2}-\d{2}$/.test(body.matches[0].playedAt), `Alice's row date is YYYY-MM-DD format (got ${body.matches[0].playedAt})`);

    ({ res, body } = await api(bob.cookie, '/api/match-history'));
    assert(body.matches.length === 1 && body.matches[0].result === 'loss', `Bob has exactly 1 'loss' row (got ${JSON.stringify(body.matches)})`);
    assert(body.matches[0].opponentDisplayName === 'AliceHistory', `Bob's row names AliceHistory as opponent (got ${body.matches[0].opponentDisplayName})`);

    console.log('\n== second match: Bob disconnects, never reconnects -- real auto-forfeit -> win_forfeit for Alice, loss for Bob ==');
    aliceWs.send(JSON.stringify({ type: 'room_create' }));
    const created2 = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
    bobWs = await connectWs(bob.cookie);
    bobWs.send(JSON.stringify({ type: 'room_join', code: created2.code }));
    await Promise.all([
      waitForMessage(bobWs, (m) => m.type === 'room_joined'),
      waitForMessage(aliceWs, (m) => m.type === 'opponent_joined'),
    ]);

    const disconnectPromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_disconnected');
    bobWs.close();
    await disconnectPromise;
    console.log(`  Bob disconnected, waiting ~${DISCONNECT_GRACE_MS}ms for auto-forfeit...`);
    const autoForfeit = await waitForMessage(aliceWs, (m) => m.type === 'match_ended', DISCONNECT_GRACE_MS + 3000);
    assert(autoForfeit.result === 'win_forfeit', `auto-forfeit match_ended is win_forfeit for Alice (got ${JSON.stringify(autoForfeit)})`);
    await sleep(300);

    ({ res, body } = await api(alice.cookie, '/api/match-history'));
    assert(body.matches.length === 2, `Alice now has 2 matches (got ${body.matches.length})`);
    assert(body.matches[0].result === 'win_forfeit', `Alice's most-recent row is win_forfeit (got ${body.matches[0].result})`);
    assert(body.matches[1].result === 'win', 'Alice\'s older row (plain win) is second, confirming most-recent-first ordering');

    ({ res, body } = await api(bob.cookie, '/api/match-history'));
    assert(body.matches.length === 2, `Bob now has 2 matches (got ${body.matches.length})`);
    assert(body.matches[0].result === 'loss', `Bob's forfeited match is recorded as plain 'loss', not a distinct enum (got ${body.matches[0].result})`);

    console.log('\n== 100-row cap: insert 130 synthetic rows for a dedicated account, confirm only 100 come back, most recent first ==');
    const dave = await signup('DaveCapTest');
    const { pool } = require('../src/db');
    // Insert 130 rows with explicit, strictly increasing played_at timestamps
    // (1 second apart) so "most recent first" is unambiguous to verify --
    // row #130 (opponent "Opp129") is the newest and must be first.
    const values = [];
    const params = [];
    for (let i = 0; i < 130; i++) {
      const base = params.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, now() - interval '1 second' * ${130 - i})`);
      params.push(dave.accountId, `Opp${i}`, i % 2 === 0 ? 'win' : 'loss');
    }
    await pool.query(
      `INSERT INTO match_history (account_id, opponent_display_name, result, played_at) VALUES ${values.join(', ')}`,
      params
    );

    ({ res, body } = await api(dave.cookie, '/api/match-history'));
    assert(res.status === 200, `Dave's GET /api/match-history returns 200 (got ${res.status})`);
    assert(body.matches.length === 100, `capped at exactly 100 rows despite 130 stored (got ${body.matches.length})`);
    assert(body.matches[0].opponentDisplayName === 'Opp129', `most recent row (Opp129, played_at closest to now) is first (got ${body.matches[0].opponentDisplayName})`);
    assert(body.matches[99].opponentDisplayName === 'Opp30', `100th row is Opp30, i.e. rows Opp0..Opp29 (the oldest 30) are correctly excluded (got ${body.matches[99].opponentDisplayName})`);
    // Confirm strictly descending order across the whole page, not just endpoints.
    let strictlyDescending = true;
    for (let i = 1; i < body.matches.length; i++) {
      if (body.matches[i - 1].playedAt < body.matches[i].playedAt) strictlyDescending = false;
    }
    assert(strictlyDescending, 'all 100 returned rows are in non-increasing date order');

    await pool.end();

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Match history smoke test crashed:', err);
  process.exit(1);
});
