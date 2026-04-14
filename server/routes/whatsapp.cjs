'use strict';

/**
 * server/routes/whatsapp.cjs — WhatsApp webhook entry point for Aria.
 *
 * Handles inbound WhatsApp messages from UltraMsg's webhook and routes
 * them through Aria's agentic tool-use loop, then replies via the
 * UltraMsg REST API.
 *
 * Responsibility:
 *   - Receive and validate UltraMsg webhook POSTs
 *   - Resolve the sender phone to a Dizon.ai user
 *   - Build Aria's system prompt with live context (tasks, notes, calendar)
 *   - Delegate AI reasoning and tool execution to agenticLoop
 *   - Send the final reply back via UltraMsg
 *
 * Inputs:
 *   - POST /api/whatsapp/inbound — UltraMsg webhook payload with
 *     { data: { from, body, ... } }. Public endpoint (no JWT auth) —
 *     authentication is implicit via phone→user lookup.
 *
 * Dependencies:
 *   - server/lib/agenticLoop.cjs — multi-turn AI tool-use loop
 *   - server/tools.cjs — ARIA_TOOLS schema + executeTool handler
 *   - server/utils/date.cjs — timezone-aware date formatting
 *   - db.cjs — user lookup, task/note/memory queries (injected)
 *   - googleapis — GCal event fetching (injected)
 *
 * Boundaries:
 *   - This module handles transport only — receiving the webhook and
 *     sending the reply. All AI reasoning and tool execution lives
 *     in agenticLoop.cjs and tools.cjs.
 *   - Context building (system prompt + live data) is duplicated from
 *     ai.cjs. Both surfaces need the same Aria context, but extract
 *     differently: ai.cjs streams via SSE, this module fires and replies.
 *
 * @note The inbound endpoint is public (no JWT). User identity is resolved
 * by matching the sender phone against whatsapp_phone in the users table.
 * If no user matches, the message is silently dropped.
 *
 * @note Image messages are supported — the media URL is downloaded,
 * converted to base64, and passed as a vision content block to Claude.
 * Unsupported media types and download failures get graceful error replies.
 */

const express   = require('express');
const { ARIA_TOOLS, executeTool, getToolByName, getToolSchemasForApi, requiresConfirmation } = require('../tools.cjs');
const { getTodayLocal } = require('../utils/date.cjs');
const { runAgenticLoop } = require('../lib/agenticLoop.cjs');
const { buildAgenticContext } = require('../lib/buildAgenticContext.cjs');
const { handlePossibleCorrection } = require('../lib/learningHandler.cjs');
const { sendWhatsApp } = require('../utils/integrations.cjs');
const logger = require('../../guardrails/logger.cjs');

/** Derive a short user-facing code from a confirmation ID. */
function codeFromConfirmId(id) {
  return String(id).replace(/-/g, '').slice(0, 4).toUpperCase();
}
function summarizeParams(tool, params) {
  if (tool === 'send_email')   return `email to ${params.to} — "${params.subject || ''}"`;
  if (tool === 'reply_email')  return `reply on thread ${params.thread_id}`;
  if (tool === 'delete_task')  return `delete task ${params.task_id}`;
  if (tool === 'delete_event') return `delete event ${params.event_id}`;
  return `${tool}`;
}

/**
 * Factory function that creates the WhatsApp webhook router.
 *
 * @param {Object} deps - Injected dependencies.
 * @param {Object} deps.db - Database helper module (db.cjs).
 * @param {Function} deps.loadGcalTokens - Async function to load + decrypt GCal tokens for a user.
 * @param {Function} deps.makeOAuth2Client - Factory for Google OAuth2 client.
 * @param {Object} deps.google - googleapis module for GCal API calls.
 * @returns {express.Router} Mounted at /api/whatsapp by proxy-server.cjs.
 *
 * @note executeTool is imported from tools.cjs and passed into
 * agenticLoop. This module does not execute tools directly.
 */
module.exports = function createWhatsAppRouter({ db, loadGcalTokens, makeOAuth2Client, google }) {
  const router = express.Router();

  // Pending completion note requests: Map<`${userId}`, { taskId, taskTitle, expiresAt }>
  // 5-minute TTL — if user replies with a non-command message, save as completion_note.
  const pendingCompletionNotes = new Map();

  /**
   * POST /api/whatsapp/inbound — UltraMsg webhook handler.
   *
   * Flow: validate payload → normalize phone → resolve user →
   * build context → run agentic loop → reply via UltraMsg.
   *
   * @note Phone normalization strips all non-digit characters (e.g.
   * "+1 (555) 123-4567" → "15551234567"). This must match the format
   * stored in users.whatsapp_phone. UltraMsg sends the "from" field
   * with a country code prefix and optional formatting characters.
   *
   * @note The resolveUser pattern: instead of JWT auth, user identity
   * is resolved by matching the normalized sender phone against
   * db.getUserByWhatsAppPhone(). If no match is found, the message
   * is acknowledged (200 OK) but not processed — this prevents
   * UltraMsg from retrying and avoids exposing error details to
   * unknown senders.
   *
   * @note UltraMsg response format: the reply is sent as a POST to
   * the UltraMsg REST API with { token, to, body }. The "to" field
   * uses the raw (unnormalized) sender address from the webhook,
   * which UltraMsg expects for routing.
   *
   * @note Always returns 200 OK regardless of outcome to prevent
   * UltraMsg from retrying failed webhooks. Errors are caught
   * and logged internally.
   *
   * @note This endpoint is public — no JWT auth. Security relies
   * on phone→user mapping and rate limiting. Never expose
   * sensitive error details in the response body.
   *
   * @throws Internal errors are caught and logged. The HTTP
   * response remains 200 to avoid webhook retries.
   */
  router.post('/api/whatsapp/inbound', async (req, res) => {
    try {
      const data = req.body?.data;
      logger.info('whatsapp.inbound', { requestId: req.requestId, hasData: !!req.body?.data });
      if (!data) return res.json({ ok: true, skipped: 'no data' });

      // Extract text body and media URL (if any)
      const msgBody = data.body || '';
      const fromRaw = data.from;
      const rawMedia = data.media;
      const mediaUrl = (typeof rawMedia === 'string' && rawMedia.trim() !== '') ? rawMedia.trim() : null;
      if (!fromRaw) return res.json({ ok: true, skipped: 'missing sender' });
      if (!msgBody && !mediaUrl) return res.json({ ok: true, skipped: 'empty message' });

      // Normalize phone: strip non-digits
      const normalizedPhone = fromRaw.replace(/\D/g, '');
      logger.info('whatsapp.message.received', { requestId: req.requestId, phone: normalizedPhone, hasMedia: !!mediaUrl, bodyPreview: msgBody.slice(0, 50) });

      // Look up user by WhatsApp phone
      const user = await db.getUserByWhatsAppPhone(normalizedPhone);
      if (!user) {
        logger.warn('whatsapp.inbound.unknownSender', { requestId: req.requestId, phone: normalizedPhone });
        return res.json({ ok: true, skipped: 'unknown sender' });
      }

      const userId = user.id;
      const entityIds = user.entityIds || [];
      const tzForUser = user.timezone || 'America/Los_Angeles';

      // ── Check for YES/NO confirmation reply to a prior high-risk prompt ──
      const confirmMatch = (msgBody || '').trim().match(/^(YES|NO)\s+([A-Z0-9]{4})\s*$/i);
      if (confirmMatch) {
        const approved = confirmMatch[1].toUpperCase() === 'YES';
        const code = confirmMatch[2].toUpperCase();
        try {
          const pending = await db.findLatestPendingConfirmation(userId, 'whatsapp');
          if (pending && codeFromConfirmId(pending.id) === code) {
            // On deny, persist resolution + notify.
            if (!approved) {
              const denyResolution = {
                action: 'deny',
                reason: 'user_rejected',
                message: `User cancelled ${pending.toolName}.`,
              };
              await db.updatePendingConfirmationStatus(pending.id, userId, 'rejected', denyResolution).catch(() => {});
              await db.logAgentAction({
                userId,
                eventType: 'confirmation_rejected',
                toolName: pending.toolName,
                input: pending.params,
                confirmId: pending.id,
              });
              try { await db.notifyConfirmation(pending.id, denyResolution); }
              catch (e) { logger.warn('whatsapp.confirm.notify.failed', { userId, error: e.message }); }
              await db.logAgentAction({ userId, eventType: 'tool_cancelled', toolName: pending.toolName, input: pending.params, confirmId: pending.id });
              await sendWhatsApp(db, userId, `Cancelled.`, fromRaw).catch(() => {});
              return res.json({ ok: true, confirmed: false });
            }

            // Approved: run the tool first so we can persist the real result
            // atomically with the status flip. Exactly-once: if the web
            // listener re-reads resolution_json (NOTIFY missed), it sees
            // alreadyExecuted:true and skips re-execution.
            await db.logAgentAction({
              userId,
              eventType: 'confirmation_approved',
              toolName: pending.toolName,
              input: pending.params,
              confirmId: pending.id,
            });

            const result = await executeTool(pending.toolName, pending.params, userId, entityIds, db, tzForUser);
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

            const allowResolution = {
              action: 'allow',
              alreadyExecuted: true,
              result,
              overrides: {},
            };
            await db.updatePendingConfirmationStatus(pending.id, userId, 'approved', allowResolution).catch(() => {});
            try { await db.notifyConfirmation(pending.id, allowResolution); }
            catch (e) { logger.warn('whatsapp.confirm.notify.failed', { userId, error: e.message }); }

            const reply = result?.success === false
              ? `Couldn't complete ${pending.toolName}: ${result.error || 'unknown error'}`
              : `Done — ${pending.toolName} executed.`;
            await sendWhatsApp(db, userId, reply, fromRaw).catch(() => {});
            return res.json({ ok: true, confirmed: true });
          }
        } catch (e) {
          logger.error('whatsapp.confirm.failed', { requestId: req.requestId, userId, error: e.message });
        }
        // fall through if no matching pending row
      }

      // ── Image download (if media present) ─────────────────────────────
      let imageData = null; // { mimeType, data (base64) }
      if (mediaUrl) {
        try {
          const imgRes = await fetch(mediaUrl);
          if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
          const contentType = imgRes.headers.get('content-type') || '';
          const supportedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          const mimeType = supportedTypes.find(t => contentType.includes(t));
          if (!mimeType) {
            await sendWhatsApp(db, user.id, 'I can only read photos and documents — try sending a JPG or PNG.', fromRaw).catch(() => {});
            return res.json({ ok: true, skipped: 'unsupported media type' });
          }
          const arrayBuf = await imgRes.arrayBuffer();
          imageData = { mimeType, data: Buffer.from(arrayBuf).toString('base64') };
          logger.info('whatsapp.image.downloaded', { requestId: req.requestId, mimeType, sizeKB: Math.round(arrayBuf.byteLength / 1024) });
        } catch (imgErr) {
          logger.error('whatsapp.image.downloadFailed', { requestId: req.requestId, error: imgErr.message });
          await sendWhatsApp(db, user.id, "I couldn't load that image — can you try sending it again?", fromRaw).catch(() => {});
          return res.json({ ok: true, skipped: 'image download failed' });
        }
      }

      // ── Check for pending completion note ────────────────────────────────
      const pendingKey = userId;
      const pending = pendingCompletionNotes.get(pendingKey);
      if (pending && Date.now() < pending.expiresAt) {
        // This message might be a completion note reply — save it
        pendingCompletionNotes.delete(pendingKey);
        try {
          await db.updateTask(pending.taskId, userId, { completionNote: msgBody });
          await db.logMemory({
            userId, tool: 'complete_task',
            content: `Added completion note to "${pending.taskTitle}": ${msgBody}`,
            metadata: { task_id: pending.taskId, completion_note: true, source: 'whatsapp' },
          }).catch(() => {});
          await sendWhatsApp(db, userId, `Got it — saved your note on "${pending.taskTitle}".`, fromRaw).catch(() => {});
          return res.json({ ok: true, completionNote: true });
        } catch (err) {
          logger.error('whatsapp.completionNote.saveFailed', { requestId: req.requestId, userId, error: err.message });
        }
      }
      // Clean up expired entry
      if (pending) pendingCompletionNotes.delete(pendingKey);

      // ── Entity candidate extraction ─────────────────────────────────────
      // Pattern 1: "for [entity name]" anywhere in the message
      const forMatch = msgBody.match(/\bfor\s+([A-Za-z0-9][A-Za-z0-9 &'.-]*[A-Za-z0-9])\s*[.!?]?\s*$/i)
                    || msgBody.match(/\bfor\s+([A-Za-z0-9][A-Za-z0-9 &'.-]*[A-Za-z0-9])(?=\s+(?:by|on|due|before|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)/i);
      let entityCandidate = forMatch ? forMatch[1].trim() : null;

      // ── Fuzzy match entity candidate against user's DB entities ────────
      let matchedEntity = null; // { id, name }
      let userEntityList = [];
      try {
        userEntityList = await db.getEntitiesForUser(userId);
      } catch (e) { logger.error('whatsapp.entityLoad.failed', { requestId: req.requestId, userId, error: e.message }); }

      if (userEntityList.length > 0) {
        // Pattern 2: if no "for X" match, check if message ends with a known entity name
        if (!entityCandidate) {
          const msgLower = msgBody.toLowerCase().replace(/[.!?]+$/, '').trim();
          for (const ent of userEntityList) {
            if (msgLower.endsWith(ent.name.toLowerCase())) {
              entityCandidate = ent.name;
              break;
            }
          }
        }

        // Fuzzy match: case-insensitive, startsWith or exact
        if (entityCandidate) {
          const candidateLower = entityCandidate.toLowerCase();
          matchedEntity = userEntityList.find(e => e.name.toLowerCase() === candidateLower)
                       || userEntityList.find(e => e.name.toLowerCase().startsWith(candidateLower))
                       || null;
          if (matchedEntity) {
            logger.info('whatsapp.entity.matched', { requestId: req.requestId, userId, candidate: entityCandidate, matchedName: matchedEntity.name, matchedId: matchedEntity.id });
          }
        }
      }

      // ── Load full context via shared builder ──────────────────────────
      const ctx = await buildAgenticContext({
        userId, entityIds, db, tz: tzForUser,
        loadGcalTokens, makeOAuth2Client, google,
        logger, requestId: req.requestId,
      });
      const tz = ctx.tz;

      const entityContext = matchedEntity
        ? `\nThe user's message references entity: "${matchedEntity.name}" (id: ${matchedEntity.id}). Apply this entity to any task created in this conversation by passing entity_name="${matchedEntity.name}" to create_task.`
        : '';
      const imageInstructions = imageData
        ? `\nIf the user sends an image with no message, describe what you see clearly and concisely, then recommend one specific action (create a task, log an expense, save a note). If the user sends an image with a message, use the message as context to interpret the image and act on it. If intent is unclear, ask one clarifying question only.`
        : '';
      const whatsappSuffix = `\nRespond via WhatsApp — max 3 sentences unless more detail is asked for. No sign-off.${imageInstructions}${entityContext}`;
      const systemPrompt = ctx.systemPrompt + whatsappSuffix;

      // ── Agentic loop — multi-turn tool execution ─────────────────────
      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db, tz);

      // WhatsApp confirmation gate: for high-risk tools, stash the request,
      // send YES/NO prompt, and deny execution so the loop ends cleanly.
      // A later inbound message resolves the pending row.
      let waSentConfirmation = false;
      const gateToolExecution = async ({ tool, input, decision }) => {
        if (!requiresConfirmation(tool, decision)) return { action: 'allow' };
        try {
          const pending = await db.createPendingConfirmation({ userId, toolName: tool, params: input, channel: 'whatsapp' });
          const code = codeFromConfirmId(pending.id);
          const preview = summarizeParams(tool, input);
          const prompt = `Confirm: ${preview}.\nReply YES ${code} or NO ${code} within 2 minutes.`;
          await sendWhatsApp(db, userId, prompt, fromRaw).catch(() => {});
          waSentConfirmation = true;
          await db.logAgentAction({ userId, eventType: 'confirmation_requested', toolName: tool, input, confirmId: pending.id });
          return { action: 'deny', reason: 'awaiting_whatsapp_confirmation', message: `Awaiting user confirmation via WhatsApp (code ${code}).` };
        } catch (err) {
          logger.error('whatsapp.gate.failed', { userId, tool, error: err.message });
          return { action: 'deny', reason: 'gate_error', message: `Could not request confirmation.` };
        }
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

      // ── Load conversation history (last 3 exchanges = 6 messages) ────
      // If the most recent message is older than SESSION_TIMEOUT_MS, start
      // a fresh session so stale context (e.g. yesterday's topic) doesn't
      // bleed into today's turn.
      const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      let priorMessages = [];
      try {
        const history = await db.getWhatsAppHistory(userId, normalizedPhone, 6);
        // history is oldest-first, so most-recent is the last element.
        const mostRecent = history.length ? history[history.length - 1] : null;
        const age = mostRecent?.createdAt ? Date.now() - new Date(mostRecent.createdAt).getTime() : null;
        if (age !== null && age > SESSION_TIMEOUT_MS) {
          logger.info('whatsapp.history.sessionExpired', { requestId: req.requestId, userId, ageMinutes: Math.round(age / 60000) });
          priorMessages = [];
        } else {
          priorMessages = history.map(m => ({ role: m.role, content: m.content }));
        }
      } catch (e) { logger.error('whatsapp.history.loadFailed', { requestId: req.requestId, userId, error: e.message }); }

      // Build user message — text-only or multipart (image + text) for vision
      let userMessageContent;
      if (imageData) {
        const contentParts = [
          { type: 'image', source: { type: 'base64', media_type: imageData.mimeType, data: imageData.data } },
          { type: 'text', text: msgBody || 'What is this?' },
        ];
        userMessageContent = contentParts;
      } else {
        userMessageContent = msgBody;
      }

      const { text, toolSummaries } = await runAgenticLoop({
        messages: [...priorMessages, { role: 'user', content: userMessageContent }],
        system: systemPrompt,
        tools: getToolSchemasForApi(),
        userId,
        executeTool: boundExecuteTool,
        gateToolExecution,
        logAction,
        // no onProgress — WhatsApp is fire-and-reply
      });

      // If we sent a confirmation prompt mid-loop, skip the model's
      // post-tool text so we don't double-message the user.
      let reply = waSentConfirmation ? '' : text;

      // ── Correction learning: detect → extract → persist → ack ──
      try {
        if (reply && msgBody) {
          const { acknowledgment } = await handlePossibleCorrection({
            userId, userMessage: msgBody, lastAssistantMessage: reply, db,
          });
          if (acknowledgment) reply = reply + acknowledgment;
        }
      } catch (err) {
        logger.error('whatsapp.learning.failed', { requestId: req.requestId, userId, error: err.message });
      }

      // ── Persist conversation (best-effort) ─────────────────────────────
      try {
        await db.saveWhatsAppMessage(userId, normalizedPhone, 'user', msgBody || '[image]');
        if (reply) await db.saveWhatsAppMessage(userId, normalizedPhone, 'assistant', reply);
      } catch (e) { logger.error('whatsapp.history.saveFailed', { requestId: req.requestId, userId, error: e.message }); }

      // ── Reply via user's UltraMsg integration ──────────────────────────
      if (reply) {
        const r = await sendWhatsApp(db, userId, reply, fromRaw);
        if (!r.ok) logger.error('whatsapp.reply.failed', { requestId: req.requestId, userId, reason: r.reason });
      }

      // ── Completion note follow-up prompt ────────────────────────────────
      const completedTool = (toolSummaries || []).find(s => s.tool === 'complete_task' && s.success);
      if (completedTool) {
        const taskId = completedTool.result?.task_id;
        const taskTitle = completedTool.result?.title;
        if (taskId && taskTitle && !completedTool.result?.completion_note) {
          pendingCompletionNotes.set(userId, {
            taskId, taskTitle,
            expiresAt: Date.now() + 5 * 60 * 1000,
          });
          const r = await sendWhatsApp(db, userId, 'Any notes on how it went? Reply with a note or just ignore this.', fromRaw);
          if (!r.ok) logger.error('whatsapp.completionPrompt.failed', { requestId: req.requestId, userId, reason: r.reason });
        }
      }

      return res.json({ ok: true });
    } catch (err) {
      logger.error('whatsapp.inbound.failed', { requestId: req.requestId, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
