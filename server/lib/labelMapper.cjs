'use strict';

/**
 * server/lib/labelMapper.cjs — Haiku-backed semantic mapping for Gmail
 * labels and Outlook folders.
 *
 * Aria references labels by their semantic category (finance / clients /
 * etc.) rather than their literal name, so the same prompt works whether
 * the user calls the folder "Bills" or "Finance" or "$$$".
 *
 * mapLabelsToCategories(userId) batches every unmapped label for the
 * user into a single Haiku call (one round-trip per user, not per
 * label). Redis-debounced 24h per user so scan ticks don't replay it.
 *
 * HARD CONTRACT:
 *   • Never throws.
 *   • Callers invoke as fire-and-forget; .catch() is belt-and-suspenders.
 *   • Silent on Haiku / parse failure.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../../db.cjs');
const logger = require('../../guardrails/logger.cjs');
const { rediGet, rediSet } = require('./redis.cjs');

const MODEL = 'claude-haiku-4-5-20251001';
const DEBOUNCE_TTL_SEC = 24 * 60 * 60;

const CATEGORIES = [
  'finance', 'legal', 'clients', 'vendors', 'personal', 'team',
  'receipts', 'newsletters', 'notifications', 'travel', 'hr',
  'projects', 'archive', 'other',
];

const SYSTEM_PROMPT = `Map each email label/folder name to ONE category from this exact list:
${CATEGORIES.join(', ')}

Return ONLY a JSON array of objects with the shape {"label": "<original label name>", "category": "<one of the categories>"}.
One entry per input label, preserving order. No preamble, no markdown fences.`;

function safeParseJson(text) {
  if (!text) return null;
  const stripped = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const m = stripped.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.CLAUDE_API_KEY) return null;
  try {
    _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
    return _client;
  } catch { return null; }
}

async function mapLabelsToCategories(userId) {
  try {
    if (!userId) return;
    const debounceKey = `label-map:${userId}`;
    try { if (await rediGet(debounceKey)) return; }
    catch { /* fail-soft: run anyway */ }

    const labels = await db.getEmailLabelsForUser(userId, { unmappedOnly: true });
    if (!labels.length) return;

    const c = client();
    if (!c) return;

    const labelNames = labels.map((l) => l.labelName);
    let response;
    try {
      response = await c.messages.create({
        model: MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(labelNames) }],
      });
    } catch (err) {
      logger.error('labelMapper.haiku.failed', { userId, error: err.message });
      return;
    }

    const body = response?.content?.[0]?.text || '';
    const parsed = safeParseJson(body);
    if (!Array.isArray(parsed)) {
      logger.error('labelMapper.parse.failed', { userId, bodyPreview: body.slice(0, 200) });
      try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}
      return;
    }

    const validSet = new Set(CATEGORIES);
    let mapped = 0;
    for (const entry of parsed) {
      if (!entry || typeof entry.label !== 'string' || typeof entry.category !== 'string') continue;
      const cat = validSet.has(entry.category) ? entry.category : 'other';
      const found = labels.find((l) => l.labelName === entry.label);
      if (!found) continue;
      try {
        await db.updateLabelSemanticCategory(userId, found.labelId, cat);
        mapped++;
      } catch (e) {
        logger.warn('labelMapper.update.failed', { userId, labelId: found.labelId, error: e.message });
      }
    }

    try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}
    logger.info('labelMapper.complete', { userId, mapped, total: labels.length });
  } catch (err) {
    logger.error('labelMapper.failed', { userId, error: err.message, stack: err.stack });
  }
}

module.exports = { mapLabelsToCategories, CATEGORIES };
