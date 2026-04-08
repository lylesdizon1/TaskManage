'use strict';

/**
 * server/utils/crypto.cjs — AES-256-CBC encryption for secrets at rest.
 *
 * Used to encrypt OAuth tokens (GCal, Gmail) before storing in PostgreSQL.
 * If ENCRYPTION_KEY is not set, all functions gracefully pass data through
 * unencrypted — this supports local development and legacy unencrypted rows.
 *
 * @note ENCRYPTION_KEY must be exactly 32 characters (256 bits). A shorter
 * key will cause createCipheriv to throw at runtime.
 *
 * @note The encrypted format is "iv_hex:ciphertext_hex". decrypt() uses
 * the presence of a colon to distinguish encrypted from plaintext data,
 * so raw plaintext containing a colon could theoretically confuse it —
 * in practice, OAuth token JSON always starts with "{" so this is safe.
 */

const crypto = require('crypto');

/** @type {string|undefined} Must be exactly 32 characters for AES-256. */
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
  } catch {
    return text; // decryption failed (likely unencrypted legacy data), return as-is
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
