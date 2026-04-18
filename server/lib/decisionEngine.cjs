'use strict';

/**
 * server/lib/decisionEngine.cjs — Phase 3 deterministic action gate.
 *
 * evaluateAction(userId, toolName, toolInput, tz) is called from the
 * agenticLoop's gateToolExecution hook BEFORE every tool execution.
 * Returns a richer Phase 3 disposition (auto_proceed / hard_stop /
 * confirm_required / soft_confirm) with a human-readable reason and
 * a decision_log id for downstream outcome updates.
 *
 * COMPOSITION RULES (from the Phase 0 spec):
 *   • The engine can only INCREASE friction, never decrease it.
 *     - tool's requires_confirmation: true  → caller still confirms
 *     - tool in ALWAYS_CONFIRM              → caller still confirms
 *     - engine returns auto_proceed         → caller falls through to
 *       the existing confirmation gate, which has final say
 *   • Explicit constraints (rule_type='constraint' OR strength=1.0)
 *     are HARD STOPS. No trust score can override.
 *   • The engine NEVER reduces friction. If the tool has no rules
 *     against it AND trust_score >= 0.3, return auto_proceed.
 *
 * STORAGE NOTE — disposition vocabulary mismatch:
 *   The Phase 3 spec uses {auto_proceed, hard_stop, confirm_required,
 *   soft_confirm}. Phase 0's decision_log.disposition CHECK enforces
 *   {auto_allowed, confirm_required, suggest_only}. The engine returns
 *   the richer Phase 3 vocabulary in-memory; persistence translates:
 *     hard_stop      → 'suggest_only'   (action blocked, surfaced as suggestion)
 *     confirm_required → 'confirm_required'
 *     soft_confirm   → 'confirm_required'  (with [soft] conflict_level)
 *     auto_proceed   → 'auto_allowed'
 *
 * LATENCY BUDGET: ≤ 300ms total. Cache-warm path target: ~30ms.
 *
 * FAIL-CLOSED: any unhandled exception inside evaluateAction returns
 * { disposition: 'confirm_required', reason: 'Decision engine error;
 * falling back to confirmation' }. We bias toward more friction on
 * error per the Phase 3 spec.
 */

const db = require('../../db.cjs');
const logger = require('../../guardrails/logger.cjs');
const { getCachedRules } = require('./ruleCache.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');
const { getEmailContent, assessEmailContentRisk } = require('./emailContent.cjs');

// Email tools that benefit from content-aware risk assessment. Any tool
// here triggers a getEmailContent fetch (cached) before tier evaluation.
const CONTENT_AWARE_EMAIL_TOOLS = new Set(['archive_email', 'delete_email']);

// Phase 3 → Phase 0 disposition mapping for storage.
const PERSISTED_DISPOSITION = {
  hard_stop: 'suggest_only',
  confirm_required: 'confirm_required',
  soft_confirm: 'confirm_required',
  auto_proceed: 'auto_allowed',
};

// Tool name → action keywords used by conflictsWithAction. V1 keyword
// matching; V2 will use semantic embeddings. Keys are lowercase tool
// names; values are arrays of substrings to match against rule_text.
const TOOL_ACTION_KEYWORDS = {
  delete_task:        ['delete', 'remove', 'erase'],
  delete_event:       ['delete', 'remove', 'cancel'],
  complete_task:      ['complete', 'done', 'finish', 'mark done'],
  create_task:        ['create task', 'add task', 'new task'],
  update_task:        ['update', 'edit', 'change', 'modify'],
  create_event:       ['create event', 'schedule', 'meeting', 'add event', 'book'],
  update_event:       ['update event', 'reschedule', 'change event'],
  archive_email:      ['archive', 'archive email', 'remove from inbox'],
  bulk_archive_emails:['archive', 'bulk archive', 'remove from inbox'],
  mark_email_read:    ['mark read', 'read email'],
  move_email:         ['move email', 'file email', 'label email'],
  star_email:         ['star', 'flag email', 'favorite'],
  send_email:         ['send', 'send email', 'message', 'reply'],
  reply_email:        ['reply', 'respond'],
  create_note:        ['create note', 'add note', 'new note'],
  update_note:        ['update note', 'edit note'],
  create_journal_entry:    ['journal', 'wrap', 'reflect'],
  close_task_with_note:    ['close task', 'complete with note'],
  add_event_outcome_note:  ['outcome', 'meeting note'],
  create_contact:     ['add contact', 'create contact'],
  update_contact:     ['update contact', 'edit contact'],
  grant_shared_access:['grant access', 'share with', 'invite'],
  create_project:     ['create project', 'new project'],
};

// Tool name → category match (used by ASK_FIRST polarity check, which
// fires for any tool in a category the user has flagged ask_first on).
const TOOL_CATEGORY = {
  delete_task: 'tasks', complete_task: 'tasks', create_task: 'tasks',
  update_task: 'tasks', close_task_with_note: 'tasks',
  create_event: 'calendar', update_event: 'calendar', delete_event: 'calendar',
  add_event_outcome_note: 'calendar',
  archive_email: 'email', bulk_archive_emails: 'email',
  mark_email_read: 'email', move_email: 'email', star_email: 'email',
  send_email: 'communication', reply_email: 'communication',
  grant_shared_access: 'communication',
  create_contact: 'general', update_contact: 'general',
  create_note: 'general', update_note: 'general',
  create_journal_entry: 'general', create_project: 'general',
};

/**
 * Single-word keywords match by prefix against any word in the rule text
 * — so "change" matches "changing", "delete" matches "deleting/deleted".
 * Multi-word keywords ("create task") match by substring of the full
 * lowered text. Erring toward MORE matches is intentional — false
 * positives mean extra friction (good); false negatives mean the user's
 * stated preference is silently bypassed (bad).
 */
function _matchesKeywords(text, keywords) {
  if (!text || !Array.isArray(keywords) || !keywords.length) return false;
  const lower = text.toLowerCase();
  const words = lower.split(/[\s,.;:!?()'"-]+/).filter(Boolean);
  return keywords.some((k) => {
    const lk = k.toLowerCase();
    if (lk.includes(' ')) return lower.includes(lk);
    // English gerund / past tense drops the silent trailing 'e'
    // ("change" → "changing", "delete" → "deleting"). Try the
    // e-stripped prefix as a fallback so we don't miss those.
    const stripped = lk.endsWith('e') ? lk.slice(0, -1) : null;
    return words.some((w) => w.startsWith(lk) || (stripped && w.startsWith(stripped)));
  });
}

/**
 * Does this rule conflict with the proposed action?
 * V1 — keyword matching against rule_text. Returns true/false.
 *
 * The conflict semantics depend on preference_type:
 *  - 'never' / 'avoid': matches if action keyword found in rule
 *  - 'ask_first': matches if action category matches the rule's category
 *  - 'always' / 'prefer': don't trigger conflicts here (positive directives)
 */
function conflictsWithAction(rule, toolName) {
  const ptype = rule.preferenceType || rule.preference_type;
  const ruleCat = rule.category;
  const toolCat = TOOL_CATEGORY[toolName];
  const text = rule.description || rule.ruleText || '';
  const kws = TOOL_ACTION_KEYWORDS[toolName] || [];

  // ask_first triggers on any tool in the same category.
  if (ptype === 'ask_first') {
    if (ruleCat && toolCat && ruleCat === toolCat) return true;
    return _matchesKeywords(text, kws);
  }
  // never / avoid → action must be the kind being warned against.
  if (ptype === 'never' || ptype === 'avoid') {
    return _matchesKeywords(text, kws);
  }
  // always / prefer → positive directives. Don't gate on these.
  if (ptype === 'always' || ptype === 'prefer') return false;

  // Fallback: keyword match for inferred rules / legacy rows without
  // preference_type set.
  return _matchesKeywords(text, kws);
}

const IMPACT_RISK = { low: 0.2, medium: 0.5, high: 0.9 };

/**
 * Main entry point — evaluate one proposed tool execution.
 *
 * @param {string} userId
 * @param {string} toolName
 * @param {Object} toolInput
 * @param {string} [tz]  Caller's user timezone (currently unused; reserved
 *   for time-window detectors like "no meetings before 9am" in V2).
 * @returns {Promise<{
 *   disposition: 'auto_proceed'|'confirm_required'|'soft_confirm'|'hard_stop',
 *   reason: string,
 *   decision_id: number|null,
 *   latency_ms: number,
 *   conflict_level: 'absolute'|'strong'|'medium'|'inferred'|null,
 *   conflicted_rules: Array,
 * }>}
 */
async function evaluateAction(userId, toolName, toolInput, tz = DEFAULT_TIMEZONE) {
  const t0 = Date.now();
  // Defensive defaults — every code path must populate these before logging.
  let disposition = 'auto_proceed';
  let reason = '';
  let conflictLevel = null;
  let conflictedRules = [];
  let trust = null;
  let confidenceScore = null;
  let riskScore = null;

  try {
    // Pull rules + trust in parallel. getCachedRules hits Redis first.
    const [bundle, ts] = await Promise.all([
      getCachedRules(userId).catch(() => ({ explicit: [], inferred: [] })),
      db.getTrustScore(userId, toolName).catch(() => null),
    ]);
    trust = ts;
    const explicit = (bundle?.explicit || []).filter((p) => p.isActive !== false && p.preferenceType);
    const inferred = (bundle?.inferred || []).filter((r) => r.isActive !== false);

    // ── Tier 0 (Phase 3.1) — content-aware override for email actions.
    // Fetch the message body (Redis cached, 5-min TTL). Confirmation
    // codes / OTP magic links → hard_stop because archiving them can
    // lock the user out. Financial content → bumps risk + escalates
    // to soft_confirm if the action would otherwise auto-proceed.
    let contentFlags = null;
    if (CONTENT_AWARE_EMAIL_TOOLS.has(toolName) && toolInput?.message_id && toolInput?.account_email) {
      try {
        const content = await getEmailContent(userId, toolInput.message_id, toolInput.account_email, db);
        contentFlags = assessEmailContentRisk(content);
        if (contentFlags.hasConfirmationCode) {
          disposition = 'hard_stop';
          conflictLevel = 'content_otp';
          conflictedRules = [];
          reason = `This email looks like a verification or confirmation code. Archiving it could lock you out of an account — handle it manually if you're sure.`;
        }
      } catch (err) {
        // Content fetch failures are non-fatal — fall through to baseline tiers.
        logger.warn('decisionEngine.contentCheck.failed', { userId, toolName, error: err.message });
      }
    }

    // Tier 1 — explicit hard constraints. Both 'never' polarity and
    // strength=5 with non-ask_first polarity qualify as ABSOLUTE.
    // ask_first is excluded here even if strength=5 — it goes to tier 2
    // because the user wants to be ASKED, not blocked. Phase 1's
    // _deriveRuleType marks both 'never' and 'ask_first' as
    // rule_type='constraint' for storage, so we filter on preferenceType
    // explicitly here.
    const hardConstraints = explicit.filter((p) => {
      if (p.preferenceType === 'ask_first') return false;
      const isHard = p.ruleType === 'constraint' || p.preferenceType === 'never' || p.strength === 5;
      return isHard && conflictsWithAction(p, toolName);
    });
    if (hardConstraints.length) {
      disposition = 'hard_stop';
      conflictLevel = 'absolute';
      conflictedRules = hardConstraints;
      reason = `This conflicts with your rule: "${hardConstraints[0].description}"`;
    }

    // Tier 2 — ask_first preferences AND strong explicit preferences (strength=4).
    // ask_first triggers regardless of strength; the user has explicitly
    // asked us to confirm before this category of action.
    if (disposition === 'auto_proceed') {
      const askFirst = explicit.filter((p) => p.preferenceType === 'ask_first' && conflictsWithAction(p, toolName));
      const strongPrefs = explicit.filter((p) => p.strength === 4 && p.preferenceType !== 'ask_first' && conflictsWithAction(p, toolName));
      const t2 = [...askFirst, ...strongPrefs];
      if (t2.length) {
        disposition = 'confirm_required';
        conflictLevel = askFirst.length ? 'ask_first' : 'strong';
        conflictedRules = t2;
        const r = t2[0];
        reason = askFirst.length
          ? `You asked me to check first: "${r.description}". Confirm to proceed?`
          : `This conflicts with your preference: "${r.description}". Should I proceed?`;
      }
    }

    // Tier 3 — medium explicit preferences (strength === 3).
    if (disposition === 'auto_proceed') {
      const medPrefs = explicit.filter((p) => p.strength === 3 && conflictsWithAction(p, toolName));
      if (medPrefs.length) {
        disposition = 'soft_confirm';
        conflictLevel = 'medium';
        conflictedRules = medPrefs;
        reason = `Heads up — you've noted: "${medPrefs[0].description}". Want me to proceed anyway?`;
      }
    }

    // Tier 4 — strong inferred patterns (strength >= 0.7).
    if (disposition === 'auto_proceed') {
      const strongInferred = inferred.filter((r) => r.strength >= 0.7 && conflictsWithAction(r, toolName));
      if (strongInferred.length) {
        disposition = 'soft_confirm';
        conflictLevel = 'inferred';
        conflictedRules = strongInferred;
        const r = strongInferred[0];
        reason = `I notice ${r.ruleText.toLowerCase()} (observed pattern). Should I proceed?`;
      }
    }

    // Tier 5 — trust score floor. Even with no rule conflicts, if the
    // user has corrected this action recently, trust can fall below 0.3
    // and we surface friction.
    if (disposition === 'auto_proceed' && trust && Number(trust.trustScore) < 0.3) {
      disposition = 'confirm_required';
      conflictLevel = 'low_trust';
      reason = `I want to confirm before ${toolName.replace(/_/g, ' ')} — your trust score for this action is low.`;
    }

    // Compute confidence + risk scores for the audit row.
    if (trust) {
      confidenceScore = Number(trust.trustScore) * (1 - conflictedRules.length * 0.2);
      const impactRisk = IMPACT_RISK[trust.impactLevel] ?? 0.5;
      riskScore = trust.isReversible ? impactRisk * 0.5 : impactRisk;
    }

    // Phase 3.1 — financial content bumps risk +0.3 AND escalates an
    // otherwise-auto_proceed disposition to soft_confirm. Doesn't
    // override hard_stop or higher-tier confirms (engine only adds
    // friction). Logged as conflict_level='content_financial' for
    // queryability.
    if (contentFlags?.hasFinancialData) {
      riskScore = (riskScore || 0) + 0.3;
      if (disposition === 'auto_proceed') {
        disposition = 'soft_confirm';
        conflictLevel = 'content_financial';
        reason = `This email looks financial (amounts, account numbers, billing). Want me to proceed with ${toolName.replace(/_/g, ' ')}?`;
      }
    }
  } catch (err) {
    // Fail-closed: bias to confirm_required on engine error.
    logger.error('decisionEngine.failed', { userId, toolName, error: err.message, stack: err.stack });
    disposition = 'confirm_required';
    conflictLevel = 'engine_error';
    reason = 'Decision engine error; falling back to confirmation.';
  }

  const latencyMs = Date.now() - t0;

  // Audit row — use the Phase 0 disposition vocabulary for storage.
  let decisionId = null;
  try {
    const row = await db.logDecision(userId, {
      actionType: toolName,
      toolCalled: toolName,
      toolInput,
      confidenceScore,
      riskScore,
      disposition: PERSISTED_DISPOSITION[disposition] || 'confirm_required',
      ruleIdsApplied: conflictedRules.map((r) => r.id).filter(Boolean),
      conflictDetected: conflictedRules.length > 0,
      conflictResolution: reason || null,
      contextSummary: `tool=${toolName} disposition=${disposition} conflicts=${conflictedRules.length}`,
      latencyMs,
      conflictLevel,
    });
    decisionId = row?.id || null;
  } catch (err) {
    logger.warn('decisionEngine.log.failed', { userId, toolName, error: err.message });
  }

  // Latency observability — log when we miss the budget.
  if (latencyMs > 300) {
    logger.warn('decisionEngine.latency.exceeded', { userId, toolName, latencyMs });
  }

  return {
    disposition,
    reason,
    decision_id: decisionId,
    latency_ms: latencyMs,
    conflict_level: conflictLevel,
    conflicted_rules: conflictedRules.map((r) => ({ id: r.id, description: r.description || r.ruleText })),
  };
}

module.exports = { evaluateAction, conflictsWithAction, PERSISTED_DISPOSITION };
