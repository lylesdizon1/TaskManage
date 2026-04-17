'use strict';

/**
 * server/middleware/userRateLimit.cjs — per-user, per-endpoint rate limiting
 * backed by Redis (INCR + EXPIRE + TTL).
 *
 * Use for endpoints whose cost is bounded by external quotas (Anthropic,
 * Gmail, Graph) or by server resources (image uploads). The general
 * express-rate-limit (rateLimit.cjs) is process-local; this one is
 * shared across instances and survives restarts.
 *
 * FAIL-OPEN by design: if Redis is unavailable, requests pass through.
 * The general apiLimiter (100/min in-memory) is the backstop. A Redis
 * outage taking down /api/chat/execute would be worse than briefly
 * relaxing per-user quotas.
 *
 * Usage:
 *   const limiter = userRateLimit({ key: 'chat-execute', limit: 50, windowSec: 3600 });
 *   router.post('/api/chat/execute', authenticateToken, limiter, handler);
 */

const { getRedisClient } = require('../lib/redis.cjs');
const logger = require('../../guardrails/logger.cjs');

function userRateLimit({ key, limit, windowSec }) {
  if (!key || !limit || !windowSec) {
    throw new Error('userRateLimit requires { key, limit, windowSec }');
  }

  return async function rateLimitMiddleware(req, res, next) {
    const userId = req.user?.id;
    if (!userId) return next(); // authenticateToken handles unauthenticated; nothing to rate-limit by

    const client = await getRedisClient();
    if (!client) return next(); // fail-open

    const redisKey = `rate:${userId}:${key}`;
    let current;
    try {
      current = await client.incr(redisKey);
      if (current === 1) await client.expire(redisKey, windowSec);
    } catch (err) {
      logger.error('rate-limit.redis.failed', { userId, key, error: err.message });
      return next(); // fail-open
    }

    if (current > limit) {
      let ttl = windowSec;
      try { ttl = await client.ttl(redisKey); } catch { /* fall back to windowSec */ }
      const retryAfter = Math.max(1, ttl);
      res.setHeader('Retry-After', String(retryAfter));
      logger.warn('rate-limit.exceeded', { userId, key, current, limit });
      return res.status(429).json({ error: 'Rate limit exceeded', retryAfter });
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - current)));
    next();
  };
}

module.exports = { userRateLimit };
