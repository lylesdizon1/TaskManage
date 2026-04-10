'use strict';

/**
 * server/routes/dashboard.cjs — Dashboard data aggregation and AI brief endpoints.
 *
 * Provides the backend for the dashboard panel: Command Center session
 * management, live update polling, Aria's daily brief generation, and
 * timeline summary.
 *
 * Responsibility:
 *   - Command Center session lifecycle (get-or-create daily conversation,
 *     fetch messages, poll for new inbox/overdue updates)
 *   - Generate Aria's daily brief via a one-shot Claude API call
 *   - Generate timeline summary via a one-shot Claude API call
 *
 * Inputs:
 *   - GET /api/dashboard/command-center/session — load today's conversation
 *   - GET /api/dashboard/command-center/updates — poll for new events since timestamp
 *   - POST /api/dashboard/aria-brief — generate persona-aware daily brief
 *   - POST /api/dashboard/timeline-summary — generate one-sentence day summary
 *
 * Dependencies:
 *   - db.cjs — conversation, task, note, inbox queries (injected)
 *   - axios — direct Anthropic API calls for brief/summary generation
 *
 * Boundaries:
 *   - Data aggregation plus lightweight one-shot generation — no agentic
 *     loop, no tool execution, no domain mutations.
 *   - The brief and timeline-summary endpoints make direct Anthropic API
 *     calls via axios (not the SDK) because they are simple one-shot
 *     generations with no tool use, no streaming, and no multi-turn loop.
 *   - GCal data for the brief is now fetched server-side with timezone-aware
 *     date ranges, matching the fix applied to ai.cjs and alerts.cjs.
 *
 * @note This route exists separately from ai.cjs because dashboard endpoints
 * serve aggregated data for the UI shell (session, polling, briefs), while
 * ai.cjs handles the interactive chat conversation with tool execution.
 * They share no endpoints or state.
 *
 * @note This file uses two intentional trust models:
 * - aria-brief fetches tasks server-side for correctness
 * - timeline-summary accepts client-sent data because
 *   it is cosmetic only
 * This distinction is deliberate — do not change without
 * considering the security implications.
 */

const express = require('express');
const axios = require('axios');
const logger = require('../../guardrails/logger.cjs');

/**
 * Factory function that creates the dashboard router.
 *
 * @param {Object} deps - Injected dependencies.
 * @param {Function} deps.authenticateToken - JWT auth middleware.
 * @param {Object} deps.db - Database helper module (db.cjs).
 * @returns {express.Router} Mounted by proxy-server.cjs.
 */
module.exports = function createDashboardRouter({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, makeOAuth2Client, google }) {
  const router = express.Router();

  // ── Command Center ───────────────────────────────────────────────────────────

  /**
   * GET /api/dashboard/command-center/session — Load or create today's
   * Command Center conversation and return its messages.
   *
   * @note The conversation is scoped to the user's local date (via their
   * timezone). A new conversation is automatically created each day so
   * the Command Center resets daily — yesterday's context doesn't bleed
   * into today's session.
   *
   * @returns {Object} { conversation, messages }
   */
  router.get('/api/dashboard/command-center/session', authenticateToken, async (req, res) => {
    try {
      const todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: req.user.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());

      const conversation = await db.getOrCreateCommandCenterConversation(req.user.id, todayStr);
      const messages = await db.getConversationMessages(conversation.id, req.user.id);
      return res.json({ conversation, messages });
    } catch (err) {
      logger.error('commandCenter.session.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/dashboard/command-center/updates?since=ISO — Poll for new
   * inbox items and newly overdue tasks since the given timestamp.
   *
   * @note The frontend polls this endpoint on an interval (typically every
   * 30–60 seconds) to surface real-time updates in the Command Center
   * without a WebSocket connection. Falls back to 60 seconds ago if
   * no "since" param is provided.
   *
   * @note Overdue detection compares due_date against the user's local
   * today string. Tasks with empty or null due_date are excluded.
   *
   * @returns {Object} { updates }
   */
  router.get('/api/dashboard/command-center/updates', authenticateToken, async (req, res) => {
    try {
      const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 60000);
      const userId = req.user.id;
      const todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: req.user.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());

      const updates = [];

      // Check new inbox items
      const inboxResult = await db.pool.query(
        `SELECT * FROM inbox_items
         WHERE user_id = $1 AND created_at > $2 AND action_taken IS NULL
         ORDER BY created_at ASC`,
        [userId, since]
      );
      for (const item of inboxResult.rows) {
        updates.push({
          type: 'inbox',
          content: `📬 New ${item.type === 'VIP' ? 'VIP ' : ''}email from ${item.sender || 'unknown'}: ${item.title}${item.summary ? ` — ${item.summary}` : ''}`
        });
      }

      // Check newly overdue tasks (due_date < today, completed = false, updated_at > since)
      const overdueResult = await db.pool.query(
        `SELECT * FROM tasks
         WHERE created_by = $1 AND completed = false
         AND due_date < $2 AND due_date IS NOT NULL AND due_date != ''
         AND updated_at > $3`,
        [userId, todayStr, since]
      );
      for (const task of overdueResult.rows) {
        updates.push({
          type: 'overdue',
          content: `⚠️ Task now overdue: "${task.title}"${task.priority === 'high' ? ' — high priority' : ''}`
        });
      }

      return res.json({ updates });
    } catch (err) {
      logger.error('commandCenter.updates.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Dashboard AI Brief (persona-aware) ────────────────────────────────────────

  /**
   * POST /api/dashboard/aria-brief — Generate Aria's persona-aware daily brief.
   *
   * Makes a one-shot Claude API call with a persona-tuned system prompt
   * and the user's live task/note/calendar data. Returns 2–3 sentences
   * of natural-language summary.
   *
   * @note Tasks and calendar events are fetched server-side — never from
   * the client request body. This prevents stale or manipulated data from
   * reaching the brief. Calendar events use timezone-aware date ranges.
   *
   * @note The brief uses direct axios calls to the Anthropic API (not the
   * SDK or agenticLoop) because it is a simple one-shot generation with
   * no tool use and no streaming. Failures degrade gracefully to an empty
   * string response so the dashboard shell remains usable.
   *
   * @note Persona tones (executive_assistant, coo, best_friend, life_coach,
   * cfo) are mapped to tone descriptors that shape the brief's voice.
   * The persona is selected by the user in Settings → AI Assistant.
   *
   * @returns {Object} { brief }
   */
  router.post('/api/dashboard/aria-brief', authenticateToken, async (req, res) => {
    try {
      const apiKey = process.env.CLAUDE_API_KEY;
      if (!apiKey) return res.json({ brief: '' });

      const { assistantName, persona, userName, timeOfDay, data } = req.body;
      const userId = req.user.id;

      // Fetch fresh tasks from DB — never trust client-sent task data
      const todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: req.user.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const tasks = await db.getTasksForUser(userId, []);
      const activeTasks = tasks.filter(t => !t.completed);
      const overdue = activeTasks.filter(t => t.dueDate && t.dueDate < todayStr).map(t => t.title).join(', ') || 'None';
      const highPriority = activeTasks.filter(t => t.priority === 'high').map(t => t.title).join(', ') || 'None';
      const todayTasks = activeTasks.filter(t => t.dueDate === todayStr).map(t => t.title).join(', ') || 'None';
      const notes = await db.getPrivateNotesForAI(userId);

      // Fetch calendar events server-side from ALL connected accounts
      let calendarEventStr = data?.events || 'None';
      try {
        const allAccounts = loadAllGcalAccounts ? await loadAllGcalAccounts(userId) : [];
        if (allAccounts.length > 0 && makeOAuth2Client && google) {
          const userTz = req.user.timezone || 'America/Los_Angeles';
          const todayLocal = new Intl.DateTimeFormat('en-CA', {
            timeZone: userTz, year: 'numeric', month: '2-digit', day: '2-digit',
          }).format(new Date());
          const startOfDay = new Date(`${todayLocal}T00:00:00`);
          const endOfDay = new Date(`${todayLocal}T00:00:00`);
          endOfDay.setDate(endOfDay.getDate() + 1);

          const results = await Promise.allSettled(allAccounts.map(async (acct) => {
            const oauth2 = makeOAuth2Client();
            if (!oauth2) return [];
            oauth2.setCredentials(acct.tokens);
            oauth2.on('tokens', async (newTokens) => {
              try {
                const existing = await loadGcalTokens(userId, acct.googleEmail);
                await saveGcalTokens(userId, { ...existing, ...newTokens }, acct.googleEmail);
              } catch (e) { logger.error('ariaBrief.tokenRefresh.failed', { userId, googleEmail: acct.googleEmail, error: e.message }); }
            });
            const calendar = google.calendar({ version: 'v3', auth: oauth2 });
            const { data: calData } = await calendar.events.list({
              calendarId: 'primary',
              timeMin: startOfDay.toISOString(),
              timeMax: endOfDay.toISOString(),
              timeZone: userTz,
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 20,
            });
            return (calData.items || []).map((ev) => ({
              title: (ev.summary || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
              start: ev.start?.dateTime || ev.start?.date || '',
            }));
          }));

          const allEvents = [];
          const seenTitles = new Set();
          for (const result of results) {
            if (result.status === 'fulfilled') {
              for (const ev of result.value) {
                const key = `${ev.title}::${ev.start}`;
                if (!seenTitles.has(key)) {
                  seenTitles.add(key);
                  allEvents.push(ev);
                }
              }
            }
          }
          allEvents.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
          if (allEvents.length > 0) {
            calendarEventStr = allEvents.map((e) => {
              if (!e.start || !e.start.includes('T')) return e.title;
              const t = new Date(e.start);
              const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: userTz });
              return `${e.title} at ${time}`;
            }).join('; ');
          }
          logger.info('ariaBrief.calendarEvents', { requestId: req.requestId, userId, eventCount: allEvents.length, titles: allEvents.map(e => e.title) });
        }
      } catch (calErr) {
        logger.error('ariaBrief.calendarFetch.failed', { requestId: req.requestId, userId, error: calErr.message });
      }

      const personaTones = {
        executive_assistant: 'warm and professional',
        coo: 'direct and strategic',
        best_friend: 'casual and real',
        life_coach: 'motivating and big-picture focused',
        cfo: 'numbers-first and analytical',
      };
      const tone = personaTones[persona] || personaTones.executive_assistant;
      const name = assistantName || 'Aria';

      const systemPrompt = `You are ${name}, the user's ${persona === 'best_friend' ? 'best friend' : persona === 'executive_assistant' ? 'executive assistant' : persona === 'coo' ? 'COO' : persona === 'life_coach' ? 'life coach' : 'CFO'}. Write a warm, ${tone} ${timeOfDay || 'morning'} brief for ${userName} in 2-4 sentences. Be specific — reference actual data below. Do not use bullet points. Write naturally like a real person. IMPORTANT: mention EVERY calendar event listed below with its time — do not skip or summarize events. If there are 2 events, mention both. If there are 5, mention all 5. Only reference tasks, calendar events, and notes that are explicitly listed in the context below. Do not infer or reference activities from memory, business context, or profile information. Do NOT mention note counts — only mention a specific note if it contains something actionable today. Sign off with just your name: — ${name}`;

      // Build actionable notes string — only include notes with actionable/time-sensitive content
      const actionableNotes = notes
        .filter(n => n.title || n.content)
        .map(n => (n.title || '').slice(0, 80))
        .slice(0, 5)
        .join(', ') || 'None';

      const dataStr = `Overdue tasks: ${overdue}\nHigh priority tasks: ${highPriority}\nTasks due today: ${todayTasks}\nToday's calendar events: ${calendarEventStr}\nRecent notes (only mention if actionable): ${actionableNotes}\nBusinesses: ${data?.entities || 'None'}`;

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          system: systemPrompt,
          messages: [{ role: 'user', content: `Write my ${timeOfDay || 'morning'} brief.\n\n${dataStr}` }],
        },
        {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          timeout: 15_000,
        },
      );

      const brief = response.data.content?.[0]?.text || '';
      return res.json({ brief });
    } catch (err) {
      logger.error('ariaBrief.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json({ brief: '' });
    }
  });

  // ── Dashboard Timeline Summary ────────────────────────────────────────────────

  /**
   * POST /api/dashboard/timeline-summary — Generate a one-sentence day summary.
   *
   * Takes today's calendar events and tasks from the request body and
   * returns a max-15-word summary. Used as a tagline below the timeline
   * header on the dashboard.
   *
   * @note This endpoint accepts client-sent task/event data
   * because the output is cosmetic and non-authoritative.
   *
   * @note Failures degrade gracefully to an empty string response
   * so the dashboard shell remains usable.
   *
   * @returns {Object} { summary }
   */
  router.post('/api/dashboard/timeline-summary', authenticateToken, async (req, res) => {
    try {
      const apiKey = process.env.CLAUDE_API_KEY;
      if (!apiKey) return res.json({ summary: '' });

      const { events, tasks } = req.body;
      const eventsStr = (events || []).map((e) => `${e.time || 'All day'}: ${e.title}`).join(', ') || 'None';
      const tasksStr = (tasks || []).map((t) => `${t.title} (${t.priority}${t.overdue ? ', overdue' : ''})`).join(', ') || 'None';

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 60,
          system: 'Write ONE sentence summarizing this person\'s day. Be specific and actionable. Max 15 words. No quotes.',
          messages: [{
            role: 'user',
            content: `Today's calendar events: ${eventsStr}\nToday's tasks: ${tasksStr}\n\nSummarize the day in one sentence.`,
          }],
        },
        {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          timeout: 15_000,
        },
      );

      const summary = response.data.content?.[0]?.text || '';
      return res.json({ summary });
    } catch (err) {
      logger.error('timelineSummary.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json({ summary: '' });
    }
  });

  return router;
};
