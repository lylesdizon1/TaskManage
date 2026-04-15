'use strict';

/**
 * server/utils/outlook.cjs — Microsoft Graph OAuth + token persistence.
 *
 * V1 compromises (documented in CLAUDE.md):
 *   - No provider column in calendar_events. Outlook events are stored in
 *     the same table via account_email='outlook:<upn>' — the prefix lets
 *     cron/read paths distinguish them without a schema change.
 *   - Token storage lives in user_integrations with integration_type='outlook'
 *     and provider='microsoft'. One row per (user, Microsoft account).
 *   - No Graph SDK — direct fetch against the v2.0 endpoints to avoid a
 *     new dependency. Node 18+ global fetch.
 *   - Tokens are AES-wrapped via crypto.cjs, same pattern as Gmail.
 */

const { encryptTokens, decryptTokens, ENCRYPTION_KEY } = require('./crypto.cjs');

const AUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

// Calendars.Read + Mail.Read for V1. offline_access yields a refresh_token.
// User.Read lets us resolve the account email on first callback without
// needing Directory.Read.All.
const SCOPES = ['offline_access', 'User.Read', 'Calendars.Read', 'Mail.Read'];

function getAppUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/+$/, '');
}

function getClientConfig() {
  const clientId = process.env.OUTLOOK_CLIENT_ID;
  const clientSecret = process.env.OUTLOOK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.OUTLOOK_REDIRECT_URI || `${getAppUrl()}/api/outlook/callback`;
  return { clientId, clientSecret, redirectUri };
}

function buildAuthUrl(userId) {
  const cfg = getClientConfig();
  if (!cfg) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state: userId,
    prompt: 'consent',
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const cfg = getClientConfig();
  if (!cfg) throw new Error('Outlook OAuth not configured');
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
    scope: SCOPES.join(' '),
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Outlook token exchange failed: ${json.error_description || json.error || res.status}`);
  return normalizeTokens(json);
}

async function refreshAccessToken(refreshToken) {
  const cfg = getClientConfig();
  if (!cfg) throw new Error('Outlook OAuth not configured');
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPES.join(' '),
  });
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Outlook token refresh failed: ${json.error_description || json.error || res.status}`);
    err.code = json.error || 'refresh_failed';
    throw err;
  }
  return normalizeTokens(json, refreshToken);
}

function normalizeTokens(json, fallbackRefresh) {
  const now = Date.now();
  const expiresAt = json.expires_in ? now + (Number(json.expires_in) - 60) * 1000 : now + 55 * 60 * 1000;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || fallbackRefresh || null,
    expires_at: expiresAt,
    scope: json.scope || SCOPES.join(' '),
    token_type: json.token_type || 'Bearer',
  };
}

function wrapTokens(tokens) {
  if (ENCRYPTION_KEY) return { _enc: encryptTokens(tokens) };
  return tokens;
}
function unwrapTokens(stored) {
  if (!stored) return null;
  if (stored._enc) return decryptTokens(stored._enc);
  return stored;
}

async function listOutlookAccounts(userId, db) {
  const rows = await db.getUserIntegrationsByType(userId, 'outlook');
  return rows.map((r) => ({
    id: r.id,
    accountEmail: r.accountEmail || '',
    tokens: unwrapTokens(r.config?.tokens),
    createdAt: r.createdAt,
  }));
}

async function saveOutlookAccount(userId, accountEmail, tokens, db) {
  return db.upsertUserIntegration(
    userId,
    'outlook',
    { tokens: wrapTokens(tokens) },
    true,
    accountEmail || '',
    'microsoft',
  );
}

/**
 * Fetch /me via Graph and return { email, displayName }. Used at callback
 * to resolve the account_email for dedup.
 */
async function fetchUserProfile(accessToken) {
  const res = await fetch(`${GRAPH_BASE}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Graph /me failed: ${res.status}`);
  const json = await res.json();
  const email = (json.mail || json.userPrincipalName || '').toLowerCase();
  return { email, displayName: json.displayName || null };
}

/**
 * Run a Graph API call with a known-fresh access token, refreshing+persisting
 * on expiry or 401. Callers pass an already-loaded tokens object; returns the
 * (possibly refreshed) tokens so the caller can persist them.
 */
async function withFreshAccessToken(account, db, userId) {
  let tokens = account.tokens;
  if (!tokens) throw new Error('No tokens for outlook account');
  const now = Date.now();
  if (!tokens.expires_at || tokens.expires_at <= now) {
    if (!tokens.refresh_token) throw new Error('Outlook access token expired and no refresh_token available');
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    tokens = { ...tokens, ...refreshed };
    await saveOutlookAccount(userId, account.accountEmail || '', tokens, db);
  }
  return tokens;
}

module.exports = {
  AUTH_BASE,
  GRAPH_BASE,
  SCOPES,
  getAppUrl,
  getClientConfig,
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  fetchUserProfile,
  withFreshAccessToken,
  listOutlookAccounts,
  saveOutlookAccount,
  wrapTokens,
  unwrapTokens,
};
