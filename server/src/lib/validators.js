/* Server-side validation for signup/login, mirroring spec §4.1-§4.2.
 * Client-side validation (js/ later, Phase 4) is a UX nicety; this is the
 * actual enforcement -- never trust the client.
 */

// Standard-enough email shape check. Not RFC 5322-complete (nothing
// practical is) -- just enough to reject obvious garbage. Real dedup
// happens via the DB unique constraint on `accounts.email`.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 320 && EMAIL_RE.test(email);
}

// spec §4.1: min 8 chars, no complexity rules.
function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

// spec §4.1: 2-16 chars, no other constraints stated (charset, whitespace).
function isValidDisplayName(displayName) {
  if (typeof displayName !== 'string') return false;
  const trimmed = displayName.trim();
  return trimmed.length >= 2 && trimmed.length <= 16;
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

module.exports = {
  isValidEmail,
  isValidPassword,
  isValidDisplayName,
  normalizeEmail,
};
