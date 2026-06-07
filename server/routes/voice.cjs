'use strict';

/**
 * server/routes/voice.cjs — Voice channel entry point for Aria.
 *
 * Voice rides the SAME reasoning spine as web chat and WhatsApp:
 * handleConversationTurn (server/lib/conversationTurn.cjs) builds the
 * identical agentic context, assembles the cache-split system prompt, runs
 * the identical agentic loop, and applies the identical correction/memory
 * post-processing. There is intentionally NO parallel reasoning path.
 *
 * What's voice-specific (and lives here):
 *   - transport: a single JSON request/response (no SSE)
 *   - server-held conversation state: voice is stateful like WhatsApp. The
 *     client holds only a conversation_id; the server loads a windowed
 *     history (last 20 turns) from chat_messages and persists each turn with
 *     channel='voice'. A 30-minute idle gap starts a fresh conversation
 *     (mirrors the WhatsApp session reset) and the new id is returned so the
 *     satellite can adopt it.
 *   - confirmation: voice has no card UI and no open socket to resume, so it
 *     mirrors WhatsApp's deferred gate. A confirmation-required tool stages a
 *     pending_confirmations row (channel='voice', 10-min window), the loop is
 *     denied, and the spoken reply becomes the YES/NO prompt. The NEXT turn,
 *     a strict "yes"/"no" resolves the latest pending row — executing the
 *     tool exactly once (alreadyExecuted:true in the persisted resolution, so
 *     any other resolver path is a no-op).
 *
 * Endpoint:
 *   POST /api/voice/message  (JWT-authenticated)
 *     body:  { transcript: string, conversation_id?: number }
 *     reply: { reply: string, conversation_id: number, toolSummaries?: [...] }
 *
 * Dependencies (injected, same set as ai.cjs since buildAgenticContext needs
 * GCal token access): authenticateToken, db, loadGcalTokens, loadAllGcalAccounts,
 * saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google.
 */

const express = require('express');
const { executeTool, getToolSchemasForApi, requiresConfirmation } = require('../tools.cjs');
const { closeDecisionWithFeedback } = require('../lib/trustFeedback.cjs');
const { handleConversationTurn, applyCorrectionAndEnrichment } = require('../lib/conversationTurn.cjs');
const logger = require('../../guardrails/logger.cjs');
const { userRateLimit } = require('../middleware/userRateLimit.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');

const voiceMessageLimit = userRateLimit({ key: 'voice-message', limit: 60, windowSec: 3600 });

const MAX_TRANSCRIPT_CHARS = 4000;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes — mirrors WhatsApp
const VOICE_MODEL = 'claude-sonnet-4-6';

// Strict single-token YES/NO — same contract as WhatsApp's deferred gate so
// an ambiguous reply ("yeah maybe later") falls through to normal chat
// instead of silently firing a staged action.
const STRICT_YES = /^(YES|YEAH|YEP|YUP|Y|SURE|OKAY|OK|CONFIRM|DO IT)\.?$/i;
const STRICT_NO  = /^(NO|NOPE|NAH|N|CANCEL|STOP)\.?$/i;

function createVoiceRouter({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google }) {
  const router = express.Router();

  router.post('/api/voice/message', authenticateToken, voiceMessageLimit, async (req, res) => {
    const userId = req.user.id;
    const entityIds = req.user.entityIds || [];
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'CLAUDE_API_KEY not configured' });

    const transcript = typeof req.body?.transcript === 'string'
      ? req.body.transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS)
      : '';
    if (!transcript) return res.status(400).json({ error: 'transcript required' });

    const clientConvId = Number.isInteger(req.body?.conversation_id) ? req.body.conversation_id : null;

    try {
      const tzForUser = req.user.timezone || DEFAULT_TIMEZONE;

      // ── Resolve the conversation (server-held state) ──────────────────
      // Reuse the client's conversation when it's owned by this user and
      // still inside the 30-min session window; otherwise start fresh and
      // return the new id so the satellite adopts it.
      let conversation = null;
      if (clientConvId) {
        const existing = await db.getConversation(clientConvId, userId);
        if (existing) {
          const recent = await db.getConversationMessagesWindowed(existing.id, userId, 1);
          const last = recent.length ? recent[recent.length - 1] : null;
          const age = last?.createdAt ? Date.now() - new Date(last.createdAt).getTime() : null;
          if (age === null || age <= SESSION_TIMEOUT_MS) {
            conversation = existing;
          } else {
            logger.info('voice.session.expired', { requestId: req.requestId, userId, ageMinutes: Math.round(age / 60000) });
          }
        }
      }
      if (!conversation) conversation = await db.createConversation(userId, VOICE_MODEL);
      const conversationId = conversation.id;

      // ── YES/NO resolution of a prior staged confirmation ──────────────
      // Strict single-token match + LIFO on the latest pending voice row.
      // A "yes" with no fresh pending row falls through to normal chat.
      const isYes = STRICT_YES.test(transcript);
      const isNo  = STRICT_NO.test(transcript);
      if (isYes || isNo) {
        const approved = isYes;
        try {
          const pending = await db.findLatestPendingConfirmation(userId, 'voice');
          if (pending) {
            if (!approved) {
              const denyResolution = { action: 'deny', reason: 'user_rejected', message: `User cancelled ${pending.toolName}.` };
              await db.updatePendingConfirmationStatus(pending.id, userId, 'rejected', denyResolution).catch(() => {});
              await db.logAgentAction({ userId, eventType: 'confirmation_rejected', toolName: pending.toolName, input: pending.params, confirmId: pending.id });
              try { await db.notifyConfirmation(pending.id, denyResolution); }
              catch (e) { logger.warn('voice.confirm.notify.failed', { userId, error: e.message }); }
              await db.logAgentAction({ userId, eventType: 'tool_cancelled', toolName: pending.toolName, input: pending.params, confirmId: pending.id });
              if (pending.decisionLogId) {
                closeDecisionWithFeedback({
                  userId, decisionId: pending.decisionLogId, outcome: 'rejected',
                  actionType: pending.toolName, contextSummary: 'voice_user_rejected',
                }).catch(() => {});
              }
              const cancelReply = 'Okay, cancelled.';
              await db.addConversationMessage(conversationId, userId, 'user', transcript, VOICE_MODEL, 'voice').catch(() => {});
              await db.addConversationMessage(conversationId, userId, 'assistant', cancelReply, VOICE_MODEL, 'voice').catch(() => {});
              return res.json({ reply: cancelReply, conversation_id: conversationId, toolSummaries: [] });
            }

            // Approved: execute the tool first so the real result is
            // persisted atomically with the status flip. alreadyExecuted:true
            // means any other resolver path (web listener re-read) is a no-op.
            await db.logAgentAction({ userId, eventType: 'confirmation_approved', toolName: pending.toolName, input: pending.params, confirmId: pending.id });
            const result = await executeTool(pending.toolName, pending.params, userId, entityIds, db, tzForUser, 'voice');
            await db.logAgentAction({
              userId,
              eventType: result?.success === false ? 'tool_failed' : 'tool_executed',
              toolName: pending.toolName,
              input: pending.params,
              output: result,
              status: result?.success === false ? 'failure' : 'success',
              errorMsg: result?.success === false ? (result.error || 'failed') : null,
              confirmId: pending.id,
            });
            const allowResolution = { action: 'allow', alreadyExecuted: true, result, overrides: {} };
            await db.updatePendingConfirmationStatus(pending.id, userId, 'approved', allowResolution).catch(() => {});
            try { await db.notifyConfirmation(pending.id, allowResolution); }
            catch (e) { logger.warn('voice.confirm.notify.failed', { userId, error: e.message }); }
            if (pending.decisionLogId) {
              closeDecisionWithFeedback({
                userId, decisionId: pending.decisionLogId, outcome: 'confirmed',
                actionType: pending.toolName, contextSummary: 'voice_user_confirmed',
              }).catch(() => {});
            }
            const doneReply = result?.success === false
              ? `I couldn't complete that — ${result.error || 'something went wrong'}.`
              : 'Done.';
            await db.addConversationMessage(conversationId, userId, 'user', transcript, VOICE_MODEL, 'voice').catch(() => {});
            await db.addConversationMessage(conversationId, userId, 'assistant', doneReply, VOICE_MODEL, 'voice').catch(() => {});
            return res.json({ reply: doneReply, conversation_id: conversationId, toolSummaries: [{ tool: pending.toolName, success: result?.success !== false, result }] });
          }
        } catch (e) {
          logger.error('voice.confirm.failed', { requestId: req.requestId, userId, error: e.message });
        }
        // fall through if no matching pending row
      }

      // ── Load windowed history (last 20 turns) ─────────────────────────
      let priorMessages = [];
      try {
        const history = await db.getConversationMessagesWindowed(conversationId, userId, 20);
        priorMessages = history.map((m) => ({ role: m.role, content: m.content }));
      } catch (e) {
        logger.error('voice.history.loadFailed', { requestId: req.requestId, userId, error: e.message });
      }
      const messages = [...priorMessages, { role: 'user', content: transcript }];

      // tz reassigned to ctx.tz in onContextReady before the loop runs, so
      // boundExecuteTool (which closes over this binding) sees the resolved
      // zone at call time.
      let tz = tzForUser;

      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db, tz, 'voice');

      const logAction = async (event) => {
        try {
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
        } catch (err) {
          logger.warn('voice.logAction.failed', { requestId: req.requestId, userId, error: err.message });
        }
      };

      // ── Confirmation gate — deferred, spoken-prompt variant ───────────
      // Static gating policy (2026-06-06) — decision engine removed from the
      // gating path. Confirm IFF requiresConfirmation() says so (tool ∈
      // CONSEQUENTIAL_TOOLS or a dynamic safety gate fires); otherwise
      // auto-proceed. Cannot throw, so routine voice actions never fall into a
      // "Decision engine error" confirmation. When a confirm IS required we
      // stage a pending voice row and the spoken reply BECOMES the YES/NO
      // prompt — captured here and used to override the model's post-deny text.
      let voiceConfirmPrompt = null;
      const gateToolExecution = async ({ tool, input, decision }) => {
        if (!requiresConfirmation(tool, decision, input)) {
          return { action: 'allow' };
        }

        // Stage a pending voice confirmation (10-min window) and turn the
        // spoken reply into the YES/NO prompt. We do NOT execute now and do
        // NOT leave a row the loop expects to resume — resolution happens on
        // the next turn via the STRICT_YES/STRICT_NO branch above.
        try {
          const pending = await db.createPendingConfirmation({
            userId, toolName: tool, params: input, channel: 'voice',
            decisionLogId: null, // engine no longer in the gating path
            expiresAtMinutes: 10,
          });
          voiceConfirmPrompt = `I need your okay to ${tool.replace(/_/g, ' ')}. Say "yes" to confirm or "no" to cancel.`;
          await db.logAgentAction({ userId, eventType: 'confirmation_requested', toolName: tool, input, confirmId: pending.id });
          return { action: 'deny', reason: 'awaiting_voice_confirmation', message: 'Awaiting user confirmation via voice.' };
        } catch (err) {
          logger.error('voice.gate.failed', { requestId: req.requestId, userId, tool, error: err.message });
          return { action: 'deny', reason: 'gate_error', message: `Could not request confirmation for ${tool}.` };
        }
      };

      const { text, toolSummaries } = await handleConversationTurn({
        channel: 'voice',
        userId, entityIds, db,
        tz: tzForUser,
        userMessageText: transcript,
        messages,
        tools: getToolSchemasForApi(),
        model: VOICE_MODEL,
        executeTool: boundExecuteTool,
        gateToolExecution,
        logAction,
        gcalDeps: { loadAllGcalAccounts, loadGcalTokens, saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google },
        onContextReady: (ctx) => { tz = ctx.tz; },
        loggerOverride: logger,
        requestId: req.requestId,
      });

      // When we staged a confirmation this turn, the spoken reply IS the
      // YES/NO prompt — discard the model's post-deny text (parity with
      // WhatsApp suppressing its post-loop text after a staged confirm).
      const staged = !!voiceConfirmPrompt;
      let reply = staged ? voiceConfirmPrompt : text;

      // ── Correction learning + memory extraction (shared post-loop) ────
      // Skip both when this turn only staged a confirmation prompt (the
      // reply is boilerplate, not a real assistant signal yet).
      reply = await applyCorrectionAndEnrichment({
        channel: 'voice', userId, db,
        userMessage: transcript,
        assistantText: reply,
        toolsCalled: (toolSummaries || []).map((s) => s.tool),
        doCorrection: !staged && !!reply,
        doEnrichment: !staged && !!reply,
        loggerOverride: logger,
      });

      // ── Persist the turn (channel='voice') ────────────────────────────
      try {
        await db.addConversationMessage(conversationId, userId, 'user', transcript, VOICE_MODEL, 'voice');
        if (reply) await db.addConversationMessage(conversationId, userId, 'assistant', reply, VOICE_MODEL, 'voice');
      } catch (e) {
        logger.error('voice.history.saveFailed', { requestId: req.requestId, userId, error: e.message });
      }

      return res.json({ reply: reply || '', conversation_id: conversationId, toolSummaries: toolSummaries || [] });
    } catch (err) {
      logger.error('voice.message.failed', { requestId: req.requestId, userId, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createVoiceRouter;
module.exports.createVoiceRouter = createVoiceRouter;
