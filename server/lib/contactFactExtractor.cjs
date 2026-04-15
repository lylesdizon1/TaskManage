'use strict';

/**
 * server/lib/contactFactExtractor.cjs — fire-and-forget fact extractor
 * for contact notes + ingested mail snippets. Mirrors the shape of
 * outcomeEnrichment.cjs.
 *
 * HARD CONTRACT:
 *   • Never throws — every await is guarded.
 *   • Never blocks the caller. Callers invoke as fire-and-forget and
 *     should pin a `.catch()` at the call site.
 *   • Silent on Haiku parse/network failure.
 *   • Redis debounce at 6h per (user, contact) so repeat signals on the
 *     same person don't burn tokens. When Redis is absent (fail-soft
 *     helper returns null) the extractor runs every time — acceptable
 *     for V1 since the input volume is bounded by note writes + mail
 *     scans and the Haiku call itself is cheap.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../../db.cjs');
const { withRetry } = require('./anthropicRetry.cjs');
const { rediGet, rediSet } = require('./redis.cjs');

const MODEL = 'claude-haiku-4-5-20251001';
const DEBOUNCE_TTL_SEC = 6 * 60 * 60; // 6 hours
const MAX_FACTS = 5;
const MIN_NOTE_CHARS = 20;

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

function safeParseJsonArray(text) {
  if (!text) return [];
  const stripped = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    return Array.isArray(parsed) ? parsed : [];
  } catch {}
  const m = stripped.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

const SYSTEM_PROMPT = `Extract durable facts about a person from this note. Only include facts that are:
- useful long-term
- specific
- actionable
- non-trivial

Do NOT extract:
- temporary logistics
- speculative claims
- redundant restatements

Return a JSON array of strings. Each string is one fact. Maximum ${MAX_FACTS} facts. No preamble, no markdown, JSON only.`;

async function extractContactFacts(userId, contactId, contactName, noteContent) {
  try {
    if (!userId || !contactId) return;
    const text = typeof noteContent === 'string' ? noteContent.trim() : '';
    if (text.length < MIN_NOTE_CHARS) return;

    // Redis debounce — 6h per (user, contact).
    const debounceKey = `contact-fact:${userId}:${contactId}`;
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
          messages: [{
            role: 'user',
            content: `Person: ${contactName || '(unknown)'}\nNote: ${text}`,
          }],
        }),
        'contact-fact-extract',
      );
    } catch (err) {
      console.error('[contactFactExtractor] haiku call failed:', err.message);
      return;
    }

    const body = response?.content?.[0]?.text || '';
    const facts = safeParseJsonArray(body)
      .map((f) => (typeof f === 'string' ? f.trim() : ''))
      .filter((f) => f.length > 0)
      .slice(0, MAX_FACTS);

    if (!facts.length) {
      // Still set the debounce key even on empty extraction so we don't
      // re-hit Haiku on back-to-back no-signal notes.
      try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}
      return;
    }

    for (const fact of facts) {
      await db.addContactFact(userId, contactId, fact, 'extracted', 0.7).catch((e) => {
        // 23505 is expected when the same fact repeats — upsert handles
        // it internally, so any leak here is unusual.
        console.error('[contactFactExtractor] addContactFact failed:', e.message);
      });
    }

    try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}

    console.log('[contactFactExtractor] complete', {
      userId, contactId, extracted: facts.length,
    });
  } catch (err) {
    // Last-resort guard so a bug here can never surface as an unhandled
    // rejection in the caller's fire-and-forget promise chain.
    console.error('[contactFactExtractor] unexpected failure:', err.message);
  }
}

module.exports = { extractContactFacts };
