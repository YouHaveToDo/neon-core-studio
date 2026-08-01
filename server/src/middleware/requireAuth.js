const { readSessionCookie, findAccountBySessionToken } = require('../lib/session');

/* Session-validation middleware for authenticated routes (spec §4.2: once
 * logged in, no re-auth needed until explicit logout). Attaches
 * `req.account` = { id, email, display_name, created_at } on success.
 *
 * Nothing in Phase 1 mounts this on a route yet (signup/login/logout are
 * all public), but Phase 3+ (deck endpoints, match history) will need it,
 * so it's built now per plan.md 1.3 ("session-validation middleware for
 * all authenticated routes").
 */
async function requireAuth(req, res, next) {
  const token = readSessionCookie(req);
  const account = await findAccountBySessionToken(token);
  if (!account) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  req.account = account;
  next();
}

module.exports = { requireAuth };
