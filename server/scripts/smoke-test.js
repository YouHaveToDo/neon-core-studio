/* Manual smoke test for the auth endpoints (Phase 1). Not a substitute for
 * QA's own pass (plan.md 1.5) -- this is the programmer's own sanity check
 * that the endpoints behave as written before handing off, and doubles as
 * a runnable example of expected request/response shapes.
 *
 * Usage: server must already be running (npm start), then:
 *   node scripts/smoke-test.js [baseUrl]
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
  return setCookie.split(';')[0]; // "al_session=...."
}

async function main() {
  const rand = Math.random().toString(36).slice(2, 8);
  const email = `smoketest-${rand}@example.com`;
  const password = 'password123';
  const displayName = 'SmokeTester';

  console.log(`\n== signup: new account (${email}) ==`);
  let res = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, confirmPassword: password, displayName }),
  });
  let body = await res.json();
  assert(res.status === 201, `signup returns 201 (got ${res.status}: ${JSON.stringify(body)})`);
  assert(body.account && body.account.displayName === displayName, 'signup response includes account.displayName');
  const sessionCookie = extractCookie(res);
  assert(!!sessionCookie, 'signup sets a session cookie (auto-login)');

  console.log('\n== signup: duplicate email rejected ==');
  res = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, confirmPassword: password, displayName: 'Other' }),
  });
  body = await res.json();
  assert(res.status === 400, `duplicate signup returns 400 (got ${res.status})`);
  assert(
    body.fieldErrors && body.fieldErrors.email === '이미 사용 중인 이메일입니다',
    'duplicate signup gives inline email error'
  );

  console.log('\n== signup: validation errors ==');
  res = await fetch(`${BASE_URL}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: 'short', confirmPassword: 'nope', displayName: 'x' }),
  });
  body = await res.json();
  assert(res.status === 400, `bad signup returns 400 (got ${res.status})`);
  assert(body.fieldErrors.email, 'invalid email format flagged');
  assert(body.fieldErrors.password, 'short password flagged');
  assert(body.fieldErrors.displayName, 'too-short display name flagged');

  console.log('\n== GET /api/auth/me with valid session ==');
  res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: sessionCookie } });
  body = await res.json();
  assert(res.status === 200, `me returns 200 with valid session (got ${res.status})`);
  assert(body.account && body.account.displayName === displayName, 'me returns correct account');

  console.log('\n== GET /api/auth/me with no session ==');
  res = await fetch(`${BASE_URL}/api/auth/me`);
  assert(res.status === 401, `me returns 401 with no session (got ${res.status})`);

  console.log('\n== login: wrong password ==');
  res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'wrongpassword' }),
  });
  body = await res.json();
  assert(res.status === 401, `wrong password returns 401 (got ${res.status})`);
  assert(body.error === '이메일 또는 비밀번호가 올바르지 않습니다', 'wrong password gives unified generic error');

  console.log('\n== login: nonexistent email (same generic message) ==');
  res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody-here@example.com', password: 'password123' }),
  });
  body = await res.json();
  assert(res.status === 401, `nonexistent email returns 401 (got ${res.status})`);
  assert(
    body.error === '이메일 또는 비밀번호가 올바르지 않습니다',
    'nonexistent-email failure uses the SAME generic message as wrong-password (no account enumeration)'
  );

  console.log('\n== login: correct credentials ==');
  res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  body = await res.json();
  assert(res.status === 200, `correct login returns 200 (got ${res.status})`);
  const loginCookie = extractCookie(res);
  assert(!!loginCookie, 'login sets a session cookie');

  console.log('\n== session persists across requests (new cookie) ==');
  res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: loginCookie } });
  assert(res.status === 200, `me works with fresh login cookie (got ${res.status})`);

  console.log('\n== logout ==');
  res = await fetch(`${BASE_URL}/api/auth/logout`, { method: 'POST', headers: { Cookie: loginCookie } });
  assert(res.status === 204, `logout returns 204 (got ${res.status})`);

  console.log('\n== session invalid after logout ==');
  res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Cookie: loginCookie } });
  assert(res.status === 401, `me returns 401 after logout (got ${res.status})`);

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
