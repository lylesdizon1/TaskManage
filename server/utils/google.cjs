'use strict';

const { google } = require('googleapis');
const { encryptTokens, decryptTokens, ENCRYPTION_KEY } = require('./crypto.cjs');

function getAppUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/+$/, '');
}

function makeOAuth2Client() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, `${getAppUrl()}/api/gcal/callback`);
}

function makeGmailOAuth2Client() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, `${getAppUrl()}/api/gmail/callback`);
}

const saveGcalTokens = async (userId, tokens, db) => {
  if (ENCRYPTION_KEY) {
    const encrypted = encryptTokens(tokens);
    await db.setGcalTokensForUser(userId, { _enc: encrypted });
  } else {
    await db.setGcalTokensForUser(userId, tokens);
  }
};

const loadGcalTokens = async (userId, db) => {
  const stored = await db.getGcalTokensForUser(userId);
  if (!stored) return null;
  if (stored._enc) return decryptTokens(stored._enc);
  return stored; // legacy unencrypted tokens
};

const saveGmailTokens = async (userId, tokens, db) => {
  if (ENCRYPTION_KEY) {
    const encrypted = encryptTokens(tokens);
    await db.setGmailTokensForUser(userId, { _enc: encrypted });
  } else {
    await db.setGmailTokensForUser(userId, tokens);
  }
};

const loadGmailTokens = async (userId, db) => {
  const stored = await db.getGmailTokensForUser(userId);
  if (!stored) return null;
  if (stored._enc) return decryptTokens(stored._enc);
  return stored;
};

module.exports = { getAppUrl, makeOAuth2Client, makeGmailOAuth2Client, saveGcalTokens, loadGcalTokens, saveGmailTokens, loadGmailTokens };
