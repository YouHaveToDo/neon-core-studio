/* Manual smoke test for the deck CRUD endpoints (Phase 3.1/3.2/3.4). Same
 * spirit as scripts/smoke-test.js (Phase 1) -- programmer's own sanity pass
 * before handoff, and a runnable example of expected request/response
 * shapes. Not a substitute for a dedicated QA pass (this repo's QA role is
 * blocked on Phase 4.1's login UI for any click-through testing, per the
 * task brief -- this script is the only coverage deck CRUD gets this round).
 *
 * Usage: server must already be running (npm start), then:
 *   node scripts/deck-smoke-test.js [baseUrl]
 * Defaults to http://localhost:3001
 */
const BASE_URL = process.argv[2] || 'http://localhost:3001';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  PASS  ${msg}`);
  } else {
    console.log(`  FAIL  ${msg}`);
    failures += 1;
  }
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
  const res = await fetch(`${BASE_URL}${path}`, {
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

async function main() {
  const rand = Math.random().toString(36).slice(2, 8);
  const email = `decksmoke-${rand}@example.com`;
  const password = 'password123';
  const displayName = 'DeckSmoke';

  console.log(`\n== signup: new account (${email}) ==`);
  let { res, body } = await api(null, '/api/auth/signup', {
    method: 'POST',
    body: { email, password, confirmPassword: password, displayName },
  });
  assert(res.status === 201, `signup returns 201 (got ${res.status}: ${JSON.stringify(body)})`);
  let cookie = extractCookie(res);
  assert(!!cookie, 'signup sets a session cookie');

  console.log('\n== GET /api/decks without a session ==');
  ({ res, body } = await api(null, '/api/decks'));
  assert(res.status === 401, `no-session GET /api/decks returns 401 (got ${res.status})`);

  console.log('\n== GET /api/decks: new account has slot 1 = 24-card starter deck, slots 2/3 empty ==');
  ({ res, body } = await api(cookie, '/api/decks'));
  assert(res.status === 200, `GET /api/decks returns 200 (got ${res.status})`);
  assert(Array.isArray(body.slots) && body.slots.length === 3, 'response has exactly 3 slot entries');
  const slot1 = body.slots[0];
  assert(!!slot1, 'slot 1 is filled');
  assert(slot1 && slot1.name === '스타터 덱', `slot 1 name is "스타터 덱" (got ${slot1 && slot1.name})`);
  assert(slot1 && slot1.total === 24, `slot 1 totals 24 cards (got ${slot1 && slot1.total})`);
  assert(slot1 && slot1.valid === true, 'slot 1 is valid (20-30 range)');
  assert(body.slots[1] === null, 'slot 2 is empty (null)');
  assert(body.slots[2] === null, 'slot 3 is empty (null)');

  console.log('\n== PUT /api/decks/:slot: invalid slot numbers rejected ==');
  ({ res, body } = await api(cookie, '/api/decks/0', { method: 'PUT', body: { name: 'x', cards: {} } }));
  assert(res.status === 400, `slot 0 rejected with 400 (got ${res.status})`);
  ({ res, body } = await api(cookie, '/api/decks/4', { method: 'PUT', body: { name: 'x', cards: {} } }));
  assert(res.status === 400, `slot 4 rejected with 400 (got ${res.status})`);
  ({ res, body } = await api(cookie, '/api/decks/abc', { method: 'PUT', body: { name: 'x', cards: {} } }));
  assert(res.status === 400, `non-numeric slot rejected with 400 (got ${res.status})`);
  ({ res, body } = await api(cookie, '/api/decks/0', { method: 'DELETE' }));
  assert(res.status === 400, `DELETE slot 0 rejected with 400 (got ${res.status})`);

  console.log('\n== PUT /api/decks/2: create a brand-new deck (slot 2), empty at first ==');
  ({ res, body } = await api(cookie, '/api/decks/2', { method: 'PUT', body: { name: '', cards: {} } }));
  assert(res.status === 200, `create slot 2 returns 200 (got ${res.status})`);
  assert(body.name === '덱 2', `blank name on create defaults to "덱 2" (got ${body.name})`);
  assert(body.total === 0 && body.valid === false, 'new empty deck: total 0, valid false');

  console.log('\n== PUT /api/decks/2: unknown card id rejected ==');
  ({ res, body } = await api(cookie, '/api/decks/2', {
    method: 'PUT',
    body: { name: '테스트 덱', cards: { notARealCard: 1 } },
  }));
  assert(res.status === 400, `unknown card id rejected with 400 (got ${res.status})`);

  console.log('\n== PUT /api/decks/2: max 3 copies per card enforced ==');
  ({ res, body } = await api(cookie, '/api/decks/2', {
    method: 'PUT',
    body: { name: '테스트 덱', cards: { strike: 4 } },
  }));
  assert(res.status === 400, `4x strike rejected with 400 (got ${res.status})`);

  console.log('\n== PUT /api/decks/2: max 30 total enforced ==');
  ({ res, body } = await api(cookie, '/api/decks/2', {
    method: 'PUT',
    body: {
      name: '테스트 덱',
      // 14 card types x 3 = 42 > 30
      cards: {
        strike: 3, defend: 3, heavySlash: 3, twinStrike: 3, piercingStrike: 3,
        execute: 3, recklessSwing: 3, quickGuard: 3, secondWind: 3, adrenaline: 3,
        fortify: 3, ironSkin: 3, bloodlust: 3, hoarder: 3,
      },
    },
  }));
  assert(res.status === 400, `42-card deck (over 30 cap) rejected with 400 (got ${res.status})`);

  console.log('\n== PUT /api/decks/2: valid but under 20 (incomplete) deck saves fine, marked invalid/미완성 ==');
  ({ res, body } = await api(cookie, '/api/decks/2', {
    method: 'PUT',
    body: { name: '번개 러시', cards: { strike: 3, defend: 3, heavySlash: 3, twinStrike: 3, piercingStrike: 2 } },
  }));
  assert(res.status === 200, `14-card (under 20) deck saves with 200, not rejected (got ${res.status})`);
  assert(body.total === 14, `total reported as 14 (got ${body.total})`);
  assert(body.valid === false, 'under-20 deck reported as invalid (미완성)');

  console.log('\n== PUT /api/decks/2: raise it into the valid 20-30 range ==');
  ({ res, body } = await api(cookie, '/api/decks/2', {
    method: 'PUT',
    body: {
      name: '번개 러시',
      cards: { strike: 3, defend: 3, heavySlash: 3, twinStrike: 3, piercingStrike: 3, execute: 1, recklessSwing: 1, quickGuard: 3 },
    },
  }));
  assert(res.status === 200, `20-card deck saves with 200 (got ${res.status})`);
  assert(body.total === 20, `total reported as 20 (got ${body.total})`);
  assert(body.valid === true, '20-card deck reported as valid');

  console.log('\n== GET /api/decks reflects the slot 2 edit ==');
  ({ res, body } = await api(cookie, '/api/decks'));
  assert(body.slots[1] && body.slots[1].total === 20, `slot 2 now shows total 20 (got ${body.slots[1] && body.slots[1].total})`);
  assert(body.slots[1] && body.slots[1].name === '번개 러시', 'slot 2 name persisted');

  console.log('\n== DELETE /api/decks/2 clears the slot ==');
  ({ res, body } = await api(cookie, '/api/decks/2', { method: 'DELETE' }));
  assert(res.status === 204, `delete slot 2 returns 204 (got ${res.status})`);
  ({ res, body } = await api(cookie, '/api/decks'));
  assert(body.slots[1] === null, 'slot 2 is empty again after delete');

  console.log('\n== DELETE /api/decks/3 (already empty) is idempotent ==');
  ({ res, body } = await api(cookie, '/api/decks/3', { method: 'DELETE' }));
  assert(res.status === 204, `deleting an already-empty slot still returns 204 (got ${res.status})`);

  console.log('\n== edits persist across a simulated logout/login (new session, same account) ==');
  // Leave slot 1 (starter deck) edited so we have something to verify.
  ({ res, body } = await api(cookie, '/api/decks/1', {
    method: 'PUT',
    body: { name: '수정된 스타터', cards: { strike: 3, defend: 3, heavySlash: 2, twinStrike: 2, piercingStrike: 2, execute: 1, recklessSwing: 1, quickGuard: 2, secondWind: 2, adrenaline: 1, fortify: 2, ironSkin: 1, bloodlust: 1, hoarder: 1 } },
  }));
  assert(res.status === 200, `rename slot 1 returns 200 (got ${res.status})`);

  ({ res } = await api(cookie, '/api/auth/logout', { method: 'POST' }));
  assert(res.status === 204, `logout returns 204 (got ${res.status})`);

  ({ res, body } = await api(cookie, '/api/decks'));
  assert(res.status === 401, `old session cookie is rejected after logout (got ${res.status})`);

  ({ res, body } = await api(null, '/api/auth/login', { method: 'POST', body: { email, password } }));
  assert(res.status === 200, `re-login returns 200 (got ${res.status})`);
  const newCookie = extractCookie(res);
  assert(!!newCookie && newCookie !== cookie, 'a fresh, different session cookie is issued on re-login');

  ({ res, body } = await api(newCookie, '/api/decks'));
  assert(res.status === 200, `GET /api/decks works with the new session (got ${res.status})`);
  assert(body.slots[0] && body.slots[0].name === '수정된 스타터', 'slot 1 rename persisted across logout/login (new session)');
  assert(body.slots[0] && body.slots[0].total === 24, 'slot 1 still totals 24 cards after logout/login');
  assert(body.slots[1] === null, 'slot 2 still empty after logout/login (delete persisted too)');

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Deck smoke test crashed:', err);
  process.exit(1);
});
