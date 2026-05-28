'use strict';

/**
 * server/lib/costTracker.cjs — generic per-user daily counters in Redis.
 *
 * Used today for:
 *   - M1b memory extractor (calls/day per user)
 *
 * Designed to slot directly into:
 *   - Per-user daily TOKEN budget (Layer 1 of docs/audit/04-llm-cost-risks.md
 *     §7). Same helper, increment = response.usage tokens instead of 1.
 *   - Any future per-extractor or per-endpoint daily cap.
 *
 * The unit (calls vs tokens vs $) lives in the caller's `increment`
 * argument — this module is unit-agnostic.
 *
 * FAIL-OPEN by design: if Redis is unavailable, callers see
 * `{ ok: false, exceeded: false }` and proceed without enforcement.
 * Matches the policy in userRateLimit.cjs — a Redis outage shouldn't
 * silently disable a paid surface.
 *
 * Day boundary: UTC. A user-local boundary could mismatch their
 * timezone, but for cost windows a stable rolling 24h is the correct
 * primitive — the cap is a budget, not a circadian observation.
 */

const { getRedisClient } = require('./redis.cjs');
const logger = require('../../guardrails/logger.cjs');

const DAY_SECONDS = 86400;

function dateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * Atomic increment of a per-user daily counter scoped to a label.
 *
 * @param {string} userId — DB user id.
 * @param {string} scope  — e.g. 'memory_extractor', 'tokens', 'vision'.
 * @param {object} [opts]
 * @param {number} [opts.increment=1] — amount to add (calls=1, tokens=N).
 * @param {number|null} [opts.dailyCap=null] — if set, `exceeded` flips when
 *   the post-increment value crosses the cap.
 * @returns {Promise<{ count: number, exceeded: boolean, ok: boolean }>}
 *   `ok: false` means Redis was unavailable; treat as no enforcement.
 */
async function incrementDailyCounter(userId, scope, { increment = 1, dailyCap = null } = {}) {
  if (!userId || !scope) {
    return { count: 0, exceeded: false, ok: false };
  }
  const client = await getRedisClient();
  if (!client) return { count: 0, exceeded: false, ok: false };

  const key = `cost:${scope}:${userId}:${dateKey()}`;
  try {
    const count = await client.incrby(key, increment);
    if (count === increment) {
      // First write today — set the TTL so Redis reaps the key.
      try { await client.expire(key, DAY_SECONDS); } catch { /* best-effort */ }
    }
    return {
      count,
      exceeded: dailyCap != null && count > dailyCap,
      ok: true,
    };
  } catch (err) {
    logger.error('costTracker.incr.failed', { userId, scope, error: err.message });
    return { count: 0, exceeded: false, ok: false };
  }
}

/**
 * Read-only counter check. Returns the current count without incrementing.
 * Returns 0 on Redis miss or unavailability — callers cannot distinguish
 * "no usage yet today" from "Redis down."
 */
async function getDailyCount(userId, scope) {
  if (!userId || !scope) return 0;
  const client = await getRedisClient();
  if (!client) return 0;
  try {
    const val = await client.get(`cost:${scope}:${userId}:${dateKey()}`);
    return val ? parseInt(val, 10) : 0;
  } catch { return 0; }
}

module.exports = { incrementDailyCounter, getDailyCount, dateKey };
