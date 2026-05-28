'use strict';

/**
 * server/lib/conversationEnrichment.cjs — fire-and-forget memory
 * extraction from each agentic conversation turn.
 *
 * Mirrors journalEnrichment.cjs / outcomeEnrichment.cjs structure:
 * single Haiku call, never-throw, Redis debounce, fire-and-forget
 * from the route layer.
 *
 * SHIPPED INERT — gated by MEMORY_EXTRACTOR_ENABLED env flag.
 *
 * Set MEMORY_EXTRACTOR_ENABLED=true in Railway to activate. Any other
 * value (including unset, empty, 'false', '1', 'yes') keeps the
 * extractor a no-op. This is the safety hatch per memory-phase-2.md
 * Q8/Bug B gate: if Bug B is observed during Commit B's soak the
 * extractor never runs; if soak shows Bug B is quiet the env flag
 * flips on without a code change.
 *
 * Quality gate (before Haiku call, per spec):
 *   • User message length ≥ 30 chars
 *   • User message ≠ exact YES/Y/yes/NO/N/no (confirmation reply)
 *   • Redis debounce 30s per user (mem:extract:{userId})
 *   • Loop produced assistant text (not a tool-only turn)
 *
 * Channel-agnostic by construction — same extractor fires for web
 * chat, WhatsApp, future SMS. `channel` is captured and persisted
 * via memory_facts.source_channel (M1a's strict enum).
 *
 * HARD CONTRACT:
 *   • Never throws.
 *   • Callers invoke as fire-and-forget; .catch() at the call site
 *     is belt-and-suspenders.
 *   • Silent on Haiku failure, parse failure, or any DB error.
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../../db.cjs');
const logger = require('../../guardrails/logger.cjs');
const { withRetry } = require('./anthropicRetry.cjs');
const { rediGet, rediSet } = require('./redis.cjs');
const { incrementDailyCounter } = require('./costTracker.cjs');

const MODEL = 'claude-haiku-4-5-20251001';
const DEBOUNCE_TTL_SEC = 30; // per spec: 30s per user
const MIN_USER_MSG_CHARS = 30;
const MAX_FACTS = 5;
const MAX_FACT_CHARS = 300;
const MIN_CONFIDENCE = 0.3; // server-side floor; Haiku is told 0.5

// Per-user daily Haiku call cap. The 30s debounce already bounds the
// theoretical max at ~2880/day, but a determined bot still costs ~$2/day.
// Default 200/day gives Lyle headroom for 100+ chat-turn power-user days.
// Override via env (`MEMORY_EXTRACTOR_DAILY_CAP=N`) without a redeploy.
const DAILY_CAP = (() => {
  const v = Number(process.env.MEMORY_EXTRACTOR_DAILY_CAP);
  return Number.isFinite(v) && v > 0 ? v : 200;
})();

// Strict YES/NO/etc. — confirmation replies should never feed
// extraction. Mirrors the matcher in whatsapp.cjs.
const STRICT_CONFIRM_RE = /^(YES|Y|NO|N)\.?$/i;

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

const SYSTEM_PROMPT = `You are an extraction-only assistant. From the conversation turn below, extract durable facts the user would want remembered.

Output ONLY this JSON shape (no preamble, no markdown):
{
  "facts": [
    {
      "text": "<fact in third-person neutral phrasing>",
      "type": "<'preference' | 'decision' | 'intention' | 'context' | 'person_fact'>",
      "confidence": 0.0,
      "contact_mention": "<exact name string if the fact is about a specific person, else null>"
    }
  ]
}

Rules:
- 0-5 facts per turn. Empty array is correct when nothing durable was said.
- Skip routine acknowledgments, time-of-day greetings, and tool restatements.
- Skip facts already implied by the structured tool calls Aria made this turn (e.g. don't re-extract "user wants to create a task X" — that already lives in tasks).
- contact_mention is the exact case-sensitive name as the user wrote it. Resolution to a contact_id happens server-side, not here.
- confidence ≥ 0.5 to be saved. Be honest about how durable the fact is.`;

const ALLOWED_TYPES = new Set(['preference', 'decision', 'intention', 'context', 'person_fact']);

/**
 * Extract memory facts from a single agentic turn. Caller passes the
 * raw materials; this module owns gating, Haiku, parse, persist.
 *
 * @param {Object} input
 * @param {string} input.userId      — DB user id
 * @param {string} input.channel     — source_channel enum value
 * @param {string} input.userMessage — last user-role text content
 * @param {string} input.assistantText — assistant reply text
 * @param {Array<string>} [input.toolsCalled] — tool names invoked this turn
 */
async function enrichConversationTurn({ userId, channel, userMessage, assistantText, toolsCalled = [] }) {
  // Hard inert by env. Fails closed on anything but the literal string 'true'.
  if (process.env.MEMORY_EXTRACTOR_ENABLED !== 'true') return;

  try {
    if (!userId) return;
    if (typeof userMessage !== 'string') return;

    const trimmed = userMessage.trim();

    // Quality gate
    if (trimmed.length < MIN_USER_MSG_CHARS) return;
    if (STRICT_CONFIRM_RE.test(trimmed)) return;
    if (typeof assistantText !== 'string' || !assistantText.trim()) return;

    // Redis debounce — 30s per user. Burst conversation collapses to
    // one extraction window.
    const debounceKey = `mem:extract:${userId}`;
    try {
      const hit = await rediGet(debounceKey);
      if (hit) return;
    } catch { /* fail-soft: run anyway */ }

    // Per-user daily cap. Incrementing BEFORE the Haiku call means a
    // failed call still counts — preferred for cost protection (the user
    // is "attempting" the spend even when the API blips). The increment
    // happens after debounce so background fail-soft paths don't bump
    // the counter unnecessarily.
    const capCheck = await incrementDailyCounter(userId, 'memory_extractor', { dailyCap: DAILY_CAP });
    if (capCheck.exceeded) {
      logger.info('conversation.enrichment.dailyCap', { userId, channel, count: capCheck.count, cap: DAILY_CAP });
      return;
    }

    const c = client();
    if (!c) return;

    const toolsLine = (toolsCalled || []).length
      ? `Tool calls made this turn: [${toolsCalled.join(', ')}]`
      : 'Tool calls made this turn: (none)';
    const promptBody = `User message: ${JSON.stringify(trimmed)}\nAria's response: ${JSON.stringify(assistantText.slice(0, 4000))}\n${toolsLine}`;

    let response;
    try {
      response = await withRetry(
        () => c.messages.create({
          model: MODEL,
          max_tokens: 600,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: promptBody }],
        }),
        'conversation-enrichment',
      );
    } catch (err) {
      logger.error('conversation.enrichment.haiku.failed', {
        userId, channel, error: err.message,
      });
      // Set debounce so we don't immediately retry the same turn on
      // a transient Haiku blip.
      try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}
      return;
    }

    const body = response?.content?.[0]?.text || '';
    const parsed = safeParseJson(body);
    if (!parsed) {
      logger.error('conversation.enrichment.parse.failed', {
        userId, channel, bodyPreview: body.slice(0, 200),
      });
      try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}
      return;
    }

    const facts = Array.isArray(parsed.facts) ? parsed.facts.slice(0, MAX_FACTS) : [];

    let factsWritten = 0;
    let contactsTagged = 0;

    for (const raw of facts) {
      if (!raw || typeof raw !== 'object') continue;
      const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_FACT_CHARS) : '';
      if (!text) continue;
      const confidence = Number(raw.confidence);
      if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) continue;
      const factType = ALLOWED_TYPES.has(raw.type) ? raw.type : 'context';

      const contactMention = typeof raw.contact_mention === 'string' && raw.contact_mention.trim()
        ? raw.contact_mention.trim()
        : null;

      // Contact-scoped write iff exactly-one resolution. Otherwise
      // global write — preserves intent without forcing disambiguation.
      let routedToContact = false;
      if (contactMention) {
        try {
          const matches = await db.resolveContactByName(contactMention, userId);
          if (Array.isArray(matches) && matches.length === 1) {
            await db.addContactFact(userId, matches[0].id, text, factType, confidence, channel || null);
            routedToContact = true;
            contactsTagged++;
          }
        } catch (e) {
          logger.error('conversation.enrichment.contactRoute.failed', {
            userId, channel, contactMention, error: e.message,
          });
        }
      }

      if (!routedToContact) {
        try {
          await db.upsertMemoryFact(userId, null, text, factType, channel || null);
          factsWritten++;
        } catch (e) {
          logger.error('conversation.enrichment.upsert.failed', {
            userId, channel, error: e.message,
          });
        }
      }
    }

    try { await rediSet(debounceKey, true, DEBOUNCE_TTL_SEC); } catch {}

    if (factsWritten || contactsTagged) {
      logger.info('conversation.enrichment.complete', {
        userId, channel, factsWritten, contactsTagged,
      });
    }
  } catch (err) {
    // Outermost catch: never let the extractor surface an error to the
    // caller. Fire-and-forget contract.
    try {
      logger.error('conversation.enrichment.failed', {
        userId, channel, error: err.message, stack: err.stack,
      });
    } catch { /* swallow */ }
  }
}

module.exports = { enrichConversationTurn };
