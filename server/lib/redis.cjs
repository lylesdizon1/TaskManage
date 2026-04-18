'use strict';

/**
 * server/lib/redis.cjs — lazy-singleton Redis client + fail-soft helpers.
 *
 * Every operation degrades gracefully when REDIS_URL is unset or the
 * connection fails. Callers must treat `null` from rediGet as a cache
 * miss (not an error) and treat a no-op from rediSet/rediDel as
 * acceptable — cache is best-effort, never authoritative.
 *
 * Visibility: every operation failure emits a structured warn through
 * guardrails/logger so degraded-mode incidents are queryable in Railway
 * log search. Per-error-type log throttle (60s) prevents a Redis outage
 * from spamming logs every cron tick.
 *
 * Note: this is a CACHE primitive. Security controls that need
 * fail-closed semantics (OAuth state, dedup locks where DB is the
 * authority) layer their own behavior on top — see oauthState.cjs and
 * userRateLimit.cjs for examples.
 */

const logger = require('../../guardrails/logger.cjs');

let redis;
try {
  // eslint-disable-next-line global-require
  redis = require('redis');
} catch {
  redis = null;
}

let client = null;
let connecting = null; // guards against concurrent getRedisClient() calls

// Per-operation log throttle so an extended outage doesn't spam logs
// every cron tick. Re-emits at most once per 60s per operation kind.
const LOG_THROTTLE_MS = 60_000;
const _lastLog = new Map();
function shouldLog(key) {
  const now = Date.now();
  const last = _lastLog.get(key) || 0;
  if (now - last < LOG_THROTTLE_MS) return false;
  _lastLog.set(key, now);
  return true;
}

async function getRedisClient() {
  if (client) return client;
  if (!redis) {
    if (shouldLog('redis.unavailable.notInstalled')) {
      logger.warn('redis.unavailable', { reason: 'node-redis not installed' });
    }
    return null;
  }
  if (!process.env.REDIS_URL) {
    if (shouldLog('redis.unavailable.noUrl')) {
      logger.warn('redis.unavailable', { reason: 'REDIS_URL not set' });
    }
    return null;
  }
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const c = redis.createClient({ url: process.env.REDIS_URL });
      c.on('error', (err) => {
        if (shouldLog('redis.client.error')) {
          logger.warn('redis.client.error', { error: err.message });
        }
      });
      await c.connect();
      logger.info('redis.connected', {});
      _lastLog.clear(); // healthy again — let next failure log immediately
      client = c;
      return c;
    } catch (e) {
      if (shouldLog('redis.connect.failed')) {
        logger.warn('redis.connect.failed', { error: e.message });
      }
      client = null;
      return null;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

async function rediGet(key) {
  const c = await getRedisClient();
  if (!c) return null;
  try {
    const val = await c.get(key);
    return val ? JSON.parse(val) : null;
  } catch (err) {
    if (shouldLog('redis.get.failed')) {
      logger.warn('redis.operation.failed', { operation: 'get', error: err.message });
    }
    return null;
  }
}

async function rediSet(key, value, ttlSeconds) {
  const c = await getRedisClient();
  if (!c) return;
  try {
    await c.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch (err) {
    if (shouldLog('redis.set.failed')) {
      logger.warn('redis.operation.failed', { operation: 'set', error: err.message });
    }
  }
}

async function rediDel(key) {
  const c = await getRedisClient();
  if (!c) return;
  try { await c.del(key); }
  catch (err) {
    if (shouldLog('redis.del.failed')) {
      logger.warn('redis.operation.failed', { operation: 'del', error: err.message });
    }
  }
}

module.exports = { getRedisClient, rediGet, rediSet, rediDel };
