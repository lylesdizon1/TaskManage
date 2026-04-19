'use strict';

/**
 * server/utils/crypto.cjs — AES-256-CBC encryption for secrets at rest.
 *
 * Used to encrypt OAuth tokens (GCal, Gmail, Outlook) before storing in
 * PostgreSQL. ENCRYPTION_KEY is required at startup — no silent
 * pass-through, since first encryption call would otherwise throw a
 * cryptic createCipheriv error long after boot.
 *
 * Decryption still tolerates legacy unencrypted rows (the catch in
 * decrypt() returns the input as-is on failure) so existing data keeps
 * reading after the strict-key requirement lands.
 *
 * @note The encrypted format is "iv_hex:ciphertext_hex". decrypt() uses
 * the presence of a colon to distinguish encrypted from plaintext data,
 * so raw plaintext containing a colon could theoretically confuse it —
 * in practice, OAuth token JSON always starts with "{" so this is safe.
 */

const crypto = require('crypto');

if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be exactly 32 characters');
}

/** @type {string} Exactly 32 characters (256 bits) for AES-256. */
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

/**
 * Encrypt a plaintext string using AES-256-CBC with a random IV.
 * Returns "iv_hex:ciphertext_hex". No-ops if text is falsy or key is missing.
 *
 * @param {string} text - Plaintext to encrypt.
 * @returns {string} Encrypted string in "iv:ciphertext" hex format, or the
 *   original text if encryption is not configured.
 */
const encrypt = (text) => {
  if (!text || !ENCRYPTION_KEY) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
};

/**
 * Decrypt an "iv_hex:ciphertext_hex" string back to plaintext.
 * Gracefully returns the input unchanged if decryption fails or if the
 * value appears to be unencrypted legacy data.
 *
 * @param {string} text - Encrypted string or plaintext passthrough.
 * @returns {string} Decrypted plaintext, or original value on failure.
 */
const decrypt = (text) => {
  if (!text || !ENCRYPTION_KEY) return text;
  try {
    const [ivHex, encrypted] = text.split(':');
    if (!ivHex || !encrypted) return text; // not encrypted, return as-is
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // Distinguish "this looks encrypted but failed to decrypt" from
    // "this is legacy plaintext (no colon)". The plaintext path returned
    // above already; reaching here means the input HAD an iv:cipher
    // shape but the key didn't match — likely ENCRYPTION_KEY rotation.
    // Logging via require() rather than module-load to avoid circular
    // bootstrap risk in the crypto-on-boot flow.
    try {
      const logger = require('../../guardrails/logger.cjs');
      logger.error('crypto.decrypt.failed', {
        error: err.message,
        // Hint at the likely cause without leaking ciphertext.
        likelyCause: 'encryption_key_mismatch_or_corrupt_ciphertext',
      });
    } catch { /* logger unavailable during boot — silent ok */ }
    return text; // preserve legacy-read semantics so the rest of the app keeps working
  }
};

/**
 * Serialize an OAuth token object to JSON, then encrypt it.
 *
 * @param {Object} tokens - OAuth credentials (access_token, refresh_token, etc.).
 * @returns {string|Object} Encrypted string, or the original object if no key.
 */
const encryptTokens = (tokens) => {
  if (!tokens || !ENCRYPTION_KEY) return tokens;
  return encrypt(JSON.stringify(tokens));
};

/**
 * Decrypt and parse a stored token string back to an object.
 * Handles three storage formats: encrypted string, plain JSON string,
 * and raw object (legacy unencrypted rows).
 *
 * @param {string|Object} stored - Encrypted string, JSON string, or plain object.
 * @returns {Object} Parsed token credentials.
 */
const decryptTokens = (stored) => {
  if (!stored || !ENCRYPTION_KEY) return stored;
  if (typeof stored === 'object') return stored; // already a plain object (unencrypted legacy)
  try {
    return JSON.parse(decrypt(stored));
  } catch {
    return stored; // couldn't decrypt/parse, return as-is
  }
};

module.exports = { encrypt, decrypt, encryptTokens, decryptTokens, ENCRYPTION_KEY };
