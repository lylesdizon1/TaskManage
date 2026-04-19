'use strict';

/**
 * server/utils/quickbooks.cjs — Intuit QuickBooks OAuth + token persistence.
 *
 * P0 scope: prove the OAuth round-trip and persist encrypted tokens. No
 * data sync — that lands in P1 alongside the *\/15 cron worker.
 *
 * Differences from the Outlook integration template:
 *   - Connections are scoped to (user, entity, realm_id), not (user, account_email).
 *     entity_qb_connections is its own table, not a user_integrations row.
 *   - Intuit's callback returns realmId as a separate query param (not in
 *     the token response) — must be captured at callback time.
 *   - Refresh tokens ROTATE on every refresh; the old refresh_token is
 *     invalidated. Persist the new one immediately or you brick the
 *     connection.
 *   - Sandbox vs production is a different API host, not just a flag —
 *     stored per-connection so a single user can mix environments.
 *
 * Env vars:
 *   QB_CLIENT_ID, QB_CLIENT_SECRET — required.
 *   QB_REDIRECT_URI — optional, defaults to APP_URL/api/quickbooks/callback.
 *   QB_DEFAULT_ENVIRONMENT — 'sandbox' | 'production', defaults to sandbox.
 *   QB_ALLOW_PRODUCTION — '1' to permit production realms; otherwise the
 *     callback rejects production realmIds. Off by default for safety.
 */

const crypto = require('crypto');
const { encryptTokens, decryptTokens, ENCRYPTION_KEY } = require('./crypto.cjs');
const { getRedisClient } = require('../lib/redis.cjs');
const logger = require('../../guardrails/logger.cjs');

const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

// Read-only Accounting scope only — no Payments. P0 success criterion.
const SCOPES = ['com.intuit.quickbooks.accounting'];

const STATE_KEY_PREFIX = 'oauth:qb:state:';
const STATE_TTL_SECONDS = 600;

function getAppUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/+$/, '');
}

function getClientConfig() {
  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const redirectUri = process.env.QB_REDIRECT_URI || `${getAppUrl()}/api/quickbooks/callback`;
  return { clientId, clientSecret, redirectUri };
}

function defaultEnvironment() {
  const v = (process.env.QB_DEFAULT_ENVIRONMENT || 'sandbox').toLowerCase();
  return v === 'production' ? 'production' : 'sandbox';
}

function productionAllowed() {
  return process.env.QB_ALLOW_PRODUCTION === '1';
}

function apiBase(environment) {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// ── OAuth state (binds {userId, entityId, environment}) ────────────────────
//
// Built locally rather than extending oauthState.cjs because we need to bind
// extra context (entityId + environment) and don't want to widen the
// shared mintState contract.

async function mintQbState({ userId, entityId, environment }) {
  const client = await getRedisClient();
  if (!client) throw new Error('Redis unavailable; cannot mint QB OAuth state');
  const state = crypto.randomBytes(32).toString('hex');
  const payload = JSON.stringify({ userId, entityId, environment });
  await client.set(`${STATE_KEY_PREFIX}${state}`, payload, { EX: STATE_TTL_SECONDS });
  return state;
}

async function consumeQbState(state) {
  if (!state || typeof state !== 'string') return null;
  const client = await getRedisClient();
  if (!client) {
    logger.warn('quickbooks.state.consume.redisUnavailable', {});
    return null;
  }
  const key = `${STATE_KEY_PREFIX}${state}`;
  let raw;
  try { raw = await client.get(key); }
  catch (err) {
    logger.warn('quickbooks.state.consume.redisError', { error: err.message });
    return null;
  }
  if (!raw) return null;
  try { await client.del(key); } catch { /* TTL will reap */ }
  try { return JSON.parse(raw); }
  catch { return null; }
}

// ── Auth URL + token exchange ───────────────────────────────────────────────

function buildAuthUrl(state) {
  const cfg = getClientConfig();
  if (!cfg) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: SCOPES.join(' '),
    redirect_uri: cfg.redirectUri,
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const cfg = getClientConfig();
  if (!cfg) throw new Error('QuickBooks OAuth not configured');
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`QB token exchange failed: ${json.error_description || json.error || res.status}`);
  return normalizeTokens(json);
}

async function refreshAccessToken(refreshToken) {
  const cfg = getClientConfig();
  if (!cfg) throw new Error('QuickBooks OAuth not configured');
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`QB token refresh failed: ${json.error_description || json.error || res.status}`);
    err.code = json.error || 'refresh_failed';
    throw err;
  }
  return normalizeTokens(json);
}

function normalizeTokens(json) {
  const now = Date.now();
  // QB access tokens are 1h; subtract 60s to refresh slightly early.
  const expiresAt = json.expires_in ? now + (Number(json.expires_in) - 60) * 1000 : now + 55 * 60 * 1000;
  // Refresh tokens last 100 days; same -60s safety margin.
  const xRefreshExpiresAt = json.x_refresh_token_expires_in
    ? now + (Number(json.x_refresh_token_expires_in) - 60) * 1000
    : null;
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token, // ROTATES — caller MUST persist
    expires_at: expiresAt,
    x_refresh_token_expires_at: xRefreshExpiresAt,
    scope: json.scope || SCOPES.join(' '),
    token_type: json.token_type || 'Bearer',
  };
}

// ── Token storage envelope (encrypted_tokens TEXT column) ───────────────────

function packTokens(tokens) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY required to store QB tokens');
  return encryptTokens(tokens);
}

function unpackTokens(encryptedTokens) {
  if (!encryptedTokens) return null;
  return decryptTokens(encryptedTokens);
}

/**
 * Return a known-fresh access token for a connection, refreshing+persisting
 * if the current access token is expired. Returns the (possibly refreshed)
 * tokens object so callers can use it directly.
 */
async function withFreshAccessToken(connection, db) {
  let tokens = unpackTokens(connection.encryptedTokens);
  if (!tokens) throw new Error('No tokens for QB connection');
  const now = Date.now();
  if (!tokens.expires_at || tokens.expires_at <= now) {
    if (!tokens.refresh_token) throw new Error('QB access token expired and no refresh_token available');
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    tokens = refreshed;
    await db.updateQbConnectionTokens(connection.id, connection.userId, packTokens(tokens));
  }
  return tokens;
}

// ── Intuit API helpers ──────────────────────────────────────────────────────

/**
 * Fetch CompanyInfo for a realm. Used at callback to cache company_name and
 * by /test to verify the connection is live.
 */
async function fetchCompanyInfo({ realmId, environment, accessToken }) {
  const url = `${apiBase(environment)}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=70`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`QB CompanyInfo failed: ${json.Fault?.Error?.[0]?.Message || res.status}`);
    err.status = res.status;
    throw err;
  }
  return json.CompanyInfo || json;
}

/**
 * Run a QuickBooks Online SOQL-like `query` against the connection's realm.
 * Returns the raw QueryResponse object (Account, Invoice, Bill, etc. arrays
 * keyed by entity name). Throws on non-2xx with a sanitized message — caller
 * decides whether to swallow or surface.
 */
async function qbQuery({ realmId, environment, accessToken, query }) {
  const url = `${apiBase(environment)}/v3/company/${realmId}/query?minorversion=70`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/text',
    },
    body: query,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`QB query failed: ${json.Fault?.Error?.[0]?.Message || res.status}`);
    err.status = res.status;
    throw err;
  }
  return json.QueryResponse || {};
}

module.exports = {
  AUTH_BASE,
  TOKEN_URL,
  SCOPES,
  getAppUrl,
  getClientConfig,
  defaultEnvironment,
  productionAllowed,
  apiBase,
  mintQbState,
  consumeQbState,
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  packTokens,
  unpackTokens,
  withFreshAccessToken,
  fetchCompanyInfo,
  qbQuery,
};
