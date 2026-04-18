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
const cacheKey = (userId, messageId) => `email:${userId}:${messageId}`;

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

async function _fetchFromGmail(userId, messageId, accountEmail, db) {
  const row = await db.getGmailIntegrationByEmail(userId, accountEmail);
  const stored = row?.config?.tokens || null;
  if (!stored) return null;
  const tokens = stored._enc ? decryptTokens(stored._enc) : stored;
  const oauth2 = makeGmailOAuth2Client();
  if (!oauth2) return null;
  oauth2.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  const headers = data.payload?.headers || [];
  return {
    messageId: data.id,
    threadId: data.threadId,
    subject: _headerVal(headers, 'Subject'),
    from: _headerVal(headers, 'From'),
    to: _headerVal(headers, 'To'),
    date: _headerVal(headers, 'Date'),
    snippet: data.snippet || '',
    body: _extractBody(data.payload),
    labelIds: data.labelIds || [],
    hasContent: true,
  };
}

/**
 * Fetch a single Gmail message's content. Returns { hasContent: false }
 * on any failure path so callers can branch cleanly without try/catch.
 */
async function getEmailContent(userId, messageId, accountEmail, db) {
  if (!userId || !messageId || !accountEmail || !db) return { hasContent: false };
  const key = cacheKey(userId, messageId);
  try {
    const cached = await rediGet(key);
    if (cached && cached.hasContent) return cached;
  } catch { /* cache miss path */ }
  let content;
  try {
    content = await _fetchFromGmail(userId, messageId, accountEmail, db);
  } catch (err) {
    logger.warn('emailContent.fetch.failed', { userId, messageId, error: err.message });
    return { hasContent: false };
  }
  if (!content) return { hasContent: false };
  // Best-effort cache write — never blocks the caller.
  rediSet(key, content, CACHE_TTL_SEC).catch(() => {});
  return content;
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

module.exports = {
  getEmailContent,
  assessEmailContentRisk,
  containsFinancialData,
  containsConfirmationCode,
};
