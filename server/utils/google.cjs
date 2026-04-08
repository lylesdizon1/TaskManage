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
 * Persist GCal OAuth tokens for a user, encrypting if ENCRYPTION_KEY is set.
 *
 * @param {string} userId
 * @param {Object} tokens - OAuth2 credentials from Google.
 * @param {Object} db - Database helper module.
 */
const saveGcalTokens = async (userId, tokens, db) => {
  if (ENCRYPTION_KEY) {
    const encrypted = encryptTokens(tokens);
    await db.setGcalTokensForUser(userId, { _enc: encrypted });
  } else {
    await db.setGcalTokensForUser(userId, tokens);
  }
};

/**
 * Load and decrypt GCal OAuth tokens for a user.
 * Returns null if the user has not connected Google Calendar.
 *
 * @param {string} userId
 * @param {Object} db - Database helper module.
 * @returns {Promise<Object|null>} Decrypted token credentials or null.
 */
const loadGcalTokens = async (userId, db) => {
  const stored = await db.getGcalTokensForUser(userId);
  if (!stored) return null;
  if (stored._enc) return decryptTokens(stored._enc);
  return stored; // legacy unencrypted tokens
};

/**
 * Persist Gmail OAuth tokens for a user, encrypting if ENCRYPTION_KEY is set.
 *
 * @param {string} userId
 * @param {Object} tokens - OAuth2 credentials from Google.
 * @param {Object} db - Database helper module.
 */
const saveGmailTokens = async (userId, tokens, db) => {
  if (ENCRYPTION_KEY) {
    const encrypted = encryptTokens(tokens);
    await db.setGmailTokensForUser(userId, { _enc: encrypted });
  } else {
    await db.setGmailTokensForUser(userId, tokens);
  }
};

/**
 * Load and decrypt Gmail OAuth tokens for a user.
 * Returns null if the user has not connected Gmail.
 *
 * @param {string} userId
 * @param {Object} db - Database helper module.
 * @returns {Promise<Object|null>} Decrypted token credentials or null.
 */
const loadGmailTokens = async (userId, db) => {
  const stored = await db.getGmailTokensForUser(userId);
  if (!stored) return null;
  if (stored._enc) return decryptTokens(stored._enc);
  return stored;
};

module.exports = { getAppUrl, makeOAuth2Client, makeGmailOAuth2Client, saveGcalTokens, loadGcalTokens, saveGmailTokens, loadGmailTokens };
