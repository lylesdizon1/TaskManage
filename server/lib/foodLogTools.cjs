'use strict';

/**
 * server/lib/foodLogTools.cjs — model-backed helpers for food logging.
 *
 * Two entry points:
 *   estimateNutrition(description) — text → { items, note }
 *   generateInsights(payload)      — recent rollup → plain-text bullets
 *
 * Anthropic SDK isolated here so route handlers stay vendor-agnostic
 * (matches the existing journalEnrichment / conversationEnrichment
 * pattern; swap the client by editing this file).
 *
 * Parse defensively: strip code fences, then fall back to first `{`
 * through last `}`. Reject empty `items` so the persistence layer
 * never lands a zero-item row that would mislead totals.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('./anthropicRetry.cjs');
const { trackedAnthropicCall } = require('./anthropicCall.cjs');

const MODEL = 'claude-haiku-4-5-20251001';

const ESTIMATE_SYSTEM = `You are Aria's nutrition estimation engine. Given a free-text description of food and drink consumed, return ONLY a JSON object — no markdown, no code fences, no commentary. Schema: {"items":[{"name":string,"calories":number,"protein":number,"carbs":number,"fat":number,"fiber":number,"sugar":number,"sodium":number}],"note":string}. Break the description into individual foods/drinks. name includes the portion you assumed (e.g. "2 large eggs"). calories in kcal; protein, carbs, fat, fiber, sugar in grams; sodium in mg. Realistic USDA-style estimates, whole numbers. If quantity unspecified, assume one typical serving and reflect it in name. note: one short sentence only if you made a notable assumption, else empty string.`;

const INSIGHTS_SYSTEM = `You are Aria, a practical and supportive nutrition coach. You'll receive JSON of the user's recent daily nutrition totals and the meals they ate. Identify 2–4 concrete, specific trends and give 2–3 realistic meal or swap recommendations grounded in what they actually eat. Be encouraging and non-judgmental. Do not make medical claims, diagnoses, or push extreme restriction. Reply in short plain-text bullet lines using "-" bullets and **bold** leads, grouped under "Trends" and "Suggestions".`;

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.CLAUDE_API_KEY) return null;
  _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _client;
}

/**
 * Defensive JSON parser. Tries straight JSON.parse, then strips code
 * fences, then carves out first-{...last-} substring.
 */
function safeParseJson(text) {
  if (!text || typeof text !== 'string') return null;
  let stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  try { return JSON.parse(stripped.slice(first, last + 1)); } catch { return null; }
}

const MACRO_KEYS = ['calories', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium'];

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map((it) => {
    if (!it || typeof it !== 'object') return null;
    const out = { name: typeof it.name === 'string' ? it.name.slice(0, 200) : '' };
    if (!out.name) return null;
    for (const k of MACRO_KEYS) {
      const v = Number(it[k]);
      out[k] = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
    }
    return out;
  }).filter(Boolean);
}

/**
 * Estimate nutrition from a free-text meal description.
 * Returns { items, note } or throws on hard failure (caller decides
 * whether to surface or 500).
 */
async function estimateNutrition(description, { userId } = {}) {
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error('description required');
  }
  const c = client();
  if (!c) throw new Error('CLAUDE_API_KEY not configured');

  const response = await withRetry(
    () => trackedAnthropicCall(c, {
      model: MODEL,
      max_tokens: 1500,
      system: ESTIMATE_SYSTEM,
      messages: [{ role: 'user', content: description.trim().slice(0, 4000) }],
    }, { userId, scope: 'food_estimate' }),
    'food.estimateNutrition',
  );

  const body = response?.content?.[0]?.text || '';
  const parsed = safeParseJson(body);
  if (!parsed) throw new Error('estimate.parse_failed');

  const items = normalizeItems(parsed.items);
  if (items.length === 0) throw new Error('estimate.empty_items');
  const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 500) : '';
  return { items, note };
}

/**
 * Generate insights from recent daily rollups.
 * Returns the plain-text bullet body. No JSON envelope — the spec
 * explicitly says plain text grouped under Trends + Suggestions.
 */
async function generateInsights({ goal, days, userId }) {
  const c = client();
  if (!c) throw new Error('CLAUDE_API_KEY not configured');
  const payload = {
    goal: goal || 'none',
    days: Array.isArray(days) ? days : [],
  };
  const response = await withRetry(
    () => trackedAnthropicCall(c, {
      model: MODEL,
      max_tokens: 1500,
      system: INSIGHTS_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }, { userId, scope: 'food_insights' }),
    'food.generateInsights',
  );
  return response?.content?.[0]?.text || '';
}

module.exports = {
  estimateNutrition,
  generateInsights,
  normalizeItems,
  safeParseJson,
};
