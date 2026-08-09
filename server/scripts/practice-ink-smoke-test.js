/* Smoke test for POST /api/economy/practice-result (docs/design/
 * practice-mode-proposal.md §6/§7, Track B of the practice-mode milestone --
 * server-side Ink cap + audit log).
 *
 * Same spawn-a-dedicated-server pattern as pull-smoke-test.js/
 * ink-award-smoke-test.js. Uses direct SQL against `accounts` /
 * `practice_ink_log` for setup (seeding practice_ink_today near the cap) and
 * for the UTC-day-boundary test (backdating practice_ink_reset_date to
 * simulate "yesterday" without waiting a real day).
 *
 * Covers:
 *   - a normal win awards exactly 4 Ink, ink_balance +4, practiceInkToday
 *     becomes 4
 *   - a normal loss awards exactly 1 Ink, ink_balance +1, practiceInkToday
 *     increments by 1
 *   - partial award at the cap boundary: account already at 18/20 today, a
 *     4-Ink win awards only 2 (not 4) -- exact partial-award math
 *   - a match played after already at 20/20 today awards exactly 0, and
 *     still returns 200 (not an error)
 *   - UTC day-boundary reset: directly backdating practice_ink_reset_date to
 *     simulate "yesterday" (via SQL, not waiting a real day) causes the next
 *     call to reset practiceInkToday to 0 before applying today's award
 *   - concurrency: 10 simultaneous win requests (4 Ink each) against an
 *     account already at 12/20 today (8 Ink of headroom, i.e. exactly 2 full
 *     4-Ink wins' worth) never push the account's practiceInkToday above 20
 *     -- reusing pull-smoke-test.js's Promise.all concurrency-race approach
 *   - invalid `result` value -> 400, no effect
 *   - POST /api/economy/practice-result without a session -> 401
 *   - zero rows are ever written to match_history by this endpoint
 *
 * Usage (from server/): node scripts/practice-ink-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied (npm run migrate -- specifically
 * 004_add_practice_ink_cap.sql).
 */
const path = require('path');
const { spawn } = require('child_process');

const TEST_PORT = 3098;
const BASE_URL = `http://localhost:${TEST_PORT}`;

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
  const res = await fetch(`${BASE_URL}${apiPath}`, {
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
  const email = `practice-${rand}@example.com`;
  const { res, body } = await api(null, '/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'password123', confirmPassword: 'password123', displayName },
  });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(body)}`);
  const cookie = extractCookie(res);
  return { email, cookie, accountId: body.account.id, displayName };
}

async function waitForServerReady(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
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
    env: { ...process.env, PORT: String(TEST_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));

  try {
    await waitForServerReady();
    console.log('  server is up');

    const { pool } = require('../src/db');

    console.log('\n== a normal win awards exactly 4 Ink ==');
    const alice = await signup('AlicePractice');
    let { res, body } = await api(alice.cookie, '/api/economy/practice-result', {
      method: 'POST',
      body: { result: 'win' },
    });
    assert(res.status === 200, `win returns 200 (got ${res.status}: ${JSON.stringify(body)})`);
    assert(body.inkAwarded === 4, `inkAwarded is exactly 4 (got ${body.inkAwarded})`);
    assert(body.inkBalance === 4, `inkBalance is 4 after the first win (got ${body.inkBalance})`);
    assert(body.practiceInkToday === 4, `practiceInkToday is 4 (got ${body.practiceInkToday})`);
    assert(body.practiceInkDailyCap === 20, `practiceInkDailyCap is 20 (got ${body.practiceInkDailyCap})`);

    console.log('\n== a normal loss awards exactly 1 Ink ==');
    ({ res, body } = await api(alice.cookie, '/api/economy/practice-result', {
      method: 'POST',
      body: { result: 'loss' },
    }));
    assert(res.status === 200, `loss returns 200 (got ${res.status})`);
    assert(body.inkAwarded === 1, `inkAwarded is exactly 1 (got ${body.inkAwarded})`);
    assert(body.inkBalance === 5, `inkBalance is 5 (4 win + 1 loss) (got ${body.inkBalance})`);
    assert(body.practiceInkToday === 5, `practiceInkToday is 5 (got ${body.practiceInkToday})`);

    console.log('\n== GET /api/economy reflects the same balance ==');
    ({ res, body } = await api(alice.cookie, '/api/economy'));
    assert(body.inkBalance === 5, `GET /api/economy shows inkBalance 5 (got ${body.inkBalance})`);

    console.log('\n== partial award at the cap boundary: 18/20 today, a 4-Ink win awards only 2 ==');
    const bob = await signup('BobPractice');
    await pool.query(
      `UPDATE accounts SET practice_ink_today = 18, practice_ink_reset_date = (now() AT TIME ZONE 'utc')::date WHERE id = $1`,
      [bob.accountId]
    );
    ({ res, body } = await api(bob.cookie, '/api/economy/practice-result', {
      method: 'POST',
      body: { result: 'win' },
    }));
    assert(res.status === 200, `capped win still returns 200 (got ${res.status})`);
    assert(body.inkAwarded === 2, `inkAwarded is exactly 2 (min(4, 20-18)), not 4 (got ${body.inkAwarded})`);
    assert(body.inkBalance === 2, `inkBalance is 2 (got ${body.inkBalance})`);
    assert(body.practiceInkToday === 20, `practiceInkToday is now exactly 20 (got ${body.practiceInkToday})`);

    console.log('\n== a match played after already at 20/20 today awards exactly 0, still 200 not an error ==');
    ({ res, body } = await api(bob.cookie, '/api/economy/practice-result', {
      method: 'POST',
      body: { result: 'win' },
    }));
    assert(res.status === 200, `at-cap win still returns 200, not an error (got ${res.status}: ${JSON.stringify(body)})`);
    assert(body.inkAwarded === 0, `inkAwarded is exactly 0 (got ${body.inkAwarded})`);
    assert(body.inkBalance === 2, `inkBalance is UNCHANGED at 2 (got ${body.inkBalance})`);
    assert(body.practiceInkToday === 20, `practiceInkToday stays at 20, does not exceed the cap (got ${body.practiceInkToday})`);

    ({ res, body } = await api(bob.cookie, '/api/economy/practice-result', {
      method: 'POST',
      body: { result: 'loss' },
    }));
    assert(body.inkAwarded === 0, `at-cap loss also awards exactly 0 (got ${body.inkAwarded})`);
    assert(body.inkBalance === 2, `inkBalance still UNCHANGED at 2 (got ${body.inkBalance})`);

    console.log('\n== UTC day-boundary reset: backdating practice_ink_reset_date to "yesterday" resets the counter ==');
    await pool.query(
      `UPDATE accounts SET practice_ink_reset_date = ((now() AT TIME ZONE 'utc')::date - INTERVAL '1 day')::date WHERE id = $1`,
      [bob.accountId]
    );
    const beforeReset = await pool.query(
      'SELECT practice_ink_today, practice_ink_reset_date FROM accounts WHERE id = $1',
      [bob.accountId]
    );
    assert(beforeReset.rows[0].practice_ink_today === 20, `sanity: counter is still 20 before the reset-triggering call (got ${beforeReset.rows[0].practice_ink_today})`);

    ({ res, body } = await api(bob.cookie, '/api/economy/practice-result', {
      method: 'POST',
      body: { result: 'win' },
    }));
    assert(res.status === 200, `post-reset win returns 200 (got ${res.status})`);
    assert(body.inkAwarded === 4, `post-reset win awards the FULL 4 Ink (cap reset to 0 first), not a capped amount (got ${body.inkAwarded})`);
    assert(body.practiceInkToday === 4, `practiceInkToday reset to 0 then incremented to 4, not 24 (got ${body.practiceInkToday})`);
    assert(body.inkBalance === 6, `inkBalance is 2 (pre-reset) + 4 (post-reset win) = 6 (got ${body.inkBalance})`);

    const afterReset = await pool.query(
      'SELECT practice_ink_reset_date FROM accounts WHERE id = $1',
      [bob.accountId]
    );
    const today = await pool.query(`SELECT (now() AT TIME ZONE 'utc')::date AS d`);
    assert(
      afterReset.rows[0].practice_ink_reset_date.getTime() === today.rows[0].d.getTime(),
      `practice_ink_reset_date is updated to today's UTC date (got ${afterReset.rows[0].practice_ink_reset_date}, expected ${today.rows[0].d})`
    );

    console.log('\n== concurrency at the cap boundary: 10 simultaneous 4-Ink wins against an account with only 8 Ink of headroom (12/20) never exceed 20/20 ==');
    const carol = await signup('CarolPractice');
    await pool.query(
      `UPDATE accounts SET practice_ink_today = 12, practice_ink_reset_date = (now() AT TIME ZONE 'utc')::date, ink_balance = 0 WHERE id = $1`,
      [carol.accountId]
    );
    const concurrentResults = await Promise.all(
      Array.from({ length: 10 }, () =>
        api(carol.cookie, '/api/economy/practice-result', { method: 'POST', body: { result: 'win' } })
      )
    );
    const totalAwarded = concurrentResults.reduce((sum, { body: b }) => sum + (b && b.inkAwarded != null ? b.inkAwarded : 0), 0);
    assert(
      concurrentResults.every(({ res: r }) => r.status === 200),
      `all 10 concurrent requests returned 200 (no errors), got statuses: ${concurrentResults.map(({ res: r }) => r.status).join(',')}`
    );
    assert(totalAwarded === 8, `total Ink awarded across all 10 concurrent requests is exactly 8 (the exact remaining headroom: 2 full wins of 4), not more (got ${totalAwarded})`);
    ({ res, body } = await api(carol.cookie, '/api/economy'));
    assert(body.inkBalance === 8, `Carol's final inkBalance is exactly 8 -- no lost update, no over-award (got ${body.inkBalance})`);
    const carolRow = await pool.query('SELECT practice_ink_today FROM accounts WHERE id = $1', [carol.accountId]);
    assert(carolRow.rows[0].practice_ink_today === 20, `Carol's practice_ink_today settles at exactly 20, never exceeding the cap under concurrency (got ${carolRow.rows[0].practice_ink_today})`);

    console.log('\n== invalid result value -> 400, no effect ==');
    const dave = await signup('DavePractice');
    ({ res, body } = await api(dave.cookie, '/api/economy/practice-result', {
      method: 'POST',
      body: { result: 'draw' },
    }));
    assert(res.status === 400, `invalid result returns 400 (got ${res.status})`);
    assert(body.error === 'invalid_result', `error code is invalid_result (got ${JSON.stringify(body)})`);
    ({ res, body } = await api(dave.cookie, '/api/economy'));
    assert(body.inkBalance === 0, `Dave's balance is UNCHANGED at 0 after the rejected call (got ${body.inkBalance})`);

    console.log('\n== POST /api/economy/practice-result without a session -> 401 ==');
    ({ res, body } = await api(null, '/api/economy/practice-result', {
      method: 'POST',
      body: { result: 'win' },
    }));
    assert(res.status === 401, `no-session call returns 401 (got ${res.status})`);

    console.log('\n== zero rows ever written to match_history by this endpoint ==');
    const allTestAccountIds = [alice.accountId, bob.accountId, carol.accountId, dave.accountId];
    const historyRows = await pool.query(
      'SELECT COUNT(*)::int AS n FROM match_history WHERE account_id = ANY($1)',
      [allTestAccountIds]
    );
    assert(historyRows.rows[0].n === 0, `no match_history rows exist for any test account after all practice-result calls (got ${historyRows.rows[0].n})`);

    console.log('\n== practice_ink_log has one audit row per practice-result call for Alice (2 calls: win, loss) ==');
    const aliceLog = await pool.query(
      'SELECT result, ink_awarded FROM practice_ink_log WHERE account_id = $1 ORDER BY created_at ASC',
      [alice.accountId]
    );
    assert(aliceLog.rows.length === 2, `Alice has exactly 2 practice_ink_log rows (got ${aliceLog.rows.length})`);
    assert(
      aliceLog.rows[0].result === 'win' && aliceLog.rows[0].ink_awarded === 4,
      `Alice's first log row is win/4 (got ${JSON.stringify(aliceLog.rows[0])})`
    );
    assert(
      aliceLog.rows[1].result === 'loss' && aliceLog.rows[1].ink_awarded === 1,
      `Alice's second log row is loss/1 (got ${JSON.stringify(aliceLog.rows[1])})`
    );

    await pool.end();

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Practice Ink smoke test crashed:', err);
  process.exit(1);
});
