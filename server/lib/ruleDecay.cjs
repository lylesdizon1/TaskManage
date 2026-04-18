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
    const ids = await db.getAllUserIds();
    for (const userId of ids) {
      try {
        const dec = await db.decayRules(userId);
        const arc = await db.archiveWeakRules(userId);
        decayed += dec || 0;
        archived += arc || 0;
        users++;
        // Drop cache so the next chat turn picks up decayed strengths +
        // archived rows.
        if (dec || arc) {
          await invalidateRulesCache(userId).catch(() => {});
        }
      } catch (err) {
        logger.warn('ruleDecay.user.failed', { userId, error: err.message });
      }
    }
    logger.info('ruleDecay.complete', { users, decayed, archived });
  } catch (err) {
    logger.error('ruleDecay.failed', { error: err.message });
  }
  return { users, decayed, archived };
}

module.exports = { processRuleDecay };
