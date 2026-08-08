/* Smoke test for POST /api/economy/pull (docs/design/card-shop-currency-
 * proposal.md §6, Phase 4 of the card-shop-currency milestone -- the "bag"
 * pull mechanic).
 *
 * Same spawn-a-dedicated-server + direct-SQL-Ink-grant pattern as
 * expansion-deck-ownership-test.js/ink-award-smoke-test.js -- grants Ink via
 * direct SQL against `accounts.ink_balance` rather than playing real matches
 * (matchHistory.js's award amounts are already covered by
 * ink-award-smoke-test.js; this test only needs *some* Ink balance to exist,
 * however it got there, so SQL is the more direct setup here).
 *
 * Covers:
 *   - insufficient Ink (0 balance) -> 400 insufficient_ink, no partial effect
 *   - a single successful pull -> exactly -50 Ink, +1 ownership on the
 *     returned cardId, cardId is a real expansion-pool id
 *   - a failed pull due to insufficient Ink never touches the balance (49
 *     Ink is not enough for a 50-cost pull)
 *   - full-pool completion: granting 1200 Ink (24 * 50) and pulling 24 times
 *     from a fresh account lands EXACTLY 3 copies of EACH of the 8 expansion
 *     ids (the bag's "no waste, guaranteed even coverage" guarantee) and
 *     drains Ink to exactly 0
 *   - the 25th pull attempt against a completed pool -> 409
 *     collection_complete, NOT charged (Ink balance unchanged), not a crash
 *   - every individual pull only ever returns a card the account owned < 3
 *     of immediately before that pull (bag correctness, checked pull-by-pull)
 *   - atomicity under concurrency: 5 simultaneous pull requests against an
 *     account with exactly enough Ink for 1 pull -> exactly 1 succeeds, the
 *     other 4 fail with insufficient_ink, final balance is 0 (no double-spend,
 *     no lost update on expansion_cards)
 *   - POST /api/economy/pull without a session -> 401
 *
 * Usage (from server/): node scripts/pull-smoke-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied.
 */
const path = require('path');
const { spawn } = require('child_process');

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const PULL_COST = 50;
const EXPANSION_CARD_IDS = [
  'enfeeble', 'cripplingBlow', 'exploitWeakness', 'overextend',
  'steadyBreath', 'corrosiveAura', 'crushingCurse', 'opportunist',
];

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
  const email = `pull-${rand}@example.com`;
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

    console.log('\n== brand-new account (0 Ink): pull attempt is rejected, no partial effect ==');
    const alice = await signup('AlicePull');
    let { res, body } = await api(alice.cookie, '/api/economy/pull', { method: 'POST' });
    assert(res.status === 400, `0-Ink pull returns 400 (got ${res.status}: ${JSON.stringify(body)})`);
    assert(body.error === 'insufficient_ink', `error code is insufficient_ink (got ${JSON.stringify(body)})`);
    ({ res, body } = await api(alice.cookie, '/api/economy'));
    assert(body.inkBalance === 0, `Alice's balance is still 0 after the rejected pull (got ${body.inkBalance})`);
    assert(Object.keys(body.expansionCards).length === 0, `Alice's expansionCards is still empty after the rejected pull (got ${JSON.stringify(body.expansionCards)})`);

    console.log('\n== 49 Ink (one short of PULL_COST=50) is still insufficient ==');
    await pool.query('UPDATE accounts SET ink_balance = 49 WHERE id = $1', [alice.accountId]);
    ({ res, body } = await api(alice.cookie, '/api/economy/pull', { method: 'POST' }));
    assert(res.status === 400 && body.error === 'insufficient_ink', `49 Ink is rejected as insufficient (got ${res.status}: ${JSON.stringify(body)})`);
    ({ res, body } = await api(alice.cookie, '/api/economy'));
    assert(body.inkBalance === 49, `Alice's balance is UNCHANGED at 49 after the rejected pull -- no partial deduction (got ${body.inkBalance})`);

    console.log('\n== exactly 50 Ink: a single successful pull ==');
    await pool.query('UPDATE accounts SET ink_balance = 50 WHERE id = $1', [alice.accountId]);
    ({ res, body } = await api(alice.cookie, '/api/economy/pull', { method: 'POST' }));
    assert(res.status === 200, `50-Ink pull succeeds with 200 (got ${res.status}: ${JSON.stringify(body)})`);
    assert(EXPANSION_CARD_IDS.includes(body.cardId), `pulled cardId is a real expansion-pool id (got ${body.cardId})`);
    assert(body.inkBalance === 0, `Ink balance is exactly 0 after spending the only 50 Ink Alice had (got ${body.inkBalance})`);
    assert(body.expansionCards[body.cardId] === 1, `the pulled card's owned count is now 1 (got ${JSON.stringify(body.expansionCards)})`);

    console.log('\n== full-pool completion: 24 pulls from a fresh account land EXACTLY 3x each of all 8 expansion ids, draining Ink to 0 ==');
    const bob = await signup('BobPull');
    await pool.query('UPDATE accounts SET ink_balance = $2 WHERE id = $1', [bob.accountId, PULL_COST * 24]);

    const pullCounts = {};
    EXPANSION_CARD_IDS.forEach((id) => { pullCounts[id] = 0; });
    let bagCorrectnessOk = true;
    for (let i = 0; i < 24; i += 1) {
      const ownedBeforePull = { ...pullCounts };
      ({ res, body } = await api(bob.cookie, '/api/economy/pull', { method: 'POST' }));
      if (res.status !== 200) {
        bagCorrectnessOk = false;
        console.log(`  FAIL  pull #${i + 1} did not return 200 (got ${res.status}: ${JSON.stringify(body)})`);
        failures += 1;
        continue;
      }
      // Bag correctness: the card returned must have been owned < 3 times
      // immediately before this pull.
      if (!(ownedBeforePull[body.cardId] < 3)) {
        bagCorrectnessOk = false;
      }
      pullCounts[body.cardId] += 1;
    }
    assert(bagCorrectnessOk, 'every one of the 24 pulls returned a card owned < 3 times immediately before that pull (bag correctness)');
    EXPANSION_CARD_IDS.forEach((id) => {
      assert(pullCounts[id] === 3, `after 24 pulls, '${id}' was drawn exactly 3 times (got ${pullCounts[id]}) -- bag guarantees even coverage, no waste`);
    });
    ({ res, body } = await api(bob.cookie, '/api/economy'));
    assert(body.inkBalance === 0, `Bob's Ink is drained to exactly 0 after 24 pulls * 50 cost = 1200 spent (got ${body.inkBalance})`);
    EXPANSION_CARD_IDS.forEach((id) => {
      assert(body.expansionCards[id] === 3, `GET /api/economy confirms '${id}' is owned at 3/3 (got ${body.expansionCards[id]})`);
    });

    console.log('\n== distribution sanity: across the 24-pull run, no single card monopolized the draws (each landed exactly 3/24, not e.g. 24/0) ==');
    const counts = Object.values(pullCounts);
    assert(Math.max(...counts) === 3 && Math.min(...counts) === 3, `pull distribution is perfectly even across all 8 ids (counts: ${JSON.stringify(pullCounts)})`);

    console.log('\n== 25th pull against a completed pool (8/8 at 3/3): rejected as collection_complete, NOT charged ==');
    await pool.query('UPDATE accounts SET ink_balance = $2 WHERE id = $1', [bob.accountId, 500]); // give plenty of Ink so this can't be mistaken for insufficient_ink
    ({ res, body } = await api(bob.cookie, '/api/economy/pull', { method: 'POST' }));
    assert(res.status === 409, `pull against a completed pool returns 409 (got ${res.status}: ${JSON.stringify(body)})`);
    assert(body.error === 'collection_complete', `error code is collection_complete (got ${JSON.stringify(body)})`);
    ({ res, body } = await api(bob.cookie, '/api/economy'));
    assert(body.inkBalance === 500, `Bob's Ink is UNCHANGED at 500 after the rejected completed-pool pull -- not charged (got ${body.inkBalance})`);
    EXPANSION_CARD_IDS.forEach((id) => {
      assert(body.expansionCards[id] === 3, `'${id}' ownership is still exactly 3 after the rejected pull, not incremented past the cap (got ${body.expansionCards[id]})`);
    });

    console.log('\n== atomicity under concurrency: 5 simultaneous pulls with exactly 1 pull worth of Ink -> exactly 1 succeeds ==');
    const carol = await signup('CarolPull');
    await pool.query('UPDATE accounts SET ink_balance = $2 WHERE id = $1', [carol.accountId, PULL_COST]);
    const concurrentResults = await Promise.all(
      Array.from({ length: 5 }, () => api(carol.cookie, '/api/economy/pull', { method: 'POST' }))
    );
    const successes = concurrentResults.filter(({ res: r }) => r.status === 200);
    const rejections = concurrentResults.filter(({ res: r }) => r.status === 400);
    assert(successes.length === 1, `exactly 1 of 5 concurrent pulls succeeded (got ${successes.length})`);
    assert(rejections.length === 4, `the other 4 concurrent pulls were rejected as insufficient_ink, not double-spent (got ${rejections.length})`);
    ({ res, body } = await api(carol.cookie, '/api/economy'));
    assert(body.inkBalance === 0, `Carol's final Ink balance is exactly 0 -- no double-spend, no lost balance (got ${body.inkBalance})`);
    const totalOwned = Object.values(body.expansionCards).reduce((sum, n) => sum + n, 0);
    assert(totalOwned === 1, `Carol owns exactly 1 total expansion card across all ids -- no lost/duplicated ownership write from the race (got ${totalOwned}, ${JSON.stringify(body.expansionCards)})`);

    console.log('\n== POST /api/economy/pull without a session -> 401 ==');
    ({ res, body } = await api(null, '/api/economy/pull', { method: 'POST' }));
    assert(res.status === 401, `no-session pull returns 401 (got ${res.status})`);

    await pool.end();

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Pull smoke test crashed:', err);
  process.exit(1);
});
