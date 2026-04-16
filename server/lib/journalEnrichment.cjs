'use strict';

/**
 * server/lib/journalEnrichment.cjs — fire-and-forget enrichment for
 * completed journal entries. Mirrors contactFactExtractor.cjs +
 * outcomeEnrichment.cjs: single Haiku call, never-throw, Redis debounce.
 *
 * Runs ONLY when:
 *   • completed === true on the entry (wrap finalized)
 *   • at least one of wins / frustrations is populated (structured signal)
 *   • combined content length > 50 chars
 *
 * raw_freeform-only entries are intentionally skipped — too noisy for
 * pattern extraction at V1 quality bar. Multi-field entries carry the
 * signal needed for durable fact mining.
 *
 * HARD CONTRACT:
 *   • Never throws.
 *   • Callers invoke as fire-and-forget; `.catch()` at the call site is
 *     belt-and-suspenders.
 *   • Silent on Haiku failure.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../../db.cjs');
const { withRetry } = require('./anthropicRetry.cjs');
const { rediGet, rediSet } = require('./redis.cjs');

const MODEL = 'claude-haiku-4-5-20251001';
const DEBOUNCE_TTL_SEC = 24 * 60 * 60; // 24 hours
const MIN_CONTENT_CHARS = 50;
const MAX_FACTS = 3;
const MAX_NAMES = 5;
const MAX_FACT_CHARS = 300;

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.CLAUDE_API_KEY) return null;
  try {
    _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
    return _client;
  } catch { return null; }
}

function safeParseJson(text) {
  if (!text) return null;
  const stripped = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const m = stripped.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const SYSTEM_PROMPT = `Extract durable signal from this daily journal entry as JSON.

Return ONLY this shape (no preamble, no markdown):
{
  "memory_facts": [<up to 3 strings — recurring patterns, tendencies, or actionable insights about how this person works or what matters to them; skip one-time events, temporary logistics, dates/times, and anything irrelevant in 30 days>],
  "contact_mentions": [<up to 5 names — first names or full names that appear to be real people the user interacted with today>]
}

Both arrays may be empty. Output JSON only.`;

function buildEntryContent(entry) {
  const parts = [];
  if (entry?.wins) parts.push(`Wins: ${entry.wins}`);
  if (entry?.frustrations) parts.push(`Frustrations: ${entry.frustrations}`);
  if (entry?.tomorrowFocus) parts.push(`Tomorrow: ${entry.tomorrowFocus}`);
  if (entry?.rawFreeform) parts.push(entry.rawFreeform);
  return parts.join('\n\n');
}

async function enrichJournalEntry(userId, entry) {
  try {
    if (!userId || !entry?.id) return;
    // Quality gate: require at least one structured field (wins or
    // frustrations). raw_freeform alone is too noisy for V1.
    const hasStructured = !!(entry.wins || entry.frustrations);
    if (!hasStructured) return;

    const content = buildEntryContent(entry);
    if (content.length < MIN_CONTENT_CHARS) return;

    // Redis debounce — 24h per entry id. Protects against replays from
    // partial-save re-upserts on the same day.
    const debounceKey = `journal-enrich:${userId}:${entry.id}`;
    try {
      const hit = await rediGet(debounceKey);
      if (hit) return;
    } catch { /* fail-soft: run anyway */ }

    const c = client();
    if (!c) return;

    let response;
    try {
      response = await withRetry(
        () => c.messages.create({
          model: MODEL,
          max_tokens: 500,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content }],
        }),
        'journal-enrichment',
      );
    } catch (err) {
      console.error('[journalEnrichment] haiku call failed:', err.message);
      return;
    }

    const body = response?.content?.[0]?.text || '';
    const parsed = safeParseJson(body);
    if (!parsed) {
      console.error('[journalEnrichment] parse failed');
      try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}
      return;
    }

    const facts = Array.isArray(parsed.memory_facts) ? parsed.memory_facts : [];
    const names = Array.isArray(parsed.contact_mentions) ? parsed.contact_mentions : [];

    // Memory facts: write global (contact_id null), fact_type='journal_pattern'.
    // upsertMemoryFact already enforces the partial-unique + strength bump.
    let factsWritten = 0;
    for (const raw of facts.slice(0, MAX_FACTS)) {
      if (typeof raw !== 'string') continue;
      const fact = raw.trim().slice(0, MAX_FACT_CHARS);
      if (!fact) continue;
      try {
        await db.upsertMemoryFact(userId, null, fact, 'journal_pattern');
        factsWritten++;
      } catch (e) {
        console.error('[journalEnrichment] upsertMemoryFact failed:', e.message);
      }
    }

    // Contact mentions: resolve by name, add a contact fact. Never
    // auto-create contacts from journal text (per spec).
    let contactsTagged = 0;
    for (const raw of names.slice(0, MAX_NAMES)) {
      if (typeof raw !== 'string') continue;
      const name = raw.trim();
      if (!name) continue;
      try {
        const matches = await db.resolveContactByName(name, userId);
        if (!Array.isArray(matches) || matches.length !== 1) continue; // skip ambiguous / not-found
        const contact = matches[0];
        const factText = `Mentioned in daily wrap ${entry.entryDate || ''}`.trim();
        await db.addContactFact(userId, contact.id, factText, 'journal_mention', 0.5);
        contactsTagged++;
      } catch (e) {
        console.error('[journalEnrichment] contact tag failed:', e.message);
      }
    }

    try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}

    console.log('[journalEnrichment] complete', {
      userId, entryId: entry.id, factsWritten, contactsTagged,
    });
  } catch (err) {
    console.error('[journalEnrichment] unexpected failure:', err.message);
  }
}

module.exports = { enrichJournalEntry };
