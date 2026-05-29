'use strict';

/**
 * server/lib/anthropicCall.cjs — token-tracked Anthropic client wrapper.
 *
 * Layer 1 of the cost-cap architecture (docs/audit/04-llm-cost-risks.md §7).
 * Shipped in OBSERVABILITY-ONLY mode: records token usage per user per
 * day across all LLM call sites. Enforcement is opt-in via the
 * `TOKEN_DAILY_CAP_PER_USER` env var (default: disabled).
 *
 * Recorded counters (Redis, 24h TTL):
 *   - cost:tokens:{userId}:{YYYY-MM-DD}                — global daily sum
 *   - cost:tokens:{scope}:{userId}:{YYYY-MM-DD}        — per-scope sum
 *
 * Day 2 (today): observability only. Lyle reads the counters to size
 * the cap before flipping enforcement on.
 * Day 3: set TOKEN_DAILY_CAP_PER_USER to the observed P99, flip
 * enforcement on. Every call site returns the same `{ exceeded }`
 * surface that M1b already uses.
 */

const { incrementDailyCounter, getDailyCount } = require('./costTracker.cjs');
const logger = require('../../guardrails/logger.cjs');

const ENFORCEMENT_CAP = (() => {
  const v = Number(process.env.TOKEN_DAILY_CAP_PER_USER);
  return Number.isFinite(v) && v > 0 ? v : null;
})();

/**
 * Wrap a `client.messages.create(params)` call. Forwards args
 * unchanged; on response, fires fire-and-forget Redis increments.
 *
 * Optional enforcement: when TOKEN_DAILY_CAP_PER_USER is set, throws
 * a `token_cap_exceeded` error BEFORE the API call if the user has
 * already crossed the cap on a prior call today. Estimating input
 * tokens up-front to pre-check isn't done in this layer — we let
 * one over-cap call through, then reject the next. Simpler and
 * cheaper than a pre-call token estimator.
 *
 * @param {object} client   — Anthropic SDK instance.
 * @param {object} params   — messages.create params.
 * @param {object} [opts]
 * @param {string} [opts.userId] — DB user id. Omit for proxy paths
 *   where no authed user is meaningful (cost tracked under 'anon').
 * @param {string} [opts.scope]  — e.g. 'memory_extractor', 'agentic_loop'.
 *   Counted into a per-scope key in addition to the global key.
 * @returns The unchanged Anthropic response.
 */
async function trackedAnthropicCall(client, params, opts = {}) {
  const { userId = 'anon', scope = 'unscoped' } = opts;

  // Enforcement pre-check (skipped when no cap configured).
  if (ENFORCEMENT_CAP && userId !== 'anon') {
    const current = await getDailyCount(userId, 'tokens');
    if (current > ENFORCEMENT_CAP) {
      const err = new Error('token_cap_exceeded');
      err.code = 'token_cap_exceeded';
      err.current = current;
      err.cap = ENFORCEMENT_CAP;
      throw err;
    }
  }

  const response = await client.messages.create(params);

  // Awaited token recording — sub-millisecond Redis INCR per scope, but
  // crucially happens BEFORE the response returns so a subsequent
  // get_cost_usage tool call (in the SAME agentic turn) sees the just-
  // recorded usage. Was originally fire-and-forget; that raced against
  // intra-turn reads ("Aria, how many tokens have I used today?" returned
  // 0 because the asking turn's tokens hadn't landed yet).
  try {
    const usage = response?.usage;
    if (usage) {
      const total = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      if (total > 0) {
        await incrementDailyCounter(userId, 'tokens', { increment: total });
        await incrementDailyCounter(userId, `tokens:${scope}`, { increment: total });
        logger.debug?.('anthropic.call.tracked', {
          userId, scope,
          input_tokens: usage.input_tokens || 0,
          output_tokens: usage.output_tokens || 0,
          model: response?.model,
        });
      }
    }
  } catch (err) {
    logger.warn('anthropic.call.trackFailed', { userId, scope, error: err.message });
  }

  return response;
}

/**
 * Read-only daily cost summary for a user. Returns global + per-scope
 * token counters. Useful for an admin dashboard or a /me/cost endpoint.
 */
async function getDailyCostSummary(userId) {
  if (!userId) return { totalTokens: 0, byScope: {} };
  const scopes = ['memory_extractor', 'agentic_loop', 'classification', 'food_estimate', 'food_insights', 'contact_facts', 'journal', 'outcome', 'research_agent', 'unscoped'];
  const total = await getDailyCount(userId, 'tokens');
  const byScope = {};
  for (const s of scopes) {
    const v = await getDailyCount(userId, `tokens:${s}`);
    if (v > 0) byScope[s] = v;
  }
  return { totalTokens: total, byScope, enforcementCap: ENFORCEMENT_CAP };
}

module.exports = {
  trackedAnthropicCall,
  getDailyCostSummary,
};
