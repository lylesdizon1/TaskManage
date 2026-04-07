'use strict';

const express   = require('express');
const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { ARIA_TOOLS, executeTool } = require('../tools.cjs');
const { runAgenticLoop } = require('../lib/agenticLoop.cjs');

/**
 * Creates the AI proxy router.
 * @param {Object} deps
 * @param {Function} deps.authenticateToken
 * @param {Object}   deps.db
 * @param {Function} deps.loadGcalTokens
 * @param {Function} deps.makeOAuth2Client
 * @param {Object}   deps.google
 * @returns {express.Router}
 */
module.exports = function createAiRouter({ authenticateToken, db, loadGcalTokens, makeOAuth2Client, google }) {
  const router = express.Router();

  // ── Claude proxy ────────────────────────────────────────────────────────────

  /**
   * Claude proxy
   * Body: { apiKey?: string, ...anthropicPayload }
   * Falls back to CLAUDE_API_KEY env var if apiKey not in body.
   */
  router.post('/api/claude', authenticateToken, async (req, res) => {
    const { apiKey: bodyKey, ...body } = req.body;
    const apiKey = (bodyKey && !bodyKey.includes('****')) ? bodyKey : process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(401).json({ error: 'Missing apiKey in request body' });

    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        body,
        {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 60_000,
        },
      );
      return res.status(response.status).json(response.data);
    } catch (err) {
      return res.status(err.response?.status || 502).json(
        err.response?.data || { error: err.message },
      );
    }
  });

  // ── Claude streaming proxy (SSE) ────────────────────────────────────────────

  /**
   * Claude streaming proxy (SSE)
   * Body: { apiKey?: string, ...anthropicPayload }
   * Falls back to CLAUDE_API_KEY env var if apiKey not in body.
   */
  router.post('/api/chat/stream', authenticateToken, async (req, res) => {
    const { apiKey: bodyKey, ...body } = req.body;
    const apiKey = (bodyKey && !bodyKey.includes('****')) ? bodyKey : process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(401).json({ error: 'Missing apiKey' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
      const client = new Anthropic({ apiKey });
      const stream = client.messages.stream(body);

      stream.on('text', (text) => {
        res.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
      });

      stream.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
      });

      stream.on('error', (err) => {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      });

      req.on('close', () => {
        stream.abort();
      });
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  });

  // ── OpenAI proxy ────────────────────────────────────────────────────────────

  /**
   * OpenAI proxy
   * Body: { apiKey?: string, ...openaiPayload }
   * Falls back to OPENAI_API_KEY env var if apiKey not in body.
   */
  router.post('/api/openai', authenticateToken, async (req, res) => {
    const { apiKey: bodyKey, ...body } = req.body;
    const apiKey = (bodyKey && !bodyKey.includes('****')) ? bodyKey : process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(401).json({ error: 'Missing apiKey in request body' });

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        body,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          timeout: 60_000,
        },
      );
      return res.status(response.status).json(response.data);
    } catch (err) {
      return res.status(err.response?.status || 502).json(
        err.response?.data || { error: err.message },
      );
    }
  });

  // ── Chat Execute (server-side tool loop) ───────────────────────────────────

  router.post('/api/chat/execute', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const entityIds = req.user.entityIds || [];
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });

    const { messages, systemPrompt, model: reqModel, timeZone } = req.body;
    const model = reqModel || 'claude-sonnet-4-20250514';

    try {
      // Load user context
      const user = await db.getUserById(userId);
      const tasks = await db.getTasksForUser(userId, entityIds);
      const notes = await db.getPrivateNotesForAI(userId);

      let calendarEvents = [];
      try {
        const tokens = await loadGcalTokens(userId);
        if (tokens) {
          const oauth2 = makeOAuth2Client();
          if (oauth2) {
            oauth2.setCredentials(tokens);
            const calendar = google.calendar({ version: 'v3', auth: oauth2 });
            const now = new Date();
            const weekOut = new Date(now);
            weekOut.setDate(weekOut.getDate() + 7);
            const { data } = await calendar.events.list({
              calendarId: 'primary',
              timeMin: now.toISOString(),
              timeMax: weekOut.toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 20,
            });
            calendarEvents = (data.items || []).map(ev => ({
              title: (ev.summary || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
              start: ev.start?.dateTime || ev.start?.date || '',
            }));
          }
        }
      } catch (calErr) {
        console.error('[chat/execute] calendar fetch failed:', calErr.message);
      }

      let recentMemories = [];
      try { recentMemories = await db.getRecentMemories(userId, 20); } catch {}

      const tz = timeZone || 'America/Los_Angeles';
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const activeTasks = tasks.filter(t => !t.completed);
      const contextAppend = `\n\n## Live Data\nActive tasks (${activeTasks.length}): ${
        activeTasks.slice(0, 30).map(t =>
          `[${t.id}] ${t.title} (${t.priority}${t.dueDate ? ', due ' + t.dueDate : ''}${t.dueDate && t.dueDate < todayStr ? ', OVERDUE' : ''})`
        ).join('; ') || 'none'
      }\nRecent notes: ${notes.slice(0, 10).map(n => n.title).join(', ') || 'none'
      }\nCalendar next 7 days: ${calendarEvents.map(ev => `${ev.start} — ${ev.title}`).join('; ') || 'none'
      }\nRecent Aria actions (last 10): ${
        recentMemories.length
          ? recentMemories.slice(0, 10).map(m =>
              `[${new Date(m.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}] ${m.content}`
            ).join('; ')
          : 'none yet'
      }`;
      const profileParts = [];
      if (user.profileName)       profileParts.push(`You are helping ${user.profileName}.`);
      if (user.profileBusinesses) profileParts.push(`Businesses: ${user.profileBusinesses}.`);
      if (user.profileHousehold)  profileParts.push(`Household context: ${user.profileHousehold}.`);
      if (user.profileLocation)   profileParts.push(`Based in: ${user.profileLocation}.`);
      if (user.profileNotes)      profileParts.push(`Additional context: ${user.profileNotes}.`);
      const profileContext = profileParts.length ? profileParts.join(' ') + '\n\n' : '';
      const fullSystem = profileContext + (systemPrompt || '') + `\nToday's date is ${todayStr}.` + contextAppend;

      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db);

      const onProgress = ({ type, tool, input, result, error }) => {
        if (type === 'tool_start')    send('tool_start',    { tool, input });
        if (type === 'tool_complete') send('tool_complete', { tool, result });
        if (type === 'tool_error')    send('tool_error',    { tool, error });
      };

      const { text, toolSummaries, maxIterationsReached } = await runAgenticLoop({
        messages,
        system: fullSystem,
        tools: ARIA_TOOLS,
        userId,
        executeTool: boundExecuteTool,
        onProgress,
        model,
      });

      send('text', { content: text });

      if (toolSummaries.length > 0) {
        send('tools_executed', { tools: toolSummaries.map(s => s.tool), summaries: toolSummaries });
      }

      if (maxIterationsReached) {
        send('warning', { message: 'Step limit reached' });
      }

      send('done', {});
      res.end();
    } catch (err) {
      console.error('[chat/execute] Error:', err.message);
      res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      res.end();
    }
  });

  return router;
};
