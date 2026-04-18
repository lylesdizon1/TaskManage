'use strict';

/**
 * server/lib/emailContent.cjs — Phase 3.1 email content retrieval +
 * risk heuristics for the decision engine.
 *
 * Two responsibilities:
 *
 *  1. getEmailContent(userId, messageId, accountEmail, db)
 *     Returns { subject, from, to, snippet, body, hasContent }.
 *     Caches in Redis at email:{userId}:{messageId} with 5-min TTL so
 *     the decision engine can fetch the same message multiple times
 *     in a chat turn without paying the Gmail round-trip every time.
 *     Cache miss path: Gmail's gmail.users.messages.get (lighter than
 *     threads.get when we only need one message). ~200-500ms cold;
 *     ~5ms warm.
 *
 *  2. assessEmailContentRisk(content)
 *     Pure function over the content. Returns { hasFinancialData,
 *     hasConfirmationCode, summary }. Used by decisionEngine to bump
 *     risk scores or trigger hard_stop on archive/delete email tools.
 *
 * NEVER throws. On any failure (no tokens, Gmail error, parse fail) the
 * fetcher returns { hasContent: false } and the engine treats it as
 * "no extra signal" — falls through to baseline disposition.
 */

const { google } = require('googleapis');
const { rediGet, rediSet } = require('./redis.cjs');
const { makeGmailOAuth2Client } = require('../utils/google.cjs');
const { decryptTokens } = require('../utils/crypto.cjs');
const logger = require('../../guardrails/logger.cjs');

const CACHE_TTL_SEC = 5 * 60;
const FAIL_CACHE_TTL_SEC = 60;          // don't retry-storm a failing message
const GMAIL_FULL_TIMEOUT_MS = 15_000;   // ceiling for format: 'full' fetch
const GMAIL_META_TIMEOUT_MS = 5_000;    // metadata-only fallback — much smaller payload
const GMAIL_SEARCH_TIMEOUT_MS = 20_000; // mailbox search (q=) ceiling
const SEARCH_CACHE_TTL_SEC = 10 * 60;   // 10min — search results are stable enough
const SEARCH_FAIL_CACHE_TTL_SEC = 120;  // 2min — shorter so a transient failure isn't sticky
const cacheKey = (userId, messageId) => `email:${userId}:${messageId}`;
const searchCacheKey = (userId, accountEmail, query) =>
  `email-search:${userId}:${(accountEmail || 'all').toLowerCase()}:${String(query).toLowerCase().trim().slice(0, 200)}`;

/**
 * Wrap a promise in a race against a timeout. On timeout, the underlying
 * operation keeps running (can't cancel Gmail's fetch) but the caller
 * gets a synchronous rejection so we don't hang the request chain.
 */
function withTimeout(p, ms, label) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Classify a Gmail API error so the failure cache + caller can decide
 * how to react. Keeps the category set intentionally small.
 */
function _classifyGmailError(err) {
  const msg = (err?.message || '').toLowerCase();
  const code = err?.code;
  if (msg.includes('timed out') || msg.includes('timeout')) return 'timeout';
  if (code === 429 || msg.includes('rate limit') || msg.includes('quota')) return 'rate_limit';
  if (code === 401 || code === 403 || msg.includes('invalid_grant') || msg.includes('insufficient')) return 'auth';
  if (code === 404) return 'not_found';
  return 'unknown';
}

// Headers we extract from the Gmail payload — keep this list small,
// every entry costs us a header iteration.
const HEADERS_OF_INTEREST = ['from', 'to', 'subject', 'date'];

function _headerVal(headers, name) {
  if (!Array.isArray(headers)) return '';
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h ? (h.value || '') : '';
}

function _decode(b64) {
  if (!b64) return '';
  try {
    return Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch { return ''; }
}

function _extractBody(payload) {
  if (!payload) return '';
  const walk = (node, mime) => {
    if (!node) return null;
    if (node.mimeType === mime && node.body?.data) return node.body.data;
    if (Array.isArray(node.parts)) {
      for (const p of node.parts) {
        const hit = walk(p, mime);
        if (hit) return hit;
      }
    }
    return null;
  };
  // Prefer plain-text for content scanning — strips HTML noise so the
  // financial / confirmation-code regex doesn't match URL fragments.
  const plainB64 = walk(payload, 'text/plain');
  if (plainB64) return _decode(plainB64);
  const htmlB64 = walk(payload, 'text/html');
  if (htmlB64) {
    // Light HTML strip — good enough for keyword/regex matching.
    return _decode(htmlB64).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (payload.body?.data) return _decode(payload.body.data);
  return '';
}

async function _fetchFromGmail(userId, messageId, accountEmail, db, opts = {}) {
  const format = opts.format || 'full';
  const timeoutMs = opts.timeoutMs || GMAIL_FULL_TIMEOUT_MS;
  const row = await db.getGmailIntegrationByEmail(userId, accountEmail);
  const stored = row?.config?.tokens || null;
  if (!stored) { const e = new Error('no_tokens'); e.code = 401; throw e; }
  const tokens = stored._enc ? decryptTokens(stored._enc) : stored;
  const oauth2 = makeGmailOAuth2Client();
  if (!oauth2) { const e = new Error('oauth_not_configured'); e.code = 500; throw e; }
  oauth2.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const req = format === 'metadata'
    ? gmail.users.messages.get({ userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] })
    : gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const { data } = await withTimeout(req, timeoutMs, `gmail.messages.get(${format})`);
  const headers = data.payload?.headers || [];
  return {
    messageId: data.id,
    threadId: data.threadId,
    subject: _headerVal(headers, 'Subject'),
    from: _headerVal(headers, 'From'),
    to: _headerVal(headers, 'To'),
    date: _headerVal(headers, 'Date'),
    snippet: data.snippet || '',
    // Metadata responses have no body payload; return empty so downstream
    // heuristics don't match on noise.
    body: format === 'full' ? _extractBody(data.payload) : '',
    bodyFallback: format !== 'full',
    labelIds: data.labelIds || [],
    hasContent: true,
  };
}

/**
 * Fetch a single Gmail message's content with a timeout / fallback ladder:
 *   1. Cache check (success or recent failure) — returns immediately
 *   2. Full-content fetch with 15s ceiling
 *   3. On timeout (or retryable error), fall back to metadata-only fetch
 *      (5s ceiling). Returns { hasContent: true, bodyFallback: true }.
 *   4. On total failure, cache the failure shape for 60s so repeat
 *      "try again" calls don't replay the slow Gmail path.
 *
 * @param {string} userId
 * @param {string} messageId
 * @param {string} accountEmail
 * @param {Object} db
 * @param {Object} [opts]
 * @param {boolean} [opts.allowMetadataFallback=true] - Set false to skip
 *   the metadata-only retry. Decision engine uses this when it only
 *   wants a fast-or-nothing answer.
 * @returns {Promise<Object>} Always returns an object. On failure:
 *   { hasContent: false, failed: true, reason: 'timeout'|'rate_limit'|
 *   'auth'|'not_found'|'unknown' }.
 */
async function getEmailContent(userId, messageId, accountEmail, db, opts = {}) {
  if (!userId || !messageId || !accountEmail || !db) {
    return { hasContent: false, failed: true, reason: 'invalid_args' };
  }
  const allowFallback = opts.allowMetadataFallback !== false;
  const key = cacheKey(userId, messageId);

  // 1. Cache check — return both success and recent-failure shapes so
  //    subsequent calls within the failure TTL don't retry-storm.
  try {
    const cached = await rediGet(key);
    if (cached) return cached;
  } catch { /* cache miss path */ }

  let content = null;
  let reason = null;

  // 2. Full-content fetch.
  try {
    content = await _fetchFromGmail(userId, messageId, accountEmail, db, {
      format: 'full',
      timeoutMs: opts.fullTimeoutMs || GMAIL_FULL_TIMEOUT_MS,
    });
  } catch (err) {
    reason = _classifyGmailError(err);
    logger.warn('emailContent.fullFetch.failed', { userId, messageId, reason, error: err.message });
  }

  // 3. Metadata fallback — only worth trying for transient errors.
  //    Auth / not_found / invalid_args won't be fixed by a smaller request.
  if (!content && allowFallback && (reason === 'timeout' || reason === 'rate_limit' || reason === 'unknown')) {
    try {
      content = await _fetchFromGmail(userId, messageId, accountEmail, db, {
        format: 'metadata',
        timeoutMs: opts.metadataTimeoutMs || GMAIL_META_TIMEOUT_MS,
      });
    } catch (err) {
      // Metadata failure doesn't change the reason — the full-fetch
      // classification stays as the root cause surface.
      logger.warn('emailContent.metadataFetch.failed', { userId, messageId, error: err.message });
    }
  }

  // 4. Cache + return.
  if (content) {
    rediSet(key, content, CACHE_TTL_SEC).catch(() => {});
    return content;
  }
  const failed = {
    hasContent: false,
    failed: true,
    reason: reason || 'unknown',
    failedAt: Date.now(),
  };
  // Don't cache auth/not_found failures — those are permanent and
  // warrant immediate visibility, not a 60s silence.
  if (reason === 'timeout' || reason === 'rate_limit' || reason === 'unknown') {
    rediSet(key, failed, FAIL_CACHE_TTL_SEC).catch(() => {});
  }
  return failed;
}

// ── Risk heuristics ──

// Words/phrases strongly indicating financial content. Bias toward
// recall over precision — false positives are extra friction (good).
const FINANCIAL_KEYWORDS = [
  'invoice', 'amount due', 'payment due', 'balance due',
  'wire transfer', 'ach transfer', 'routing number', 'account number',
  'amex', 'american express', 'visa ending', 'mastercard', 'discover',
  'paypal', 'venmo', 'zelle', 'stripe',
  'tax return', 'irs', 'w-2', 'w2', '1099', 'k-1',
  'mortgage', 'escrow', 'closing disclosure',
  'statement balance', 'minimum payment', 'past due',
];

// Confirmation-code / OTP patterns. The 6-digit standalone regex is
// greedy on purpose — even a "your verification code is 123456" buried
// in marketing fluff is enough to be cautious.
const OTP_KEYWORDS = [
  'verification code', 'confirmation code', 'security code', 'access code',
  'one-time password', 'one time password', 'otp', '2fa', 'two-factor',
  'two factor', 'sign-in code', 'login code', 'authentication code',
  'magic link', 'reset your password', 'password reset',
];
// Standalone 6+ digit codes (avoid false-positives from phone numbers
// by requiring word boundaries and excluding 4-digit years).
const CODE_NUMERIC_RE = /\b\d{6,8}\b/;

function _normalize(s) {
  return String(s || '').toLowerCase();
}

function containsFinancialData(content) {
  if (!content) return false;
  const blob = `${_normalize(content.subject)} ${_normalize(content.body)} ${_normalize(content.snippet)}`;
  // Dollar-amount patterns ($1,234.56 etc.)
  if (/\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?/.test(blob)) return true;
  return FINANCIAL_KEYWORDS.some((k) => blob.includes(k));
}

function containsConfirmationCode(content) {
  if (!content) return false;
  const blob = `${_normalize(content.subject)} ${_normalize(content.body)} ${_normalize(content.snippet)}`;
  // Strong signal: explicit OTP language.
  if (OTP_KEYWORDS.some((k) => blob.includes(k))) {
    // Combined with a numeric code somewhere in the message → very high confidence.
    if (CODE_NUMERIC_RE.test(blob)) return true;
    // Even without a numeric code (magic-link emails), the keyword
    // alone is enough — archiving could lock the user out.
    return true;
  }
  return false;
}

function assessEmailContentRisk(content) {
  if (!content || !content.hasContent) {
    return { hasContent: false, hasFinancialData: false, hasConfirmationCode: false, summary: '' };
  }
  const hasFinancialData = containsFinancialData(content);
  const hasConfirmationCode = containsConfirmationCode(content);
  const flags = [];
  if (hasConfirmationCode) flags.push('confirmation_code');
  if (hasFinancialData) flags.push('financial');
  return {
    hasContent: true,
    hasFinancialData,
    hasConfirmationCode,
    summary: flags.length ? `email content flags: ${flags.join(', ')}` : '',
  };
}

/**
 * Search Gmail across one or all of the user's connected accounts via
 * Gmail's native q= syntax. Wraps googleEmailProvider.listThreads with:
 *   - 20s hard timeout per account (race, doesn't cancel in-flight)
 *   - Redis cache: 10min on success, 2min on failure (shorter so
 *     transient errors aren't sticky)
 *   - Result shape: { threads: [{id, subject, from, date, snippet}],
 *     totalAccountsSearched, failedAccounts: [{accountEmail, reason}] }
 *
 * Returns { failed: true, reason } on total failure (no accounts, no
 * Gmail tokens, full timeout across all accounts). Partial success
 * (some accounts succeed, some fail) returns threads + failedAccounts
 * so the caller can surface "searched 2 of 3 accounts".
 *
 * NEVER throws. Callers treat failed:true as "no results, with reason".
 *
 * @param {string} userId
 * @param {string} query - Gmail q= syntax. Aria should scope with
 *   from:, subject:, newer_than:, has:attachment, label: etc.
 * @param {Object} db
 * @param {Object} [opts]
 * @param {string} [opts.accountEmail] - restrict to a single connected
 *   Gmail account. Omitted → search every connected account, merged.
 * @param {number} [opts.maxResults=10] - cap per account. Final merged
 *   list sorted by date desc then truncated to this limit.
 * @param {number} [opts.timeoutMs=20000]
 */
async function searchGmail(userId, query, db, opts = {}) {
  if (!userId || !query || !db) {
    return { failed: true, reason: 'invalid_args', threads: [] };
  }
  const accountEmail = opts.accountEmail || null;
  const maxResults = Math.min(Math.max(parseInt(opts.maxResults, 10) || 10, 1), 25);
  const timeoutMs = opts.timeoutMs || GMAIL_SEARCH_TIMEOUT_MS;

  const key = searchCacheKey(userId, accountEmail, query);
  try {
    const cached = await rediGet(key);
    if (cached) return cached;
  } catch { /* cache miss */ }

  // Resolve which accounts to search. Route restricts to 'gmail' type.
  let integrationRows;
  try {
    integrationRows = await db.getUserIntegrationsByType(userId, 'gmail');
  } catch (err) {
    logger.warn('searchGmail.accounts.failed', { userId, error: err.message });
    return { failed: true, reason: 'accounts_fetch_failed', threads: [] };
  }
  const targets = accountEmail
    ? integrationRows.filter((r) => (r.accountEmail || '').toLowerCase() === accountEmail.toLowerCase())
    : integrationRows;
  if (!targets.length) {
    return { failed: true, reason: 'no_accounts', threads: [] };
  }

  // Lazy-require to keep the ai/chat route startup path lean and avoid
  // a circular between providers/googleEmailProvider ↔ emailContent.
  const googleEmailProvider = require('./providers/googleEmailProvider.cjs');

  const failedAccounts = [];
  const perAccount = await Promise.all(targets.map(async (row) => {
    try {
      const res = await withTimeout(
        googleEmailProvider.listThreads({
          db, userId,
          accountEmail: row.accountEmail,
          maxResults,
          query,
        }),
        timeoutMs,
        `gmail.search(${row.accountEmail || '?'})`,
      );
      return (res?.threads || []).map((t) => ({ ...t, accountEmail: row.accountEmail || '' }));
    } catch (err) {
      const reason = _classifyGmailError(err);
      failedAccounts.push({ accountEmail: row.accountEmail || '', reason });
      logger.warn('searchGmail.account.failed', { userId, accountEmail: row.accountEmail, reason, error: err.message });
      return [];
    }
  }));
  const merged = perAccount.flat();

  // All accounts failed with the same reason → treat as a total failure
  // so the caller can show a unified error message.
  if (merged.length === 0 && failedAccounts.length === targets.length) {
    const allSameReason = failedAccounts.every((f) => f.reason === failedAccounts[0].reason);
    const reason = allSameReason ? failedAccounts[0].reason : 'mixed_failures';
    const failed = { failed: true, reason, threads: [], failedAccounts, failedAt: Date.now() };
    if (reason === 'timeout' || reason === 'rate_limit' || reason === 'unknown' || reason === 'mixed_failures') {
      rediSet(key, failed, SEARCH_FAIL_CACHE_TTL_SEC).catch(() => {});
    }
    return failed;
  }

  // Sort merged results by date desc (Gmail RFC 2822 strings), truncate.
  merged.sort((a, b) => {
    const ta = Date.parse(a.date || '') || 0;
    const tb = Date.parse(b.date || '') || 0;
    return tb - ta;
  });
  const truncated = merged.slice(0, maxResults);
  const result = {
    failed: false,
    query,
    threads: truncated,
    totalAccountsSearched: targets.length - failedAccounts.length,
    failedAccounts,
    hasMore: merged.length > truncated.length,
  };
  rediSet(key, result, SEARCH_CACHE_TTL_SEC).catch(() => {});
  return result;
}

module.exports = {
  getEmailContent,
  searchGmail,
  assessEmailContentRisk,
  containsFinancialData,
  containsConfirmationCode,
};
