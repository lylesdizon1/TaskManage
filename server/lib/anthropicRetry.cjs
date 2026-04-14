'use strict';

/**
 * server/lib/anthropicRetry.cjs — exponential-backoff retry wrapper for
 * Anthropic API calls.
 *
 * Use ONLY for non-streaming calls (one-shot generations like aria-brief
 * and the outcome enrichment Haiku call). Do NOT wrap SSE streams —
 * retrying mid-stream corrupts the response. The streaming agentic loop
 * in /api/chat/execute should fail fast and let the client retry.
 *
 * Retries on: 529 (overloaded), 503, 502, 500, plus messages containing
 * 'overloaded' or '529' for SDKs/clients that don't surface a status
 * code cleanly. All other errors throw immediately.
 *
 * Backoff: 1s × 2^attempt + 0-500ms jitter. Max 3 retries (4 total
 * attempts). Worst-case wait before final throw: ~7.5s + jitter.
 */

const RETRYABLE_CODES = new Set([529, 503, 502, 500]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function withRetry(fn, context = '') {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const status = err.status || err.statusCode || err.response?.status;
      const msg = err.message || '';
      const isRetryable = RETRYABLE_CODES.has(status)
        || /overloaded/i.test(msg)
        || /\b529\b/.test(msg);

      if (!isRetryable || attempt === MAX_RETRIES) throw err;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
      console.warn(`[anthropic-retry] ${context} attempt ${attempt + 1} failed (${status || 'unknown'}), retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

module.exports = { withRetry };
