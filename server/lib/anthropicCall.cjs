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

  const t0 = Date.now();
  const response = await client.messages.create(params);
  const latencyMs = Date.now() - t0;

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
      }
      // Latency tracking — per-scope rolling sum + call count. Lets us
      // measure mean latency per scope and watch the cache-hit-rate
      // proxy (cache_read_input_tokens vs total input_tokens).
      await incrementDailyCounter(userId, `latency_ms:${scope}`, { increment: latencyMs });
      await incrementDailyCounter(userId, `calls:${scope}`, { increment: 1 });
      // Cache observability — cache_read_input_tokens is non-zero when
      // the prefix hit the Anthropic prompt cache. Sum the read + create
      // counts so we can compute hit rate downstream.
      const cacheRead = Number(usage?.cache_read_input_tokens || 0);
      const cacheCreate = Number(usage?.cache_creation_input_tokens || 0);
      if (cacheRead > 0) {
        await incrementDailyCounter(userId, `cache_read:${scope}`, { increment: cacheRead });
      }
      if (cacheCreate > 0) {
        await incrementDailyCounter(userId, `cache_create:${scope}`, { increment: cacheCreate });
      }
      logger.debug?.('anthropic.call.tracked', {
        userId, scope,
        latency_ms: latencyMs,
        input_tokens: usage?.input_tokens || 0,
        output_tokens: usage?.output_tokens || 0,
        cache_read_tokens: cacheRead,
        cache_create_tokens: cacheCreate,
        model: response?.model,
      });
    }
  } catch (err) {
    logger.warn('anthropic.call.trackFailed', { userId, scope, error: err.message });
  }

  return response;
}

/**
 * Read-only daily cost summary for a user. Returns global + per-scope
 * token counters PLUS per-scope latency stats and cache hit rate so
 * we can see whether the prompt-caching work is actually landing.
 */
async function getDailyCostSummary(userId) {
  if (!userId) return { totalTokens: 0, byScope: {} };
  const scopes = ['memory_extractor', 'agentic_loop', 'classification', 'food_estimate', 'food_insights', 'contact_facts', 'journal', 'outcome', 'research_agent', 'unscoped'];
  const total = await getDailyCount(userId, 'tokens');
  const byScope = {};
  for (const s of scopes) {
    const tokens = await getDailyCount(userId, `tokens:${s}`);
    if (tokens === 0) continue;
    const calls = await getDailyCount(userId, `calls:${s}`);
    const latencyTotalMs = await getDailyCount(userId, `latency_ms:${s}`);
    const cacheRead = await getDailyCount(userId, `cache_read:${s}`);
    const cacheCreate = await getDailyCount(userId, `cache_create:${s}`);
    byScope[s] = {
      tokens,
      calls,
      avg_latency_ms: calls > 0 ? Math.round(latencyTotalMs / calls) : 0,
      cache_read_tokens: cacheRead,
      cache_create_tokens: cacheCreate,
      // Hit rate proxy: cache_read / (cache_read + uncached input). Not
      // perfect (we don't store non-cached input separately) but enough
      // to see whether caching is firing at all.
      cache_hit_signal: cacheRead > 0 ? `${cacheRead} tokens served from cache` : 'no cache hits',
    };
  }
  return { totalTokens: total, byScope, enforcementCap: ENFORCEMENT_CAP };
}

/**
 * Streaming variant. Uses client.messages.stream() so the caller can
 * forward text_delta events live (SSE → client → incremental render).
 * After the stream completes, returns the assembled final message in
 * the same shape as trackedAnthropicCall — so callers downstream of
 * the await (tool_use block extraction, etc.) work unchanged.
 *
 * @param {object} client — Anthropic SDK instance.
 * @param {object} params — messages.stream params (model, system, tools, messages, ...).
 * @param {object} [opts]
 * @param {string} [opts.userId]
 * @param {string} [opts.scope]
 * @param {(text: string) => void} [opts.onTextDelta] — fires per
 *   text chunk as the model produces tokens. Use this to forward
 *   incremental text to the user (SSE text_delta event).
 * @returns {Promise<object>} The assembled final message.
 */
async function trackedAnthropicStream(client, params, opts = {}) {
  const { userId = 'anon', scope = 'unscoped', onTextDelta } = opts;

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

  const t0 = Date.now();
  const stream = client.messages.stream(params);

  // Iterate stream events. Text deltas are the user-facing payload;
  // everything else is for the final assembled message which we get
  // from finalMessage() once the stream closes.
  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta'
          && event.delta?.type === 'text_delta'
          && typeof onTextDelta === 'function') {
        try { onTextDelta(event.delta.text || ''); } catch { /* never let handler crash the stream */ }
      }
    }
  } catch (err) {
    logger.error('anthropic.stream.failed', { userId, scope, error: err.message });
    throw err;
  }

  const response = await stream.finalMessage();
  const latencyMs = Date.now() - t0;

  // Same accounting as the non-streaming path.
  try {
    const usage = response?.usage;
    if (usage) {
      const total = (usage.input_tokens || 0) + (usage.output_tokens || 0);
      if (total > 0) {
        await incrementDailyCounter(userId, 'tokens', { increment: total });
        await incrementDailyCounter(userId, `tokens:${scope}`, { increment: total });
      }
      await incrementDailyCounter(userId, `latency_ms:${scope}`, { increment: latencyMs });
      await incrementDailyCounter(userId, `calls:${scope}`, { increment: 1 });
      const cacheRead = Number(usage?.cache_read_input_tokens || 0);
      const cacheCreate = Number(usage?.cache_creation_input_tokens || 0);
      if (cacheRead > 0)   await incrementDailyCounter(userId, `cache_read:${scope}`,   { increment: cacheRead });
      if (cacheCreate > 0) await incrementDailyCounter(userId, `cache_create:${scope}`, { increment: cacheCreate });
      logger.debug?.('anthropic.stream.tracked', {
        userId, scope,
        latency_ms: latencyMs,
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_tokens: cacheRead,
        cache_create_tokens: cacheCreate,
        model: response?.model,
      });
    }
  } catch (err) {
    logger.warn('anthropic.stream.trackFailed', { userId, scope, error: err.message });
  }

  return response;
}

module.exports = {
  trackedAnthropicCall,
  trackedAnthropicStream,
  getDailyCostSummary,
};
