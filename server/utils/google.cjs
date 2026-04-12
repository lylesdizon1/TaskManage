'use strict';

/**
 * server/utils/google.cjs — Google OAuth2 client factory + token persistence.
 *
 * Centralises Google API setup for both GCal and Gmail integrations.
 * Tokens are encrypted at rest via crypto.cjs — the save/load helpers
 * handle the encrypt/decrypt lifecycle so callers never touch raw crypto.
 *
 * @note Each Google product (Calendar, Gmail) needs its own OAuth2 client
 * because the redirect URI differs per callback route. Do not share a
 * single client across products.
 *
 * @note Token storage uses a { _enc: "..." } wrapper object to distinguish
 * encrypted tokens from legacy unencrypted JSON. loadGcalTokens/loadGmailTokens
 * detect this sentinel and decrypt accordingly.
 */

const { google } = require('googleapis');
const { encryptTokens, decryptTokens, ENCRYPTION_KEY } = require('./crypto.cjs');

/**
 * Return the application's public URL, stripping trailing slashes.
 * Falls back to localhost for local development.
 *
 * @returns {string} Base URL without trailing slash.
 */
function getAppUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/+$/, '');
}

/**
 * Create a Google OAuth2 client configured for the Calendar callback.
 * Returns null if GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET are missing,
 * allowing callers to fail gracefully in unconfigured environments.
 *
 * @returns {google.auth.OAuth2|null}
 */
function makeOAuth2Client() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, `${getAppUrl()}/api/gcal/callback`);
}

/**
 * Create a Google OAuth2 client configured for the Gmail callback.
 * Separate from makeOAuth2Client because the redirect URI differs.
 *
 * @returns {google.auth.OAuth2|null}
 */
function makeGmailOAuth2Client() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, `${getAppUrl()}/api/gmail/callback`);
}

/**
 * Persist GCal OAuth tokens for a user+email, encrypting if ENCRYPTION_KEY is set.
 *
 * @param {string} userId
 * @param {Object} tokens - OAuth2 credentials from Google.
 * @param {Object} db - Database helper module.
 * @param {string} [googleEmail] - Google account email (for multi-account).
 */
const saveGcalTokens = async (userId, tokens, db, googleEmail) => {
  if (ENCRYPTION_KEY) {
    const encrypted = encryptTokens(tokens);
    await db.setGcalTokensForUser(userId, { _enc: encrypted }, googleEmail);
  } else {
    await db.setGcalTokensForUser(userId, tokens, googleEmail);
  }
};

/**
 * Load and decrypt GCal OAuth tokens for a user.
 * If googleEmail is provided, loads that specific account.
 * Otherwise loads the primary (or first) account (backward-compat).
 *
 * @param {string} userId
 * @param {Object} db - Database helper module.
 * @param {string} [googleEmail] - Specific account to load.
 * @returns {Promise<Object|null>} Decrypted token credentials or null.
 */
const loadGcalTokens = async (userId, db, googleEmail) => {
  const stored = googleEmail
    ? await db.getGcalTokensByEmail(userId, googleEmail)
    : await db.getGcalTokensForUser(userId);
  if (!stored) return null;
  if (stored._enc) return decryptTokens(stored._enc);
  return stored; // legacy unencrypted tokens
};

/**
 * Load and decrypt ALL GCal accounts for a user.
 *
 * @param {string} userId
 * @param {Object} db
 * @returns {Promise<Array<{ googleEmail: string, isPrimary: boolean, tokens: Object }>>}
 */
const loadAllGcalAccounts = async (userId, db) => {
  const rows = await db.getAllGcalAccountsForUser(userId);
  return rows.map((row) => {
    let tokens = row.tokens;
    if (tokens && tokens._enc) tokens = decryptTokens(tokens._enc);
    return { googleEmail: row.googleEmail, isPrimary: row.isPrimary, tokens };
  });
};

// Gmail token helpers removed — tokens now live in user_integrations and are
// read/written directly by server/routes/gmail.cjs and server/tools.cjs.

module.exports = { getAppUrl, makeOAuth2Client, makeGmailOAuth2Client, saveGcalTokens, loadGcalTokens, loadAllGcalAccounts };
