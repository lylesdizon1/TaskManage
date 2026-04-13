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

const VALID_CATEGORIES = new Set([
  'invoice', 'receipt', 'purchase', 'contract', 'alert',
  'newsletter', 'personal', 'meeting', 'financial', 'general',
]);
const VALID_IMPORTANCE = new Set(['critical', 'high', 'normal', 'low']);
const FINANCIAL_CATEGORIES = new Set(['invoice', 'receipt', 'purchase', 'financial', 'contract']);

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
function matchClassificationRule(rules, { from, subject, body }) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const f = _norm(from);
  const s = _norm(subject);
  const b = _norm(body);

  for (const rule of rules) {
    if (!rule || rule.active === false) continue;
    const c = rule.conditions || {};
    const checks = [];

    if (Array.isArray(c.from_domains) && c.from_domains.length) {
      checks.push(c.from_domains.some(d => f.includes(_norm(d))));
    }
    if (Array.isArray(c.from_emails) && c.from_emails.length) {
      checks.push(c.from_emails.some(e => f === _norm(e) || f.includes(_norm(e))));
    }
    if (Array.isArray(c.subject_contains) && c.subject_contains.length) {
      checks.push(c.subject_contains.some(k => s.includes(_norm(k))));
    }
    if (Array.isArray(c.body_contains) && c.body_contains.length) {
      checks.push(c.body_contains.some(k => b.includes(_norm(k))));
    }
    if (!checks.length) continue; // no conditions = not a valid rule to match

    const passed = c.any_of ? checks.some(Boolean) : checks.every(Boolean);
    if (passed) return rule;
  }
  return null;
}

// ── 2. Financial metadata extractor ────────────────────────────────────────
async function extractFinancialMetadata({ subject, body, anthropicClient }) {
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
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
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
async function classifyEmailWithAI({ from, subject, body, entityNames, anthropicClient }) {
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
      client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
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

function _hasListUnsubscribe(headers) {
  if (!Array.isArray(headers)) return false;
  return headers.some(h => String(h?.name || '').toLowerCase() === 'list-unsubscribe');
}

function _matchLabel(labelIds) {
  if (!Array.isArray(labelIds)) return null;
  for (const id of labelIds) {
    if (LABEL_MAP[id]) return { id, ...LABEL_MAP[id] };
  }
  return null;
}

function _matchBulkHeuristic({ from, body, headers }) {
  if (_hasListUnsubscribe(headers)) return 'list_unsubscribe';
  const fromLower = String(from || '').toLowerCase();
  if (BULK_PATTERNS.some(p => fromLower.includes(p))) return 'bulk_sender';
  const b = String(body || '').toLowerCase();
  if (b.includes('unsubscribe') && b.includes('email preferences')) return 'unsubscribe_body';
  return null;
}

async function classifyEmail({ userId, messageId, threadId, accountEmail, from, subject, body, isRead, labelIds, headers, db, anthropicClient }) {
  try {
    if (!userId || !messageId || !threadId || !accountEmail) return null;

    const existing = await db.getClassification(userId, messageId).catch(() => null);
    if (existing && existing.classifiedAt) {
      const age = Date.now() - new Date(existing.classifiedAt).getTime();
      if (Number.isFinite(age) && age < FRESHNESS_MS) return existing;
    }

    const rules = await db.getRules(userId).catch(() => []);
    const matched = matchClassificationRule(rules, { from, subject, body });

    let entityId = null;
    let category = 'general';
    let importance = 'normal';
    let actionRequired = false;
    let amount = null;
    let currency = 'USD';
    let vendor = null;
    let summary = null;
    let source = 'rule';

    let resolved = false;

    if (matched) {
      entityId = matched.entityId || null;
      category = matched.category || 'general';
      importance = matched.importance || 'normal';
      source = 'rule';
      resolved = true;

      const shouldExtract = matched.extractAmount || FINANCIAL_CATEGORIES.has(category);
      if (shouldExtract) {
        const meta = await extractFinancialMetadata({ subject, body, anthropicClient });
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
    if (!resolved) {
      const label = _matchLabel(labelIds);
      if (label) {
        category = label.category;
        importance = label.importance;
        source = 'label';
        resolved = true;
      }
    }

    // Step 4 — sender heuristics (bulk / newsletter signals).
    if (!resolved) {
      if (_matchBulkHeuristic({ from, body, headers })) {
        category = 'newsletter';
        importance = 'low';
        source = 'heuristic';
        resolved = true;
      }
    }

    // Step 5 — AI fallback (only if nothing above matched).
    if (!resolved) {
      const entities = (await db.getEntitiesForUser?.(userId).catch(() => [])) || [];
      const entityNames = entities.map(e => e.name);
      const ai = await classifyEmailWithAI({ from, subject, body, entityNames, anthropicClient });
      if (ai) {
        entityId = ai.entity ? (entities.find(e => e.name === ai.entity)?.id || null) : null;
        category = ai.category;
        importance = ai.importance;
        actionRequired = !!ai.action_required;
        if (ai.amount != null) amount = ai.amount;
        if (ai.vendor) vendor = ai.vendor;
        if (ai.summary) summary = ai.summary;
        source = 'ai';
      }
    }

    const saved = await db.upsertClassification(userId, {
      messageId, threadId, accountEmail,
      entityId,
      category, importance,
      actionRequired, isRead: !!isRead,
      amount, currency, vendor, summary, source,
    }).catch(() => null);

    return saved || null;
  } catch {
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
};
