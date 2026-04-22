'use strict';

/**
 * server/lib/ruleDecay.cjs — nightly decay job for behavior_rules.
 *
 * Decay formula (executed in SQL by db.decayRules):
 *   strength = strength * (0.95 ^ days_since_last_reinforced)
 *
 * Once decay is applied, db.archiveWeakRules flips is_active=FALSE on
 * rows below the 0.1 floor — they stop appearing in the system prompt
 * but the row stays for audit history.
 *
 * Cron schedule: 0 3 * * * (3am every day, fixed UTC). Per-user decay
 * is independent so this can iterate sequentially without coordination.
 *
 * HARD CONTRACT:
 *   • Never throws. Per-user failures are isolated and logged.
 *   • Returns aggregate stats { users, decayed, archived } for cron
 *     observability.
 */

const db = require('../../db.cjs');
const logger = require('../../guardrails/logger.cjs');
const { invalidateRulesCache } = require('./ruleCache.cjs');

async function processRuleDecay() {
  let users = 0;
  let decayed = 0;
  let archived = 0;
  try {
    // Two whole-table UPDATEs replace the per-user loop. The decay
    // formula is per-row in SQL, so there's no semantic difference
    // between iterating users and updating the table directly — but at
    // 1k users this saves ~2000 round-trips at 3am.
    decayed = await db.decayAllRules();
    archived = await db.archiveAllWeakRules();

    // Cache invalidation still iterates users (Redis-side, no DB load).
    // Could be optimised further with SCAN+DEL by prefix; not worth
    // changing today.
    const ids = await db.getAllUserIds();
    users = ids.length;
    for (const userId of ids) {
      await invalidateRulesCache(userId).catch(() => {});
    }
    // Decay inferred classification rules with the same formula
    try {
      const clsDecay = await db.decayInferredClassificationRules();
      logger.info('ruleDecay.classificationRules', clsDecay);
    } catch (clsErr) {
      logger.warn('ruleDecay.classificationRules.failed', { error: clsErr.message });
    }

    logger.info('ruleDecay.complete', { users, decayed, archived });
  } catch (err) {
    logger.error('ruleDecay.failed', { error: err.message });
  }
  return { users, decayed, archived };
}

module.exports = { processRuleDecay };
