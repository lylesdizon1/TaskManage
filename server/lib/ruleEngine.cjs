'use strict';

/**
 * server/lib/ruleEngine.cjs — Phase 2 behavioral pattern inference.
 *
 * inferRulesFromBehavior(userId, actionType, context, outcome) is called
 * fire-and-forget from hot paths after a successful user action. The
 * function:
 *   1. Redis-debounces per (userId, actionType) at 6h TTL so we don't
 *      replay pattern detection on every event.
 *   2. Runs the relevant detector functions for the action type. Each
 *      detector reads recent activity from Postgres and returns 0+
 *      candidate rules.
 *   3. upsertInferredRule for each candidate (bumps signal_count if the
 *      same pattern already exists; never inserts duplicates).
 *   4. Invalidates the rule cache so the next chat turn sees fresh rules.
 *
 * HARD CONTRACTS:
 *   • Never throws. Caller invokes as fire-and-forget.
 *   • NEVER infers constraints — only 'preference' or 'pattern' rule types.
 *   • Requires 3+ signals before inferring a new rule.
 *   • Total wallclock target: <50ms per call (debounce short-circuits
 *     most invocations to ~1ms).
 */

const db = require('../../db.cjs');
const logger = require('../../guardrails/logger.cjs');
const { rediGet, rediSet } = require('./redis.cjs');
const { invalidateRulesCache } = require('./ruleCache.cjs');

const DEBOUNCE_TTL_SEC = 6 * 3600; // 6h per (userId, actionType)
const MIN_SIGNALS = 3;
const MAX_INFERRED_PER_USER = 100;

// Hour-of-day buckets for time-preference detection.
function bucketForHour(h) {
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  return 'night';
}

/**
 * Detector 1: time_preference.
 * Look at the user's last 10 task creations. If 3+ cluster in the same
 * hour bucket (morning/afternoon/evening/night) AND that bucket dominates
 * (>= 60% of recent creations), infer a "prefers <bucket> tasks" rule.
 *
 * Reads tasks.created_at directly — no schema additions needed.
 */
async function detectTimePreference(userId, tz) {
  const out = [];
  try {
    const { rows } = await db.pool.query(
      `SELECT created_at FROM tasks
        WHERE owner = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [userId],
    );
    if (rows.length < MIN_SIGNALS) return out;

    const counts = { morning: 0, afternoon: 0, evening: 0, night: 0 };
    for (const r of rows) {
      try {
        const localHour = parseInt(new Intl.DateTimeFormat('en-US', {
          timeZone: tz || 'America/Los_Angeles', hour: 'numeric', hour12: false,
        }).format(new Date(r.created_at)), 10);
        if (Number.isFinite(localHour)) counts[bucketForHour(localHour)]++;
      } catch { /* skip un-parseable rows */ }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total < MIN_SIGNALS) return out;
    const [topBucket, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (topCount >= MIN_SIGNALS && (topCount / total) >= 0.6) {
      out.push({
        ruleType: 'preference',
        patternType: 'time_preference',
        category: 'tasks',
        ruleText: `Prefers creating tasks in the ${topBucket}`,
        contextData: { bucket: topBucket, sampleSize: total, matchCount: topCount },
        initialStrength: 0.5,
      });
    }
  } catch (err) {
    logger.warn('ruleEngine.detectTimePreference.failed', { userId, error: err.message });
  }
  return out;
}

/**
 * Detector 2: entity_affinity.
 * For each entity tag the user touches frequently, count creates vs
 * deletes over the last 60 days. An entity with 5+ creates AND zero
 * deletes signals "user is careful with X" → infer a soft preference.
 */
async function detectEntityAffinity(userId) {
  const out = [];
  try {
    // Pull entity tag occurrences across created/deleted tasks.
    const { rows } = await db.pool.query(
      `SELECT tag,
              COUNT(*) FILTER (WHERE NOT completed_at IS NOT NULL OR completed_at IS NULL) AS created_ct,
              COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS completed_ct
         FROM (
           SELECT jsonb_array_elements_text(tags) AS tag, completed_at
             FROM tasks
            WHERE owner = $1
              AND created_at > NOW() - INTERVAL '60 days'
         ) t
        GROUP BY tag
        HAVING COUNT(*) >= 5`,
      [userId],
    );
    for (const r of rows) {
      const created = Number(r.created_ct) || 0;
      const completed = Number(r.completed_ct) || 0;
      if (created >= 5 && completed === 0) {
        // 5+ tasks, none ever completed → user is sitting on this entity's items
        out.push({
          ruleType: 'preference',
          patternType: 'entity_affinity',
          category: 'tasks',
          ruleText: `Tends to keep tasks tagged "${r.tag}" open without completing them`,
          contextData: { entityTag: r.tag, created, completed },
          initialStrength: 0.5,
        });
      }
    }
  } catch (err) {
    logger.warn('ruleEngine.detectEntityAffinity.failed', { userId, error: err.message });
  }
  return out;
}

// Stub: workflow_pattern requires an action-sequence log we don't keep
// today. Implementation deferred — see follow-up note in commit body.
async function detectWorkflowPattern(_userId) { return []; }

// Stub: frequency_pattern requires email-action timestamps that aren't
// currently logged at row level. Deferred.
async function detectFrequencyPattern(_userId) { return []; }

const DETECTOR_REGISTRY = {
  task_created:   ['detectTimePreference', 'detectEntityAffinity'],
  task_completed: ['detectTimePreference', 'detectEntityAffinity', 'detectWorkflowPattern'],
  email_moved:    ['detectFrequencyPattern'],
  email_archived: ['detectFrequencyPattern'],
};
const DETECTOR_FNS = {
  detectTimePreference,
  detectEntityAffinity,
  detectWorkflowPattern,
  detectFrequencyPattern,
};

/**
 * Entry point — fire-and-forget from hot paths.
 *
 * @param {string} userId
 * @param {string} actionType - e.g. 'task_completed', 'email_moved'
 * @param {Object} [context] - optional event-specific context (currently unused
 *   by detectors but available for future detectors that need the trigger row)
 * @param {string} [outcome] - 'success' | 'error' (we only learn from successes)
 */
async function inferRulesFromBehavior(userId, actionType, context = {}, outcome = 'success') {
  try {
    if (!userId || !actionType) return;
    if (outcome !== 'success') return;
    const detectors = DETECTOR_REGISTRY[actionType];
    if (!detectors || !detectors.length) return;

    // Per-(user, actionType) debounce — short-circuits the common case.
    const debounceKey = `rule-infer:${userId}:${actionType}`;
    try { if (await rediGet(debounceKey)) return; }
    catch { /* fail-soft: run anyway */ }

    // Soft cap on inferred rules per user — protect against runaway state.
    try {
      const { rows } = await db.pool.query(
        `SELECT COUNT(*)::int AS n FROM behavior_rules
          WHERE user_id = $1 AND source = 'inferred' AND is_active = TRUE`,
        [userId],
      );
      if ((rows[0]?.n || 0) >= MAX_INFERRED_PER_USER) {
        logger.warn('ruleEngine.maxInferredReached', { userId, count: rows[0].n });
        try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}
        return;
      }
    } catch { /* count failure shouldn't block inference */ }

    // Resolve user timezone for time-bucket detectors.
    let tz = 'America/Los_Angeles';
    try {
      const ctx = await db.getUserAuthContext?.(userId);
      if (ctx?.timezone) tz = ctx.timezone;
    } catch { /* default tz is fine */ }

    // Run detectors in parallel, collect candidates.
    const results = await Promise.allSettled(
      detectors.map((name) => DETECTOR_FNS[name](userId, tz, context))
    );
    const candidates = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) candidates.push(...r.value);
    }
    if (!candidates.length) {
      try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}
      return;
    }

    // Persist (or reinforce) each candidate. upsertInferredRule handles
    // dedup via (user_id, pattern_type, rule_text).
    let touched = 0;
    for (const c of candidates) {
      try {
        const r = await db.upsertInferredRule(userId, c);
        if (r) touched++;
      } catch (err) {
        logger.warn('ruleEngine.upsert.failed', { userId, patternType: c.patternType, error: err.message });
      }
    }
    if (touched) await invalidateRulesCache(userId);

    try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}
    logger.info('ruleEngine.inferred', { userId, actionType, touched });
  } catch (err) {
    logger.error('ruleEngine.failed', { userId, actionType, error: err.message });
  }
}

module.exports = {
  inferRulesFromBehavior,
  // exported for test/debug
  detectTimePreference,
  detectEntityAffinity,
};
