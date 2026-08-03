/* Manual smoke test for QA finding #2 (docs/qa/online-pvp-milestone.md):
 * a genuinely simultaneous double-disconnect used to delete the room
 * outright (server/src/ws/rooms.js's old markDisconnected()), canceling
 * both players' just-armed 45s grace timers -- no auto-forfeit, no
 * match_history row, no reconnect path, for either side. Same spawn-a-
 * dedicated-server-with-short-timing-overrides pattern as pvp-smoke-test.js.
 *
 * Two scenarios:
 *   A. Both sockets close back-to-back (no gap), NEITHER reconnects within
 *      the grace window -> both accounts get a 'void' match_history row,
 *      the room is torn down (a stale room code can't be rejoined).
 *   B. Both sockets close back-to-back, but ONE side reconnects well within
 *      its own grace window -> the match is recoverable (not forced into a
 *      void/forfeit outcome just because both were briefly gone at once).
 *
 * Usage (from server/): node scripts/double-disconnect-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied (npm run migrate -- specifically
 * 002_add_void_match_result.sql, which adds the 'void' result value this
 * test asserts on).
 */
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const TEST_PORT = 3095;
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

async function signup(displayName) {
  const rand = Math.random().toString(36).slice(2, 8);
  const email = `dbldc-${rand}@example.com`;
  const res = await fetch(`${BASE_HTTP}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', confirmPassword: 'password123', displayName }),
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
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

async function queryMatchHistory(accountId) {
  const { pool } = require('../src/db');
  const result = await pool.query(
    'SELECT result, opponent_display_name FROM match_history WHERE account_id = $1 ORDER BY played_at DESC LIMIT 5',
    [accountId]
  );
  return result.rows;
}

async function setUpRoomAndStartMatch(alice, bob) {
  const aliceWs = await connectWs(alice.cookie);
  const bobWs = await connectWs(bob.cookie);
  aliceWs.send(JSON.stringify({ type: 'room_create' }));
  const created = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
  const roomCode = created.code;
  bobWs.send(JSON.stringify({ type: 'room_join', code: roomCode }));
  await Promise.all([
    waitForMessage(bobWs, (m) => m.type === 'room_joined'),
    waitForMessage(aliceWs, (m) => m.type === 'opponent_joined'),
  ]);
  aliceWs.send(JSON.stringify({ type: 'start_match', firstAccountId: alice.accountId }));
  await Promise.all([
    waitForMessage(aliceWs, (m) => m.type === 'turn_started'),
    waitForMessage(bobWs, (m) => m.type === 'turn_started'),
  ]);
  return { aliceWs, bobWs, roomCode };
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

    console.log('\n== Scenario A: simultaneous double-disconnect, NEITHER side reconnects -- must resolve to a recorded, symmetric \'void\' outcome ==');
    const alice = await signup('AliceDbl');
    const bob = await signup('BobDbl');
    const { aliceWs, bobWs, roomCode } = await setUpRoomAndStartMatch(alice, bob);

    // Close BOTH sockets back-to-back, no gap -- this is the exact race that
    // used to hit rooms.js's old "delete the room the instant nobody is
    // connected" behavior before either grace timer could even be armed.
    aliceWs.close();
    bobWs.close();

    console.log(`  both sockets closed simultaneously, waiting ${DISCONNECT_GRACE_MS + 1500}ms for both grace periods to expire...`);
    await sleep(DISCONNECT_GRACE_MS + 1500);

    const aliceHistory = await queryMatchHistory(alice.accountId);
    const bobHistory = await queryMatchHistory(bob.accountId);
    assert(
      aliceHistory[0] && aliceHistory[0].result === 'void' && aliceHistory[0].opponent_display_name === 'BobDbl',
      `Alice's match_history row is 'void' vs BobDbl, not silently missing (got ${JSON.stringify(aliceHistory[0])})`
    );
    assert(
      bobHistory[0] && bobHistory[0].result === 'void' && bobHistory[0].opponent_display_name === 'AliceDbl',
      `Bob's match_history row is 'void' vs AliceDbl too -- symmetric, neither side silently wins/loses (got ${JSON.stringify(bobHistory[0])})`
    );

    const aliceRetryWs = await connectWs(alice.cookie);
    aliceRetryWs.send(JSON.stringify({ type: 'room_join', code: roomCode }));
    const retryErr = await waitForMessage(aliceRetryWs, (m) => m.type === 'error' || m.type === 'room_joined');
    assert(
      retryErr.type === 'error' && retryErr.code === 'ROOM_NOT_FOUND',
      `the voided room is actually gone afterward, not leaked forever (got ${JSON.stringify(retryErr)})`
    );
    aliceRetryWs.close();

    console.log('\n== Scenario B: simultaneous double-disconnect, but ONE side reconnects within its own grace window -- must be recoverable, not force-voided ==');
    const carol = await signup('CarolDbl');
    const dave = await signup('DaveDbl');
    const setup2 = await setUpRoomAndStartMatch(carol, dave);

    setup2.aliceWs.close(); // carol
    setup2.bobWs.close(); // dave

    // Carol reconnects almost immediately -- well within DISCONNECT_GRACE_MS
    // of her own disconnect, even though Dave is ALSO still disconnected at
    // this exact moment (the same "both briefly gone" condition Scenario A
    // exercises). This must NOT be forced into a void outcome just because
    // both happened to be gone at the same instant.
    await sleep(300);
    const carolWs2 = await connectWs(carol.cookie);
    carolWs2.send(JSON.stringify({ type: 'room_join', code: setup2.roomCode }));
    const carolRejoinAck = await waitForMessage(carolWs2, (m) => m.type === 'room_joined');
    assert(carolRejoinAck.reconnected === true, "Carol's reconnect succeeds (room wasn't deleted out from under her)");

    // Dave never comes back -- once HIS OWN grace window (measured from his
    // own disconnect) elapses, this should resolve as a completely normal
    // single-sided forfeit (Carol wins), NOT a void -- the room recovered
    // the moment Carol reconnected, so this is no longer a "both gone"
    // situation from that point on.
    const forfeitMsg = await waitForMessage(
      carolWs2,
      (m) => m.type === 'match_ended',
      DISCONNECT_GRACE_MS + 3000
    );
    assert(
      forfeitMsg.result === 'win_forfeit' && forfeitMsg.reason === 'disconnect_timeout',
      `Carol gets a normal auto-forfeit win once Dave's own grace period lapses, not a void (got ${JSON.stringify(forfeitMsg)})`
    );

    await sleep(300);
    const carolHistory = await queryMatchHistory(carol.accountId);
    const daveHistory = await queryMatchHistory(dave.accountId);
    assert(
      carolHistory[0] && carolHistory[0].result === 'win_forfeit',
      `Carol's match_history row is a real win_forfeit, not void (got ${JSON.stringify(carolHistory[0])})`
    );
    assert(
      daveHistory[0] && daveHistory[0].result === 'loss',
      `Dave's match_history row is a real loss, not void (got ${JSON.stringify(daveHistory[0])})`
    );

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    child.kill();
    try {
      const { pool } = require('../src/db');
      await pool.end();
    } catch {
      // ignore
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Double-disconnect smoke test crashed:', err);
  process.exit(1);
});
