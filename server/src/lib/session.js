const crypto = require('crypto');
const cookie = require('cookie');
const { pool } = require('../db');
const { SESSION_TTL_MS, SESSION_COOKIE_NAME, IS_PRODUCTION } = require('../config');

// Opaque random session token (not JWT), per the plan's explicit reasoning:
// server-stored tokens can be revoked by deleting the row, which JWTs can't
// do without extra denylist infrastructure. 32 bytes -> 43-char base64url,
// ~256 bits of entropy.
function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function createSession(accountId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    'INSERT INTO sessions (token, account_id, expires_at) VALUES ($1, $2, $3)',
    [token, accountId, expiresAt]
  );
  return { token, expiresAt };
}

async function destroySession(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function findAccountBySessionToken(token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT a.id, a.email, a.display_name, a.created_at
     FROM sessions s
     JOIN accounts a ON a.id = s.account_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  return result.rows[0] || null;
}

// --- History of the cookie's SameSite setting, and why cookies are no longer
// the production auth transport at all (kept here since this comment was the
// prior session's record of the SameSite=None reasoning, and the next person
// reading this file needs the full chain, not just the current end state):
//
// `onrender.com` is on the public suffix list (Render registers it
// specifically so that different customers'/services' `*.onrender.com`
// subdomains are treated as different sites, not as one shared domain) --
// verified directly against https://publicsuffix.org/list/public_suffix_list.dat.
// That means the client (neon-core-client.onrender.com) and this API
// (neon-core-api.onrender.com) are cross-SITE in production, not just
// cross-origin. A prior session correctly identified that `lax` cookies are
// withheld from cross-site fetch/XHR/WS-upgrade requests and switched
// production to `sameSite: 'none'` (+ `Secure`, required by `none`) to fix
// that.
//
// That fix was spec-correct but didn't hold up on real devices: mobile
// Safari and iOS in-app-browser WebViews apply Intelligent Tracking
// Prevention (ITP), which classifies a cookie set by a cross-site
// fetch/XHR *response* (exactly what login/signup's Set-Cookie is here) as
// a third-party tracking cookie and blocks or aggressively evicts it --
// regardless of `SameSite=None; Secure` being attribute-correct. That's the
// literal bug reported: login succeeds (the response itself is fine), but
// the cookie doesn't reliably survive to the very next request on iOS, so
// the next authenticated call 401s with "session expired" seconds later.
// No cookie attribute combination sidesteps ITP -- it's a deliberate
// anti-tracking policy aimed at exactly this "cookie set by domain B while
// browsing domain A" shape, not a bug to work around with more cookie flags.
//
// Fix: production now authenticates exclusively via `Authorization: Bearer
// <token>` (see readSessionToken below), which the client stores in
// localStorage and attaches itself on every request -- not an ambient
// credential the browser attaches automatically, so ITP's cross-site-cookie
// heuristics don't apply to it at all (see js/api.js's top comment for the
// client-side half of this). Cookies are no longer set in production at
// all -- see setSessionCookie's IS_PRODUCTION early-return below -- both
// because they don't reliably work there anymore and because leaving a
// broken-looking Set-Cookie header in place is misleading (it looks like
// auth, but isn't the thing actually being relied on). They're kept for
// local dev only, purely so server/scripts/*-smoke-test.js (which drive the
// API directly with `Cookie` headers, no browser/localStorage involved) and
// manual curl-style testing keep working unmodified -- dev's two `localhost`
// ports are same-site, so `lax` cookies round-trip there with no ITP
// involved (ITP is a real-Safari-only policy, irrelevant to local dev).
function setSessionCookie(res, token, expiresAt) {
  if (IS_PRODUCTION) return; // production auth is Authorization: Bearer only, see above
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: false, // local dev only ever runs plain http://
      sameSite: 'lax', // fine for same-site localhost:<port> <-> localhost:<port>
      path: '/',
      expires: expiresAt,
    })
  );
}

// Unlike setSessionCookie, this always runs (not gated on IS_PRODUCTION):
// production stopped SETTING new cookies with this deploy, but any account
// that logged in before this deploy may still be carrying a leftover
// `SameSite=None; Secure` cookie from the old code, and a stale session
// cookie with no client relying on it is still a session token that could
// in principle be replayed -- clearing it on logout is cheap and correct
// regardless of which era set it. Uses the OLD (pre-this-fix) attribute
// values (secure/sameSite tied to IS_PRODUCTION) since a Set-Cookie must
// match Path (and, for the browser to treat it as "the same cookie" worth
// overwriting) reasonably closely to what actually got stored.
function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      secure: IS_PRODUCTION,
      sameSite: IS_PRODUCTION ? 'none' : 'lax',
      path: '/',
      expires: new Date(0),
    })
  );
}

function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parse(header);
  return parsed[SESSION_COOKIE_NAME] || null;
}

const AUTH_HEADER_PREFIX = 'Bearer ';

function readBearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith(AUTH_HEADER_PREFIX)) return null;
  const token = header.slice(AUTH_HEADER_PREFIX.length).trim();
  return token || null;
}

// The authoritative token lookup for HTTP requests (server/src/middleware/
// requireAuth.js, and auth.js's own /logout): `Authorization: Bearer <token>`
// first (the only thing production clients send, per the ITP fix above),
// falling back to the session cookie only because dev keeps setting one (see
// setSessionCookie) and server/scripts/*-smoke-test.js still authenticate
// via `Cookie` headers directly. A request carrying both would prefer the
// header, which is never actually possible from js/api.js today (it only
// ever sends one or the other depending on environment) -- ordering is just
// "trust the mechanism that's actually the production one first."
function readSessionToken(req) {
  return readBearerToken(req) || readSessionCookie(req);
}

module.exports = {
  createSession,
  destroySession,
  findAccountBySessionToken,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  readSessionToken,
};
