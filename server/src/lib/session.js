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

// SameSite: `onrender.com` is on the public suffix list (Render registers it
// specifically so that different customers'/services' `*.onrender.com`
// subdomains are treated as different sites, not as one shared domain) --
// verified directly against https://publicsuffix.org/list/public_suffix_list.dat.
// That means the client (neon-core-client.onrender.com) and this API
// (neon-core-api.onrender.com) are cross-SITE in production, not just
// cross-origin, even though they share the `onrender.com` suffix. `lax`
// cookies are withheld from cross-site fetch/XHR/WS-upgrade requests (they
// only ride along on top-level navigations), so `lax` would silently break
// every credentialed request js/api.js/js/ws.js make in production -- this
// only worked in local dev because two `localhost` ports count as same-site.
// `none` is required for the cross-site case, and `none` requires `Secure`
// (HTTPS-only), which is already tied to IS_PRODUCTION below, so this is
// safe: production (always HTTPS on Render) gets `none`+Secure, dev (plain
// http://) keeps `lax`, which still works fine there since dev is same-site.
function setSessionCookie(res, token, expiresAt) {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: IS_PRODUCTION, // Secure requires HTTPS; local dev runs plain http://
      sameSite: IS_PRODUCTION ? 'none' : 'lax',
      path: '/',
      expires: expiresAt,
    })
  );
}

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

module.exports = {
  createSession,
  destroySession,
  findAccountBySessionToken,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
};
