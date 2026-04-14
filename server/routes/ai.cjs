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
const { ARIA_TOOLS, executeTool, getToolByName, getToolSchemasForApi, requiresConfirmation } = require('../tools.cjs');
const { getTodayLocal } = require('../utils/date.cjs');
const { runAgenticLoop } = require('../lib/agenticLoop.cjs');
const { buildAgenticContext } = require('../lib/buildAgenticContext.cjs');
const { handlePossibleCorrection } = require('../lib/learningHandler.cjs');
const logger = require('../../guardrails/logger.cjs');

// Confirmation waiters now use pg LISTEN/NOTIFY (db.listenForConfirmation /
// db.notifyConfirmation). The DB's pending_confirmations row is the
// authoritative state; NOTIFY carries advisory payload metadata. No
// in-memory waiter map — survives restarts and horizontal scaling.

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
function createAiRouter({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, makeOAuth2Client, google }) {
  const router = express.Router();

  // ── GCal token cache (5-minute TTL per user) ───────────────────────────────
  const gcalTokenCache = new Map();
  const GCAL_TOKEN_TTL = 5 * 60 * 1000;

  async function getCachedGcalTokens(userId) {
    const cached = gcalTokenCache.get(userId);
    if (cached && Date.now() - cached.ts < GCAL_TOKEN_TTL) {
      return cached.tokens;
    }
    const tokens = await loadGcalTokens(userId);
    if (tokens) {
      gcalTokenCache.set(userId, { tokens, ts: Date.now() });
    }
    return tokens;
  }

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

    const { messages, systemPrompt: clientPrompt, model: reqModel, timeZone, context_hint } = req.body;
    const model = reqModel || 'claude-sonnet-4-20250514';

    // Hoist finalizeStream so the sibling catch block can reference it even
    // when an error occurs before the try-body assignment runs. The no-op
    // default covers the pre-flushHeaders failure mode (catch returns JSON).
    let finalizeStream = () => {};

    try {
      const userTz = timeZone || req.user.timezone || 'America/Los_Angeles';
      const ctx = await buildAgenticContext({
        userId, entityIds, db, tz: userTz, contextHint: context_hint,
        loadAllGcalAccounts, loadGcalTokens, saveGcalTokens,
        makeOAuth2Client, google, logger, requestId: req.requestId,
      });
      const tz = ctx.tz;
      // Always forward learnings + email + projects + outcomes + facts to
      // the model, even when the client supplies its own base system prompt.
      // Missing projectsBlock here was the bug where Aria claimed no project
      // access despite getProjectContextForUser returning rows.
      const serverBlocks = (ctx.learningsBlock || '') + (ctx.emailBlock || '') + (ctx.outcomesBlock || '') + (ctx.factsBlock || '') + (ctx.projectsBlock || '');
      const fullSystem = clientPrompt
        ? ctx.profileContext + clientPrompt + ctx.decisionInstructions + serverBlocks + ctx.contextBlock
        : ctx.systemPrompt;

      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Idempotent SSE writer + single-shot finalizer. Every terminal path
      // (happy return, gate-cancel resume, extractor failure, thrown error,
      // timeout) funnels through finalizeStream so `done` + res.end() fire
      // exactly once regardless of how control leaves the handler.
      let streamFinalized = false;
      const send = (event, data) => {
        if (streamFinalized) return;
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
      };
      finalizeStream = (payload = {}) => {
        if (streamFinalized) return;
        streamFinalized = true;
        logger.info('chat.stream.finalized', { requestId: req.requestId, userId, hasError: !!payload.error, hasText: !!(payload.text && payload.text.length) });
        try {
          if (payload.error) {
            res.write(`event: error\ndata: ${JSON.stringify({ message: payload.error })}\n\n`);
          } else {
            res.write(`event: text\ndata: ${JSON.stringify({ content: payload.text || '' })}\n\n`);
            if (payload.toolSummaries?.length) {
              res.write(`event: tools_executed\ndata: ${JSON.stringify({ tools: payload.toolSummaries.map(s => s.tool), summaries: payload.toolSummaries })}\n\n`);
            }
            if (payload.maxIterationsReached) {
              res.write(`event: warning\ndata: ${JSON.stringify({ message: 'Step limit reached' })}\n\n`);
            }
          }
          res.write(`event: done\ndata: {}\n\n`);
        } catch {}
        try { res.end(); } catch {}
      };

      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db, tz);

      const onProgress = ({ type, tool, input, result, error }) => {
        if (type === 'tool_start')    send('tool_start',    { tool, input });
        if (type === 'tool_complete') send('tool_complete', { tool, result });
        if (type === 'tool_error')    send('tool_error',    { tool, error });
      };

      const logAction = async (event) => {
        await db.logAgentAction({
          userId,
          eventType: event.eventType,
          toolName: event.toolName || null,
          input: event.input,
          output: event.output,
          status: event.status,
          errorMsg: event.errorMsg,
          confidence: event.decision?.confidence,
          risk: event.decision?.risk,
          confirmId: event.confirmId,
        });
      };

      const gateToolExecution = async ({ tool, input, decision }) => {
        if (!requiresConfirmation(tool, decision)) return { action: 'allow' };

        let pending;
        try {
          pending = await db.createPendingConfirmation({ userId, toolName: tool, params: input, channel: 'web' });
        } catch (err) {
          logger.error('chat.gate.pendingCreate.failed', { requestId: req.requestId, userId, tool, error: err.message });
          // Fail closed: deny execution so the loop resumes and finalizes.
          return { action: 'deny', reason: 'pending_create_failed', message: `Could not request confirmation for ${tool}.` };
        }

        // For email-composition tools, emit the full draft before the
        // approval card so the thread shows the complete message.
        if (tool === 'send_email') {
          send('email_draft', {
            draft: {
              from: input.account_email || '',
              to: input.to || '',
              subject: input.subject || '',
              body: input.body || '',
            },
          });
        }

        send('tool_confirm', { tool, params: input, confirm_id: pending.id, risk: getToolByName(tool)?.risk || 'high' });
        logger.info('chat.gate.waiter.created', { requestId: req.requestId, userId, tool, confirmId: pending.id });
        await logAction({ eventType: 'confirmation_requested', toolName: tool, input, confirmId: pending.id, decision });

        // Abort the listener (releases its dedicated pg client) if the SSE
        // response closes before the user confirms.
        const listenController = new AbortController();
        const onResClose = () => { try { listenController.abort(); } catch {} };
        res.once('close', onResClose);

        try {
          const resolution = await db.listenForConfirmation(pending.id, 2 * 60 * 1000, { signal: listenController.signal });
          res.removeListener('close', onResClose);
          logger.info('chat.gate.waiter.resolved', { requestId: req.requestId, userId, tool, confirmId: pending.id, action: resolution?.action, alreadyExecuted: !!resolution?.alreadyExecuted });
          return resolution;
        } catch (err) {
          res.removeListener('close', onResClose);
          if (err.message === 'confirmation_timeout') {
            await db.updatePendingConfirmationStatus(pending.id, userId, 'expired').catch(() => {});
            await logAction({ eventType: 'tool_cancelled', toolName: tool, input, errorMsg: 'expired', confirmId: pending.id });
            logger.info('chat.gate.waiter.expired', { requestId: req.requestId, userId, tool, confirmId: pending.id });
            return { action: 'deny', reason: 'expired', message: `Confirmation for ${tool} timed out.` };
          }
          if (err.message === 'confirmation_aborted') {
            logger.info('chat.gate.waiter.aborted', { requestId: req.requestId, userId, tool, confirmId: pending.id });
            return { action: 'deny', reason: 'client_disconnected', message: `Confirmation for ${tool} was not acknowledged.` };
          }
          logger.error('chat.gate.listen.failed', { requestId: req.requestId, userId, tool, confirmId: pending.id, error: err.message });
          return { action: 'deny', reason: 'listen_failed', message: `Could not wait for confirmation for ${tool}.` };
        }
      };

      const loopResult = await runAgenticLoop({
        messages,
        system: fullSystem,
        tools: getToolSchemasForApi(),
        userId,
        executeTool: boundExecuteTool,
        onProgress,
        gateToolExecution,
        logAction,
        model,
      });
      let { text, toolSummaries, maxIterationsReached } = loopResult;

      // ── Correction learning: detect → extract → persist → ack ──
      try {
        const lastUserContent = [...messages].reverse().find(m => m.role === 'user')?.content;
        const lastUserMsg = typeof lastUserContent === 'string'
          ? lastUserContent
          : Array.isArray(lastUserContent)
            ? (lastUserContent.find(b => b?.type === 'text')?.text || '')
            : '';
        if (lastUserMsg) {
          const { acknowledgment } = await handlePossibleCorrection({
            userId, userMessage: lastUserMsg, lastAssistantMessage: text || null, db,
          });
          if (acknowledgment) text = (text || '') + acknowledgment;
        }
      } catch (err) {
        logger.error('chat.learning.failed', { requestId: req.requestId, userId, error: err.message });
      }

      finalizeStream({ text, toolSummaries, maxIterationsReached });
      return;
    } catch (err) {
      logger.error('chat.execute.failed', { requestId: req.requestId, userId, error: err.message });
      // If headers never flushed, fall back to a JSON error. Otherwise
      // route through finalizeStream so `done` + res.end fire once.
      if (!res.headersSent) {
        try { return res.status(500).json({ error: err.message }); } catch { /* fallthrough */ }
      }
      finalizeStream({ error: err.message });
      return;
    }
  });

  // ── User-facing confirmation endpoint (resumes a paused agentic loop) ────
  router.post('/api/chat/confirm', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { confirm_id, approved, account_email, to_override, body_override } = req.body || {};
      if (!confirm_id) return res.status(400).json({ error: 'confirm_id required' });

      const pending = await db.getPendingConfirmation(confirm_id, userId);
      if (!pending) return res.status(404).json({ error: 'Confirmation not found' });
      if (pending.status !== 'pending') return res.status(409).json({ error: `Already ${pending.status}` });
      if (pending.expiresAt && new Date(pending.expiresAt) < new Date()) {
        await db.updatePendingConfirmationStatus(confirm_id, userId, 'expired').catch(() => {});
        return res.status(410).json({ error: 'Confirmation expired' });
      }

      const nextStatus = approved ? 'approved' : 'rejected';
      const overrides = {};
      if (account_email) overrides.account_email = account_email;
      if (to_override)   overrides.to = to_override;
      if (typeof body_override === 'string') overrides.body = body_override;
      const resolution = approved
        ? { action: 'allow', overrides }
        : { action: 'deny', reason: 'user_rejected', message: `User cancelled ${pending.toolName}.` };

      // DB update first (row is authoritative, resolution_json persisted so
      // the listener's re-read path works even if NOTIFY is lost). NOTIFY is
      // the wake-up signal only.
      await db.updatePendingConfirmationStatus(confirm_id, userId, nextStatus, resolution).catch(() => {});
      await db.logAgentAction({
        userId,
        eventType: approved ? 'confirmation_approved' : 'confirmation_rejected',
        toolName: pending.toolName,
        input: pending.params,
        confirmId: confirm_id,
      });

      try {
        await db.notifyConfirmation(confirm_id, resolution);
      } catch (e) {
        // Non-fatal: listener re-reads resolution_json on LISTEN so it still
        // recovers the full payload even without NOTIFY delivery.
        logger.warn('chat.confirm.notify.failed', { requestId: req.requestId, userId, confirmId: confirm_id, error: e.message });
      }
      return res.json({ success: true, status: nextStatus });
    } catch (err) {
      logger.error('chat.confirm.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createAiRouter;
module.exports.createAiRouter = createAiRouter;
