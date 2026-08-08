/* Regression test for docs/qa/card-shop-currency-milestone.md finding #2
 * (Blocker): two near-simultaneous `report_result` WS messages for the SAME
 * match -- both clients independently detecting match end at essentially
 * the same instant, spec §6.4's normal (not contrived) path -- could both
 * reach `onReportResult()` before either's `await recordMatchResult(...)`
 * DB round trip finished and `endRoomAndClearSockets()` tore the room down,
 * so both calls ran, double-awarding Ink and double-writing match_history.
 *
 * Reuses QA's own 100%-reproducible repro methodology (docs/qa/card-shop-
 * currency-milestone.md, "qa-double-report-result-race.js"): real spawned
 * server, real Postgres, real two-account WS session, real room, real
 * start_match, then firing BOTH clients' `report_result` back-to-back with
 * NO `await` between the two `ws.send()` calls, so both messages are
 * in-flight before either's handler can possibly finish -- this is exactly
 * the timing that made the original bug 3/3 reproducible.
 *
 * The fix (server/src/ws/rooms.js's claimResult(), called synchronously in
 * onReportResult() BEFORE the first `await`) should make this race
 * deterministically safe -- run several iterations (fresh room each time,
 * same two accounts) to build confidence this isn't a lucky single pass.
 *
 * Usage (from server/): node scripts/report-result-race-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied.
 */
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const TEST_PORT = 3094;
const BASE_HTTP = `http://localhost:${TEST_PORT}`;
const BASE_WS = `ws://localhost:${TEST_PORT}`;
const RACE_ITERATIONS = 5; // QA's own repro claimed 3/3 -- run more here for extra confidence

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
  const email = `raceink-${rand}@example.com`;
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

function waitForMessage(ws, predicate, timeoutMs = 5000) {
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
  console.log(`\n== spawning server on port ${TEST_PORT} ==`);
  const serverDir = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  try {
    await waitForServerReady();
    console.log('  server is up');

    const { pool } = require('../src/db');

    const alice = await signup('AliceRace');
    const bob = await signup('BobRace');
    console.log(`\n== ${RACE_ITERATIONS} iterations of a real near-simultaneous report_result race (fresh room/match each time, same two accounts) ==`);

    let expectedAliceInk = 0;
    let expectedBobInk = 0;

    for (let i = 1; i <= RACE_ITERATIONS; i++) {
      console.log(`\n-- iteration ${i}/${RACE_ITERATIONS} --`);
      const aliceWs = await connectWs(alice.cookie);
      const bobWs = await connectWs(bob.cookie);
      await createAndJoinRoom(aliceWs, bobWs);

      aliceWs.send(JSON.stringify({ type: 'start_match', firstAccountId: alice.accountId }));
      await Promise.all([
        waitForMessage(aliceWs, (m) => m.type === 'turn_started'),
        waitForMessage(bobWs, (m) => m.type === 'turn_started'),
      ]);

      // THE race: both clients independently conclude the match is over and
      // report their own consistent result (Alice 'win', Bob 'loss') at
      // essentially the same instant -- no await between the two sends, same
      // as QA's repro. This is spec §6.4's normal path (both clients detect
      // HP hitting 0 at the same moment), not a contrived double-click.
      const beforeReport = new Date();
      aliceWs.send(JSON.stringify({ type: 'report_result', result: 'win' }));
      bobWs.send(JSON.stringify({ type: 'report_result', result: 'loss' }));

      await Promise.all([
        waitForMessage(aliceWs, (m) => m.type === 'match_ended'),
        waitForMessage(bobWs, (m) => m.type === 'match_ended'),
      ]);
      await sleep(500); // let any (would-be double) DB write settle

      expectedAliceInk += 15;
      expectedBobInk += 5;

      const { body: aliceEcon } = await api(alice.cookie, '/api/economy');
      const { body: bobEcon } = await api(bob.cookie, '/api/economy');
      assert(
        aliceEcon.inkBalance === expectedAliceInk,
        `iter ${i}: Alice's cumulative Ink is exactly ${expectedAliceInk} (win credited exactly ONCE this match, not twice) (got ${aliceEcon.inkBalance})`
      );
      assert(
        bobEcon.inkBalance === expectedBobInk,
        `iter ${i}: Bob's cumulative Ink is exactly ${expectedBobInk} (loss credited exactly ONCE this match, not twice) (got ${bobEcon.inkBalance})`
      );

      // Exactly one NEW row per account for THIS iteration's match --
      // queried by played_at strictly after the timestamp captured right
      // before the two racing report_result sends, not a fixed time window
      // (iterations run close enough together that a fixed window can catch
      // a PRIOR iteration's already-correct single row too, which would
      // make this assertion pass/fail for the wrong reason).
      const aliceRows = await pool.query(
        'SELECT result, played_at FROM match_history WHERE account_id = $1 AND played_at > $2 ORDER BY played_at ASC',
        [alice.accountId, beforeReport]
      );
      const bobRows = await pool.query(
        'SELECT result, played_at FROM match_history WHERE account_id = $1 AND played_at > $2 ORDER BY played_at ASC',
        [bob.accountId, beforeReport]
      );
      assert(
        aliceRows.rows.length === 1 && aliceRows.rows[0].result === 'win',
        `iter ${i}: exactly ONE match_history row written for Alice this match (result 'win', not duplicated) (got ${JSON.stringify(aliceRows.rows)})`
      );
      assert(
        bobRows.rows.length === 1 && bobRows.rows[0].result === 'loss',
        `iter ${i}: exactly ONE match_history row written for Bob this match (result 'loss', not duplicated) (got ${JSON.stringify(bobRows.rows)})`
      );

      aliceWs.close();
      bobWs.close();
      await sleep(200);
    }

    await pool.end();

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('report_result race smoke test crashed:', err);
  process.exit(1);
});
