/* Password hashing: argon2id via the `argon2` package.
 *
 * Chose argon2id over bcrypt because it's the current recommended default
 * (OWASP) and the native binding built and ran fine in this environment
 * (verified: `node -e "require('argon2').hash(...)"` succeeded during
 * setup) -- no fallback to bcrypt was needed.
 */
const argon2 = require('argon2');

async function hashPassword(plaintext) {
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

async function verifyPassword(hash, plaintext) {
  try {
    return await argon2.verify(hash, plaintext);
  } catch (err) {
    // argon2.verify throws on malformed hashes rather than returning false.
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
