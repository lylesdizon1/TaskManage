'use strict';

/**
 * server/lib/trustFeedback.cjs — Phase 4 trust-score feedback loop.
 *
 * Single entry point closeDecisionWithFeedback() that callers (the chat
 * confirmation flow in ai.cjs and whatsapp.cjs) invoke instead of the
 * raw db.updateDecisionOutcome. It atomically:
 *   1. Flips decision_log.outcome.
 *   2. Bumps trust_scores counters + applies the Phase 4 deltas
 *      (+0.02 confirm, -0.05 reject, -0.10 correction).
 *   3. On 'rejected' AND ≥ THRESHOLD pending corrections for this
 *      action_type, materialises the pattern as a behavior_rule and
 *      marks the corrections processed (so the next reject doesn't
 *      generate a duplicate rule).
 *
 * HARD CONTRACT:
 *   - Never throws past the boundary. All failures log via the
 *     structured logger and return { ok: false }.
 *   - Idempotent on re-call within the same outcome — the underlying
 *     trust_score update would double-count, so callers MUST only
 *     invoke this once per decision (the pattern in ai.cjs/whatsapp.cjs
 *     already does this).
 */

const logger = require('../../guardrails/logger.cjs');
const db = require('../../db.cjs');
const { invalidateRulesCache } = require('./ruleCache.cjs');

const CORRECTION_THRESHOLD = 2; // 2+ corrections → auto-rule

/**
 * Apply trust feedback for a closed decision. Returns
 *   { ok: true, trust: { trustScore, ... }, ruleGenerated: id|null }
 * or { ok: false, reason } on a hard failure.
 */
async function closeDecisionWithFeedback({ userId, decisionId, outcome, actionType, contextSummary }) {
  if (!decisionId || !outcome) return { ok: false, reason: 'missing_args' };

  let result;
  try {
    result = await db.applyTrustFeedback(userId, decisionId, outcome, actionType);
  } catch (err) {
    logger.error('trustFeedback.apply.failed', {
      userId, decisionId, outcome, actionType, error: err.message,
    });
    return { ok: false, reason: err.message };
  }

  // For rejections (and explicit corrections), check if the user has
  // hit the threshold for materialising a behavior_rule. We only
  // generate ONCE per (user, action_type) pattern — markCorrectionsProcessed
  // flips generated_rule_id so subsequent counts return 0 until the user
  // corrects in a different way.
  let ruleGenerated = null;
  if (outcome === 'rejected' || outcome === 'corrected') {
    try {
      ruleGenerated = await maybeGenerateCorrectionRule({
        userId, actionType, decisionId, contextSummary,
      });
    } catch (err) {
      // Rule-generation failure shouldn't roll back the trust update;
      // the next correction will retry the threshold check.
      logger.warn('trustFeedback.ruleGen.failed', {
        userId, actionType, error: err.message,
      });
    }
  }

  logger.info('trustFeedback.applied', {
    userId, decisionId, outcome, actionType,
    trustScore: result.trustRow?.trustScore,
    ruleGenerated: ruleGenerated || undefined,
  });

  return { ok: true, trust: result.trustRow, ruleGenerated };
}

/**
 * If the user has rejected this action_type CORRECTION_THRESHOLD+ times
 * without a generated rule yet, materialise a behavior_rule from the
 * pattern. Returns the new rule id or null if no rule was created.
 *
 * Phase 4 minimum-viable shape: rule_text is "User rejected
 * {action_type} {N} times — confirm before retrying", strength=0.3,
 * source='inferred'. The next reject doesn't double-up because we
 * also mark corrections processed.
 */
async function maybeGenerateCorrectionRule({ userId, actionType, decisionId, contextSummary }) {
  if (!actionType) return null;

  // First log a correction_event for THIS rejection so the count
  // includes it. trust_score_adjusted=true since the trust delta
  // already moved in applyTrustFeedback above.
  await db.logCorrection(userId, {
    decisionLogId: decisionId,
    originalAction: actionType,
    correctionType: 'reject',
    correctionNote: contextSummary || null,
    trustScoreAdjusted: true,
  });

  const pending = await db.countPendingCorrections(userId, actionType);
  if (pending < CORRECTION_THRESHOLD) return null;

  // Materialise the pattern as a behavior_rule. Mid-strength (0.3) so it
  // surfaces in the system prompt but doesn't immediately hard-stop;
  // user can /strengthen via set_preference if they want it firmer.
  const ruleRow = await db.upsertBehaviorRule(userId, {
    ruleType: 'constraint',
    triggerContext: actionType,
    ruleText: `User has rejected ${actionType} ${pending} times in recent history — confirm before re-attempting.`,
    source: 'inferred',
    strength: 0.3,
  });
  if (!ruleRow?.id) return null;

  // Drop the rule cache so the next chat turn picks up the new constraint.
  await invalidateRulesCache(userId).catch(() => {});

  // Stamp all the contributing correction_events so we don't re-generate
  // on the next rejection.
  await db.markCorrectionsProcessed(userId, actionType, ruleRow.id).catch(() => {});

  logger.info('trustFeedback.rule.generated', {
    userId, actionType, ruleId: ruleRow.id, fromCorrections: pending,
  });
  return ruleRow.id;
}

module.exports = {
  closeDecisionWithFeedback,
  CORRECTION_THRESHOLD,
};
