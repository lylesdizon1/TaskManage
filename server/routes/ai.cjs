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
const Sentry    = require('@sentry/node');
const { ARIA_TOOLS, executeTool, getToolByName, getToolSchemasForApi, requiresConfirmation } = require('../tools.cjs');
const { getTodayLocal } = require('../utils/date.cjs');
const { buildAgenticContext } = require('../lib/buildAgenticContext.cjs');
const { handleConversationTurn, applyCorrectionAndEnrichment } = require('../lib/conversationTurn.cjs');
const logger = require('../../guardrails/logger.cjs');
const { userRateLimit } = require('../middleware/userRateLimit.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');

const chatExecuteLimit = userRateLimit({ key: 'chat-execute', limit: 50, windowSec: 3600 });
const chatWarmupLimit  = userRateLimit({ key: 'chat-warmup',  limit: 15, windowSec: 3600 });
const ttsLimit         = userRateLimit({ key: 'tts',          limit: 100, windowSec: 3600 });

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
// ── Proxy payload sanitisation ──────────────────────────────────────────────
// Both /api/claude and /api/chat/stream forward the body verbatim to
// Anthropic's API on the server's CLAUDE_API_KEY. Without these guards,
// any authed user could (a) pick an arbitrary expensive model, (b) ask
// for an unbounded max_tokens, or (c) attach `tools` definitions that
// bypass the agentic-gating + confirmation flow on /api/chat/execute.
const PROXY_ALLOWED_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);
const PROXY_MAX_TOKENS_CAP = 8192;

function sanitizeProxyPayload(input, label, userId) {
  if (!input || typeof input !== 'object') return { error: 'Invalid payload' };
  const model = input.model;
  if (!model || !PROXY_ALLOWED_MODELS.has(model)) {
    return { error: `Model "${model || ''}" not permitted via proxy` };
  }
  const requestedMax = parseInt(input.max_tokens, 10);
  const max_tokens = Math.min(Number.isFinite(requestedMax) ? requestedMax : 4096, PROXY_MAX_TOKENS_CAP);

  const stripped = [];
  if (input.tools)       stripped.push('tools');
  if (input.tool_choice) stripped.push('tool_choice');
  if (stripped.length) {
    require('../../guardrails/logger.cjs').warn(`${label}.fieldsStripped`, { userId, stripped });
  }

  // Build a clean payload — only fields we explicitly allow through.
  const payload = {
    model,
    max_tokens,
    ...(input.system !== undefined ? { system: input.system } : {}),
    messages: Array.isArray(input.messages) ? input.messages : [],
    ...(input.temperature !== undefined ? { temperature: Math.max(0, Math.min(1, Number(input.temperature) || 0)) } : {}),
    ...(input.stop_sequences ? { stop_sequences: input.stop_sequences } : {}),
  };
  return { payload };
}

function createAiRouter({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google }) {
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
   * Body: anthropicPayload only. The API key is server-side only
   * (CLAUDE_API_KEY env var); requests carrying an `apiKey` field
   * are rejected to prevent client-supplied key injection / quota bypass.
   *
   * @note Authenticated but thin pass-through proxy. Caller-side
   * validation and rate limiting still matter — request bodies are
   * forwarded largely unchanged to the upstream LLM API.
   */
  router.post('/api/claude', authenticateToken, async (req, res) => {
    if (req.body.apiKey) {
      return res.status(400).json({ error: 'API key must be configured server-side' });
    }
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });
    const body = sanitizeProxyPayload(req.body, 'api.claude', req.user?.id);
    if (body.error) return res.status(400).json({ error: body.error });

    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        body.payload,
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
   * Body: anthropicPayload only. Key is server-side (CLAUDE_API_KEY);
   * requests carrying `apiKey` are rejected.
   *
   * @note This endpoint does not inject Aria context, does not
   * execute tools, and does not emit tool progress events.
   * For Aria's agentic chat, use /api/chat/execute.
   */
  router.post('/api/chat/stream', authenticateToken, async (req, res) => {
    if (req.body.apiKey) {
      return res.status(400).json({ error: 'API key must be configured server-side' });
    }
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });
    const sanitized = sanitizeProxyPayload(req.body, 'api.chat.stream', req.user?.id);
    if (sanitized.error) return res.status(400).json({ error: sanitized.error });
    const body = sanitized.payload;

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
   * Body: openaiPayload only. Key is server-side (OPENAI_API_KEY);
   * requests carrying `apiKey` are rejected.
   *
   * @note Authenticated but thin pass-through proxy. Caller-side
   * validation and rate limiting still matter — request bodies are
   * forwarded largely unchanged to the upstream LLM API.
   */
  router.post('/api/openai', authenticateToken, async (req, res) => {
    if (req.body.apiKey) {
      return res.status(400).json({ error: 'API key must be configured server-side' });
    }
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    const body = req.body;

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
  /**
   * POST /api/chat/warmup — prime the prompt cache for this user.
   *
   * Frontend fires this when the user focuses the chat input or starts
   * typing (debounced). By the time they hit send, the cacheable prefix
   * is already in Anthropic's prompt cache, so the real call hits cache
   * for ~90% input cost reduction + 2-5× faster TTFT.
   *
   * Calls buildAgenticContext + a minimal `max_tokens: 1` Sonnet call
   * with the same systemBlocks + cached tools as /api/chat/execute.
   * The output token is discarded — we only care about the input cache write.
   *
   * Cost shape per warmup (Sonnet 4.6, 34k cached prefix):
   *   • cache_creation_input_tokens cost: ~$0.10 first time
   *   • subsequent warmups in 5-min window: ~$0 (cache hit on warmup itself)
   *   • savings on the actual user send: ~$0.10 (cache_read instead of input)
   * Net: roughly break-even at worst, big win when warmup → send within 5 min.
   *
   * Rate limit 15/hour caps the abuse worst case at ~$1.50/day per user.
   */
  router.post('/api/chat/warmup', authenticateToken, chatWarmupLimit, async (req, res) => {
    try {
      const userId = req.user.id;
      const userTz = req.user.timezone || DEFAULT_TIMEZONE;
      const entityIds = req.user.entityIds || [];

      const ctx = await buildAgenticContext({
        userId, entityIds, db, tz: userTz, contextHint: 'warmup',
        userMessage: '',
        loadAllGcalAccounts, loadGcalTokens, saveGcalTokens, mergeAndSaveGcalTokens,
        makeOAuth2Client, google, logger, requestId: req.requestId,
      });

      const systemBlocks = (ctx.systemCacheable !== undefined && ctx.systemDynamic !== undefined)
        ? [
            { type: 'text', text: ctx.systemCacheable, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: ctx.systemDynamic },
          ]
        : ctx.systemPrompt;

      const tools = getToolSchemasForApi();
      const cachedTools = tools.length > 0
        ? tools.map((t, i) =>
            i === tools.length - 1
              ? { ...t, cache_control: { type: 'ephemeral' } }
              : t)
        : tools;

      const Anthropic = require('@anthropic-ai/sdk');
      const { trackedAnthropicCall } = require('../lib/anthropicCall.cjs');
      const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

      await trackedAnthropicCall(client, {
        model: 'claude-sonnet-4-6',
        max_tokens: 1,
        system: systemBlocks,
        tools: cachedTools,
        messages: [{ role: 'user', content: 'ping' }],
      }, { userId, scope: 'warmup' });

      return res.json({ ok: true });
    } catch (err) {
      // Warmup failure is non-fatal — the next /execute will just pay
      // the cache-miss cost as before. Log at warn so we can spot
      // chronic failures without alarming on transient.
      logger.warn('chat.warmup.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json({ ok: false });
    }
  });

  /**
   * POST /api/tts/synthesize — synthesize speech for the browser.
   *
   * Body: { text }
   * Returns: audio bytes (mp3) with proper Content-Type.
   *
   * Used by the Command Center voice-reply mode: after Aria's text
   * response completes, the client posts the assembled text here and
   * plays the returned audio. Provider auto-selects (ElevenLabs primary,
   * OpenAI tts-1 fallback) per server/lib/textToSpeech.cjs.
   *
   * Rate limit 100/hour — generous for normal interactive use but caps
   * the abuse worst case at ~$3/day on ElevenLabs at typical reply
   * length (~$0.03 per call worst case).
   */
  router.post('/api/tts/synthesize', authenticateToken, ttsLimit, async (req, res) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (!text) return res.status(400).json({ error: 'text required' });
      const { synthesizeSpeech } = require('../lib/textToSpeech.cjs');
      const result = await synthesizeSpeech(text, { userId: req.user.id });
      if (!result.ok) {
        logger.warn('tts.synthesize.failed', { requestId: req.requestId, userId: req.user.id, error: result.error });
        return res.status(502).json({ error: result.error || 'tts failed' });
      }
      res.set('Content-Type', result.mimeType || 'audio/mpeg');
      res.set('X-TTS-Provider', result.provider || 'unknown');
      return res.send(result.bytes);
    } catch (err) {
      logger.error('tts.synthesize.threw', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/chat/execute', authenticateToken, chatExecuteLimit, async (req, res) => {
    const userId = req.user.id;
    const entityIds = req.user.entityIds || [];
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });

    const { messages: rawMessages, systemPrompt: clientPrompt, model: reqModel, timeZone, context_hint } = req.body;
    const model = reqModel || 'claude-sonnet-4-6';

    // ── Server-side defense: strip non-Anthropic message roles ───────
    // Anthropic only accepts role: 'user' | 'assistant'. The client
    // (DashboardPanel.jsx) injects UI-only synthetic roles into chat
    // history for inline tiles ('confirm' for tool gates, 'task_draft',
    // 'event_draft', 'email_draft', 'close_loop', 'daily_wrap'). The
    // client's chatHistoryForLLM() helper strips them — this is the
    // belt-and-suspenders pass in case a future client surface
    // regresses.
    //
    // Origin: prod incident 2026-05-08 — back-to-back tool calls left
    // a 'confirm' synthetic in the slice-9 history window; next user
    // turn shipped it → Anthropic 400 → SSE error → silent client ghost.
    // This filter ensures the bug can't recur server-side regardless
    // of client behavior.
    const droppedRoles = [];
    const messages = Array.isArray(rawMessages)
      ? rawMessages
          .filter((m) => {
            if (!m) return false;
            const ok = (m.role === 'user' || m.role === 'assistant');
            if (!ok && m.role) droppedRoles.push(m.role);
            return ok;
          })
          .filter((m) => typeof m.content === 'string'
            ? m.content.length > 0
            : Array.isArray(m.content) && m.content.length > 0)
      : [];
    if (droppedRoles.length) {
      try {
        Sentry.addBreadcrumb({
          category: 'chat.execute.role-filter',
          message: `Stripped ${droppedRoles.length} non-LLM messages from request body`,
          level: 'warning',
          data: { droppedRoles, userId, requestId: req.requestId },
        });
      } catch { /* breadcrumb best-effort */ }
      logger.warn('chat.execute.dropped-roles', {
        requestId: req.requestId, userId,
        roles: droppedRoles,
        count: droppedRoles.length,
      });
    }

    // Hoist finalizeStream so the sibling catch block can reference it even
    // when an error occurs before the try-body assignment runs. The no-op
    // default covers the pre-flushHeaders failure mode (catch returns JSON).
    let finalizeStream = () => {};

    try {
      const userTz = timeZone || req.user.timezone || DEFAULT_TIMEZONE;
      // Latest user-authored message text powers the chatContext envelope
      // for skills loading. Walk back from the tail since the client may
      // append the assistant placeholder before the request fires.
      let latestUserMessage = '';
      if (Array.isArray(messages)) {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m && m.role === 'user') {
            latestUserMessage = typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content.map(c => c?.text || '').join(' ')
                : '';
            break;
          }
        }
      }
      // tz resolves to ctx.tz once the shared handler has built context
      // (see onContextReady below); boundExecuteTool reads it at call time.
      let tz = userTz;

      // SSE plumbing. `send` + `finalizeStream` are (re)assigned in
      // onContextReady AFTER headers flush — so a context-build failure
      // still routes through the JSON-500 path in the catch (headers not
      // yet sent). Every terminal path funnels through finalizeStream so
      // `done` + res.end() fire exactly once.
      let streamFinalized = false;
      let send = () => {};

      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db, tz, 'web_chat');

      const onProgress = ({ type, tool, input, result, error, text }) => {
        if (type === 'tool_start')    send('tool_start',    { tool, input });
        if (type === 'tool_complete') send('tool_complete', { tool, result });
        if (type === 'tool_error')    send('tool_error',    { tool, error });
        // 2026-05-29 — token-level streaming. The agentic loop forwards
        // text_delta events as Anthropic emits them; flush each one
        // through SSE so the client can render incrementally instead of
        // waiting for the full assembled message.
        if (type === 'text_delta' && text) send('text_delta', { text });
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
        // Static gating policy (2026-06-06) — the decision engine is OUT of
        // the gating path. Confirmation is required IFF requiresConfirmation()
        // says so: tool ∈ CONSEQUENTIAL_TOOLS (irreversible / external /
        // access-changing) or a dynamic safety gate fires (bulk-archive count,
        // image save). Everything else auto-proceeds. This check cannot throw,
        // so the engine's "Decision engine error; falling back to confirmation"
        // failure mode can no longer gate routine actions.
        if (!requiresConfirmation(tool, decision, input)) {
          return { action: 'allow' };
        }

        let pending;
        try {
          pending = await db.createPendingConfirmation({
            userId, toolName: tool, params: input, channel: 'web',
            decisionLogId: null, // engine no longer in the gating path
          });
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

        send('tool_confirm', {
          tool, params: input, confirm_id: pending.id,
          risk: getToolByName(tool)?.risk || 'high',
          // Confirmation comes from the static tool policy (CONSEQUENTIAL_TOOLS
          // / dynamic safety gate), not a rule conflict — no engine reason.
          reason: '',
          conflict_level: null,
        });
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

      // Fired by the shared handler AFTER a successful context build, BEFORE
      // the loop runs. This is where web flushes SSE headers + installs the
      // real `send`/`finalizeStream` — placing it here (not before the
      // handler call) keeps a context-build throw on the JSON-500 path since
      // headers aren't sent yet.
      const onContextReady = (ctx) => {
        tz = ctx.tz || tz;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        send = (event, data) => {
          if (streamFinalized) return;
          try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
        };
        // skills_loaded indicator (M2.6) — only when a skill matched + loaded.
        if (Array.isArray(ctx.loadedSkills) && ctx.loadedSkills.length) {
          send('skills_loaded', {
            skills: ctx.loadedSkills.map((s) => ({ id: s.id, name: s.name, reason: s.reason })),
          });
        }
        // Idempotent single-shot finalizer. Every terminal path funnels
        // through here so `done` + res.end() fire exactly once.
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
      };

      const loopResult = await handleConversationTurn({
        channel: 'web_chat',
        userId, entityIds, db,
        tz: userTz,
        contextHint: context_hint,
        userMessageText: latestUserMessage,
        messages,
        clientPrompt,
        tools: getToolSchemasForApi(),
        model,
        executeTool: boundExecuteTool,
        gateToolExecution,
        onProgress,
        logAction,
        gcalDeps: { loadAllGcalAccounts, loadGcalTokens, saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google },
        onContextReady,
        loggerOverride: logger,
        requestId: req.requestId,
      });
      let { text, toolSummaries, maxIterationsReached } = loopResult;

      // ── Correction learning + memory extraction (shared post-loop) ──────
      // lastUserMsg gates both; derive once from the tail user turn.
      let lastUserMsg = '';
      try {
        const lastUserContent = [...messages].reverse().find(m => m.role === 'user')?.content;
        lastUserMsg = typeof lastUserContent === 'string'
          ? lastUserContent
          : Array.isArray(lastUserContent)
            ? (lastUserContent.find(b => b?.type === 'text')?.text || '')
            : '';
      } catch (err) {
        logger.error('chat.learning.lastUserMsg.failed', { requestId: req.requestId, userId, error: err.message });
      }
      text = await applyCorrectionAndEnrichment({
        channel: 'web_chat',
        userId, db,
        userMessage: lastUserMsg,
        assistantText: text,
        toolsCalled: (toolSummaries || []).map((s) => s.tool),
        doCorrection: !!lastUserMsg,
        doEnrichment: !!lastUserMsg,
        loggerOverride: logger,
      });

      finalizeStream({ text, toolSummaries, maxIterationsReached });
      return;
    } catch (err) {
      logger.error('chat.execute.failed', { requestId: req.requestId, userId, error: err.message });
      // If headers never flushed, fall back to a JSON error. Otherwise
      // route through finalizeStream so `done` + res.end fire once.
      if (!res.headersSent) {
        try { return res.status(500).json({ error: 'Internal server error' }); } catch { /* fallthrough */ }
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
      //
      // No silent .catch — prior code swallowed DB failures here, so the
      // route would NOTIFY/audit/return success while the row stayed
      // 'pending' forever. The listener can't resolve from the wrong
      // status, the user thinks they approved, and the action expires
      // unfulfilled. Let it throw to the outer try → 500 to the client
      // and skip the audit/notify below.
      await db.updatePendingConfirmationStatus(confirm_id, userId, nextStatus, resolution);
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
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createAiRouter;
module.exports.createAiRouter = createAiRouter;
