/* Manual end-to-end smoke test for plan.md Phase 2.5-2.7: server-side turn
 * timer, match-result persistence, disconnect/forfeit. Same spirit as
 * scripts/ws-smoke-test.js (2.1-2.3) -- programmer's own sanity pass, not a
 * substitute for a dedicated QA pass.
 *
 * Unlike the other smoke-test scripts, this one SPAWNS its own server
 * instance rather than assuming one is already running -- the 24s/45s/10s
 * spec timings would make a real-timing run take minutes, so this test
 * needs the server started with PVP_TURN_TIMEOUT_MS / PVP_DISCONNECT_GRACE_MS
 * / PVP_CLAIM_FORFEIT_FLOOR_MS overridden to short values (see config.js --
 * these envs exist specifically for this). Spawning it here (rather than
 * asking the operator to remember to set 3 env vars before starting the
 * server by hand) guarantees the test script and the server agree on the
 * same short values, and runs on a dedicated port so it doesn't collide
 * with a normal `npm start` dev server on 3001.
 *
 * Usage (from server/): node scripts/pvp-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied (npm run migrate).
 */
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const TEST_PORT = 3099;
const BASE_HTTP = `http://localhost:${TEST_PORT}`;
const BASE_WS = `ws://localhost:${TEST_PORT}`;

const TURN_TIMEOUT_MS = 3000;
const DISCONNECT_GRACE_MS = 6000;
const CLAIM_FORFEIT_FLOOR_MS = 2000;

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
  const email = `pvpsmoke-${rand}@example.com`;
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

// A simple always-on message bus per socket, rather than attaching/removing
// a fresh 'message' listener per waitForMessage() call. Two server-emitted
// messages that are logically back-to-back (e.g. turn_timeout immediately
// followed by the next turn_started, both broadcast synchronously server-
// side in the same handler) can arrive in the same TCP read and get emitted
// as two 'message' events before this script's `await` even continues past
// the first one -- a sequential "add listener, wait, remove listener, add
// next listener" pattern loses that second message in the gap. Buffering
// every message as it arrives (and having waitForMessage check the buffer
// first) avoids that race entirely.
function connectWs(cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_WS}/ws`, { headers: cookie ? { Cookie: cookie } : {} });
    ws.once('open', () => {
      ws.buffered = [];
      ws.waiters = []; // [{ predicate, resolve }]
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

function waitForMessage(ws, predicate, timeoutMs = TURN_TIMEOUT_MS + 3000) {
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

/** Resolves true if `predicate` never matches within windowMs, false if it does. */
function assertNoMessageWithin(ws, predicate, windowMs) {
  const bufferedIndex = ws.buffered.findIndex(predicate);
  if (bufferedIndex !== -1) {
    ws.buffered.splice(bufferedIndex, 1);
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const waiter = { predicate };
    const timer = setTimeout(() => {
      const i = ws.waiters.indexOf(waiter);
      if (i !== -1) ws.waiters.splice(i, 1);
      resolve(true);
    }, windowMs);
    waiter.resolve = () => {
      clearTimeout(timer);
      resolve(false);
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
  // Loaded lazily (after the child server process's own dotenv load doesn't
  // matter here -- this is our own process) so DATABASE_URL comes from this
  // script's own server/.env via the shared config/db modules.
  const { pool } = require('../src/db');
  const result = await pool.query(
    'SELECT result, opponent_display_name FROM match_history WHERE account_id = $1 ORDER BY played_at DESC LIMIT 5',
    [accountId]
  );
  return result.rows;
}

async function main() {
  console.log(`\n== spawning server on port ${TEST_PORT} with short timer overrides ==`);
  console.log(`   turn=${TURN_TIMEOUT_MS}ms grace=${DISCONNECT_GRACE_MS}ms claimFloor=${CLAIM_FORFEIT_FLOOR_MS}ms`);
  const serverDir = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      PVP_TURN_TIMEOUT_MS: String(TURN_TIMEOUT_MS),
      PVP_DISCONNECT_GRACE_MS: String(DISCONNECT_GRACE_MS),
      PVP_CLAIM_FORFEIT_FLOOR_MS: String(CLAIM_FORFEIT_FLOOR_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  try {
    await waitForServerReady();
    console.log('  server is up');

    console.log('\n== signup two accounts, connect, create/join room ==');
    const alice = await signup('AliceTimer');
    const bob = await signup('BobTimer');
    const aliceWs = await connectWs(alice.cookie);
    let bobWs = await connectWs(bob.cookie);

    aliceWs.send(JSON.stringify({ type: 'room_create' }));
    const created = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
    const roomCode = created.code;

    bobWs.send(JSON.stringify({ type: 'room_join', code: roomCode }));
    await Promise.all([
      waitForMessage(bobWs, (m) => m.type === 'room_joined'),
      waitForMessage(aliceWs, (m) => m.type === 'opponent_joined'),
    ]);

    console.log('\n== Scenario A: start_match + full timer timeout ==');
    const startedAt = Date.now();
    aliceWs.send(JSON.stringify({ type: 'start_match', firstAccountId: alice.accountId }));
    const [aliceStart, bobStart] = await Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'turn_started'),
      waitForMessage(bobWs, (m) => m.type === 'turn_started'),
    ]);
    assert(aliceStart.activeAccountId === alice.accountId, 'turn_started names Alice as the active player');
    assert(
      typeof aliceStart.deadline === 'number' && aliceStart.deadline > Date.now(),
      'turn_started carries a future deadline'
    );
    assert(
      bobStart.activeAccountId === alice.accountId && bobStart.deadline === aliceStart.deadline,
      'both clients receive the identical server-stamped deadline'
    );

    const [aliceTimeout, bobTimeout] = await Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'turn_timeout'),
      waitForMessage(bobWs, (m) => m.type === 'turn_timeout'),
    ]);
    const elapsedForTimeout = Date.now() - startedAt;
    assert(aliceTimeout.accountId === alice.accountId, 'turn_timeout fires for the account whose turn it was (Alice)');
    assert(bobTimeout.accountId === alice.accountId, 'opponent also observes the same turn_timeout');
    assert(
      elapsedForTimeout >= TURN_TIMEOUT_MS - 200,
      `timeout did not fire early (elapsed ${elapsedForTimeout}ms >= ~${TURN_TIMEOUT_MS}ms)`
    );

    const [aliceNext, bobNext] = await Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'turn_started'),
      waitForMessage(bobWs, (m) => m.type === 'turn_started'),
    ]);
    assert(
      aliceNext.activeAccountId === bob.accountId && bobNext.activeAccountId === bob.accountId,
      'after Alice times out, server automatically advances the turn to Bob'
    );

    console.log('\n== Scenario B: manual end_turn ends the turn well before the deadline ==');
    const endTurnAt = Date.now();
    bobWs.send(JSON.stringify({ type: 'end_turn' }));
    const [aliceAfterEnd, bobAfterEnd] = await Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'turn_started'),
      waitForMessage(bobWs, (m) => m.type === 'turn_started'),
    ]);
    const elapsedForEndTurn = Date.now() - endTurnAt;
    assert(
      aliceAfterEnd.activeAccountId === alice.accountId && bobAfterEnd.activeAccountId === alice.accountId,
      'manual end_turn immediately hands the turn back to Alice'
    );
    assert(
      elapsedForEndTurn < TURN_TIMEOUT_MS / 2,
      `turn_started after manual end_turn arrived quickly, not near the 24s-equivalent deadline (${elapsedForEndTurn}ms)`
    );

    console.log('\n== end_turn rejected when it is not your turn ==');
    bobWs.send(JSON.stringify({ type: 'end_turn' })); // it's Alice's turn now
    const notYourTurnErr = await waitForMessage(bobWs, (m) => m.type === 'error');
    assert(notYourTurnErr.code === 'NOT_YOUR_TURN', `end_turn out of turn rejected (got ${JSON.stringify(notYourTurnErr)})`);

    console.log('\n== Scenario C: disconnect + reconnect within the grace window -- forfeit must NOT trigger ==');
    const disconnectPromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_disconnected');
    bobWs.close();
    await disconnectPromise;
    console.log(`  Bob disconnected, waiting ${Math.round(DISCONNECT_GRACE_MS / 2)}ms (under the ${DISCONNECT_GRACE_MS}ms grace) before reconnecting`);

    const noForfeitPromise = assertNoMessageWithin(aliceWs, (m) => m.type === 'match_ended', DISCONNECT_GRACE_MS / 2);
    await sleep(DISCONNECT_GRACE_MS / 2);
    assert(await noForfeitPromise, 'no match_ended fired while still inside the reconnect grace window');

    const bobWs2 = await connectWs(bob.cookie);
    const reconnectAckPromise = waitForMessage(aliceWs, (m) => m.type === 'opponent_reconnected');
    const resumePromise = Promise.all([
      waitForMessage(aliceWs, (m) => m.type === 'turn_started'),
      waitForMessage(bobWs2, (m) => m.type === 'turn_started'),
    ]);
    bobWs2.send(JSON.stringify({ type: 'room_join', code: roomCode }));
    const rejoinAck = await waitForMessage(bobWs2, (m) => m.type === 'room_joined');
    assert(rejoinAck.reconnected === true, 'rejoin flagged reconnected:true');
    await reconnectAckPromise;
    const [aliceResume, bobResume] = await resumePromise;
    assert(
      aliceResume.activeAccountId === alice.accountId && bobResume.activeAccountId === alice.accountId,
      'turn timer resumes (still Alice\'s turn) after reconnect, with a fresh turn_started broadcast'
    );

    console.log('\n== Scenario D: disconnect that never reconnects -- auto-forfeit at the grace deadline, match_history written ==');
    const disconnectPromise2 = waitForMessage(aliceWs, (m) => m.type === 'opponent_disconnected');
    bobWs2.close();
    await disconnectPromise2;
    const forfeitStart = Date.now();
    const autoForfeit = await waitForMessage(
      aliceWs,
      (m) => m.type === 'match_ended',
      DISCONNECT_GRACE_MS + 3000
    );
    const forfeitElapsed = Date.now() - forfeitStart;
    assert(
      autoForfeit.result === 'win_forfeit' && autoForfeit.reason === 'disconnect_timeout',
      `auto-forfeit match_ended has result=win_forfeit, reason=disconnect_timeout (got ${JSON.stringify(autoForfeit)})`
    );
    assert(
      forfeitElapsed >= DISCONNECT_GRACE_MS - 300,
      `auto-forfeit did not fire early (elapsed ${forfeitElapsed}ms >= ~${DISCONNECT_GRACE_MS}ms)`
    );

    await sleep(300); // let the DB write settle before querying
    const aliceHistory = await queryMatchHistory(alice.accountId);
    const bobHistory = await queryMatchHistory(bob.accountId);
    assert(
      aliceHistory[0] && aliceHistory[0].result === 'win_forfeit' && aliceHistory[0].opponent_display_name === 'BobTimer',
      `match_history row written for Alice: win_forfeit vs BobTimer (got ${JSON.stringify(aliceHistory[0])})`
    );
    assert(
      bobHistory[0] && bobHistory[0].result === 'loss' && bobHistory[0].opponent_display_name === 'AliceTimer',
      `match_history row written for Bob: loss vs AliceTimer, not a distinct "loss_forfeit" enum value (got ${JSON.stringify(bobHistory[0])})`
    );

    console.log('\n== Scenario E: 10s-equivalent claim-forfeit floor rejected before, accepted after ==');
    aliceWs.send(JSON.stringify({ type: 'room_create' }));
    const created2 = await waitForMessage(aliceWs, (m) => m.type === 'room_created');
    const bobWs3 = await connectWs(bob.cookie);
    bobWs3.send(JSON.stringify({ type: 'room_join', code: created2.code }));
    await Promise.all([
      waitForMessage(bobWs3, (m) => m.type === 'room_joined'),
      waitForMessage(aliceWs, (m) => m.type === 'opponent_joined'),
    ]);

    const disconnectPromise3 = waitForMessage(aliceWs, (m) => m.type === 'opponent_disconnected');
    bobWs3.close();
    await disconnectPromise3;

    aliceWs.send(JSON.stringify({ type: 'claim_forfeit' }));
    const tooEarly = await waitForMessage(aliceWs, (m) => m.type === 'error' || m.type === 'match_ended');
    assert(
      tooEarly.type === 'error' && tooEarly.code === 'CLAIM_TOO_EARLY',
      `claim_forfeit rejected before the ${CLAIM_FORFEIT_FLOOR_MS}ms floor (got ${JSON.stringify(tooEarly)})`
    );

    await sleep(CLAIM_FORFEIT_FLOOR_MS + 200);
    aliceWs.send(JSON.stringify({ type: 'claim_forfeit' }));
    const claimed = await waitForMessage(aliceWs, (m) => m.type === 'match_ended' || m.type === 'error');
    assert(
      claimed.type === 'match_ended' && claimed.result === 'win_forfeit' && claimed.reason === 'forfeit_claimed',
      `claim_forfeit accepted after the floor elapses (got ${JSON.stringify(claimed)})`
    );

    await sleep(300);
    const aliceHistory2 = await queryMatchHistory(alice.accountId);
    assert(
      aliceHistory2[0] && aliceHistory2[0].result === 'win_forfeit',
      `second match_history row written for Alice's claimed forfeit (got ${JSON.stringify(aliceHistory2[0])})`
    );

    aliceWs.close();
    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    child.kill();
    // pool used for the match_history checks -- close it so the process can exit.
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
  console.error('PvP smoke test crashed:', err);
  process.exit(1);
});
