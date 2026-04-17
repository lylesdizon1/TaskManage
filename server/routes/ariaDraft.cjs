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
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');

const VALID_TYPES = new Set(['task', 'event', 'project', 'project_task', 'checklist', 'clarify', 'daily_wrap_chat', 'default_chat']);

// Pre-LLM fast-path: obvious wrap-intent phrases → daily_wrap_chat without
// spending a Haiku call. The DashboardPanel intercept handles the rest.
const WRAP_INTENT_RE = /^(?:let'?s\s+)?(?:ready\s+to\s+)?(?:wrap|close\s*out)(?:\s+(?:my|the))?\s*(?:day|today)?[.!?\s]*$|daily\s+wrap/i;
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

    // Fast-path: explicit wrap phrases bypass the classifier so we don't
    // burn a Haiku call on a deterministic intent.
    if (WRAP_INTENT_RE.test(message)) {
      return res.json({ type: 'daily_wrap_chat' });
    }

    const client = _client();
    if (!client?.messages?.create) return res.json({ type: 'default_chat' });

    const tz = req.body?.timezone || req.user?.timezone || DEFAULT_TIMEZONE;
    const today = req.body?.today || new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const userEntities = Array.isArray(req.body?.entities) ? req.body.entities : [];
    const entityListStr = userEntities.length
      ? userEntities.map((e) => `- ${e.name}`).join('\n')
      : '(none)';
    const userProjects = Array.isArray(req.body?.projects) ? req.body.projects : [];
    const projectListStr = userProjects.length
      ? userProjects.map((p) => `- ${p.title}${p.entityName ? ` (entity: ${p.entityName})` : ''}`).join('\n')
      : '(none)';
    // Last-created project task — passed by the Command Center so that
    // "yes" / "add subtasks" following "Want to add checklist items?"
    // resolves to the right task without asking again.
    const lastTask = req.body?.lastProjectTask && typeof req.body.lastProjectTask === 'object' ? req.body.lastProjectTask : null;
    const lastTaskStr = lastTask && lastTask.id && lastTask.title
      ? `- ${lastTask.title}${lastTask.projectName ? ` (project: ${lastTask.projectName})` : ''}`
      : '(none)';

    const system = 'You classify a single user message for a personal productivity assistant. Output ONLY one JSON object. No prose.';
    const prompt =
`Today is ${today} (${tz}).

User's entities (workspaces):
${entityListStr}

User's active projects:
${projectListStr}

Last-created project task (recent, may be the target of a "yes" follow-up):
${lastTaskStr}

HARD RULES — evaluated in this exact priority order. The FIRST rule that matches wins. Do not evaluate any lower rule if a higher one matches.

A1 (HIGHEST PRIORITY): If the message contains the word "subtasks", "checklist items", "checklist:", or "subtasks:" followed by a list (comma/semicolon/newline separated) — classify immediately as {"type":"checklist"}. Do not ask for clarification. Do not classify as project_task or task. Parse the items from everything after the colon (or the list on subsequent lines); split on commas, semicolons, or newlines; trim each. Stop.

A. EMAIL/MESSAGE CHECK: If the message contains "send", "email", "message", "reach out", "reply" → ALWAYS return {"type": "default_chat"}. Stop.

B. PROJECT CREATION: If the message asks to "create a project", "set up a project", "make a [X] project", "start a new project" → ALWAYS return {"type": "project"}. Stop.

B2. CHECKLIST (evaluated before project_task/task):
- If the message is "yes", "sure", "yep", "go ahead", "ok", "do it" AND there is a Last-created project task (not "(none)") → return {"type": "checklist", "project_task_title": "<exact title from last task>", "items": []}. The client will pre-fill items as empty and let the user type them. Stop.
- If the message says "add subtasks", "add checklist", "add checklist items", "add items", "add subtasks:", "subtasks:", "checklist:", etc. with a colon/comma/newline list of items (e.g. "Add subtasks: login, keyboard, retry", "subtasks: X, Y, Z") → return {"type": "checklist", "project_task_title": <match against last task OR task name in message OR null>, "items": [<string>, ...]}. Parse the items from everything after the colon (or the list on subsequent lines); split on commas, semicolons, or newlines; trim each. Stop.

D. AMBIGUOUS TASK WITH NO PROJECT: If the message says "add a task", "create a task", "new task" with NO project named AND NO concrete subject that makes it obviously standalone (e.g. no "to buy groceries", "for the camping trip", "to call mom") → return {"type": "clarify", "question": "Should I add this to a project or as a standalone task?"}. Stop.

E. REMINDER / STANDALONE TASK: If the message contains "remind me", "reminder", "don't forget", "don't let me forget" OR asks to do something concrete with no project context (e.g. "buy groceries", "call Mom at 3pm with no time → task", "Wire to Schwab") → return {"type": "task"}. Stop.

F. MEETING / EVENT: "Call X at [time]", "meeting with X", scheduled calendar item → {"type": "event"}. Stop.

G. DEFAULT: Anything else → {"type": "default_chat"}.

These rules are absolute and ordered. C must be evaluated before E. D must be evaluated before E.

Bucket output shapes:

1) "task" — todos, reminders, things to do (standalone — no project).
   Output: {"type":"task","title":string,"due_date":"YYYY-MM-DD"|null,"due_time":"HH:MM"|null,"priority":"low"|"medium"|"high"|null,"confidence":"high"|"medium"|"low"}
   If the message mentions a specific time (e.g. "at 9am", "at 2pm"), extract it as due_time in 24-hour HH:MM format. If no time mentioned, omit due_time.

2) "event" — meetings, calls, calendar items with a time.
   Output: {"type":"event","title":string,"start_time":"YYYY-MM-DDTHH:MM:SS","duration_minutes":number,"confidence":"high"|"medium"|"low"}

3) "project" — collaborative project workspaces inside an entity.
   Output: {"type":"project","title":string,"entity_name":string|null,"description":string,"confidence":"high"|"medium"|"low"}
   For entity_name: match (case-insensitive) against the entity list above when the message mentions one. If no entity named or no match, set null. Description optional — set to "" if not specified.

4) "project_task" — a task inside an existing active project.
   Output: {"type":"project_task","title":string,"project_name":string,"description":string,"confidence":"high"|"medium"|"low"}
   project_name MUST be the exact title from the active projects list (not the user's paraphrase). Description optional.

5) "clarify" — ambiguous task request with no project context.
   Output: {"type":"clarify","question":"Should I add this to a project or as a standalone task?"}

6) "checklist" — batch checklist items under an existing project task.
   Output: {"type":"checklist","project_task_title":string|null,"items":string[]}
   Items parsed from the message. If the user said "yes" after a recent task creation, leave items empty — the client renders a blank list.

7) "default_chat" — anything else (questions, chitchat, lookups).
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

      if (parsed.type === 'clarify') {
        const question = typeof parsed.question === 'string' && parsed.question.trim()
          ? parsed.question.trim().slice(0, 300)
          : 'Should I add this to a project or as a standalone task?';
        return res.json({ type: 'clarify', question });
      }

      const confidence = VALID_CONFIDENCE.has(parsed.confidence) ? parsed.confidence : 'medium';

      if (parsed.type === 'task') {
        const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '';
        if (!title) return res.json({ type: 'default_chat' });
        const due_date = (typeof parsed.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.due_date)) ? parsed.due_date : null;
        const due_time = (typeof parsed.due_time === 'string' && /^\d{2}:\d{2}$/.test(parsed.due_time)) ? parsed.due_time : null;
        const priority = VALID_PRIORITY.has(parsed.priority) ? parsed.priority : null;
        return res.json({ type: 'task', title, due_date, due_time, priority, confidence });
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

      if (parsed.type === 'checklist') {
        const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
        const items = rawItems
          .map((s) => (typeof s === 'string' ? s.trim() : ''))
          .filter((s) => s.length > 0)
          .slice(0, 50);
        const claimedTitle = typeof parsed.project_task_title === 'string' ? parsed.project_task_title.trim() : '';
        // Resolve to a task id. Prefer lastTask when its title matches (or
        // when the user said "yes"); otherwise the client must clarify.
        let resolved = null;
        if (lastTask?.id && lastTask?.title) {
          const lt = (lastTask.title || '').toLowerCase();
          const ct = claimedTitle.toLowerCase();
          if (!claimedTitle || lt === ct || lt.includes(ct) || ct.includes(lt)) {
            resolved = {
              project_task_id: lastTask.id,
              task_title: lastTask.title,
              project_name: lastTask.projectName || null,
              entity_id: lastTask.entityId || null,
            };
          }
        }
        if (!resolved) return res.json({ type: 'clarify', question: 'Which task should I add these to?' });
        return res.json({
          type: 'checklist',
          project_task_id: resolved.project_task_id,
          task_title: resolved.task_title,
          project_name: resolved.project_name,
          entity_id: resolved.entity_id,
          items,
          confidence,
        });
      }

      if (parsed.type === 'project_task') {
        const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '';
        if (!title) return res.json({ type: 'default_chat' });
        const description = typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 1000) : '';
        const claimed = typeof parsed.project_name === 'string' ? parsed.project_name.trim() : '';
        if (!claimed) return res.json({ type: 'default_chat' });
        // Resolve project_name → project_id + entity_id via the user's
        // active project list (case-insensitive). If no match, downgrade
        // so the client can ask "Which project?".
        // Exact match first, then substring/token overlap as a safety net
        // (Haiku is instructed to return the exact title but may paraphrase).
        const claimedLc = claimed.toLowerCase();
        let match = userProjects.find((p) => (p.title || '').toLowerCase() === claimedLc);
        if (!match) match = userProjects.find((p) => (p.title || '').toLowerCase().includes(claimedLc) || claimedLc.includes((p.title || '').toLowerCase()));
        if (!match) return res.json({ type: 'clarify', question: 'Which project should I add this task to?' });
        return res.json({
          type: 'project_task',
          title,
          project_id: match.id,
          project_name: match.title,
          entity_id: match.entityId,
          entity_name: match.entityName || null,
          description,
          confidence,
        });
      }

      if (parsed.type === 'project') {
        const title = typeof parsed.title === 'string' ? parsed.title.trim().slice(0, 200) : '';
        if (!title) return res.json({ type: 'default_chat' });
        const description = typeof parsed.description === 'string' ? parsed.description.trim().slice(0, 1000) : '';
        // Resolve entity_name → entity_id via the user's actual entity list
        // (case-insensitive). If no match, return null id and let the client
        // surface "No entity" so the user knows to clarify.
        let entity_id = null;
        let entity_name = null;
        const claimed = typeof parsed.entity_name === 'string' ? parsed.entity_name.trim() : '';
        if (claimed) {
          const match = userEntities.find((e) => (e.name || '').toLowerCase() === claimed.toLowerCase());
          if (match) { entity_id = match.id; entity_name = match.name; }
        }
        return res.json({ type: 'project', title, entity_id, entity_name, description, confidence });
      }

      return res.json({ type: 'default_chat' });
    } catch (err) {
      logger.warn('aria.parseDraft.failed', { requestId: req.requestId, error: err.message });
      return res.json({ type: 'default_chat' });
    }
  });

  return router;
};
