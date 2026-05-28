'use strict';

/**
 * server/lib/classificationEngine.cjs
 *
 * Four-function pipeline:
 *   matchClassificationRule   — pure regex/substring match against user rules
 *   extractFinancialMetadata  — Haiku call for amount/vendor/summary
 *   classifyEmailWithAI       — Haiku call for full classification
 *   classifyEmail             — orchestrator (existing → rule → AI → persist)
 *
 * All failures are swallowed by classifyEmail. Never throws.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('./anthropicRetry.cjs');
const { trackedAnthropicCall } = require('./anthropicCall.cjs');
const logger = require('../../guardrails/logger.cjs');

const VALID_CATEGORIES = new Set([
  'invoice', 'receipt', 'purchase', 'contract', 'alert',
  'newsletter', 'personal', 'meeting', 'financial', 'general',
]);
const VALID_IMPORTANCE = new Set(['critical', 'high', 'normal', 'low']);
const FINANCIAL_CATEGORIES = new Set(['invoice', 'receipt', 'purchase', 'financial', 'contract']);

// Confirmation code / OTP detection — regex for 4-8 digit codes and
// common OTP patterns in subject or body.
const CONFIRMATION_CODE_RE = /\b(verification|confirmation|security)\s+code[:\s]+\d{4,8}\b|\bOTP[:\s]+\d{4,8}\b|\b\d{4,8}\s+is your (code|pin|otp)\b/i;

function _hasConfirmationCode(subject, body) {
  const text = `${subject || ''} ${(body || '').slice(0, 2000)}`;
  return CONFIRMATION_CODE_RE.test(text);
}

let _anthropic = null;
function _defaultClient() {
  if (_anthropic) return _anthropic;
  if (!process.env.CLAUDE_API_KEY) return null;
  _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropic;
}

function _norm(s) { return String(s || '').toLowerCase().trim(); }

function _safeParseJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── 1. Pure rule matcher ───────────────────────────────────────────────────
// Returns { rule, signals } when a rule matches, null otherwise. `signals`
// is the list of sub-conditions inside the rule that tripped — surfaces
// which primitive (subject/from/body) actually caught the email so the
// reasoning blob can attribute past the rule name.
function matchClassificationRule(rules, { from, subject, body }) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const f = _norm(from);
  const s = _norm(subject);
  const b = _norm(body);

  for (const rule of rules) {
    if (!rule || rule.active === false) continue;
    const c = rule.conditions || {};
    const checks = [];
    const hits = [];

    if (Array.isArray(c.from_domains) && c.from_domains.length) {
      const hit = c.from_domains.find(d => f.includes(_norm(d)));
      checks.push(!!hit);
      if (hit) hits.push(`rule_from_domain:${_norm(hit)}`);
    }
    if (Array.isArray(c.from_emails) && c.from_emails.length) {
      const hit = c.from_emails.find(e => f === _norm(e) || f.includes(_norm(e)));
      checks.push(!!hit);
      if (hit) hits.push(`rule_from_email:${_norm(hit)}`);
    }
    if (Array.isArray(c.subject_contains) && c.subject_contains.length) {
      const hit = c.subject_contains.find(k => s.includes(_norm(k)));
      checks.push(!!hit);
      if (hit) hits.push(`rule_subject_contains:${_norm(hit)}`);
    }
    if (Array.isArray(c.body_contains) && c.body_contains.length) {
      const hit = c.body_contains.find(k => b.includes(_norm(k)));
      checks.push(!!hit);
      if (hit) hits.push(`rule_body_contains:${_norm(hit)}`);
    }
    if (!checks.length) continue; // no conditions = not a valid rule to match

    const passed = c.any_of ? checks.some(Boolean) : checks.every(Boolean);
    if (passed) return { rule, signals: hits };
  }
  return null;
}

// ── 2. Financial metadata extractor ────────────────────────────────────────
async function extractFinancialMetadata({ subject, body, anthropicClient, userId }) {
  const client = anthropicClient || _defaultClient();
  if (!client?.messages?.create) return null;

  const prompt =
`Extract from this email. Respond ONLY with JSON, no explanation:
{
  "amount": number|null,
  "currency": string|null,
  "vendor": string|null,
  "action_required": boolean,
  "summary": string (max 15 words)
}
Subject: ${subject || ''}
Body (first 400 chars): ${String(body || '').slice(0, 400)}`;

  try {
    const resp = await Promise.race([
      withRetry(
        () => trackedAnthropicCall(client, {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{ role: 'user', content: prompt }],
        }, { userId, scope: 'classification' }),
        'classifyFinancialExtract',
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('extract-timeout')), 8000)),
    ]);
    const text = resp?.content?.[0]?.text || '';
    const parsed = _safeParseJson(text);
    if (!parsed) return null;
    const amount = typeof parsed.amount === 'number' ? parsed.amount : null;
    return {
      amount,
      currency: typeof parsed.currency === 'string' ? parsed.currency : null,
      vendor: typeof parsed.vendor === 'string' ? parsed.vendor : null,
      action_required: !!parsed.action_required,
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : null,
    };
  } catch {
    return null;
  }
}

// ── 3. Full AI classifier ──────────────────────────────────────────────────
async function classifyEmailWithAI({ from, subject, body, entityNames, anthropicClient, userId }) {
  const client = anthropicClient || _defaultClient();
  if (!client?.messages?.create) return null;

  const names = Array.isArray(entityNames) ? entityNames : [];
  const prompt =
`Classify this email for a busy executive. Respond ONLY with JSON, no explanation:
{
  "entity": string|null,
  "category": "invoice"|"receipt"|"purchase"|"contract"|"alert"|"newsletter"|"personal"|"meeting"|"financial"|"general",
  "importance": "critical"|"high"|"normal"|"low",
  "action_required": boolean,
  "amount": number|null,
  "vendor": string|null,
  "summary": string (max 15 words)
}
Entity must exactly match one of: [${names.join(', ')}] or be null if none match.

Importance guide:
critical: legal notices, urgent payments, security alerts
high: invoices, contracts, time-sensitive business
normal: receipts, confirmations, personal emails
low: newsletters, marketing, promotions

From: ${from || ''}
Subject: ${subject || ''}
Body (first 300 chars): ${String(body || '').slice(0, 300)}`;

  try {
    const resp = await Promise.race([
      withRetry(
        () => trackedAnthropicCall(client, {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }, { userId, scope: 'classification' }),
        'classifyEmailWithAI',
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('classify-timeout')), 10000)),
    ]);
    const text = resp?.content?.[0]?.text || '';
    const p = _safeParseJson(text);
    if (!p) return null;

    const category = VALID_CATEGORIES.has(p.category) ? p.category : 'general';
    const importance = VALID_IMPORTANCE.has(p.importance) ? p.importance : 'normal';
    const entity = typeof p.entity === 'string' && names.includes(p.entity) ? p.entity : null;
    return {
      entity,
      category,
      importance,
      action_required: !!p.action_required,
      amount: typeof p.amount === 'number' ? p.amount : null,
      vendor: typeof p.vendor === 'string' ? p.vendor : null,
      summary: typeof p.summary === 'string' ? p.summary.slice(0, 200) : null,
    };
  } catch {
    return null;
  }
}

// ── 4. Orchestrator ────────────────────────────────────────────────────────
const FRESHNESS_MS = 24 * 60 * 60 * 1000;

// Bump when the deterministic pipeline changes shape. Cached rows whose
// reasoning.classifier_version differs are treated as cache misses so the
// new logic re-decides them on next sight. Keep `classifier_version` in
// the reasoning blob below in sync with this constant.
const CLASSIFIER_VERSION = 'v1.5';

// Gmail system label → (importance, category) mapping. Match is short-
// circuit: if any label hits, we skip heuristics and AI entirely.
const LABEL_MAP = {
  'CATEGORY_PROMOTIONS': { importance: 'low',    category: 'newsletter' },
  'CATEGORY_SOCIAL':     { importance: 'low',    category: 'newsletter' },
  'CATEGORY_FORUMS':     { importance: 'low',    category: 'newsletter' },
  'CATEGORY_UPDATES':    { importance: 'normal', category: 'general' },
};

// Sender-local-part patterns that almost always indicate bulk mail.
const BULK_PATTERNS = [
  'noreply@', 'no-reply@', 'donotreply@',
  'notifications@', 'updates@', 'newsletter@',
  'mailer@', 'bounce@', 'automated@',
];

// Subject patterns canonical to marketing/promotional mail. Tuned to be
// specific — no bare \boffer\b, which would catch "job offer" / "offer
// letter" / "counter-offer".
const PROMO_SUBJECT_RE = /\b\d{1,3}%\s*off\b|\bmember offer\b|\bends soon\b|\blimited time\b/i;

function _findHeader(headers, name) {
  if (!Array.isArray(headers)) return null;
  const target = String(name).toLowerCase();
  const h = headers.find(x => String(x?.name || '').toLowerCase() === target);
  return h ? String(h.value || '') : null;
}

function _matchLabel(labelIds) {
  if (!Array.isArray(labelIds)) return null;
  for (const id of labelIds) {
    if (LABEL_MAP[id]) return { id, ...LABEL_MAP[id] };
  }
  return null;
}

// Returns the full list of bulk/promo primitives that match — no
// short-circuit. Drives both classification (any non-empty result =
// newsletter/low) and signal-level telemetry. Order matches detection
// strength: header signals first, then sender, subject, body.
function _detectBulkSignals({ from, subject, body, headers }) {
  const out = [];
  if (_findHeader(headers, 'list-unsubscribe')) out.push('list_unsubscribe');
  if (_findHeader(headers, 'list-id')) out.push('list_id');
  const precedence = _findHeader(headers, 'precedence');
  if (precedence && /\b(bulk|list|junk)\b/i.test(precedence)) out.push('precedence_bulk');
  const fromLower = String(from || '').toLowerCase();
  if (BULK_PATTERNS.some(p => fromLower.includes(p))) out.push('bulk_sender');
  if (subject && PROMO_SUBJECT_RE.test(subject)) out.push('promo_subject');
  const b = String(body || '').toLowerCase();
  if (b.includes('unsubscribe') && b.includes('email preferences')) out.push('unsubscribe_body');
  return out;
}

async function classifyEmail({ userId, messageId, threadId, accountEmail, from, subject, body, isRead, labelIds, headers, db, anthropicClient }) {
  try {
    if (!userId || !messageId || !threadId || !accountEmail) return null;

    const existing = await db.getClassification(userId, messageId).catch(() => null);
    if (existing && existing.classifiedAt) {
      const age = Date.now() - new Date(existing.classifiedAt).getTime();
      const cachedVersion = existing.classificationReasoning?.classifier_version || null;
      const versionFresh = cachedVersion === CLASSIFIER_VERSION;
      if (Number.isFinite(age) && age < FRESHNESS_MS && versionFresh) return existing;
    }

    const rules = await db.getRules(userId).catch(() => []);
    const matchResult = matchClassificationRule(rules, { from, subject, body });
    const matched = matchResult?.rule || null;
    const ruleSignals = matchResult?.signals || [];

    // Always probe label + bulk signals so signal-level attribution is
    // complete even when a rule short-circuits the heuristic resolution
    // path. Cheap (regex/string only, no API) and pure read on already-
    // loaded headers/subject/body.
    const probeLabel = _matchLabel(labelIds);
    const probeBulkSignals = _detectBulkSignals({ from, subject, body, headers });

    let entityId = null;
    let category = 'general';
    let importance = 'normal';
    let actionRequired = false;
    let amount = null;
    let currency = 'USD';
    let vendor = null;
    let summary = null;
    let source = 'rule';
    const matchedPatterns = [];
    const signalsFired = [...ruleSignals];
    if (probeLabel) signalsFired.push(`gmail_label:${probeLabel.id}`);
    signalsFired.push(...probeBulkSignals);

    let resolved = false;

    if (matched) {
      entityId = matched.entityId || null;
      category = matched.category || 'general';
      importance = matched.importance || 'normal';
      source = 'rule';
      resolved = true;
      matchedPatterns.push(`rule: "${matched.ruleName || matched.id}" matched`);

      const shouldExtract = matched.extractAmount || FINANCIAL_CATEGORIES.has(category);
      if (shouldExtract) {
        const meta = await extractFinancialMetadata({ subject, body, anthropicClient, userId });
        if (meta) {
          if (meta.amount != null) amount = meta.amount;
          if (meta.currency) currency = meta.currency;
          if (meta.vendor) vendor = meta.vendor;
          if (meta.action_required) actionRequired = true;
          if (meta.summary) summary = meta.summary;
        }
      }
    }

    // Step 3 — Gmail system label mapping. Short-circuits AI.
    if (!resolved && probeLabel) {
      category = probeLabel.category;
      importance = probeLabel.importance;
      source = 'label';
      resolved = true;
      matchedPatterns.push(`gmail_label: ${probeLabel.id}`);
    }

    // Step 4 — sender heuristics (bulk / newsletter signals).
    if (!resolved && probeBulkSignals.length) {
      category = 'newsletter';
      importance = 'low';
      source = 'heuristic';
      resolved = true;
      matchedPatterns.push(`heuristic: ${probeBulkSignals[0]}`);
    }

    // Step 5 — AI fallback (only if nothing above matched).
    if (!resolved) {
      const entities = (await db.getEntitiesForUser?.(userId).catch(() => [])) || [];
      const entityNames = entities.map(e => e.name);
      const ai = await classifyEmailWithAI({ from, subject, body, entityNames, anthropicClient, userId });
      if (ai) {
        entityId = ai.entity ? (entities.find(e => e.name === ai.entity)?.id || null) : null;
        category = ai.category;
        importance = ai.importance;
        actionRequired = !!ai.action_required;
        if (ai.amount != null) amount = ai.amount;
        if (ai.vendor) vendor = ai.vendor;
        if (ai.summary) summary = ai.summary;
        source = 'ai';
        matchedPatterns.push('ai_classifier: haiku');
        if (ai.entity) matchedPatterns.push(`ai_entity: ${ai.entity}`);
        if (ai.amount != null) matchedPatterns.push(`ai_amount: ${ai.amount}`);
        signalsFired.push('ai_classification');
        if (ai.entity) signalsFired.push(`ai_entity:${ai.entity}`);
      }
    }

    // ── Suppress pass: apply inferred classification rules ──────────────
    // Inferred rules are suppress-only — they downgrade dimensions that
    // users have repeatedly corrected. Never upgrade/add classifications.
    const suppressedDims = [];
    try {
      const inferredRules = (db.getActiveInferredClassificationRules
        ? await db.getActiveInferredClassificationRules(userId).catch(() => [])
        : []);
      const fromLower = _norm(from);
      const fromDomain = (fromLower.match(/@([^>]+)/) || [])[1] || '';
      for (const rule of inferredRules) {
        let match = false;
        if (rule.patternType === 'sender_email' && fromLower.includes(rule.patternValue)) match = true;
        if (rule.patternType === 'sender_domain' && fromDomain === rule.patternValue) match = true;
        if (!match) continue;
        const dim = rule.suppressDimension;
        if (dim === 'not_critical' && (importance === 'critical' || importance === 'high')) {
          importance = 'normal';
          suppressedDims.push(`suppress: ${dim} via ${rule.patternType}:${rule.patternValue}`);
        }
        if (dim === 'not_financial' && FINANCIAL_CATEGORIES.has(category)) {
          category = 'general';
          amount = null;
          suppressedDims.push(`suppress: ${dim} via ${rule.patternType}:${rule.patternValue}`);
        }
        if (dim === 'not_otp') {
          // Can't un-detect OTP, but prevent auto-flagging by lowering importance
          suppressedDims.push(`suppress: ${dim} via ${rule.patternType}:${rule.patternValue}`);
        }
        if (dim === 'wrong_priority' || dim === 'wrong_entity') {
          suppressedDims.push(`suppress: ${dim} via ${rule.patternType}:${rule.patternValue}`);
        }
      }
    } catch { /* suppress lookup failure → proceed with original classification */ }

    // Invariant: a low-importance newsletter is never action-required.
    // Promo subjects ("Final Hours", "Ends soon") trick the financial-
    // extraction Haiku into returning action_required=true on rules with
    // extract_amount enabled (myQ "50% Off" trace, May 3 2026). Clamp
    // here so downstream agentic readers (morning brief, narration
    // counts) see a consistent flag regardless of which path resolved.
    if (importance === 'low' && category === 'newsletter') {
      actionRequired = false;
    }

    // Dedupe signals_fired while preserving insertion order.
    const uniqueSignals = Array.from(new Set(signalsFired));

    // Build reasoning snapshot for the "Why?" surface
    const classificationReasoning = {
      source,
      category,
      importance,
      matched_patterns: [...matchedPatterns, ...suppressedDims],
      signals_fired: uniqueSignals,
      has_confirmation_code: _hasConfirmationCode(subject, body),
      classifier_version: CLASSIFIER_VERSION,
      suppressed: suppressedDims.length > 0 ? suppressedDims : undefined,
    };
    if (amount != null) classificationReasoning.amount = amount;
    if (vendor) classificationReasoning.vendor = vendor;

    const saved = await db.upsertClassification(userId, {
      messageId, threadId, accountEmail,
      entityId,
      category, importance,
      actionRequired, isRead: !!isRead,
      amount, currency, vendor, summary, source,
      classificationReasoning,
    }).catch(() => null);

    // ── Auto-flag: single source of truth for the Flagged view ─────────
    // This is the ONE path that creates flagged inbox_items from classification.
    // New flags have flagged_acked_at=NULL so they appear in the unacked
    // triage queue. Manual flags via toggleFlag use the /flag-thread endpoint.
    // Conditions: critical importance, financial with amount, or OTP codes.
    try {
      const otpSuppressed = suppressedDims.some(d => d.includes('not_otp'));
      const shouldAutoFlag =
        importance === 'critical'
        || (FINANCIAL_CATEGORIES.has(category) && amount != null)
        || (!otpSuppressed && _hasConfirmationCode(subject, body));

      if (shouldAutoFlag && db.flagInboxItem && db.inboxItemExistsBySourceId) {
        const flagReason = importance === 'critical' ? 'aria_decision'
          : FINANCIAL_CATEGORIES.has(category) ? 'financial'
          : 'confirmation_code';

        const exists = await db.inboxItemExistsBySourceId(userId, threadId);
        if (!exists && db.createInboxItem) {
          const id = `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          await db.createInboxItem({
            id, userId, type: 'EMAIL',
            title: subject || '(no subject)',
            summary: summary || '',
            source: accountEmail?.includes('outlook') ? 'outlook' : 'gmail',
            sourceId: threadId,
            gmailThreadId: threadId,
            gmailLink: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
            sender: from || null,
          });
        }

        // Flag only if not already flagged (skip re-flag on every sync)
        const { rows } = await db.pool.query(
          'SELECT id, flagged_at FROM inbox_items WHERE user_id = $1 AND source_id = $2',
          [userId, threadId],
        );
        if (rows[0] && !rows[0].flagged_at) {
          await db.flagInboxItem(rows[0].id, userId, flagReason);
          logger.info('classifyEmail.autoFlagged', { userId, threadId, reason: flagReason });
        }
      } else if (db.unflagAutoFlaggedBySourceId) {
        // Auto-unflag-on-demote — when reclassification drops a row out
        // of auto-flag eligibility (e.g. v1.5 demotes a Hubstaff weekly
        // from critical/alert → low/newsletter), clear the stale auto-
        // flag. Without this, the flag set at first classification
        // outlives every demotion and the critical_email_unacked tile
        // overcounts. Manual flags + already-acked flags are preserved
        // by the helper's WHERE clause.
        const cleared = await db.unflagAutoFlaggedBySourceId(userId, threadId);
        if (cleared) {
          logger.info('classifyEmail.autoUnflagged', { userId, threadId, reason: 'demoted_below_threshold' });
        }
      }
    } catch (autoFlagErr) {
      // Fire-and-forget — never break classification for flag failure
      logger.warn('classifyEmail.autoFlag.failed', { userId, threadId, error: autoFlagErr.message });
    }

    return saved || null;
  } catch (err) {
    // Hot path called from inbox.cjs / gmail.cjs / outlookMailScan.cjs;
    // every caller swallows null. Without a log line, classification
    // failures (DB write, AI 500, label lookup) silently disappear and
    // the user sees the inbox "just not getting smarter."
    logger.error('classifyEmail.unexpected', { userId, messageId, error: err.message });
    return null;
  }
}

module.exports = {
  matchClassificationRule,
  extractFinancialMetadata,
  classifyEmailWithAI,
  classifyEmail,
  VALID_CATEGORIES,
  VALID_IMPORTANCE,
  CLASSIFIER_VERSION,
};
