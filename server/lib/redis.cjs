'use strict';

/**
 * server/lib/redis.cjs — lazy-singleton Redis client + fail-soft helpers.
 *
 * Every operation degrades gracefully when REDIS_URL is unset or the
 * connection fails. Callers must treat `null` from rediGet as a cache
 * miss (not an error) and treat a no-op from rediSet/rediDel as
 * acceptable — cache is best-effort, never authoritative.
 */

let redis;
try {
  // eslint-disable-next-line global-require
  redis = require('redis');
} catch {
  redis = null;
}

let client = null;
let connecting = null; // guards against concurrent getRedisClient() calls

async function getRedisClient() {
  if (client) return client;
  if (!redis) {
    console.warn('[redis] node-redis not installed — skipping');
    return null;
  }
  if (!process.env.REDIS_URL) {
    // Log once per process; noisy to log every call.
    if (!connecting) console.warn('[redis] REDIS_URL not set — skipping Redis');
    return null;
  }
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const c = redis.createClient({ url: process.env.REDIS_URL });
      c.on('error', (err) => console.error('[redis] error:', err.message));
      await c.connect();
      console.log('[redis] connected');
      client = c;
      return c;
    } catch (e) {
      console.error('[redis] connection failed:', e.message);
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
  } catch {
    return null;
  }
}

async function rediSet(key, value, ttlSeconds) {
  const c = await getRedisClient();
  if (!c) return;
  try {
    await c.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch { /* silent — cache miss is acceptable */ }
}

async function rediDel(key) {
  const c = await getRedisClient();
  if (!c) return;
  try { await c.del(key); } catch { /* silent */ }
}

module.exports = { getRedisClient, rediGet, rediSet, rediDel };
