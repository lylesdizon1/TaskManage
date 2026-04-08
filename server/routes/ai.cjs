'use strict';

/**
 * server/routes/ai.cjs — Web chat entry point for Aria with SSE streaming.
 *
 * Provides three endpoint categories:
 *   1. /api/claude, /api/openai — thin API proxies (pass-through to LLM APIs)
 *   2. /api/chat/stream — SSE streaming proxy for raw Claude conversations
 *   3. /api/chat/execute — Aria's agentic chat with tool use and live context
 *
 * Responsibility:
 *   - Authenticate requests via JWT (all endpoints require authenticateToken)
 *   - Build Aria's system prompt with live context (tasks, notes, calendar, memories)
 *   - Handle web chat transport, including standard JSON proxy
 *     responses and SSE streaming endpoints
 *   - Forward tool execution progress events to the client in real time
 *
 * Inputs:
 *   - POST /api/chat/execute — JWT-authenticated. Body: { messages, systemPrompt,
 *     model?, timeZone? }. The frontend's Command Center sends conversations here.
 *
 * Dependencies:
 *   - server/lib/agenticLoop.cjs — multi-turn AI tool-use loop
 *   - server/tools.cjs — ARIA_TOOLS schema + executeTool handler
 *   - server/utils/date.cjs — timezone-aware date formatting
 *   - @anthropic-ai/sdk — direct streaming for /api/chat/stream
 *   - axios — HTTP proxy for /api/claude and /api/openai
 *   - db.cjs — user/task/note/memory queries (injected)
 *   - googleapis — GCal event fetching (injected)
 *
 * Boundaries:
 *   - This module handles transport (SSE streaming) and context building.
 *     All AI reasoning and tool execution lives in agenticLoop.cjs and tools.cjs.
 *   - Context building (system prompt + live data) is shared with whatsapp.cjs.
 *     Both surfaces build the same Aria context but deliver differently:
 *     this module streams via SSE with real-time tool progress; whatsapp.cjs
 *     fires and replies in a single message after the loop completes.
 *
 * @note The /api/claude and /api/openai endpoints are thin proxies — they
 * forward the request body to the respective LLM API and return the response.
 * They exist so the frontend never needs direct API keys in the browser.
 *
 * @note The /api/chat/execute endpoint uses SSE (Server-Sent Events) to stream
 * tool execution progress and the final response to the browser. Events:
 *   - tool_start: { tool, input } — fired when Aria begins executing a tool
 *   - tool_complete: { tool, result } — fired when a tool succeeds
 *   - tool_error: { tool, error } — fired when a tool fails
 *   - text: { content } — final assistant response text
 *   - tools_executed: { tools, summaries } — summary of all tools run
 *   - warning: { message } — emitted if the iteration cap was hit
 *   - done: {} — signals stream end
 */

const express   = require('express');
const axios     = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { ARIA_TOOLS, executeTool } = require('../tools.cjs');
const { getTodayLocal } = require('../utils/date.cjs');
const { runAgenticLoop } = require('../lib/agenticLoop.cjs');

/**
 * Factory function that creates the AI router with all chat and proxy endpoints.
 *
 * @param {Object} deps - Injected dependencies.
 * @param {Function} deps.authenticateToken - JWT auth middleware from server/middleware/auth.cjs.
 * @param {Object} deps.db - Database helper module (db.cjs).
 * @param {Function} deps.loadGcalTokens - Async function to load + decrypt GCal tokens for a user.
 * @param {Function} deps.makeOAuth2Client - Factory for Google OAuth2 client.
 * @param {Object} deps.google - googleapis module for GCal API calls.
 * @returns {express.Router} Mounted by proxy-server.cjs.
 *
 * @note executeTool is imported from tools.cjs and bound with user context
 * before being passed into agenticLoop. This module does not implement tool
 * logic directly; it injects executeTool into agenticLoop and handles transport.
 */
module.exports = function createAiRouter({ authenticateToken, db, loadGcalTokens, makeOAuth2Client, google }) {
  const router = express.Router();

  // ── Claude proxy ────────────────────────────────────────────────────────────

  /**
   * POST /api/claude — Thin proxy to the Anthropic Messages API.
   * Body: { apiKey?: string, ...anthropicPayload }.
   * Falls back to CLAUDE_API_KEY env var if apiKey not in body.
   *
   * @note The apiKey check `!bodyKey.includes('****')` prevents the
   * frontend from accidentally sending a masked key placeholder.
   *
   * @note Authenticated but thin pass-through proxy. Caller-side
   * validation and rate limiting still matter — request bodies are
   * forwarded largely unchanged to the upstream LLM API.
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
   * POST /api/chat/stream — SSE streaming proxy to Claude.
   * Body: { apiKey?: string, ...anthropicPayload }.
   * Falls back to CLAUDE_API_KEY env var if apiKey not in body.
   *
   * @note This endpoint does not inject Aria context, does not
   * execute tools, and does not emit tool progress events.
   * For Aria's agentic chat, use /api/chat/execute.
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
   * POST /api/openai — Thin proxy to the OpenAI Chat Completions API.
   * Body: { apiKey?: string, ...openaiPayload }.
   * Falls back to OPENAI_API_KEY env var if apiKey not in body.
   *
   * @note Authenticated but thin pass-through proxy. Caller-side
   * validation and rate limiting still matter — request bodies are
   * forwarded largely unchanged to the upstream LLM API.
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

  /**
   * POST /api/chat/execute — Aria's agentic chat endpoint with SSE streaming.
   *
   * Flow: authenticate → load live context (tasks, notes, calendar, memories) →
   * build system prompt → open SSE connection → run agentic loop with
   * onProgress callback → stream tool events and final text → close.
   *
   * @note Context building loads the user's own tasks (never shared/entity tasks)
   * to prevent cross-user data leaks when the user has broad entityIds
   * (e.g. superadmin sees all entities). The empty array passed to
   * getTasksForUser() disables entity-based task loading intentionally.
   *
   * @note The onProgress callback bridges agenticLoop to SSE: each tool_start,
   * tool_complete, and tool_error event is forwarded to the browser in real time.
   * This is what makes the Command Center show live "Creating task..." status
   * updates. In contrast, whatsapp.cjs passes no onProgress — it waits for
   * the full loop to complete before sending a single reply.
   *
   * @note SSE streaming pattern: headers are set and flushed before the agentic
   * loop starts. If the loop throws, the error is written as an SSE event
   * (not an HTTP error status) because headers have already been sent.
   * The client must handle error events from the stream.
   *
   * @note The client is responsible for closing the EventSource
   * when the 'done' event is received or when the component
   * unmounts to prevent connection leaks.
   */
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
      // Only load user's OWN tasks for AI context — never include shared/entity tasks
      // to prevent cross-user data leak (superadmin entityIds = all entities)
      const tasks = await db.getTasksForUser(userId, []);
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

      const tz = timeZone || req.user.timezone;
      const todayStr = getTodayLocal(tz);
      const todayDate = todayStr.split(', ')[1];
      const currentTime = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date());
      const activeTasks = tasks.filter(t => !t.completed);
      const contextAppend = `\n\nCurrent time: ${currentTime} (${tz}). When setting due times, use the user's local timezone — NOT UTC.\n\n## Live Data\nActive tasks (${activeTasks.length}): ${
        activeTasks.slice(0, 30).map(t =>
          `[${t.id}] ${t.title} (${t.priority}${t.dueDate ? ', due ' + t.dueDate : ''}${t.dueDate && t.dueDate < todayDate ? ', OVERDUE' : ''})`
        ).join('; ') || 'none'
      }\nRecent notes: ${notes.slice(0, 10).map(n => n.title).join(', ') || 'none'
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
      const fullSystem = profileContext + (systemPrompt || '') + contextAppend;

      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db, tz);

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
