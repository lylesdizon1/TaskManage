'use strict';

/**
 * server/routes/classification.cjs — rule CRUD + AI suggestions + batch lookup.
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../guardrails/logger.cjs');
const { classifyEmail, VALID_CATEGORIES, VALID_IMPORTANCE } = require('../lib/classificationEngine.cjs');
const googleProvider = require('../lib/providers/googleEmailProvider.cjs');
const { withRetry } = require('../lib/anthropicRetry.cjs');

let _anthropic = null;
function _client() {
  if (_anthropic) return _anthropic;
  if (!process.env.CLAUDE_API_KEY) return null;
  _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropic;
}

function validateRuleBody(body = {}) {
  if (body.category && !VALID_CATEGORIES.has(body.category)) return 'invalid category';
  if (body.importance && !VALID_IMPORTANCE.has(body.importance)) return 'invalid importance';
  return null;
}

// Fire-and-forget re-classification of recent threads after a rule change.
async function kickRecentReclassify({ db, userId }) {
  try {
    const rows = await db.getUserIntegrationsByType(userId, 'gmail');
    if (!rows.length) return;
    const lists = await Promise.allSettled(rows.map(async (row) => {
      const r = await googleProvider.listThreads({ db, userId, accountEmail: row.accountEmail, maxResults: 20 });
      return (r.threads || []).map(t => ({ ...t, accountEmail: row.accountEmail }));
    }));
    const threads = [];
    for (const r of lists) if (r.status === 'fulfilled') threads.push(...r.value);
    const slice = threads.slice(0, 20);
    for (const t of slice) {
      classifyEmail({
        userId, messageId: t.id, threadId: t.id,
        accountEmail: t.accountEmail,
        from: t.from, subject: t.subject, body: t.snippet,
        isRead: !!t.isRead, db, anthropicClient: _client(),
      }).catch(() => {});
    }
  } catch { /* swallow */ }
}

module.exports = function createClassificationRouter({ authenticateToken, db }) {
  const router = express.Router();

  // ── Rule CRUD ─────────────────────────────────────────────────────────

  router.get('/api/classification/rules', authenticateToken, async (req, res) => {
    try {
      const rules = await db.getRules(req.user.id);
      res.json({ rules });
    } catch (err) {
      logger.error('classification.rules.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/classification/rules', authenticateToken, async (req, res) => {
    try {
      const bad = validateRuleBody(req.body);
      if (bad) return res.status(400).json({ error: bad });
      if (!req.body?.ruleName && !req.body?.rule_name) return res.status(400).json({ error: 'rule_name required' });
      const rule = await db.createRule(req.user.id, req.body);
      kickRecentReclassify({ db, userId: req.user.id });
      res.json({ rule });
    } catch (err) {
      logger.error('classification.rules.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/classification/rules/:id', authenticateToken, async (req, res) => {
    try {
      const bad = validateRuleBody(req.body);
      if (bad) return res.status(400).json({ error: bad });
      const rule = await db.updateRule(req.params.id, req.user.id, req.body);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      kickRecentReclassify({ db, userId: req.user.id });
      res.json({ rule });
    } catch (err) {
      logger.error('classification.rules.update.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/classification/rules/:id', authenticateToken, async (req, res) => {
    try {
      const ok = await db.deleteRule(req.params.id, req.user.id);
      if (!ok) return res.status(404).json({ error: 'Rule not found' });
      res.json({ success: true });
    } catch (err) {
      logger.error('classification.rules.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Batch lookup ──────────────────────────────────────────────────────

  router.post('/api/classification/batch-lookup', authenticateToken, async (req, res) => {
    try {
      const { message_ids } = req.body || {};
      if (!Array.isArray(message_ids)) return res.status(400).json({ error: 'message_ids array required' });
      const map = await db.batchGetClassifications(req.user.id, message_ids);
      res.json({ classifications: map });
    } catch (err) {
      logger.error('classification.batchLookup.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── AI suggestions ────────────────────────────────────────────────────

  router.post('/api/classification/suggest', authenticateToken, async (req, res) => {
    try {
      const client = _client();
      if (!client?.messages?.create) return res.status(400).json({ error: 'AI not configured' });

      // Pull last 50 messages across all gmail accounts (from+subject only).
      const rows = await db.getUserIntegrationsByType(req.user.id, 'gmail');
      if (!rows.length) return res.json({ suggestions: [] });
      const perAccount = Math.max(5, Math.floor(50 / rows.length));
      const lists = await Promise.allSettled(rows.map(async (row) => {
        const r = await googleProvider.listThreads({ db, userId: req.user.id, accountEmail: row.accountEmail, maxResults: perAccount });
        return r.threads || [];
      }));
      const threads = [];
      for (const r of lists) if (r.status === 'fulfilled') threads.push(...r.value);
      threads.sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0));
      const sample = threads.slice(0, 50);
      if (!sample.length) return res.json({ suggestions: [] });

      const entities = (await db.getEntitiesForUser?.(req.user.id).catch(() => [])) || [];
      const entityNames = entities.map(e => e.name);

      const lines = sample.map(t => `${t.from} | ${t.subject || ''}`.slice(0, 200)).join('\n');
      const prompt =
`Analyze these emails. Suggest up to 8 classification rules for a busy executive.
User entities: [${entityNames.join(', ')}]
Emails (from | subject):
${lines}

Respond ONLY with a JSON array:
[{
  "rule_name": string,
  "conditions": {
    "from_domains"?: string[],
    "from_emails"?: string[],
    "subject_contains"?: string[],
    "any_of": boolean
  },
  "entity": string|null,
  "category": "invoice"|"receipt"|"purchase"|"contract"|"alert"|"newsletter"|"personal"|"meeting"|"financial"|"general",
  "importance": "critical"|"high"|"normal"|"low",
  "extract_amount": boolean,
  "reasoning": string (max 15 words)
}]`;

      const resp = await Promise.race([
        withRetry(
          () => client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1500,
            messages: [{ role: 'user', content: prompt }],
          }),
          'classificationSuggest',
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error('suggest-timeout')), 15000)),
      ]);
      const text = resp?.content?.[0]?.text || '';
      const m = text.match(/\[[\s\S]*\]/);
      if (!m) return res.json({ suggestions: [] });
      let arr;
      try { arr = JSON.parse(m[0]); } catch { return res.json({ suggestions: [] }); }
      if (!Array.isArray(arr)) return res.json({ suggestions: [] });

      // Validate + resolve entity name → id.
      const cleaned = [];
      for (const s of arr.slice(0, 8)) {
        if (!s?.rule_name) continue;
        if (s.category && !VALID_CATEGORIES.has(s.category)) continue;
        if (s.importance && !VALID_IMPORTANCE.has(s.importance)) continue;
        const entity = typeof s.entity === 'string' ? entities.find(e => e.name === s.entity) : null;
        cleaned.push({
          rule_name: s.rule_name,
          conditions: {
            ...(Array.isArray(s.conditions?.from_domains) ? { from_domains: s.conditions.from_domains.filter(x => typeof x === 'string') } : {}),
            ...(Array.isArray(s.conditions?.from_emails)  ? { from_emails:  s.conditions.from_emails.filter(x => typeof x === 'string') } : {}),
            ...(Array.isArray(s.conditions?.subject_contains) ? { subject_contains: s.conditions.subject_contains.filter(x => typeof x === 'string') } : {}),
            any_of: !!s.conditions?.any_of,
          },
          entity_name: entity?.name || null,
          entity_id: entity?.id || null,
          category: s.category || 'general',
          importance: s.importance || 'normal',
          extract_amount: !!s.extract_amount,
          reasoning: typeof s.reasoning === 'string' ? s.reasoning : '',
        });
      }
      res.json({ suggestions: cleaned });
    } catch (err) {
      logger.error('classification.suggest.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
