/* Smoke test for the expansion-pool ownership-aware deck-save validation
 * (docs/design/card-shop-currency-proposal.md §2.2/§7, Phase 3 of the
 * card-shop-currency milestone -- routes/decks.js's validateCards()).
 *
 * No shop/pull endpoint exists yet (Phase 4, out of scope this session --
 * see the task brief's "What NOT to build yet"), so there is currently no
 * real gameplay path that grants expansion-card ownership. This test grants
 * it directly via SQL against `accounts.expansion_cards` (same column
 * ink-award-smoke-test.js already reads from, migrations/
 * 003_add_ink_and_expansion_cards.sql) -- the only available way to set up
 * an "owns some expansion cards" account this phase, per the task brief.
 *
 * Spawns its own dedicated server instance (same pattern as
 * ink-award-smoke-test.js/pvp-smoke-test.js) rather than assuming one is
 * already running, so `node scripts/expansion-deck-ownership-test.js` works
 * standalone.
 *
 * Covers:
 *   - a brand-new account cannot add ANY copy of an expansion card it owns
 *     0 of (fully locked) -- PUT /api/decks/:slot rejects with 400
 *   - after granting ownership of 2 copies via direct SQL, the account CAN
 *     save a deck with up to 2 copies, but adding a 3rd copy is still
 *     rejected (ownership cap is min(3, owned), not always 3)
 *   - after granting ownership of 3+ copies, the account can save exactly 3
 *     copies (the flat MAX_COPIES_PER_CARD ceiling still applies on top of
 *     ownership)
 *   - core-pool cards (e.g. 'strike') are completely unaffected: still
 *     flat max-3, no ownership check, regardless of expansion_cards content
 *   - GET /api/decks reflects a successfully-saved expansion-card deck
 *
 * Usage (from server/): node scripts/expansion-deck-ownership-test.js
 * Requires: local Postgres reachable via server/.env's DATABASE_URL,
 * migrations already applied.
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
  const email = `ownership-${rand}@example.com`;
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

    console.log('\n== brand-new account: expansion card is fully locked (owns 0) ==');
    const alice = await signup('AliceOwnership');
    let { res, body } = await api(alice.cookie, '/api/economy');
    assert(res.status === 200 && Object.keys(body.expansionCards).length === 0, `Alice starts with an empty expansionCards map (got ${JSON.stringify(body.expansionCards)})`);

    ({ res, body } = await api(alice.cookie, '/api/decks/2', {
      method: 'PUT',
      body: { name: '테스트', cards: { enfeeble: 1 } },
    }));
    assert(res.status === 400, `saving a deck with 1x an unowned expansion card ('enfeeble') is rejected with 400 (got ${res.status}: ${JSON.stringify(body)})`);

    console.log("\n== after granting 2 owned copies via SQL, deck can include up to 2, but NOT 3 ==");
    await pool.query(
      `UPDATE accounts SET expansion_cards = $2::jsonb WHERE id = $1`,
      [alice.accountId, JSON.stringify({ enfeeble: 2 })]
    );
    ({ res, body } = await api(alice.cookie, '/api/economy'));
    assert(body.expansionCards.enfeeble === 2, `GET /api/economy reflects the granted 2 owned copies of enfeeble (got ${JSON.stringify(body.expansionCards)})`);

    ({ res, body } = await api(alice.cookie, '/api/decks/2', {
      method: 'PUT',
      body: { name: '테스트', cards: { enfeeble: 2 } },
    }));
    assert(res.status === 200, `saving a deck with exactly 2x enfeeble (== owned count) succeeds (got ${res.status}: ${JSON.stringify(body)})`);
    assert(body.cards.enfeeble === 2, `saved deck reports 2x enfeeble (got ${JSON.stringify(body.cards)})`);

    ({ res, body } = await api(alice.cookie, '/api/decks/2', {
      method: 'PUT',
      body: { name: '테스트', cards: { enfeeble: 3 } },
    }));
    assert(res.status === 400, `saving a deck with 3x enfeeble (owns only 2) is rejected with 400 even though 3 is within the flat max-3 rule (got ${res.status}: ${JSON.stringify(body)})`);

    console.log('\n== after granting 3+ owned copies, deck can include exactly 3 (flat MAX_COPIES_PER_CARD ceiling still applies) ==');
    await pool.query(
      `UPDATE accounts SET expansion_cards = $2::jsonb WHERE id = $1`,
      [alice.accountId, JSON.stringify({ enfeeble: 5 })] // owns 5, but deck cap is still 3
    );
    ({ res, body } = await api(alice.cookie, '/api/decks/2', {
      method: 'PUT',
      body: { name: '테스트', cards: { enfeeble: 3 } },
    }));
    assert(res.status === 200, `saving a deck with 3x enfeeble (owns 5, but the flat max-3-per-card rule still caps it at 3) succeeds (got ${res.status}: ${JSON.stringify(body)})`);

    ({ res, body } = await api(alice.cookie, '/api/decks/2', {
      method: 'PUT',
      body: { name: '테스트', cards: { enfeeble: 4 } },
    }));
    assert(res.status === 400, `saving a deck with 4x enfeeble is still rejected -- the flat max-3-per-card cap (MAX_COPIES_PER_CARD) is never bypassed by owning more (got ${res.status}: ${JSON.stringify(body)})`);

    console.log('\n== core-pool cards are completely unaffected by expansion_cards ownership (still flat max-3, no ownership check) ==');
    ({ res, body } = await api(alice.cookie, '/api/decks/2', {
      method: 'PUT',
      // Alice owns 0 'strike' in expansion_cards (it isn't even an
      // expansion card id) -- core cards must still save fine at max-3.
      body: { name: '코어 덱', cards: { strike: 3, defend: 3 } },
    }));
    assert(res.status === 200, `3x Strike + 3x Defend (core-pool, always free/unlimited) saves fine with 200 despite Alice's expansion_cards not mentioning them (got ${res.status}: ${JSON.stringify(body)})`);
    assert(body.cards.strike === 3 && body.cards.defend === 3, `saved core-only deck reports the correct counts (got ${JSON.stringify(body.cards)})`);

    ({ res, body } = await api(alice.cookie, '/api/decks/2', {
      method: 'PUT',
      body: { name: '코어 덱', cards: { strike: 4 } },
    }));
    assert(res.status === 400, `4x Strike is still rejected by the ordinary flat max-3 rule, same as before this milestone (got ${res.status}: ${JSON.stringify(body)})`);

    console.log('\n== a second, brand-new account never sees Alice\'s ownership (per-account isolation) ==');
    const bob = await signup('BobOwnership');
    ({ res, body } = await api(bob.cookie, '/api/decks/2', {
      method: 'PUT',
      body: { name: '테스트', cards: { enfeeble: 1 } },
    }));
    assert(res.status === 400, `Bob (fresh account) still cannot save enfeeble at all -- Alice's ownership grant did not leak to him (got ${res.status}: ${JSON.stringify(body)})`);

    console.log('\n== mixed core + expansion deck: expansion-owned copies + unlimited core copies together ==');
    ({ res, body } = await api(alice.cookie, '/api/decks/3', {
      method: 'PUT',
      body: { name: '혼합 덱', cards: { strike: 3, defend: 3, enfeeble: 3 } },
    }));
    assert(res.status === 200, `mixed deck (3x core Strike/Defend + 3x owned enfeeble) saves fine (got ${res.status}: ${JSON.stringify(body)})`);
    assert(body.total === 9, `mixed deck totals 9 cards (got ${body.total})`);

    await pool.end();

    console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  } finally {
    child.kill();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Expansion deck ownership test crashed:', err);
  process.exit(1);
});
