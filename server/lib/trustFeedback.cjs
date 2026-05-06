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
const { proposeRichPredicate } = require('./ruleProposalLlm.cjs');

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
  // hit the threshold for proposing a behavior_rule. We only propose
  // ONCE per (user, action_type) pattern — markCorrectionsProcessed
  // stamps the contributing correction_events so subsequent counts
  // return 0 until the user corrects in a different way.
  let ruleProposed = null;
  if (outcome === 'rejected' || outcome === 'corrected') {
    try {
      ruleProposed = await maybeProposeCorrectionRule({
        userId, actionType, decisionId, contextSummary,
      });
    } catch (err) {
      // Proposal-creation failure shouldn't roll back the trust update;
      // the next correction will retry the threshold check.
      logger.warn('trustFeedback.proposalGen.failed', {
        userId, actionType, error: err.message,
      });
    }
  }

  logger.info('trustFeedback.applied', {
    userId, decisionId, outcome, actionType,
    trustScore: result.trustRow?.trustScore,
    ruleProposed: ruleProposed || undefined,
  });

  return { ok: true, trust: result.trustRow, ruleProposed };
}

/**
 * If the user has rejected this action_type CORRECTION_THRESHOLD+ times
 * without a generated rule yet, propose a behavior_rule from the
 * pattern. Returns { proposalId, alreadyProposed } or null.
 *
 * Phase 2 capability — rule-proposal flow. Previously this materialized
 * the rule directly into behavior_rules with strength=0.3. Now it goes
 * through rule_proposals (pending) so the user reviews via admin
 * endpoint or future Aria tool before the rule becomes active. The
 * proposal carries a structured `predicate` with tool_names: [actionType]
 * + preference_type=ask_first so when accepted it goes through Tier 2
 * (real friction) rather than the prompt-text-only Tier (the prior
 * strength=0.3 path).
 *
 * Idempotency: the prior implementation called markCorrectionsProcessed
 * after writing the rule so subsequent rejections didn't duplicate. We
 * preserve that contract — proposals stamp the correction_events the
 * same way. A subsequent rejection in the same pattern starts a fresh
 * proposal counter.
 */
async function maybeProposeCorrectionRule({ userId, actionType, decisionId, contextSummary }) {
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

  // Try to enrich the predicate via Haiku — examines the actual rejected
  // tool_inputs and proposes a SHARED-PATTERN predicate (e.g. "you keep
  // rejecting send_email to stranger@x.com" → predicate matching that
  // recipient specifically) instead of the coarse "any call to this
  // tool" fallback. Failure-soft: any LLM error / parse error /
  // validation failure returns null, fall back to the simple shape.
  let predicate = { tool_names: [actionType] };
  let llmEnriched = false;
  let ruleTextSpecifics = null;
  try {
    const recentInputs = await db.getRecentRejectionInputs(userId, actionType, 5);
    if (recentInputs.length >= CORRECTION_THRESHOLD) {
      const llmPredicate = await proposeRichPredicate(actionType, recentInputs);
      if (llmPredicate) {
        predicate = llmPredicate;
        llmEnriched = true;
        // If Haiku produced an input tree, extract a short human-readable
        // summary for the rule_text — the user reviewing the proposal sees
        // exactly what shared pattern was detected.
        ruleTextSpecifics = _summarizePredicateInput(llmPredicate.input);
      }
    }
  } catch (err) {
    // Enrichment failure shouldn't block the proposal — fall through to
    // the simple predicate.
    logger.warn('trustFeedback.proposal.llmEnrich.failed', { userId, actionType, error: err.message });
  }

  const proposedRule = {
    ruleType: 'preference',
    ruleText: ruleTextSpecifics
      ? `You've rejected ${actionType} ${pending} times where ${ruleTextSpecifics}. Confirm before this pattern runs autonomously.`
      : `You've rejected ${actionType} ${pending} times in recent history. Confirm before this action runs autonomously.`,
    source: 'inferred',
    strength: 0.5,                         // mid-strength; lands in Tier 2 via ask_first
    category: _toolCategory(actionType),
    preferenceType: 'ask_first',
    predicate,
    triggerContext: actionType,
  };

  let proposalRow = null;
  try {
    proposalRow = await db.createRuleProposal(userId, {
      proposed_rule: proposedRule,
      reasoning: llmEnriched && ruleTextSpecifics
        ? `Trust loop detected ${pending} rejections of ${actionType} sharing a pattern: ${ruleTextSpecifics}.`
        : `Trust loop detected ${pending} rejections of ${actionType} without a rule covering it yet.`,
      source: llmEnriched ? 'correction_pattern_llm' : 'correction_pattern',
      trigger_data: {
        action_type: actionType,
        rejection_count: pending,
        latest_decision_id: decisionId || null,
        llm_enriched: llmEnriched,
      },
    });
  } catch (err) {
    logger.warn('trustFeedback.proposal.create.failed', { userId, actionType, error: err.message });
    return null;
  }
  if (!proposalRow?.id) return null;

  // Stamp all the contributing correction_events with the proposal id so
  // we don't re-propose on the next rejection in this same pattern.
  // markCorrectionsProcessed expects an INT (behavior_rule.id) historically,
  // but works fine with the proposal id since the column is just an audit
  // pointer — accepts any non-null value.
  await db.markCorrectionsProcessed(userId, actionType, proposalRow.id).catch(() => {});

  logger.info('trustFeedback.proposal.created', {
    userId, actionType, proposalId: proposalRow.id, fromCorrections: pending,
  });
  return proposalRow.id;
}

// Render the leaves of a predicate input tree into a short English
// description for embedding in the proposed rule's rule_text. Best-
// effort — depth-first, comma-separated, capped at 120 chars. Used so
// the user reviewing a proposal in admin / chat can see WHY this rule
// is being suggested without having to read the JSON predicate.
function _summarizePredicateInput(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 4) return null;
  if (Array.isArray(node.and)) {
    const parts = node.and.map((c) => _summarizePredicateInput(c, depth + 1)).filter(Boolean);
    return parts.length ? parts.join(' AND ') : null;
  }
  if (Array.isArray(node.or)) {
    const parts = node.or.map((c) => _summarizePredicateInput(c, depth + 1)).filter(Boolean);
    return parts.length ? `(${parts.join(' OR ')})` : null;
  }
  if (node.not) {
    const inner = _summarizePredicateInput(node.not, depth + 1);
    return inner ? `NOT ${inner}` : null;
  }
  if (typeof node.field === 'string' && typeof node.op === 'string') {
    const v = JSON.stringify(node.value);
    const summary = `${node.field} ${node.op} ${v}`;
    return summary.length > 120 ? summary.slice(0, 117) + '...' : summary;
  }
  return null;
}

// Map action_type → preference category for the proposed rule's category
// field. Best-effort mapping; falls back to 'general' for unknown tools.
const _ACTION_TO_CATEGORY = {
  delete_task: 'tasks', complete_task: 'tasks', create_task: 'tasks', update_task: 'tasks',
  close_task_with_note: 'tasks',
  create_event: 'calendar', update_event: 'calendar', delete_event: 'calendar',
  add_event_outcome_note: 'calendar',
  archive_email: 'email', bulk_archive_emails: 'email',
  mark_email_read: 'email', move_email: 'email', star_email: 'email',
  send_email: 'communication', reply_email: 'communication',
  grant_shared_access: 'communication',
  create_contact: 'general', update_contact: 'general',
  create_note: 'general', update_note: 'general',
};
function _toolCategory(actionType) {
  return _ACTION_TO_CATEGORY[actionType] || 'general';
}

// Backward-compat alias — closeDecisionWithFeedback still calls this name.
const maybeGenerateCorrectionRule = maybeProposeCorrectionRule;

module.exports = {
  closeDecisionWithFeedback,
  CORRECTION_THRESHOLD,
};
