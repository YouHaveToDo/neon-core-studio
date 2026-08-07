const { readSessionToken, findAccountBySessionToken } = require('../lib/session');

/* Session-validation middleware for authenticated routes (spec §4.2: once
 * logged in, no re-auth needed until explicit logout). Attaches
 * `req.account` = { id, email, display_name, created_at } on success.
 *
 * Token lookup (lib/session.js's readSessionToken): `Authorization: Bearer
 * <token>` first -- the only thing production clients send now, since
 * mobile Safari/iOS in-app-browser ITP unreliably evicts cookies set by a
 * cross-site response (see lib/session.js's long comment on
 * setSessionCookie for the full history) -- falling back to the session
 * cookie for local dev / server/scripts/*-smoke-test.js compatibility only.
 */
async function requireAuth(req, res, next) {
  const token = readSessionToken(req);
  const account = await findAccountBySessionToken(token);
  if (!account) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  req.account = account;
  next();
}

module.exports = { requireAuth };
