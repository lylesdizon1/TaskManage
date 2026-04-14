'use strict';

/**
 * server/routes/ariaDraft.cjs — one-shot intent classifier for the
 * Command Center dynamic-tile UI.
 *
 * POST /api/aria/parse-draft
 *   body: { message: string, timezone?: string, today?: 'YYYY-MM-DD' }
 *   response: one of the three shapes:
 *     { type: 'task',  title, due_date|null, priority|null, confidence }
 *     { type: 'event', title, start_time, duration_minutes, confidence }
 *     { type: 'default_chat' }
 *
 * Uses a single Haiku call; any failure → default_chat so the caller
 * falls back to the normal agentic chat flow. Never throws.
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../guardrails/logger.cjs');

const VALID_TYPES = new Set(['task', 'event', 'default_chat']);
const VALID_PRIORITY = new Set(['low', 'medium', 'high']);
const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

let _anthropic = null;
function _client() {
  if (_anthropic) return _anthropic;
  if (!process.env.CLAUDE_API_KEY) return null;
  _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropic;
}

function _safeParse(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

module.exports = function createAriaDraftRouter({ authenticateToken }) {
  const router = express.Router();

  router.post('/api/aria/parse-draft', authenticateToken, async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.json({ type: 'default_chat' });

    const client = _client();
    if (!client?.messages?.create) return res.json({ type: 'default_chat' });

    const tz = req.body?.timezone || req.user?.timezone || 'America/Los_Angeles';
    const today = req.body?.today || new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const system = 'You classify a single user message for a personal productivity assistant. Output ONLY one JSON object. No prose.';
    const prompt =
`Today is ${today} (${tz}).

HARD RULES — these override everything else:
1. If the message contains "remind me", "reminder", "don't forget", "don't let me forget" → ALWAYS return {"type": "task"}. Never event.
2. If the message contains "send", "email", "message", "reach out", "reply" → ALWAYS return {"type": "default_chat"}. Never task or event.
3. "Call X" alone with no date/time → task.
4. "Call X at [time]" or "meeting with X" → event.

These rules are absolute. Do not override them based on other context in the message.

Classify the user message into exactly one of three buckets:

1) "task" — todos, reminders, things to do.
   Output: {"type":"task","title":string,"due_date":"YYYY-MM-DD"|null,"priority":"low"|"medium"|"high"|null,"confidence":"high"|"medium"|"low"}

2) "event" — meetings, calls, calendar items with a time.
   Output: {"type":"event","title":string,"start_time":"YYYY-MM-DDTHH:MM:SS","duration_minutes":number,"confidence":"high"|"medium"|"low"}

3) "default_chat" — anything else (questions, chitchat, lookups).
   Output: {"type":"default_chat"}

Rules:
- If the request is about sending, writing, or replying to an email or message, always return {"type": "default_chat"} — never classify as task or event.
- Requests containing "remind me" or "don't let me forget" are always tasks, never events.
- Infer a reasonable draft. Never ask questions. Never return empty fields on task/event.
- Dates are in the user's local timezone. "tomorrow" = ${today} + 1 day.
- If no time given for an event, default start_time to 09:00 local and duration 60.
- If no date given for a task, set due_date to null (do NOT invent).
- If priority isn't clear, set null.
- confidence: "high" if the ask is unambiguous; "medium" if most fields inferred; "low" if vague.
- Prefer "default_chat" when it's a question, search, or open-ended request.

User message: ${message}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let resp;
    try {
      resp = await client.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          system,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: controller.signal },
      );
    } catch (e) {
      clearTimeout(timeout);
      if (e?.name === 'AbortError' || /aborted|parse-timeout/i.test(e?.message || '')) {
        return res.json({ type: 'default_chat' });
      }
      logger.warn('aria.parseDraft.failed', { requestId: req.requestId, error: e.message });
      return res.json({ type: 'default_chat' });
    }
    clearTimeout(timeout);

    try {
      const text = resp?.content?.[0]?.text || '';
      const parsed = _safeParse(text);
      if (!parsed || !VALID_TYPES.has(parsed.type)) return res.json({ type: 'default_chat' });

      if (parsed.type === 'default_chat') return res.json({ type: 'default_chat' });

      const confidence = VALID_CONFIDENCE.has(parsed.confidence) ? parsed.confidence : 'medium';

      if (parsed.type === 'task') {
        const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '';
        if (!title) return res.json({ type: 'default_chat' });
        const due_date = (typeof parsed.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date)) ? parsed.due_date : null;
        const priority = VALID_PRIORITY.has(parsed.priority) ? parsed.priority : null;
        return res.json({ type: 'task', title, due_date, priority, confidence });
      }

      if (parsed.type === 'event') {
        const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '';
        const start_time = typeof parsed.start_time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(parsed.start_time)
          ? (parsed.start_time.length === 16 ? parsed.start_time + ':00' : parsed.start_time)
          : null;
        if (!title || !start_time) return res.json({ type: 'default_chat' });
        const duration_minutes = Number.isFinite(parsed.duration_minutes) ? Math.max(5, Math.min(parsed.duration_minutes, 12 * 60)) : 60;
        return res.json({ type: 'event', title, start_time, duration_minutes, confidence });
      }

      return res.json({ type: 'default_chat' });
    } catch (err) {
      logger.warn('aria.parseDraft.failed', { requestId: req.requestId, error: err.message });
      return res.json({ type: 'default_chat' });
    }
  });

  return router;
};
