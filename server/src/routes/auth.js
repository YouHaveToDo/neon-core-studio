const express = require('express');
const { pool } = require('../db');
const { hashPassword, verifyPassword } = require('../lib/password');
const { isValidEmail, isValidPassword, isValidDisplayName, normalizeEmail } = require('../lib/validators');
const {
  createSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
  findAccountBySessionToken,
} = require('../lib/session');
const { STARTER_DECK_SLOT1, STARTER_DECK_NAME } = require('../lib/starterDeck');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

// POST /api/auth/signup
// spec §4.1: email + password (>=8 chars) + confirm-match + display name
// (2-16 chars). Inline, field-scoped errors; dup-email check; auto-login
// on success. Also seeds slot 1 with the 24-card starter deck (§5.4) in
// the same transaction, so an account is never left without a playable
// deck even if the process crashes between the two inserts.
router.post('/signup', async (req, res) => {
  const { email, password, confirmPassword, displayName } = req.body || {};

  const fieldErrors = {};
  if (!isValidEmail(email)) {
    fieldErrors.email = '올바른 이메일 형식이 아닙니다';
  }
  if (!isValidPassword(password)) {
    fieldErrors.password = '비밀번호는 최소 8자 이상이어야 합니다';
  } else if (password !== confirmPassword) {
    fieldErrors.confirmPassword = '비밀번호가 일치하지 않습니다';
  }
  if (!isValidDisplayName(displayName)) {
    fieldErrors.displayName = '표시 이름은 2~16자여야 합니다';
  }
  if (Object.keys(fieldErrors).length > 0) {
    return res.status(400).json({ fieldErrors });
  }

  const normalizedEmail = normalizeEmail(email);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM accounts WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ fieldErrors: { email: '이미 사용 중인 이메일입니다' } });
    }

    const passwordHash = await hashPassword(password);
    const displayNameTrimmed = displayName.trim();

    const accountResult = await client.query(
      `INSERT INTO accounts (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, created_at`,
      [normalizedEmail, passwordHash, displayNameTrimmed]
    );
    const account = accountResult.rows[0];

    await client.query(
      `INSERT INTO decks (account_id, slot, name, cards)
       VALUES ($1, 1, $2, $3::jsonb)`,
      [account.id, STARTER_DECK_NAME, JSON.stringify(STARTER_DECK_SLOT1)]
    );

    await client.query('COMMIT');

    // Auto-login on signup success (spec §4.1).
    const { token, expiresAt } = await createSession(account.id);
    setSessionCookie(res, token, expiresAt);

    return res.status(201).json({
      account: { id: account.id, email: account.email, displayName: account.display_name },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('signup failed', err);
    return res.status(500).json({ error: '가입 처리 중 오류가 발생했습니다' });
  } finally {
    client.release();
  }
});

// POST /api/auth/login
// spec §4.2: single unified error message on any failure (no account
// enumeration -- doesn't distinguish "no such email" from "wrong password").
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const GENERIC_ERROR = { error: '이메일 또는 비밀번호가 올바르지 않습니다' };

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json(GENERIC_ERROR);
  }

  const normalizedEmail = normalizeEmail(email);
  const result = await pool.query(
    'SELECT id, email, display_name, password_hash FROM accounts WHERE email = $1',
    [normalizedEmail]
  );
  const account = result.rows[0];

  if (!account) {
    // Still hash-compare against a dummy value so the response time doesn't
    // leak "account exists vs. not" via a timing side channel.
    await verifyPassword(
      '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      password
    );
    return res.status(401).json(GENERIC_ERROR);
  }

  const ok = await verifyPassword(account.password_hash, password);
  if (!ok) {
    return res.status(401).json(GENERIC_ERROR);
  }

  const { token, expiresAt } = await createSession(account.id);
  setSessionCookie(res, token, expiresAt);

  return res.json({
    account: { id: account.id, email: account.email, displayName: account.display_name },
  });
});

// POST /api/auth/logout
// spec §4.2: immediate, no confirmation. Deletes the session row server-
// side (the whole point of opaque tokens over JWT) and clears the cookie.
router.post('/logout', async (req, res) => {
  const token = readSessionCookie(req);
  if (token) {
    await destroySession(token);
  }
  clearSessionCookie(res);
  return res.status(204).end();
});

// GET /api/auth/me
// Not explicitly named in spec §4, but needed for any frontend to know
// on load whether an existing session cookie is still valid (spec §4.2:
// "no re-auth needed until logout" implies the client needs a way to ask
// "am I still logged in?"). Kept minimal: read-only, no side effects.
router.get('/me', requireAuth, (req, res) => {
  res.json({
    account: { id: req.account.id, email: req.account.email, displayName: req.account.display_name },
  });
});

module.exports = router;
