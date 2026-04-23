'use strict';

/**
 * server/lib/activeZone/voice.cjs — Aria's empty-state voice panel.
 *
 * When the detector returns zero candidates, the dashboard shows ONE
 * line from Aria — recap, light observation, occasional playful note.
 * Generated via Haiku, cached 30 min per user, with a deterministic
 * fallback.
 *
 * Cache key: az:voice:<userId>:<30min-bucket>
 * TTL: 30 min (matches the spec — empty-state Aria shouldn't chatter).
 */

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../../guardrails/logger.cjs');
const { rediGet, rediSet } = require('../redis.cjs');

const VOICE_TIMEOUT_MS = 3000;
const VOICE_CACHE_TTL_SEC = 30 * 60;
const VOICE_MODEL = 'claude-haiku-4-5-20251001';

let _client = null;
function _anthropic() {
  if (_client) return _client;
  if (!process.env.CLAUDE_API_KEY) return null;
  _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _client;
}

function _bucket30min(now) {
  return String(Math.floor(now.getTime() / (30 * 60 * 1000)));
}

function _cacheKey(userId, bucket) {
  return `az:voice:${userId}:${bucket}`;
}

function _localTime(date, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(date);
  } catch { return date.toISOString(); }
}

const FALLBACK = "You're all clear. Nice work.";

/**
 * Compose a single empty-state voice line. Returns { line, source } where
 * source ∈ 'cache'|'llm'|'fallback'. Never throws.
 */
async function composeVoice({ userId, firstName, timezone, recentCompletions = [], wrappedMeetings = [] }) {
  const bucket = _bucket30min(new Date());
  const cacheKey = _cacheKey(userId, bucket);
  try {
    const cached = await rediGet(cacheKey);
    if (cached) return { line: cached, source: 'cache' };
  } catch { /* fall through */ }

  const client = _anthropic();
  if (client?.messages?.create) {
    try {
      const localTime = _localTime(new Date(), timezone || 'America/Los_Angeles');
      const completionsLine = recentCompletions.length
        ? `Recently completed: ${recentCompletions.slice(0, 3).map((t) => `"${t.title}"`).join(', ')}.`
        : 'No tasks completed in the last little while.';
      const meetingsLine = wrappedMeetings.length
        ? `Wrapped meetings today: ${wrappedMeetings.slice(0, 3).map((e) => `"${e.title}"`).join(', ')}.`
        : 'No meetings yet today.';
      const prompt =
`You are Aria, ${firstName}'s personal AI assistant. The user has nothing urgent in front of them.

Write 1-2 sentences. Tone: warm, like a smart friend. Not corporate. Don't overdo personality. About 20% of the time can be slightly playful.

Pick whichever fits the moment best:
  (a) acknowledge they're caught up / recap what they knocked out
  (b) point out something interesting from their day
  (c) a light observation if nothing else fits

Output ONLY the message text — no quotes, no JSON, no preamble, no sign-off.

Time: ${localTime}
${completionsLine}
${meetingsLine}`;
      const resp = await Promise.race([
        client.messages.create({
          model: VOICE_MODEL,
          max_tokens: 120,
          messages: [{ role: 'user', content: prompt }],
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('voice-timeout')), VOICE_TIMEOUT_MS)),
      ]);
      const text = (resp?.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '');
      if (text) {
        try { await rediSet(cacheKey, text, VOICE_CACHE_TTL_SEC); } catch {}
        return { line: text, source: 'llm' };
      }
    } catch (err) {
      logger.warn('activeZone.voice.llmFailed', { userId, error: err.message });
    }
  }

  return { line: FALLBACK, source: 'fallback' };
}

module.exports = { composeVoice, FALLBACK, VOICE_CACHE_TTL_SEC };
