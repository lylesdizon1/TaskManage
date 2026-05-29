'use strict';

/**
 * server/routes/voice.cjs — Voice channel entry point for Aria.
 *
 * Voice is just another channel into the SAME Aria router that web chat uses
 * (server/routes/ai.cjs → /api/chat/execute). There is intentionally NO
 * parallel reasoning path: this endpoint builds the identical agentic context
 * (buildAgenticContext) and runs the identical loop (runAgenticLoop) with the
 * identical tool surface (getToolSchemasForApi / executeTool). The only
 * differences from /api/chat/execute are transport (single JSON response, no
 * SSE) and the gating policy for confirmation-required actions (see below).
 *
 * Endpoint:
 *   POST /api/voice/message  (JWT-authenticated)
 *     body:  { transcript: string }
 *     reply: { reply: string, toolSummaries?: [...] }
 *
 * Gating / exactly-once:
 *   The decision engine (evaluateAction) runs FIRST, exactly as in web chat —
 *   hard_stop denies, auto_proceed allows. The one adaptation: a voice request
 *   is a single synchronous round-trip with no UI to render a confirmation card
 *   and resume the loop, so when an action requires confirmation we DENY it
 *   in-channel and tell the user to approve it in the app. We do NOT create a
 *   dangling pending_confirmation (web execution happens inside the waiting SSE
 *   listener, which voice has no equivalent of) and we do NOT execute the gated
 *   action without confirmation. This preserves the existing exactly-once
 *   guarantee: a gated action is never executed twice, and never executed via
 *   voice without explicit confirmation through the normal flow.
 *
 * Dependencies (injected, same set as ai.cjs since buildAgenticContext needs
 * GCal token access): authenticateToken, db, loadGcalTokens, loadAllGcalAccounts,
 * saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google.
 */

const express = require('express');
const { executeTool, getToolSchemasForApi, requiresConfirmation } = require('../tools.cjs');
const { evaluateAction } = require('../lib/decisionEngine.cjs');
const { closeDecisionWithFeedback } = require('../lib/trustFeedback.cjs');
const { runAgenticLoop } = require('../lib/agenticLoop.cjs');
const { buildAgenticContext } = require('../lib/buildAgenticContext.cjs');
const { handlePossibleCorrection } = require('../lib/learningHandler.cjs');
const logger = require('../../guardrails/logger.cjs');
const { userRateLimit } = require('../middleware/userRateLimit.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');

const voiceMessageLimit = userRateLimit({ key: 'voice-message', limit: 60, windowSec: 3600 });

const MAX_TRANSCRIPT_CHARS = 4000;

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

    try {
      const tz = req.user.timezone || DEFAULT_TIMEZONE;

      // Same context builder as web chat — full PEOPLE/PROJECTS/MEMORY/etc.
      const ctx = await buildAgenticContext({
        userId, entityIds, db, tz,
        userMessage: transcript,
        loadAllGcalAccounts, loadGcalTokens, saveGcalTokens, mergeAndSaveGcalTokens,
        makeOAuth2Client, google, logger, requestId: req.requestId,
      });

      const fullSystem = [
        { type: 'text', text: ctx.systemCacheable || '', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: ctx.systemDynamic || '' },
      ];

      const messages = [{ role: 'user', content: transcript }];

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

      // Same decision-engine gate as web chat. The confirmation branch is
      // adapted for a synchronous channel: deny + explain rather than open
      // an interactive card (see file header). The engine can only ADD
      // friction, never reduce it.
      const gateToolExecution = async ({ tool, input, decision }) => {
        let engineDisposition = 'auto_proceed';
        let engineReason = '';
        let engineDecisionId = null;
        try {
          const result = await evaluateAction(userId, tool, input, tz);
          engineDisposition = result.disposition;
          engineReason = result.reason;
          engineDecisionId = result.decision_id;
        } catch (err) {
          logger.warn('voice.decisionEngine.failed', { requestId: req.requestId, userId, tool, error: err.message });
          engineDisposition = 'confirm_required'; // fail-closed
        }

        if (engineDisposition === 'hard_stop') {
          logger.info('voice.decisionEngine.hardStop', { requestId: req.requestId, userId, tool, reason: engineReason });
          if (engineDecisionId) {
            closeDecisionWithFeedback({
              userId, decisionId: engineDecisionId, outcome: 'rejected',
              actionType: tool, contextSummary: engineReason || null,
            }).catch(() => {});
          }
          return { action: 'deny', reason: 'hard_stop', message: engineReason || `I can't do ${tool} — it conflicts with one of your rules.` };
        }

        const engineWantsConfirm = engineDisposition === 'confirm_required' || engineDisposition === 'soft_confirm';
        const toolWantsConfirm = requiresConfirmation(tool, decision, input);
        if (!engineWantsConfirm && !toolWantsConfirm) {
          if (engineDecisionId) {
            closeDecisionWithFeedback({
              userId, decisionId: engineDecisionId, outcome: 'executed', actionType: tool,
            }).catch(() => {});
          }
          return { action: 'allow' };
        }

        // Confirmation required, but voice can't render+resume a card. Deny
        // in-channel without executing and without leaving a dangling pending
        // row. The user approves higher-risk actions in the app.
        logger.info('voice.gate.confirmDenied', { requestId: req.requestId, userId, tool, engineDisposition });
        if (engineDecisionId) {
          closeDecisionWithFeedback({
            userId, decisionId: engineDecisionId, outcome: 'rejected',
            actionType: tool, contextSummary: 'confirmation_unavailable_voice',
          }).catch(() => {});
        }
        await logAction({ eventType: 'confirmation_unavailable_voice', toolName: tool, input, status: 'denied', decision });
        return {
          action: 'deny',
          reason: 'confirmation_unavailable_voice',
          message: `That needs your confirmation, so I didn't do it over voice. Open the app to approve ${tool}.`,
        };
      };

      const loopResult = await runAgenticLoop({
        messages,
        system: fullSystem,
        tools: getToolSchemasForApi(),
        userId,
        executeTool: boundExecuteTool,
        gateToolExecution,
        logAction,
        model: 'claude-sonnet-4-6',
        channel: 'voice',
      });

      let { text, toolSummaries } = loopResult;

      // Correction learning — same as web chat; lets "no, I meant X" still
      // teach Aria when it arrives by voice.
      try {
        const { acknowledgment } = await handlePossibleCorrection({
          userId, userMessage: transcript, lastAssistantMessage: text || null, db,
        });
        if (acknowledgment) text = (text || '') + acknowledgment;
      } catch (err) {
        logger.warn('voice.learning.failed', { requestId: req.requestId, userId, error: err.message });
      }

      // Memory extraction (fire-and-forget, env-gated) — voice turns feed the
      // same memory pipeline as web so Aria gets smarter regardless of channel.
      if (text) {
        try {
          const { enrichConversationTurn } = require('../lib/conversationEnrichment.cjs');
          enrichConversationTurn({
            userId,
            channel: 'voice',
            userMessage: transcript,
            assistantText: text,
            toolsCalled: (toolSummaries || []).map((s) => s.tool).filter(Boolean),
          }).catch((err) => logger.warn('voice.memoryExtract.failed', { userId, error: err.message }));
        } catch (e) { logger.warn('voice.memoryExtract.requireFailed', { error: e.message }); }
      }

      return res.json({ reply: text || '', toolSummaries: toolSummaries || [] });
    } catch (err) {
      logger.error('voice.message.failed', { requestId: req.requestId, userId, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createVoiceRouter;
module.exports.createVoiceRouter = createVoiceRouter;
