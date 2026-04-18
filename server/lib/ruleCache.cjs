'use strict';

/**
 * server/lib/ruleCache.cjs — Redis cache for combined rules + preferences.
 *
 * The decision engine and buildAgenticContext both need fast access to
 * the user's active rules on every chat turn. Hitting Postgres twice per
 * turn (explicit prefs + inferred rules) is fine in absolute terms but
 * adds up across the 16-fetch context build. This module caches the
 * combined shape behind a 5-minute TTL.
 *
 * Cache shape:
 *   {
 *     explicit: Array<Phase1-shape preference rows>,
 *     inferred: Array<Phase2-shape inferred rule rows>,
 *     lastUpdated: ISO timestamp
 *   }
 *
 * Invalidation: every write path that touches behavior_rules calls
 * invalidateRulesCache(userId). Cache holes degrade to a fresh DB read
 * — never returns stale rules; worst case is a 5-minute window where
 * a rule change isn't visible until refetch.
 */

const db = require('../../db.cjs');
const { rediGet, rediSet, rediDel } = require('./redis.cjs');

const CACHE_TTL_SEC = 5 * 60;
const cacheKey = (userId) => `rules:${userId}`;

/**
 * Read combined rules for a user, populating from DB on cache miss.
 * Returns { explicit, inferred, lastUpdated } in either path.
 */
async function getCachedRules(userId) {
  const key = cacheKey(userId);
  const cached = await rediGet(key);
  if (cached && Array.isArray(cached.explicit) && Array.isArray(cached.inferred)) {
    return cached;
  }

  // Cache miss — fetch both paths in parallel, populate, return.
  const [explicit, inferred] = await Promise.all([
    db.getUserPreferences ? db.getUserPreferences(userId) : Promise.resolve([]),
    db.getInferredRulesForUser ? db.getInferredRulesForUser(userId) : Promise.resolve([]),
  ]);
  const value = { explicit, inferred, lastUpdated: new Date().toISOString() };
  // Best-effort write — Redis down means future reads keep paying the
  // DB cost, which is fine.
  await rediSet(key, value, CACHE_TTL_SEC);
  return value;
}

/**
 * Drop the cached entry for a user. Called by every write path that
 * touches behavior_rules: set_preference, remove_preference,
 * inferRulesFromBehavior, decay/archive cron.
 */
async function invalidateRulesCache(userId) {
  if (!userId) return;
  await rediDel(cacheKey(userId));
}

module.exports = { getCachedRules, invalidateRulesCache };
