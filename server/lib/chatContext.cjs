'use strict';

/**
 * server/lib/chatContext.cjs — conversation context envelope builder.
 *
 * Spec: docs/agents-foundation-v1.md §5A.
 *
 * The envelope is computed once per chat turn and used by skillLoader
 * to evaluate trigger_predicate trees. Every skill predicate evaluates
 * against this single envelope; computing it once and threading it
 * through the pipeline avoids per-skill duplicate work.
 *
 * Cost optimization (Q3 — locked decision):
 *   1. Lazy Haiku — skip the topic/intent extraction call entirely when
 *      no active skill has a topic-touching predicate. db.userHasTopicTouchingSkill
 *      is a cheap SQL ILIKE check on the predicate JSON.
 *   2. 60s Redis cache — when Haiku does run, cache the result keyed by
 *      sha256(user_message). Rapid-fire turns ("yes", "do that") repeat
 *      message text and the cache absorbs them.
 *
 * The deterministic fields (people_mentioned, entities_mentioned,
 * calendar_context, active_persona, explicit_skill_request) always
 * populate — they're cheap regex/db lookups, no LLM in the path.
 *
 * HARD CONTRACT:
 *   • Never throws on Haiku/Redis/db failure — degrades to deterministic-only.
 *   • Returns an envelope with all keys present; missing data → empty/null.
 *   • Latency budget: <100ms when Haiku is skipped, <2s with Haiku.
 */

const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('./anthropicRetry.cjs');
const { rediGet, rediSet } = require('./redis.cjs');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const HAIKU_CACHE_TTL_SEC = 60;
const HAIKU_TIMEOUT_MS = 8000;
const MAX_TOPICS = 5;

// Bounded set so a malicious or noisy user message can't blow up the
// envelope. Resolved against contacts/entities by substring match.
const MAX_PEOPLE_MENTIONED = 10;
const MAX_ENTITIES_MENTIONED = 10;

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

// "use my <name> skill" / "load <name> skill" / "with <name> skill"
const EXPLICIT_SKILL_RE = /\b(?:use|load|with)\s+(?:my\s+)?(["']?)([a-zA-Z][\w\s-]{1,40}?)\1\s+skill\b/i;

const HAIKU_SYSTEM_PROMPT = `You extract topics and conversation intent from a user's chat message to a personal-assistant agent.

Return STRICT JSON of this exact shape (no preamble, no markdown):
{
  "topics": ["topic1", "topic2"],
  "topic_confidence": { "topic1": 0.0, "topic2": 0.0 },
  "conversation_intent": "question|task|brainstorm|request|update|other"
}

Rules:
- Topics: at most ${MAX_TOPICS}. Lowercase, single words or hyphen-joined phrases. Examples: "wheelworks", "vendor-management", "calendar", "tax-prep". Do NOT include people's names — those are extracted separately.
- topic_confidence: 0.0 to 1.0 per topic. Confidence reflects how clearly the topic is the subject of the message (not strength of mention).
- conversation_intent: pick exactly one. "question" = asking for info; "task" = asking the agent to do something concrete; "brainstorm" = open-ended thinking; "request" = asking for help/draft/output; "update" = sharing status; "other" = none of the above.`;

function safeParseJson(text) {
  if (!text) return null;
  const stripped = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const m = stripped.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

function hashMessage(msg) {
  return crypto.createHash('sha256').update(String(msg || '')).digest('hex').slice(0, 32);
}

function extractExplicitSkillRequest(msg) {
  if (!msg) return null;
  const m = String(msg).match(EXPLICIT_SKILL_RE);
  if (!m) return null;
  return m[2].trim();
}

/**
 * Substring-match the message against a list of {key, value} pairs.
 * Returns the matched values, deduped, capped. Case-insensitive.
 */
function extractMentions(msgLower, candidates, max) {
  const hits = new Set();
  for (const c of candidates) {
    if (!c.match) continue;
    const needle = String(c.match).toLowerCase().trim();
    if (needle.length < 2) continue;
    if (msgLower.includes(needle)) {
      hits.add(c.value);
      if (hits.size >= max) break;
    }
  }
  return Array.from(hits);
}

/**
 * Resolves a user's people roster into substring-matchable candidates.
 * Uses display_name + primary_email local-part for matching; emits the
 * canonical contact display_name as the value.
 */
async function loadPeopleCandidates(db, userId) {
  if (!db?.getContactsForUser) return [];
  try {
    const contacts = await db.getContactsForUser(userId);
    const out = [];
    for (const c of (contacts || [])) {
      const name = c.displayName || c.display_name;
      if (name) out.push({ match: name, value: name });
      const email = c.primaryEmail || c.primary_email;
      if (email) {
        const local = String(email).split('@')[0];
        if (local && local.length >= 3) out.push({ match: local, value: name || email });
      }
    }
    return out;
  } catch { return []; }
}

async function loadEntityCandidates(db, userId) {
  if (!db?.getEntitiesForUser) return [];
  try {
    const entities = await db.getEntitiesForUser(userId);
    return (entities || [])
      .filter((e) => e.name && String(e.name).length >= 2)
      .map((e) => ({ match: e.name, value: e.id }));
  } catch { return []; }
}

/**
 * Returns the calendar context — in_meeting + next_meeting. Reads from
 * the synced calendar_events cache; null next_meeting if nothing within
 * the next 24h.
 */
async function loadCalendarContext(db, userId, nowDate = new Date()) {
  const fallback = { in_meeting: false, next_meeting: null };
  if (!db?.getCalendarEventsForUser) return fallback;
  try {
    const start = nowDate.toISOString();
    const end = new Date(nowDate.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const events = await db.getCalendarEventsForUser(userId, start, end);
    if (!Array.isArray(events) || events.length === 0) return fallback;
    const sorted = [...events].sort((a, b) => {
      const at = new Date(a.startTime || a.start_time || 0).getTime();
      const bt = new Date(b.startTime || b.start_time || 0).getTime();
      return at - bt;
    });
    let inMeeting = false;
    let next = null;
    const nowMs = nowDate.getTime();
    for (const ev of sorted) {
      const st = new Date(ev.startTime || ev.start_time || 0).getTime();
      const et = new Date(ev.endTime   || ev.end_time   || 0).getTime();
      if (st <= nowMs && et > nowMs) {
        inMeeting = true;
        next = ev;
        break;
      }
      if (st > nowMs && !next) next = ev;
    }
    return {
      in_meeting: inMeeting,
      next_meeting: next ? {
        title: next.title || '',
        attendees: next.attendees || [],
        time: next.startTime || next.start_time || null,
      } : null,
    };
  } catch { return fallback; }
}

/**
 * Lazy Haiku — only invoked when shouldRun is true. Returns
 * { topics, topic_confidence, conversation_intent } or empty defaults
 * on failure.
 */
async function runHaiku(message) {
  const empty = { topics: [], topic_confidence: {}, conversation_intent: null };
  if (!message || typeof message !== 'string') return empty;
  const c = client();
  if (!c) return empty;

  const cacheKey = `chatctx:haiku:${hashMessage(message)}`;
  try {
    const cached = await rediGet(cacheKey);
    if (cached) return cached;
  } catch { /* fall through */ }

  let response;
  try {
    response = await withTimeout(
      withRetry(
        () => c.messages.create({
          model: HAIKU_MODEL,
          max_tokens: 300,
          system: HAIKU_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: message.slice(0, 2000) }],
        }),
        'chatctx-haiku',
      ),
      HAIKU_TIMEOUT_MS,
      'chatctx-haiku',
    );
  } catch (err) {
    return empty;
  }

  const body = response?.content?.[0]?.text || '';
  const parsed = safeParseJson(body);
  if (!parsed) return empty;

  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.filter((t) => typeof t === 'string' && t.length > 0).slice(0, MAX_TOPICS)
    : [];
  const tc = (parsed.topic_confidence && typeof parsed.topic_confidence === 'object')
    ? Object.fromEntries(
        Object.entries(parsed.topic_confidence)
          .filter(([k, v]) => topics.includes(k) && typeof v === 'number')
          .map(([k, v]) => [k, Math.max(0, Math.min(1, v))]),
      )
    : {};
  const intent = ['question','task','brainstorm','request','update','other'].includes(parsed.conversation_intent)
    ? parsed.conversation_intent : 'other';

  const result = { topics, topic_confidence: tc, conversation_intent: intent };
  try { await rediSet(cacheKey, result, HAIKU_CACHE_TTL_SEC); } catch {}
  return result;
}

/**
 * Build the per-turn chatContext envelope.
 *
 * @param {object} opts
 * @param {string} opts.userId            user id (required)
 * @param {object} opts.db                db helpers (required)
 * @param {string} opts.userMessage       latest user message text (required)
 * @param {string} [opts.activePersona]   CFO / COO / Best-Friend / null
 * @param {Date}   [opts.now]             test seam — defaults to new Date()
 * @param {boolean}[opts.forceHaiku]      test seam — bypasses lazy gate
 * @returns {Promise<object>} envelope per spec §5A
 */
async function buildChatContext(opts = {}) {
  const { userId, db, userMessage, activePersona = null, now = new Date(), forceHaiku = false } = opts;
  const text = typeof userMessage === 'string' ? userMessage : '';
  const lower = text.toLowerCase();

  // Deterministic fields — always populate, fail-soft to defaults.
  const [peopleCands, entityCands, calContext] = await Promise.all([
    loadPeopleCandidates(db, userId),
    loadEntityCandidates(db, userId),
    loadCalendarContext(db, userId, now),
  ]);

  const people_mentioned = extractMentions(lower, peopleCands, MAX_PEOPLE_MENTIONED);
  const entities_mentioned = extractMentions(lower, entityCands, MAX_ENTITIES_MENTIONED);
  const explicit_skill_request = extractExplicitSkillRequest(text);

  // Lazy Haiku — only if some active skill cares about topics/intent.
  let haiku = { topics: [], topic_confidence: {}, conversation_intent: null };
  let haikuRan = false;
  if (text.trim().length > 0) {
    let shouldRun = forceHaiku;
    if (!shouldRun && db?.userHasTopicTouchingSkill) {
      try { shouldRun = await db.userHasTopicTouchingSkill(userId); } catch { shouldRun = false; }
    }
    if (shouldRun) {
      haiku = await runHaiku(text);
      haikuRan = true;
    }
  }

  return {
    user_message: text,
    user_message_lower: lower,
    topics: haiku.topics,
    topic_confidence: haiku.topic_confidence,
    people_mentioned,
    entities_mentioned,
    explicit_skill_request,
    active_persona: activePersona,
    calendar_context: calContext,
    conversation_intent: haiku.conversation_intent,
    _meta: {
      haiku_ran: haikuRan,
      built_at: now.toISOString(),
    },
  };
}

module.exports = {
  buildChatContext,
  // Exported for tests:
  _extractExplicitSkillRequest: extractExplicitSkillRequest,
  _extractMentions: extractMentions,
  _hashMessage: hashMessage,
  _runHaiku: runHaiku,
  _safeParseJson: safeParseJson,
};
