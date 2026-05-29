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
const crypto    = require('crypto');
const sharp     = require('sharp');
const { ARIA_TOOLS, executeTool, getToolByName, getToolSchemasForApi, requiresConfirmation } = require('../tools.cjs');
const { evaluateAction } = require('../lib/decisionEngine.cjs');
const { closeDecisionWithFeedback, processSkillFeedback } = require('../lib/trustFeedback.cjs');
const { getTodayLocal } = require('../utils/date.cjs');
const { runAgenticLoop } = require('../lib/agenticLoop.cjs');
const { buildAgenticContext } = require('../lib/buildAgenticContext.cjs');
const { handlePossibleCorrection } = require('../lib/learningHandler.cjs');
const { sendWhatsApp } = require('../utils/integrations.cjs');
const { rediGet, rediSet } = require('../lib/redis.cjs');
const { transcribeAudio } = require('../lib/audioTranscription.cjs');
const logger = require('../../guardrails/logger.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');

// 2026-05-15 — codes dropped from WhatsApp confirmation gate. Channel is
// internal-only (Lyle/Liz/Leo) per project_whatsapp_twilio_migration; the
// risk acceptance is on record. Disambiguation switched to strict YES/NO
// + 10-minute window + LIFO match on pending_confirmations.

// Strict YES/NO matchers — must be the entire message (trimmed), so a
// reply like "yes here's my note" doesn't accidentally resolve a pending
// confirmation. Optional trailing period accepted for natural typing.
const STRICT_YES = /^(YES|Y)\.?$/i;
const STRICT_NO  = /^(NO|N)\.?$/i;

// Per-tool render for the confirmation prompt body. Returns the
// human-readable preview (NO code, NO YES/NO line — those are appended
// uniformly at the call site). Image-attached create_note gets a richer
// shape showing the inferred title and body excerpt so the user can
// verify the OCR extraction before saving.
function renderConfirmationBody(tool, params) {
  const p = params || {};
  if (tool === 'send_email')   return `Send email to ${p.to}\nSubject: ${p.subject || '(no subject)'}`;
  if (tool === 'reply_email')  return `Send reply on thread ${p.thread_id}`;
  if (tool === 'delete_task')  return `Delete task ${p.task_id}`;
  if (tool === 'delete_event') return `Delete event ${p.event_id}`;
  if (tool === 'create_note') {
    const title = p.title || '(untitled)';
    const body  = (p.content || '').trim();
    const excerpt = body.length > 200 ? `${body.slice(0, 200).trim()}…` : body;
    const fromPhoto = p.image_blob_id ? ' (from photo)' : '';
    return excerpt
      ? `Save as note${fromPhoto}: "${title}"\n\n${excerpt}`
      : `Save as note${fromPhoto}: "${title}"`;
  }
  if (tool === 'create_contact') {
    // OCR'd business cards confirm via WhatsApp text. Render the
    // extracted fields in a compact card-like layout so the user can
    // verify before saving. display_name fallback follows the same
    // derivation rule as the executor (first+last → company →
    // 'New contact').
    const first = p.first_name ? String(p.first_name).trim() : '';
    const last  = p.last_name  ? String(p.last_name).trim()  : '';
    const joinedName = [first, last].filter(Boolean).join(' ');
    const name = p.display_name || joinedName || p.company || 'New contact';
    const roleLine = [p.role, p.company].filter(Boolean).join(' · ');
    const contactLine = [p.primary_email, p.primary_phone].filter(Boolean).join(' · ');
    const fromPhoto = p.image_blob_id ? ' (from photo)' : '';
    const lines = [`Save as contact${fromPhoto}:`, `  ${name}`];
    if (roleLine)    lines.push(`  ${roleLine}`);
    if (contactLine) lines.push(`  ${contactLine}`);
    return lines.join('\n');
  }
  // Defensive — any future gated tool without a dedicated render lands
  // here. Better than the bare tool name (which is what the user would
  // have seen on the capture_from_image misfire before Bug 1 was fixed).
  return `Confirm action: ${tool}`;
}

// Per-tool action verb. Both the YES side ("save"/"send"/"delete") and
// the NO side end in "cancel" — uniform refusal verb keeps the prompt
// readable across tools.
function actionVerbFor(tool) {
  if (tool === 'send_email' || tool === 'reply_email') return 'send';
  if (tool === 'delete_task' || tool === 'delete_event') return 'delete';
  if (tool === 'create_note' || tool === 'create_event' || tool === 'create_task') return 'save';
  return 'confirm';
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

      // Extract text body and media URL (if any). Mutable because voice
      // notes get transcribed and the transcript is substituted in as
      // the user's message body for the rest of the handler.
      let msgBody = data.body || '';
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
      const tzForUser = user.timezone || DEFAULT_TIMEZONE;

      // ── Check for YES/NO confirmation reply to a prior high-risk prompt ──
      // 2026-05-15 — codes dropped. Strict YES/NO + 10-minute window
      // (enforced by pending_confirmations.expires_at, set to 10m for
      // WhatsApp at insert time) + LIFO match on the latest pending row
      // for this user/channel. A "yes" with no fresh pending row falls
      // through to normal chat below.
      const trimmedBody = (msgBody || '').trim();
      const isYes = STRICT_YES.test(trimmedBody);
      const isNo  = STRICT_NO.test(trimmedBody);
      if (isYes || isNo) {
        const approved = isYes;
        try {
          const pending = await db.findLatestPendingConfirmation(userId, 'whatsapp');
          if (pending) {
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
              // Phase 5 — close the decision with trust feedback. Without
              // pending.decisionLogId (legacy rows from before the FK
              // shipped) this no-ops cleanly.
              if (pending.decisionLogId) {
                closeDecisionWithFeedback({
                  userId, decisionId: pending.decisionLogId, outcome: 'rejected',
                  actionType: pending.toolName, contextSummary: 'whatsapp_user_rejected',
                }).catch(() => {});
              }
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

            // Phase 5 — close the decision with trust feedback on approval.
            if (pending.decisionLogId) {
              closeDecisionWithFeedback({
                userId, decisionId: pending.decisionLogId, outcome: 'confirmed',
                actionType: pending.toolName, contextSummary: 'whatsapp_user_confirmed',
              }).catch(() => {});
            }

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
      // 2026-05-15 (Commit A — OCR pipeline):
      //   - HEIC accepted at ingress, converted to JPEG via sharp before
      //     persistence/Anthropic. iPhone users send HEIC by default.
      //   - Persisted bytes land in image_blobs for downstream re-render.
      //   - blob_id is threaded into the agentic system prompt so Aria
      //     can pass it as image_blob_id when calling capture_from_image
      //     and the downstream save tool.
      let imageData = null; // { mimeType, data (base64) }
      let imageBlobId = null;
      let isAudioMedia = false; // set when contentType is audio/*; suppresses image processing
      if (mediaUrl) {
        try {
          const imgRes = await fetch(mediaUrl);
          if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
          const contentType = (imgRes.headers.get('content-type') || '').toLowerCase();

          // ── Audio (voice note) handling ─────────────────────────────────
          // WhatsApp voice notes arrive as audio/ogg (Opus). Whisper
          // handles them natively — transcribe, substitute the transcript
          // for msgBody, and fall through to the regular agentic loop
          // as if the user typed it.
          if (contentType.startsWith('audio/')) {
            isAudioMedia = true;
            const audioBytes = Buffer.from(await imgRes.arrayBuffer());

            // Per-user audio dedup (same pattern as image dedup —
            // UltraMsg may retry voice notes on transport blip).
            const audioHash = crypto.createHash('sha256').update(audioBytes).digest('hex');
            const audioDedupKey = `whatsapp:audio:dedup:${user.id}:${audioHash}`;
            try {
              const cached = await rediGet(audioDedupKey);
              if (cached) {
                logger.info('whatsapp.audio.dedupHit', { requestId: req.requestId, userId: user.id, hash: audioHash.slice(0, 8) });
                return res.json({ ok: true, skipped: 'duplicate voice note (cached)' });
              }
            } catch { /* Redis miss — proceed */ }

            // Immediate ack so the user knows we got it (Whisper can take
            // 1-3s for short clips). This doubles as their "still working"
            // signal during transcription.
            await sendWhatsApp(db, user.id, 'Listening to your voice note…', fromRaw).catch(() => {});

            const result = await transcribeAudio(audioBytes, contentType, { userId: user.id });
            if (!result.ok) {
              logger.warn('whatsapp.audio.transcribeFailed', { requestId: req.requestId, userId: user.id, error: result.error });
              await sendWhatsApp(db, user.id, "I couldn't transcribe that voice note — try again or type it out.", fromRaw).catch(() => {});
              return res.json({ ok: true, skipped: 'transcription failed' });
            }

            // Substitute transcript as the user's message body.
            msgBody = result.text;
            logger.info('whatsapp.audio.transcribed', {
              requestId: req.requestId, userId: user.id,
              audioBytes: audioBytes.length, transcriptChars: msgBody.length,
            });

            // Stamp dedup so retries within 5 min short-circuit.
            try { await rediSet(audioDedupKey, 'transcribed', 300); } catch { /* best-effort */ }

            // Fall through to the rest of the handler. The image-processing
            // block below skips on isAudioMedia. msgBody now contains the
            // transcript, so the standard agentic loop treats this like
            // any typed-message turn.
          }

          // Image processing — skipped entirely when this turn was an
          // audio voice note (response body already consumed by the
          // transcription path above; msgBody now holds the transcript
          // and the handler proceeds as if the user typed it).
          if (!isAudioMedia) {
          const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          const HEIC = ['image/heic', 'image/heif'];
          const isHeic = HEIC.some(t => contentType.includes(t));
          let mimeType = SUPPORTED.find(t => contentType.includes(t)) || null;
          if (!mimeType && !isHeic) {
            await sendWhatsApp(db, user.id, 'I can only read photos and documents — try sending a JPG, PNG, or HEIC.', fromRaw).catch(() => {});
            return res.json({ ok: true, skipped: 'unsupported media type' });
          }
          let bytes = Buffer.from(await imgRes.arrayBuffer());

          // Per-image dedup gate (audit-driven 2026-05-28). UltraMsg
          // retries failed webhook deliveries; the same image bytes can
          // arrive 3-5× within seconds before the persisted blob_id
          // exists to dedup against. SHA256(bytes) + per-user 5-min
          // Redis cache short-circuits identical re-deliveries. The
          // cached value is the original imageBlobId so downstream
          // tools (capture_from_image etc) get the same reference.
          const imageHash = crypto.createHash('sha256').update(bytes).digest('hex');
          const dedupKey = `whatsapp:img:dedup:${userId}:${imageHash}`;
          try {
            const cachedBlobId = await rediGet(dedupKey);
            if (cachedBlobId) {
              logger.info('whatsapp.image.dedupHit', {
                requestId: req.requestId, userId, hash: imageHash.slice(0, 8), cachedBlobId,
              });
              return res.json({ ok: true, skipped: 'duplicate image (cached)', cached_blob_id: cachedBlobId });
            }
          } catch { /* Redis miss — proceed */ }

          if (isHeic) {
            // HEIC has no native Anthropic support — transcode to JPEG.
            // Sharp's HEIC support is built-in when libvips is compiled
            // with HEIF; Railway's Node image ships it. Quality 85 is the
            // visual-vs-size sweet spot.
            try {
              bytes = await sharp(bytes).jpeg({ quality: 85 }).toBuffer();
              mimeType = 'image/jpeg';
              logger.info('whatsapp.image.heicConverted', { requestId: req.requestId, sizeKB: Math.round(bytes.length / 1024) });
            } catch (convErr) {
              logger.error('whatsapp.image.heicConvertFailed', { requestId: req.requestId, error: convErr.message });
              await sendWhatsApp(db, user.id, "I couldn't read that HEIC photo — try sending as JPG.", fromRaw).catch(() => {});
              return res.json({ ok: true, skipped: 'heic conversion failed' });
            }
          }
          imageData = { mimeType, data: bytes.toString('base64') };
          // Persist to image_blobs so capture_from_image + downstream save
          // tools can reference the source image. 90-day expiry by default;
          // sweep cron lands in Phase 1.5.
          try {
            const expiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000);
            imageBlobId = await db.insertImageBlob({
              userId, mimeType, bytes, source: 'whatsapp_inbound', expiresAt,
            });
          } catch (blobErr) {
            // Persistence failure shouldn't block the vision call — Aria
            // can still describe the image, just without blob_id for
            // downstream save tools.
            logger.warn('whatsapp.image.persistFailed', { requestId: req.requestId, error: blobErr.message });
          }
          // Stamp the dedup cache with the blob_id so retries within 5
          // min short-circuit. TTL longer than UltraMsg's worst-case
          // retry backoff but short enough that a deliberate re-send
          // 10 minutes later is processed as a new image.
          if (imageBlobId) {
            try { await rediSet(dedupKey, imageBlobId, 300); } catch { /* best-effort */ }
          }
          logger.info('whatsapp.image.downloaded', { requestId: req.requestId, mimeType, sizeKB: Math.round(bytes.length / 1024), imageBlobId });
          } // end if (!isAudioMedia)
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
        // This message might be a completion note reply — save it.
        // Note: pendingCompletionNotes.delete moves AFTER the successful
        // updateTask. Prior code deleted before the save, so on failure
        // the user's retry wasn't recognized as a completion note (just
        // a regular Aria message) and their note was lost without trace.
        try {
          await db.updateTask(pending.taskId, userId, { completionNote: msgBody });
          pendingCompletionNotes.delete(pendingKey);
          await db.logMemory({
            userId, tool: 'complete_task',
            content: `Added completion note to "${pending.taskTitle}": ${msgBody}`,
            metadata: { task_id: pending.taskId, completion_note: true, source: 'whatsapp' },
          }).catch(() => {});
          await sendWhatsApp(db, userId, `Got it — saved your note on "${pending.taskTitle}".`, fromRaw).catch(() => {});
          return res.json({ ok: true, completionNote: true });
        } catch (err) {
          logger.error('whatsapp.completionNote.saveFailed', { requestId: req.requestId, userId, error: err.message });
          // Tell the user the save failed and exit — DO NOT fall through
          // to the rest of the message-handling pipeline (which would
          // route this same message into Aria as if it were a fresh chat,
          // confusing both the agent and the user).
          await sendWhatsApp(db, userId, "Couldn't save your note — try again.", fromRaw).catch(() => {});
          return res.json({ ok: true, completionNote: false, error: 'save_failed' });
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
      // msgBody powers the chatContext envelope for skills loading (M1.5).
      const ctx = await buildAgenticContext({
        userId, entityIds, db, tz: tzForUser,
        userMessage: msgBody || '',
        loadGcalTokens, makeOAuth2Client, google,
        logger, requestId: req.requestId,
      });

      // Skill trust feedback (M1.7) — fire-and-forget. Same regex
      // detection as the web chat path.
      if (msgBody) {
        processSkillFeedback({ userId, userMessage: msgBody, db })
          .then((applied) => {
            if (applied.length && logger?.info) {
              logger.info('skill.feedback.applied', { userId, applied });
            }
          })
          .catch(() => {});
      }
      const tz = ctx.tz;

      const entityContext = matchedEntity
        ? `\nThe user's message references entity: "${matchedEntity.name}" (id: ${matchedEntity.id}). Apply this entity to any task created in this conversation by passing entity_name="${matchedEntity.name}" to create_task.`
        : '';
      // 2026-05-15 (Commit A) — image-bearing turns: Aria must call
      // capture_from_image exactly once with image_blob_id=${imageBlobId}.
      // The tool returns the classification + extracted payload; Aria
      // then decides next steps based on class. For documents, call
      // create_note with image_blob_id so the save goes through the
      // confirmation gate. business_card and food don't have dedicated
      // save tools yet (Commits B and C) — describe the extracted
      // fields and say the dedicated save will land soon.
      const imageInstructions = imageData
        ? `\n\n## IMAGE RECEIVED\nAn image arrived with this message. image_blob_id = "${imageBlobId || ''}".\n\nCall capture_from_image EXACTLY ONCE with image_blob_id="${imageBlobId || ''}" to classify and extract structured content. Then act:\n  - classification=document, confidence >= 0.5: call create_note with title + content from the extracted document data and pass image_blob_id="${imageBlobId || ''}" (this routes through the YES/NO confirmation gate).\n  - classification=business_card, confidence >= 0.5: call create_contact with the extracted fields (first_name, last_name, primary_email, primary_phone, company, role) AND pass image_blob_id="${imageBlobId || ''}", source="business_card_ocr", raw_ocr_text=<the OCR text>. If extraction returned a duplicate=true error, follow up with update_contact instead — the existing contact's id will be available via list_contacts. Routes through the YES/NO confirmation gate.\n  - classification=food: surface the extracted items and tell the user food logging lands in an upcoming commit. Don't save.\n  - classification=unclear OR confidence < 0.5: describe what you see briefly and ask the user what to do — don't save.\n\nIf the user sent a message ALONG with the image, treat that message as additional intent context. If only an image, classify and act per the rules above.`
        : '';
      // Backstop for the schema filter above — even though capture_from_image
      // is removed from the schema when no image is attached, the prompt
      // guard makes the contract explicit. The image_blob_id values that
      // appear in conversation history refer to PAST images, not the
      // current message.
      const captureGuard = `\nDo NOT call capture_from_image unless a new image is attached to the user's current message. image_blob_id values appearing in prior conversation turns refer to past images and are NOT signals to call this tool again.`;
      const whatsappSuffix = `\nRespond via WhatsApp — max 3 sentences unless more detail is asked for. No sign-off.${captureGuard}${imageInstructions}${entityContext}`;
      // Prompt-caching split: cacheable prefix gets the ephemeral marker;
      // dynamic suffix + whatsapp-specific instructions live in the
      // second (uncached) block. Falls back to a joined string if
      // buildAgenticContext didn't expose the split fields.
      const systemPrompt = (ctx.systemCacheable !== undefined && ctx.systemDynamic !== undefined)
        ? [
            { type: 'text', text: ctx.systemCacheable, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: ctx.systemDynamic + whatsappSuffix },
          ]
        : ctx.systemPrompt + whatsappSuffix;

      // ── Agentic loop — multi-turn tool execution ─────────────────────
      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db, tz, 'whatsapp');

      // WhatsApp confirmation gate: for high-risk tools, stash the request,
      // send YES/NO prompt, and deny execution so the loop ends cleanly.
      // A later inbound message resolves the pending row.
      let waSentConfirmation = false;
      const gateToolExecution = async ({ tool, input, decision }) => {
        // Phase 3 — same compose pattern as ai.cjs. Engine runs first.
        // hard_stop short-circuits with explanation; auto_proceed
        // delegates to the existing requires_confirmation gate; engine
        // confirm/soft_confirm escalates to the WhatsApp YES/NO flow.
        let engineDisposition = 'auto_proceed';
        let engineReason = '';
        let engineDecisionId = null;
        try {
          const result = await evaluateAction(userId, tool, input, tzForUser);
          engineDisposition = result.disposition;
          engineReason = result.reason;
          engineDecisionId = result.decision_id;
        } catch (err) {
          logger.warn('whatsapp.decisionEngine.failed', { userId, tool, error: err.message });
          engineDisposition = 'confirm_required';
        }

        if (engineDisposition === 'hard_stop') {
          if (engineDecisionId) {
            closeDecisionWithFeedback({
              userId, decisionId: engineDecisionId, outcome: 'rejected',
              actionType: tool, contextSummary: engineReason || null,
            }).catch(() => {});
          }
          // WhatsApp doesn't have a confirmation-card UI — surface the
          // hard stop as the assistant's textual reply by sending it
          // directly to the user via UltraMsg.
          await sendWhatsApp(db, userId, engineReason || `I can't do that — it conflicts with one of your rules.`, fromRaw).catch(() => {});
          return { action: 'deny', reason: 'hard_stop', message: engineReason || 'Action blocked by rule.' };
        }

        const engineWantsConfirm = engineDisposition === 'confirm_required' || engineDisposition === 'soft_confirm';
        const toolWantsConfirm = requiresConfirmation(tool, decision, input);
        if (!engineWantsConfirm && !toolWantsConfirm) {
          if (engineDecisionId) {
            closeDecisionWithFeedback({
              userId, decisionId: engineDecisionId, outcome: 'executed',
              actionType: tool,
            }).catch(() => {});
          }
          return { action: 'allow' };
        }

        try {
          const pending = await db.createPendingConfirmation({
            userId, toolName: tool, params: input, channel: 'whatsapp',
            decisionLogId: engineDecisionId, // Phase 5 — let YES/NO webhook close the decision
            expiresAtMinutes: 10, // 2026-05-15: codes dropped, window extended so users have time to reply
          });
          const body = renderConfirmationBody(tool, input);
          const verb = actionVerbFor(tool);
          // If the engine raised confirmation, prepend its reason so the
          // user knows why we're asking (vs. baseline tool caution).
          const prefix = engineWantsConfirm && engineReason ? `${engineReason}\n\n` : '';
          const prompt = `${prefix}${body}\n\nReply YES to ${verb}, NO to cancel.`;
          // Check the send result — if WhatsApp delivery fails, the user
          // never sees the prompt. Without this, the agent reported
          // "Awaiting confirmation" while the row sat unfulfilled until
          // expiry. Roll back the pending row and surface a real error.
          const sendResult = await sendWhatsApp(db, userId, prompt, fromRaw);
          if (!sendResult?.ok) {
            logger.warn('whatsapp.confirmation.sendFailed', { userId, tool, reason: sendResult?.reason });
            await db.deletePendingConfirmation?.(pending.id, userId).catch(() => {});
            return { action: 'deny', reason: 'whatsapp_unreachable', message: "Couldn't reach you on WhatsApp to confirm — try again from the app." };
          }
          waSentConfirmation = true;
          await db.logAgentAction({ userId, eventType: 'confirmation_requested', toolName: tool, input, confirmId: pending.id });
          return { action: 'deny', reason: 'awaiting_whatsapp_confirmation', message: 'Awaiting user confirmation via WhatsApp.' };
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

      // ── Load conversation history (last 10 exchanges = 20 messages) ──
      // 2026-05-15 — bumped from 6 to 20. Dogfood Gap 4: at 6 messages
      // (3 exchanges) WhatsApp lost conversational context too fast,
      // putting all cross-session memory burden on memory_facts (which
      // doesn't fire on casual chat today — Gap 1, Phase 2 work). At
      // dogfood scale (Lyle/Liz/Leo) the extra token cost is moot.
      // If the most recent message is older than SESSION_TIMEOUT_MS, start
      // a fresh session so stale context (e.g. yesterday's topic) doesn't
      // bleed into today's turn.
      const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
      let priorMessages = [];
      try {
        const history = await db.getWhatsAppHistory(userId, normalizedPhone, 20);
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

      // 2026-05-15 hotfix — capture_from_image must only appear in the
      // tool schema when an image is actually attached to this turn.
      // Without this, the model pattern-matches against prior tool calls
      // in conversation history and re-fires capture_from_image on
      // non-image messages, breaking calendar / chat queries entirely.
      // Filtering at the schema level is structural; the prompt guard
      // below is defense-in-depth for the rare case the model
      // hallucinates a tool name outside the schema.
      const toolSchemas = imageData
        ? getToolSchemasForApi()
        : getToolSchemasForApi().filter((t) => t.name !== 'capture_from_image');

      // Pre-ack on first tool call. WhatsApp has no typing indicator;
      // tool calls (especially web search or inbox queries) can take
      // 2-8s before the model's final reply. Without an interim ack the
      // user feels the bot is stuck. Fire exactly one short message
      // on the first tool_start of the turn — subsequent tools in the
      // same turn stay silent to avoid chatter. The map below picks
      // friendlier copy for known tool families; everything else
      // falls back to a generic acknowledgment.
      let ackSent = false;
      const TOOL_ACK_COPY = {
        web_search: 'Searching the web…',
        search_inbox: 'Looking in your inbox…',
        search_gmail: 'Looking in your inbox…',
        get_email_content: 'Pulling up the email…',
        search_email_content: 'Searching email content…',
        list_contacts: 'Looking up your contacts…',
        get_contact: 'Looking up that contact…',
        search_tasks: 'Pulling up your tasks…',
        capture_from_image: 'Reading the photo…',
        start_sub_agent: 'Spinning up a research agent — I\'ll ping you when it\'s done.',
      };
      const onWhatsAppProgress = (evt) => {
        if (ackSent || evt?.type !== 'tool_start') return;
        // Suppress acks for confirmation-gated tools — the gate itself
        // sends a YES/NO prompt and a pre-ack would chain weirdly.
        const tool = evt.tool;
        const def = getToolByName(tool);
        if (def?.requires_confirmation) return;
        const copy = TOOL_ACK_COPY[tool] || 'Working on it…';
        ackSent = true;
        // Fire-and-forget — never block the loop on UltraMsg I/O.
        sendWhatsApp(db, userId, copy, fromRaw).catch((err) => {
          logger.warn('whatsapp.preack.failed', { userId, tool, error: err.message });
        });
      };

      const { text, toolSummaries } = await runAgenticLoop({
        messages: [...priorMessages, { role: 'user', content: userMessageContent }],
        system: systemPrompt,
        tools: toolSchemas,
        userId,
        executeTool: boundExecuteTool,
        gateToolExecution,
        logAction,
        channel: 'whatsapp',
        onProgress: onWhatsAppProgress,
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

      // ── M1b memory extraction (fire-and-forget, env-gated) ─────────────
      // SHIPPED INERT — controlled by MEMORY_EXTRACTOR_ENABLED Railway env.
      // Skipped when we sent a confirmation mid-loop (the assistant text
      // is "Awaiting confirmation" boilerplate, not real signal).
      if (!waSentConfirmation && msgBody && reply) {
        try {
          const { enrichConversationTurn } = require('../lib/conversationEnrichment.cjs');
          enrichConversationTurn({
            userId,
            channel: 'whatsapp',
            userMessage: msgBody,
            assistantText: reply,
            toolsCalled: (toolSummaries || []).map((s) => s.tool).filter(Boolean),
          }).catch((err) => logger.error('whatsapp.memoryExtract.failed', { userId, error: err.message }));
        } catch (e) { logger.warn('whatsapp.memoryExtract.requireFailed', { error: e.message }); }
      }

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
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
