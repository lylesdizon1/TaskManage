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
const { fetchCalendarWindow, localMidnightUtc } = require('../lib/buildAgenticContext.cjs');
const { withRetry } = require('../lib/anthropicRetry.cjs');

/**
 * Compute the user's local hour, human-readable time, and time-state label.
 * Shared by /api/brief/context and /api/dashboard/aria-brief so both views
 * agree on the phase of day. Buckets:
 *   morning  5-10   midday  11-13   afternoon 14-17
 *   evening  18-20  wrapup  21-4
 */
function getTimeState(tz) {
  const zone = tz || 'America/Los_Angeles';
  const hour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hour12: false }).format(new Date()), 10);
  const localTime = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date());
  let state = 'wrapup';
  if (hour >= 5  && hour < 11) state = 'morning';
  else if (hour >= 11 && hour < 14) state = 'midday';
  else if (hour >= 14 && hour < 18) state = 'afternoon';
  else if (hour >= 18 && hour < 21) state = 'evening';
  return { state, hour, localTime };
}

/**
 * Return a YYYY-MM-DD string regardless of whether the DB returned the
 * timestamp as a Date object (TIMESTAMPTZ columns via node-postgres) or
 * as an ISO string (legacy code paths). Safe on null/undefined.
 */
function toDateStr(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

/**
 * Classify a GCal event into completed | live | upcoming relative to `now`.
 * Falls back to a 60-minute duration when the event has no end time.
 */
function classifyEvent(ev, nowMs) {
  const start = ev.start ? new Date(ev.start).getTime() : NaN;
  const end   = ev.end   ? new Date(ev.end).getTime()   : (Number.isFinite(start) ? start + 60 * 60 * 1000 : NaN);
  if (!Number.isFinite(start)) return 'upcoming';
  if (end <= nowMs)   return 'completed';
  if (start <= nowMs) return 'live';
  return 'upcoming';
}

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

      // Fetch calendar events: DB cache first, live GCal fallback.
      let calendarEventStr = data?.events || 'None';
      try {
        const userTz = req.user.timezone || 'America/Los_Angeles';
        let allEvents = [];
        if (db.getCalendarEventsForUser) {
          try {
            const startUtc = localMidnightUtc(userTz, 0);
            const endUtc   = localMidnightUtc(userTz, 1);
            const cached = await db.getCalendarEventsForUser(userId, startUtc, endUtc);
            if (cached && cached.length > 0) {
              allEvents = cached.map((e) => ({
                title: (e.title || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
                start: e.startTime ? new Date(e.startTime).toISOString() : '',
              }));
            }
          } catch { /* silent — fall through to live */ }
        }
        if (allEvents.length === 0) {
          allEvents = await fetchCalendarWindow({
            userId, tz: userTz, days: 1,
            loadAllGcalAccounts, loadGcalTokens, saveGcalTokens, makeOAuth2Client, google,
            logger, requestId: req.requestId,
          });
        }
        if (allEvents.length > 0) {
          calendarEventStr = allEvents.map((e) => {
            if (!e.start || !e.start.includes('T')) return e.title;
            const t = new Date(e.start);
            const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: userTz });
            return `${e.title} at ${time}`;
          }).join('; ');
        }
        logger.info('ariaBrief.calendarEvents', { requestId: req.requestId, userId, eventCount: allEvents.length, titles: allEvents.map(e => e.title), calendarEventStr });
      } catch (calErr) {
        logger.error('ariaBrief.calendarFetch.failed', { requestId: req.requestId, userId, error: calErr.message, stack: calErr.stack?.split('\n').slice(0, 3).join(' | ') });
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

      // Time-aware prose — tone + framing shifts across the day. User tz drives
      // state so the morning-brief cron (which hits this endpoint at 8am local)
      // naturally gets the 'morning' treatment.
      const userTz = req.user.timezone || 'America/Los_Angeles';
      const { state: timeState } = getTimeState(userTz);
      const timePrompts = {
        morning:   "It's morning. Set the day. Lead with the most important thing ahead. Be direct — 2-3 sentences max.",
        midday:    "It's midday. Assess progress. What's done, what's still open, what's the window. 2-3 sentences.",
        afternoon: "It's afternoon. One task left lens. What matters most before end of day. 2-3 sentences.",
        evening:   "It's evening. Wind down. What got done, what didn't. If tasks are still open or meetings just ended, mention them and offer to help close out or capture notes. 2-3 sentences.",
        wrapup:    "It's late. Be brief and reflective. Preview tomorrow if anything notable. 1-2 sentences.",
      };
      const commonRules = [
        'Use past tense for completed events ("you had", "you were in").',
        'Use future tense for upcoming ("you have", "coming up").',
        'Use present tense for live events ("you\'re in", "you\'re currently in").',
        'Reference specific names, companies, and times from context.',
        'Never start with "Good morning", "Good afternoon", or "Good evening".',
        'Never say "Here\'s your brief" or "Here\'s a summary". Never use the word "brief".',
        'Sound like a sharp human chief of staff, not a bot.',
      ].join(' ');

      const systemPrompt = `You are ${name}, ${userName}'s ${persona === 'best_friend' ? 'best friend' : persona === 'executive_assistant' ? 'executive assistant' : persona === 'coo' ? 'COO' : persona === 'life_coach' ? 'life coach' : 'CFO'}. Tone: ${tone}. ${timePrompts[timeState] || timePrompts.morning} ${commonRules} Only reference tasks, events, and notes explicitly listed below — never infer from memory or profile. Sign off with just your name: — ${name}`;

      // Build actionable notes string — only include notes with actionable/time-sensitive content
      const actionableNotes = notes
        .filter(n => n.title || n.content)
        .map(n => (n.title || '').slice(0, 80))
        .slice(0, 5)
        .join(', ') || 'None';

      const dataStr = `Overdue tasks: ${overdue}\nHigh priority tasks: ${highPriority}\nTasks due today: ${todayTasks}\nToday's calendar events: ${calendarEventStr}\nRecent notes (only mention if actionable): ${actionableNotes}\nBusinesses: ${data?.entities || 'None'}`;

      const response = await withRetry(
        () => axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 300,
            system: systemPrompt,
            messages: [{ role: 'user', content: `Write the ${timeState} update for ${userName}.\n\n${dataStr}` }],
          },
          {
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            timeout: 15_000,
          },
        ),
        'aria-brief',
      );

      const brief = response.data.content?.[0]?.text || '';
      return res.json({ brief });
    } catch (err) {
      logger.error('ariaBrief.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json({ brief: '' });
    }
  });

  /**
   * GET /api/brief/context — structured state for the dynamic Command Center
   * brief (Phase 2 frontend). Fails soft per section: partial failures return
   * whatever is available. Never 500s.
   */
  router.get('/api/brief/context', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const userTz = req.user.timezone || 'America/Los_Angeles';
    const { state: timeState, localTime } = getTimeState(userTz);
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: userTz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const nowMs = Date.now();

    // Tasks
    let overdue = [], dueToday = [], completedToday = [];
    try {
      const tasks = await db.getTasksForUser(userId, []);
      const projectTask = (t) => ({ id: t.id, title: t.title, priority: t.priority, due_date: t.dueDate || null, due_time: t.dueTime || null });
      overdue = tasks
        .filter(t => !t.completed && t.dueDate && t.dueDate < todayLocal)
        .map(projectTask);
      dueToday = tasks
        .filter(t => !t.completed && t.dueDate === todayLocal)
        .map(projectTask);
      completedToday = tasks
        .filter(t => t.completed && t.completedAt && toDateStr(t.completedAt) === todayLocal)
        .map(projectTask);
    } catch (e) {
      logger.error('brief.context.tasks.failed', { requestId: req.requestId, userId, error: e.message });
    }

    // Events — DB-first, fall back to live fetchCalendarWindow on empty/err.
    let completed = [], live = [], upcoming = [];
    try {
      let events = [];
      if (db.getCalendarEventsForUser) {
        try {
          const startUtc = localMidnightUtc(userTz, 0);
          const endUtc   = localMidnightUtc(userTz, 1);
          const cached = await db.getCalendarEventsForUser(userId, startUtc, endUtc);
          if (cached && cached.length > 0) {
            events = cached.map((e) => ({
              id: e.id || null,
              accountEmail: e.accountEmail || null,
              title: e.title || '(No title)',
              start: e.startTime ? new Date(e.startTime).toISOString() : '',
              end:   e.endTime   ? new Date(e.endTime).toISOString()   : '',
            }));
          }
        } catch { /* silent fallback */ }
      }
      if (events.length === 0) {
        events = await fetchCalendarWindow({
          userId, tz: userTz, days: 1,
          loadAllGcalAccounts, loadGcalTokens, saveGcalTokens, makeOAuth2Client, google,
          logger, requestId: req.requestId,
        });
      }
      for (const ev of (events || [])) {
        const bucket = classifyEvent(ev, nowMs);
        // Preserve id + accountEmail when available so client-side handlers
        // (e.g. onSaveMeetingNotes) can reference the event unambiguously.
        const entry = { id: ev.id || null, accountEmail: ev.accountEmail || null, title: ev.title, start: ev.start, end: ev.end };
        if (bucket === 'completed') completed.push(entry);
        else if (bucket === 'live')  live.push(entry);
        else upcoming.push(entry);
      }
    } catch (e) {
      logger.error('brief.context.events.failed', { requestId: req.requestId, userId, error: e.message });
    }

    // Important unread emails
    let needsAttention = [];
    try {
      if (db.getImportantUnread) {
        const rows = await db.getImportantUnread(userId, 3);
        needsAttention = (rows || []).map(r => ({
          vendor: r.vendor || null,
          summary: r.summary || null,
          category: r.category || null,
          importance: r.importance || null,
          entityName: r.entityName || null,
          classifiedAt: r.classifiedAt || null,
          actionRequired: !!r.actionRequired,
        }));
      }
    } catch (e) {
      logger.error('brief.context.emails.failed', { requestId: req.requestId, userId, error: e.message });
    }

    // Meetings that recently ended and don't yet have matching notes.
    // Non-fatal: surface an empty array if the helper fails or isn't
    // deployed yet.
    let meetingsNeedingNotes = [];
    try {
      if (db.getMeetingsNeedingNotes) {
        const rows = await db.getMeetingsNeedingNotes(userId);
        meetingsNeedingNotes = (rows || []).map((m) => ({
          id: m.id,
          title: m.title,
          startTime: m.startTime,
          endTime: m.endTime,
          entityId: m.entityId || null,
        }));
      }
    } catch (e) {
      logger.error('brief.context.notesNeeded.failed', { requestId: req.requestId, userId, error: e.message });
    }

    // Active projects + open project tasks for the CC integration.
    let projects = [];
    let openProjectTasks = [];
    try {
      if (db.getProjectContextForUser) {
        projects = await db.getProjectContextForUser(userId, 3);
      }
    } catch (e) {
      logger.error('brief.context.projects.failed', { requestId: req.requestId, userId, error: e.message });
    }
    try {
      if (db.getOpenProjectTasksForUser) {
        openProjectTasks = await db.getOpenProjectTasksForUser(userId, 5);
      }
    } catch (e) {
      logger.error('brief.context.projectTasks.failed', { requestId: req.requestId, userId, error: e.message });
    }

    const stats = {
      tasksCompletedToday: completedToday.length,
      tasksTotalToday: dueToday.length + completedToday.length,
      meetingsDone: completed.length,
      meetingsTotal: completed.length + live.length + upcoming.length,
    };

    // ── Close-loop queue: open pending_close_loop rows for this user ──
    // Dismissals are scoped to today's local-midnight boundary so a
    // "not now" press resurfaces the item tomorrow (per Phase 0 decision).
    let closeLoopQueue = [];
    try {
      if (db.getOpenCloseLoopItems) {
        const localMidnightBoundary = localMidnightUtc(userTz, 0);
        closeLoopQueue = await db.getOpenCloseLoopItems(userId, localMidnightBoundary, 5);
      }
    } catch (e) {
      logger.error('brief.context.closeLoop.failed', { requestId: req.requestId, userId, error: e.message });
    }

    // ── Daily Wrap web-trigger: atomic claim so two tabs can't both fire ──
    // wrapReminderReady is TRUE on exactly the one response that won the
    // claim insert; subsequent fetches (any tab, same day) see FALSE.
    // DashboardPanel uses it to push a single assistant CC message.
    let wrapReminderReady = false;
    try {
      // Locate the user's Daily Wrap alertRule (parallel to morning-brief).
      let wrapTimeHHMM = null;
      try {
        const { rows } = await db.pool.query(
          `SELECT value_json FROM user_settings WHERE user_id = $1 AND setting_key = 'alertRules'`,
          [userId],
        );
        const rules = Array.isArray(rows[0]?.value_json) ? rows[0].value_json : [];
        const rule = rules.find((r) => r?.condition?.type === 'daily-wrap' && r?.enabled !== false);
        if (rule) wrapTimeHHMM = rule?.condition?.time || '18:00';
      } catch { /* no rule → feature off for this user */ }

      if (wrapTimeHHMM) {
        const nowLocalHHMM = new Intl.DateTimeFormat('en-US', {
          timeZone: userTz, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date()).replace(/\s/g, '');
        const todayDateKey = new Intl.DateTimeFormat('en-CA', {
          timeZone: userTz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        const timeDue = nowLocalHHMM >= wrapTimeHHMM;
        if (timeDue) {
          const wrapped = db.hasCompletedWrap ? await db.hasCompletedWrap(userId, todayDateKey) : false;
          if (!wrapped && db.checkAndLockDailyWrapWeb) {
            const alreadyClaimed = await db.checkAndLockDailyWrapWeb(userId, todayDateKey);
            wrapReminderReady = !alreadyClaimed;
          }
        }
      }
    } catch (e) {
      logger.error('brief.context.wrapReminder.failed', { requestId: req.requestId, userId, error: e.message });
    }

    // Single-tile priority: daily_wrap > close_loop > null.
    // DashboardPanel reads this once per fetch and surfaces the winning
    // tile only when the zone is empty and the user isn't mid-send.
    let activeZoneSuggestion = null;
    if (wrapReminderReady) activeZoneSuggestion = 'daily_wrap';
    else if (closeLoopQueue.length > 0 || meetingsNeedingNotes.length > 0) activeZoneSuggestion = 'close_loop';

    return res.json({
      timeState,
      localTime,
      tasks: { overdue, dueToday, completedToday },
      events: { completed, live, upcoming },
      emails: { needsAttention },
      meetingsNeedingNotes,
      projects,
      projectTasks: { open: openProjectTasks },
      stats,
      closeLoopQueue,
      wrapReminderReady,
      activeZoneSuggestion,
    });
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
