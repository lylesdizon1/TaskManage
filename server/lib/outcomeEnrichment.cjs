'use strict';

/**
 * server/lib/outcomeEnrichment.cjs — background enrichment for
 * outcome_records rows.
 *
 * Called fire-and-forget from POST /api/outcomes after a row is
 * created. Uses Haiku to extract sentiment, follow-up signal, key
 * themes, entity mentions, and (optionally) a durable memory fact.
 * Writes into outcome_signals + (conditionally) memory_facts.
 *
 * HARD CONTRACT:
 *   • Never throws — every await is guarded.
 *   • Never blocks the caller (caller must await-or-catch at its
 *     own call site; this module does not self-schedule).
 *   • Silent on Haiku failure — enrichment is best-effort.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../../db.cjs');
const { withRetry } = require('./anthropicRetry.cjs');

const MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.CLAUDE_API_KEY) return null;
  try {
    _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
    return _client;
  } catch {
    return null;
  }
}

function safeParseJson(text) {
  if (!text) return null;
  // Strip any accidental markdown fences.
  const stripped = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const m = stripped.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function enrichOutcomeRecord(outcomeId, userId, outcome) {
  try {
    const rawNote = outcome?.raw_note;
    if (!rawNote || !String(rawNote).trim()) return;

    const c = client();
    if (!c) return;

    const prompt = `You are analyzing a completed task outcome.

Task: "${outcome.title_snapshot || ''}"
Status: ${outcome.outcome_status || 'not specified'}
Note: "${rawNote}"

Extract the following as JSON only, no other text:
{
  "sentiment": "positive" | "neutral" | "negative",
  "follow_up_needed": true | false,
  "follow_up_suggestion": "string or null",
  "key_themes": ["array", "of", "short", "themes"],
  "entities_mentioned": [
    { "name": "string", "type": "person|company|project|other" }
  ],
  "confidence": 0.0-1.0,
  "memory_fact": "string or null"
}

memory_fact should only be set if this outcome reveals a durable pattern worth remembering, for example: "Prefers text before calls" or "Friday follow-ups slip". Otherwise null.

Respond with JSON only. No markdown, no explanation.`;

    let response;
    try {
      response = await withRetry(
        () => c.messages.create({
          model: MODEL,
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        }),
        'outcome-enrichment',
      );
    } catch (err) {
      console.error('[outcome-enrichment] haiku call failed:', err.message);
      return;
    }

    const text = response?.content?.[0]?.text || '';
    const parsed = safeParseJson(text);
    if (!parsed) {
      console.error('[outcome-enrichment] parse failed');
      return;
    }

    const confidence = Number.isFinite(parsed.confidence) ? parsed.confidence : null;

    const signals = [
      { name: 'sentiment',            value: parsed.sentiment },
      { name: 'follow_up_needed',     value: parsed.follow_up_needed },
      { name: 'follow_up_suggestion', value: parsed.follow_up_suggestion },
      { name: 'key_themes',           value: parsed.key_themes },
      { name: 'entities_mentioned',   value: parsed.entities_mentioned },
      { name: 'confidence',           value: parsed.confidence },
    ].filter((s) => s.value !== null && s.value !== undefined);

    for (const signal of signals) {
      await db.createOutcomeSignal(outcomeId, signal.name, signal.value, confidence, MODEL)
        .catch(() => {});
    }

    if (parsed.follow_up_needed === true) {
      await db.updateOutcomeFollowUp(outcomeId, userId, true, parsed.follow_up_suggestion || null)
        .catch(() => {});
    }

    if (parsed.memory_fact && String(parsed.memory_fact).trim()) {
      // M1a — 5th arg is now source_channel (strict enum), not the
      // legacy MODEL placeholder. MODEL passthrough was a comment-only
      // placeholder that never persisted; provenance lives in the new
      // column going forward.
      await db.upsertMemoryFact(userId, null, String(parsed.memory_fact).trim(), 'pattern', 'outcome')
        .catch(() => {});
    }

    console.log('[outcome-enrichment] complete', {
      outcomeId,
      sentiment: parsed.sentiment,
      followUpNeeded: parsed.follow_up_needed,
      hasMemoryFact: !!parsed.memory_fact,
    });
  } catch (err) {
    // Last-resort guard so a bug here can never surface as an unhandled rejection.
    console.error('[outcome-enrichment] unexpected failure:', err.message);
  }
}

module.exports = { enrichOutcomeRecord };
