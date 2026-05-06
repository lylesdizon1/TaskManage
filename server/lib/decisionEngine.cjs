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

// ── Predicate evaluator (decisionEngine extensions v1, ext 2) ─────────────
// Rules with a non-null `predicate` jsonb column bypass the legacy keyword
// path and evaluate via this function. Existing 11 user rules + 5 system
// rules have NULL predicate and continue using the keyword path unchanged.
//
// Predicate envelope shape:
//   { tool_names?: string[],     // optional toolName allowlist
//     input: PredicateNode }     // tree of conditions over toolInput
//
// PredicateNode is recursive — composition or leaf:
//   { and: [PredicateNode, ...] }     — all match
//   { or:  [PredicateNode, ...] }     — at least one matches
//   { not: PredicateNode }            — negation
//   { field: 'dotted.path', op: '<op>', value: <any> }   — leaf
//
// Operators: gt, gte, lt, lte, eq, neq, in, not_in, contains, exists, not_exists.
// Field paths: dotted lookup into toolInput. Missing segments → undefined.
//
// Reserved top-level keys (Extensions 3-5) intentionally throw in v1 so a
// rule that references them before the evaluator lands fails closed:
//   trust:   reserved for ext 3 (trust-floor)
//   rate:    reserved for ext 4 (rate limiting)
//   external_recipients: reserved for ext 5 (contact-list join)

function _getPath(obj, path) {
  if (obj == null || typeof obj !== 'object' || typeof path !== 'string') return undefined;
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function _applyOp(op, actual, value) {
  switch (op) {
    case 'gt':  return Number.isFinite(Number(actual)) && Number(actual) >  Number(value);
    case 'gte': return Number.isFinite(Number(actual)) && Number(actual) >= Number(value);
    case 'lt':  return Number.isFinite(Number(actual)) && Number(actual) <  Number(value);
    case 'lte': return Number.isFinite(Number(actual)) && Number(actual) <= Number(value);
    case 'eq':  return actual === value;
    case 'neq': return actual !== value;
    case 'in':  return Array.isArray(value) && value.includes(actual);
    case 'not_in': return Array.isArray(value) && !value.includes(actual);
    case 'contains': return typeof actual === 'string' && typeof value === 'string' && actual.includes(value);
    case 'exists': return actual !== undefined && actual !== null;
    case 'not_exists': return actual === undefined || actual === null;
    default: throw new Error(`Unknown predicate operator: ${op}`);
  }
}

function _evalNode(node, input) {
  if (node == null || typeof node !== 'object') {
    throw new Error(`Predicate node must be an object, got ${typeof node}`);
  }
  if (Array.isArray(node.and)) return node.and.every((c) => _evalNode(c, input));
  if (Array.isArray(node.or))  return node.or.some((c) => _evalNode(c, input));
  if (node.not !== undefined)  return !_evalNode(node.not, input);
  if (typeof node.field === 'string' && typeof node.op === 'string') {
    return _applyOp(node.op, _getPath(input, node.field), node.value);
  }
  throw new Error(`Unknown predicate node shape: ${JSON.stringify(node).slice(0, 120)}`);
}

// Reserved for engine extensions still to ship. Any rule that uses these
// keys before the corresponding evaluator lands fails closed via the
// per-rule error path (admin sees the broken rule via aria-health).
//   trust:   reserved for a future per-rule trust gating extension
//   rate:    reserved for a future per-rule rate-limit gating
const _RESERVED_FUTURE_KEYS = ['trust', 'rate'];

// Email normalization for the recipients predicate (Extension 5). Accepts
// "Name <email@host>" forms and bare addresses; returns lowercased atom
// or null if the value isn't a recognizable email. Strict-but-tolerant —
// matches the senderEmail() pattern used elsewhere in the codebase.
function _normalizeEmail(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/<([^>]+)>/);
  const candidate = (m ? m[1] : s).trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate) ? candidate : null;
}

// Extract a normalized list of recipient emails from a toolInput field
// value. Tolerates string ("a@x.com, b@y.com"), array (["a@x.com", ...]),
// or undefined. Filters out malformed entries.
function _extractRecipients(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(_normalizeEmail).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/[,;]/).map(_normalizeEmail).filter(Boolean);
  }
  return [];
}

// Evaluate the `recipients` envelope key (Extension 5). Resolves the
// recipient list from toolInput[field] (default 'to'), then checks
// membership against context.contactEmails (a Set of lowercased addresses
// pre-fetched in evaluateAction). Two semantics:
//   not_in_contacts: true  → fires if ANY recipient is unknown
//                            (defensive, the common guardrail shape)
//   in_contacts:     true  → fires only when ALL recipients are known
//                            (positive case, e.g. "auto-CC ok if everyone
//                            is internal")
function _evalRecipients(spec, toolInput, context) {
  if (spec == null || typeof spec !== 'object') {
    throw new Error('recipients predicate must be an object');
  }
  if (!context || !(context.contactEmails instanceof Set)) {
    throw new Error('recipients predicate requires context.contactEmails (Set)');
  }
  const fieldPath = typeof spec.field === 'string' && spec.field.length ? spec.field : 'to';
  const recipients = _extractRecipients(_getPath(toolInput, fieldPath));
  const known = context.contactEmails;
  if (spec.not_in_contacts === true) {
    if (recipients.length === 0) return false; // nothing to gate on
    return recipients.some((r) => !known.has(r));
  }
  if (spec.in_contacts === true) {
    if (recipients.length === 0) return false;
    return recipients.every((r) => known.has(r));
  }
  throw new Error('recipients predicate must specify in_contacts or not_in_contacts');
}

function evaluatePredicate(predicate, toolName, toolInput, context) {
  if (predicate == null || typeof predicate !== 'object') {
    throw new Error('predicate must be an object');
  }
  for (const k of _RESERVED_FUTURE_KEYS) {
    if (k in predicate) {
      throw new Error(`Predicate key "${k}" is reserved for a future engine extension and not yet implemented`);
    }
  }
  if (Array.isArray(predicate.tool_names) && predicate.tool_names.length) {
    if (!predicate.tool_names.includes(toolName)) return false;
  }

  // Recipients envelope (Extension 5). Two surface forms:
  //   { recipients: { field?, in_contacts?, not_in_contacts? } }
  //   { external_recipients: true }   ← convenience shorthand for
  //                                      { recipients: { field: 'to',
  //                                                      not_in_contacts: true } }
  if (predicate.external_recipients === true) {
    if (!_evalRecipients({ field: 'to', not_in_contacts: true }, toolInput || {}, context)) {
      // shorthand didn't fire; check for an explicit input/recipients block too
      // before returning false
    } else {
      return true;
    }
  }
  if (predicate.recipients !== undefined) {
    if (_evalRecipients(predicate.recipients, toolInput || {}, context)) return true;
  }

  if (predicate.input !== undefined) {
    return _evalNode(predicate.input, toolInput || {});
  }
  // tool_names without input/recipients → match purely by tool name in the list
  if (predicate.external_recipients === true || predicate.recipients !== undefined) return false;
  return Array.isArray(predicate.tool_names) && predicate.tool_names.includes(toolName);
}

// In-memory error tracking — surfaces silently-broken rules to the
// /api/admin/aria-health endpoint. Counter resets on process restart.
const _ruleEvaluationErrors = { count: 0, lastErrors: [] };
const _MAX_TRACKED_ERRORS = 10;

function _trackPredicateError(rule, err) {
  _ruleEvaluationErrors.count++;
  const entry = {
    ts: new Date().toISOString(),
    rule_id: rule?.id ?? null,
    rule_user_id: rule?.userId ?? null,
    error: err.message,
    predicate: JSON.stringify(rule?.predicate ?? null).slice(0, 200),
  };
  _ruleEvaluationErrors.lastErrors.unshift(entry);
  if (_ruleEvaluationErrors.lastErrors.length > _MAX_TRACKED_ERRORS) {
    _ruleEvaluationErrors.lastErrors.length = _MAX_TRACKED_ERRORS;
  }
  logger.warn('decisionEngine.predicate.error', entry);
}

function getRuleEvaluationErrors() {
  return {
    count: _ruleEvaluationErrors.count,
    lastErrors: _ruleEvaluationErrors.lastErrors.slice(),
  };
}

/**
 * Does this rule conflict with the proposed action?
 *
 * Two paths:
 *   - rule.predicate != null  → evaluate the structured predicate against
 *     toolInput. Predicate path is exhaustive: a predicate-bearing rule
 *     does NOT also consult the keyword path. Errors are isolated per-
 *     rule (logged + counted, returns false) so one malformed rule
 *     can't sink autonomy for the entire turn.
 *   - rule.predicate == null  → V1 keyword matching against rule_text.
 *     All 11 existing user rules + 5 system rules use this path.
 *
 * Keyword-path conflict semantics by preference_type:
 *   - 'never' / 'avoid': matches if action keyword found in rule_text
 *   - 'ask_first': matches if action category matches the rule's category
 *   - 'always' / 'prefer': don't trigger conflicts (positive directives)
 */
function conflictsWithAction(rule, toolName, toolInput, context) {
  if (rule && rule.predicate != null) {
    try {
      return evaluatePredicate(rule.predicate, toolName, toolInput, context);
    } catch (err) {
      _trackPredicateError(rule, err);
      return false; // skip this rule; other rules continue evaluating
    }
  }

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
    // Pull rules + trust + trust-floor threshold + rate-limit config +
    // recent-autonomous count in parallel. getCachedRules hits Redis
    // first; the others are single indexed queries (~ms each on cold
    // path; cached at the connection pool). Five concurrent fetches stay
    // within the 300ms decisionEngine budget — current avg is ~10ms.
    const [bundle, ts, trustFloor, rateLimit, recentAutoCount] = await Promise.all([
      getCachedRules(userId).catch(() => ({ explicit: [], inferred: [] })),
      db.getTrustScore(userId, toolName).catch(() => null),
      db.getTrustFloorThreshold
        ? db.getTrustFloorThreshold(userId).catch(() => 0.3)
        : Promise.resolve(0.3),
      db.getRateLimit
        ? db.getRateLimit(userId).catch(() => ({ count: 20, windowMinutes: 60 }))
        : Promise.resolve({ count: 20, windowMinutes: 60 }),
      db.countAutonomousActions
        ? db.countAutonomousActions(userId, 60).catch(() => 0)
        : Promise.resolve(0),
    ]);
    trust = ts;
    const explicit = (bundle?.explicit || []).filter((p) => p.isActive !== false && p.preferenceType);
    const inferred = (bundle?.inferred || []).filter((r) => r.isActive !== false);

    // Extension 5 — contact-list join. Lazy-fetch the user's contact set
    // ONLY if at least one rule's predicate references it. Most users
    // have no recipient predicates, so this stays free for them. When
    // needed, one indexed query over contacts + contact_identities.
    let contactEmails = null;
    const _hasRecipientPredicate = (r) =>
      r && r.predicate && (r.predicate.recipients !== undefined || r.predicate.external_recipients === true);
    if (explicit.some(_hasRecipientPredicate) || inferred.some(_hasRecipientPredicate)) {
      contactEmails = await db.getContactEmails(userId).catch(() => new Set());
    }
    const ruleContext = { contactEmails };

    // ── Tier 0 (Phase 3.1) — content-aware override for email actions.
    // Fetch the message body (Redis cached, 5-min TTL). Confirmation
    // codes / OTP magic links → hard_stop because archiving them can
    // lock the user out. Financial content → bumps risk + escalates
    // to soft_confirm if the action would otherwise auto-proceed.
    //
    // Hard 250ms race on this branch so a slow Gmail fetch can't blow
    // the 300ms decision-engine budget. On timeout we fall through to
    // baseline tiers (no content-aware signal this turn); next turn
    // rides the cache populated in the background.
    let contentFlags = null;
    if (CONTENT_AWARE_EMAIL_TOOLS.has(toolName) && toolInput?.message_id && toolInput?.account_email) {
      try {
        const content = await Promise.race([
          getEmailContent(userId, toolInput.message_id, toolInput.account_email, db, {
            allowMetadataFallback: false, // skip fallback when we're time-budget-bound
          }),
          new Promise((resolve) => setTimeout(() => resolve({ hasContent: false, timedOut: true }), 250)),
        ]);
        if (content?.timedOut) {
          logger.warn('decisionEngine.contentCheck.timeout', { userId, toolName });
          // Fail-closed: timeout means we couldn't check for OTP/financial
          // content. Bump auto_proceed → soft_confirm so a one-tap user
          // confirm catches anything we'd otherwise miss.
          if (disposition === 'auto_proceed') {
            disposition = 'soft_confirm';
            conflictLevel = 'content_check_unavailable';
            reason = "Couldn't verify the email's contents in time. Confirming with you to be safe.";
          }
        } else if (content?.failed) {
          // Same fail-closed treatment for hard failures (auth, rate-limit,
          // not-found). Prior code only logged on .timedOut and silently
          // accepted .failed → Aria could auto-archive an OTP email when
          // Gmail was momentarily refusing requests.
          logger.warn('decisionEngine.contentCheck.unavailable', { userId, toolName, reason: content.reason });
          if (disposition === 'auto_proceed') {
            disposition = 'soft_confirm';
            conflictLevel = 'content_check_unavailable';
            reason = "Couldn't fetch the email's contents (Gmail returned an error). Confirming with you to be safe.";
          }
        } else {
          contentFlags = assessEmailContentRisk(content);
          if (contentFlags.hasConfirmationCode) {
            disposition = 'hard_stop';
            conflictLevel = 'content_otp';
            conflictedRules = [];
            reason = `This email looks like a verification or confirmation code. Archiving it could lock you out of an account — handle it manually if you're sure.`;
          }
        }
      } catch (err) {
        // Same fail-closed treatment for unexpected throws (engine crash,
        // module load failure). Bumps friction rather than silently
        // accepting the action.
        logger.warn('decisionEngine.contentCheck.failed', { userId, toolName, error: err.message });
        if (disposition === 'auto_proceed') {
          disposition = 'soft_confirm';
          conflictLevel = 'content_check_failed';
          reason = "Couldn't safety-check this email — confirming with you to be safe.";
        }
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
      return isHard && conflictsWithAction(p, toolName, toolInput, ruleContext);
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
      const askFirst = explicit.filter((p) => p.preferenceType === 'ask_first' && conflictsWithAction(p, toolName, toolInput, ruleContext));
      const strongPrefs = explicit.filter((p) => p.strength === 4 && p.preferenceType !== 'ask_first' && conflictsWithAction(p, toolName, toolInput, ruleContext));
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
      const medPrefs = explicit.filter((p) => p.strength === 3 && conflictsWithAction(p, toolName, toolInput, ruleContext));
      if (medPrefs.length) {
        disposition = 'soft_confirm';
        conflictLevel = 'medium';
        conflictedRules = medPrefs;
        reason = `Heads up — you've noted: "${medPrefs[0].description}". Want me to proceed anyway?`;
      }
    }

    // Tier 4 — strong inferred patterns (strength >= 0.7).
    if (disposition === 'auto_proceed') {
      const strongInferred = inferred.filter((r) => r.strength >= 0.7 && conflictsWithAction(r, toolName, toolInput, ruleContext));
      if (strongInferred.length) {
        disposition = 'soft_confirm';
        conflictLevel = 'inferred';
        conflictedRules = strongInferred;
        const r = strongInferred[0];
        reason = `I notice ${r.ruleText.toLowerCase()} (observed pattern). Should I proceed?`;
      }
    }

    // Tier 5 — trust score floor. Even with no rule conflicts, if the
    // user has corrected this action recently, trust can fall below the
    // configured floor and we surface friction. Threshold is per-user
    // tunable via user_preferences_v2 ('trust_floor_threshold' key);
    // defaults to 0.3 when unset (Extension 3 of engine-extensions
    // workstream — paranoid users can raise to 0.7+, autonomous users
    // can lower further or keep default).
    if (disposition === 'auto_proceed' && trust && Number(trust.trustScore) < trustFloor) {
      disposition = 'confirm_required';
      conflictLevel = 'low_trust';
      reason = `I want to confirm before ${toolName.replace(/_/g, ' ')} — your trust score for this action (${Number(trust.trustScore).toFixed(2)}) is below your floor of ${trustFloor.toFixed(2)}.`;
    }

    // Tier 6 — autonomous-action rate limit (Extension 4). Catches runaway
    // loops: if the user has had >= rateLimit.count autonomous executions
    // in the last 60 min, the next auto_allow gets escalated to confirm.
    // Confirmation flows are NOT counted (already user-aware), so this
    // budget reflects "things Aria did without asking lately." Per-user
    // tunable count (default 20); window is hardcoded 60min in v1.
    if (disposition === 'auto_proceed' && rateLimit && recentAutoCount >= rateLimit.count) {
      disposition = 'confirm_required';
      conflictLevel = 'rate_limit';
      reason = `Rate-limit guardrail: you've had ${recentAutoCount} autonomous actions in the last ${rateLimit.windowMinutes} minutes (limit ${rateLimit.count}). Confirming this one before proceeding.`;
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

module.exports = {
  evaluateAction,
  conflictsWithAction,
  evaluatePredicate,
  getRuleEvaluationErrors,
  PERSISTED_DISPOSITION,
};
