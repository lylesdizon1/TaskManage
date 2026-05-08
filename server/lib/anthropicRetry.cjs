'use strict';

/**
 * server/lib/anthropicRetry.cjs — exponential-backoff retry wrapper for
 * Anthropic API calls.
 *
 * Use ONLY for non-streaming calls (one-shot generations like aria-brief
 * and the outcome enrichment Haiku call). Do NOT wrap SSE streams —
 * retrying mid-stream corrupts the response. The streaming agentic loop
 * in /api/chat/execute should fail fast and let the client retry. Same
 * for the sub-agent orchestrator's runSession path.
 *
 * Retry policy (V1.1 — 2026-05-08):
 *   - Status 529, 503, 502, 500 → standard exponential backoff
 *     (1s × 2^attempt + 0-500ms jitter, max 3 retries, ~7s worst case)
 *   - Status 429 → longer backoff (5s × 2^attempt + 0-1000ms jitter,
 *     capped at 30s/attempt). Honors `retry-after` header if present
 *     (parses both numeric-seconds and HTTP-date forms; capped at 30s
 *     so a pathological retry-after-3600 doesn't stall callers).
 *   - Network errnos (ECONNRESET, ETIMEDOUT, ENETUNREACH, ECONNREFUSED,
 *     EAI_AGAIN) → standard backoff
 *   - Status 400/401/403/404/422 → THROW IMMEDIATELY. These are caller
 *     bugs (malformed prompt, missing key, bad auth, schema violation),
 *     never transient. Retrying spuriously inflates spend and masks
 *     real bugs.
 *   - Heuristic message-text fallback ("overloaded" / "529") preserved
 *     for SDKs/clients that don't surface a status code cleanly.
 *
 * Each retry attempt fires a Sentry breadcrumb so when a final exhaustion
 * surfaces as an issue, the breadcrumb history shows the full retry
 * timeline (e.g. "9 seconds of 529 backoff" instead of just "one 529").
 * Breadcrumbs are no-ops when SENTRY_DSN is unset.
 */

const { APIError } = require('@anthropic-ai/sdk');
const Sentry = require('@sentry/node');

const RETRYABLE_STATUS = new Set([529, 503, 502, 500]);
const RATE_LIMIT_STATUS = 429;
const NON_RETRY_STATUS = new Set([400, 401, 403, 404, 422]);
const RETRYABLE_NETWORK_ERRNOS = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNREFUSED', 'EAI_AGAIN',
]);

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BASE_DELAY_MS = 5000;
const MAX_RETRY_AFTER_MS = 30_000;

async function withRetry(fn, context = '') {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Status-source priority: SDK APIError → err.status → err.statusCode
      // → err.response?.status. APIError instanceof check is the strongest
      // signal; the rest cover SDKs/clients that surface differently.
      const status = (err instanceof APIError ? err.status : null)
        ?? err.status ?? err.statusCode ?? err.response?.status;
      const errno  = err.code || err.cause?.code;
      const msg    = err.message || '';

      // Hard skip on 4xx — caller bugs, not transient. Throw immediately
      // without burning retry budget. This MUST come before the retryable
      // checks so a 4xx never falls into a retry path via heuristic.
      if (NON_RETRY_STATUS.has(status)) throw err;

      const isStandardRetry = RETRYABLE_STATUS.has(status)
        || /overloaded/i.test(msg)
        || /\b529\b/.test(msg)
        || RETRYABLE_NETWORK_ERRNOS.has(errno);
      const isRateLimit = status === RATE_LIMIT_STATUS;

      if (!isStandardRetry && !isRateLimit) throw err;
      if (attempt === MAX_RETRIES) throw err;

      // Backoff selection.
      let delay;
      if (isRateLimit) {
        const retryAfterMs = _parseRetryAfterMs(err);
        delay = retryAfterMs != null
          ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
          : RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 1000;
      } else {
        delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
      }

      // Sentry breadcrumb — turns "one error" into "9 seconds of overload
      // context" when the retries eventually exhaust and the error
      // surfaces as an issue. No-op when SENTRY_DSN is unset.
      try {
        Sentry.addBreadcrumb({
          category: 'anthropic-retry',
          message: `${context} attempt ${attempt + 1} failed (${status || errno || 'unknown'})`,
          level: 'warning',
          data: {
            status: status ?? null,
            errno: errno ?? null,
            attempt: attempt + 1,
            delayMs: Math.round(delay),
            isRateLimit,
          },
        });
      } catch { /* breadcrumb is best-effort */ }

      console.warn(`[anthropic-retry] ${context} attempt ${attempt + 1} failed (${status || errno || 'unknown'}), retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/**
 * Parse the retry-after header surfaced via the Anthropic SDK error.
 * Returns the delay in milliseconds, or null if absent/unparseable.
 *
 * Supports two forms (per HTTP spec):
 *   - Delta-seconds: "120" → 120000ms
 *   - HTTP-date:     "Fri, 31 Dec 2026 23:59:59 GMT" → ms-until-then
 */
function _parseRetryAfterMs(err) {
  const headers = err.headers || err.response?.headers;
  if (!headers) return null;

  // Headers may be a plain object (lower-cased keys per Anthropic SDK
  // convention) or a Headers-like with .get(). Try both.
  let raw;
  if (typeof headers.get === 'function') {
    raw = headers.get('retry-after');
  } else {
    raw = headers['retry-after'] ?? headers['Retry-After'];
  }
  if (raw == null || raw === '') return null;

  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) return asNum * 1000;

  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());

  return null;
}

module.exports = {
  withRetry,
  // Exported for tests:
  RETRYABLE_STATUS,
  RATE_LIMIT_STATUS,
  NON_RETRY_STATUS,
  RETRYABLE_NETWORK_ERRNOS,
  MAX_RETRIES,
  MAX_RETRY_AFTER_MS,
  _parseRetryAfterMs,
};
