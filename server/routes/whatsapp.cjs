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
const { ARIA_TOOLS, executeTool } = require('../tools.cjs');
const { getTodayLocal } = require('../utils/date.cjs');
const { runAgenticLoop } = require('../lib/agenticLoop.cjs');

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
      console.log('WHATSAPP INBOUND:', JSON.stringify(req.body, null, 2));
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
      console.log(`[whatsapp] Message from ${normalizedPhone}: "${msgBody.slice(0, 50)}${msgBody.length > 50 ? '...' : ''}"${mediaUrl ? ' [+image]' : ''}`);

      // Look up user by WhatsApp phone
      const user = await db.getUserByWhatsAppPhone(normalizedPhone);
      if (!user) {
        console.log(`[whatsapp/inbound] No user found for phone ${normalizedPhone}`);
        return res.json({ ok: true, skipped: 'unknown sender' });
      }

      const userId = user.id;
      const entityIds = user.entityIds || [];

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
            // Unsupported media type — reply and bail
            const ultraInstance = process.env.ULTRAMSG_INSTANCE;
            const ultraToken = process.env.ULTRAMSG_TOKEN;
            if (ultraInstance && ultraToken) {
              await fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: ultraToken, to: fromRaw, body: 'I can only read photos and documents — try sending a JPG or PNG.' }),
              }).catch(() => {});
            }
            return res.json({ ok: true, skipped: 'unsupported media type' });
          }
          const arrayBuf = await imgRes.arrayBuffer();
          imageData = { mimeType, data: Buffer.from(arrayBuf).toString('base64') };
          console.log(`[whatsapp] Image downloaded: ${mimeType}, ${Math.round(arrayBuf.byteLength / 1024)}KB`);
        } catch (imgErr) {
          console.error('[whatsapp/inbound] Image download failed:', imgErr.message);
          const ultraInstance = process.env.ULTRAMSG_INSTANCE;
          const ultraToken = process.env.ULTRAMSG_TOKEN;
          if (ultraInstance && ultraToken) {
            await fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: ultraToken, to: fromRaw, body: "I couldn't load that image — can you try sending it again?" }),
            }).catch(() => {});
          }
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
          await db.updateTask(pending.taskId, { completionNote: msgBody });
          await db.logMemory({
            userId, tool: 'complete_task',
            content: `Added completion note to "${pending.taskTitle}": ${msgBody}`,
            metadata: { task_id: pending.taskId, completion_note: true, source: 'whatsapp' },
          }).catch(() => {});
          // Reply confirming the note was saved
          const ultraInstance = process.env.ULTRAMSG_INSTANCE;
          const ultraToken = process.env.ULTRAMSG_TOKEN;
          if (ultraInstance && ultraToken) {
            await fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: ultraToken, to: fromRaw, body: `Got it — saved your note on "${pending.taskTitle}".` }),
            }).catch(() => {});
          }
          return res.json({ ok: true, completionNote: true });
        } catch (err) {
          console.error('[whatsapp/inbound] completion note save failed:', err.message);
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
      } catch (e) { console.error('[whatsapp] entity load failed:', e.message); }

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
            console.log(`[whatsapp] Entity matched: "${entityCandidate}" → ${matchedEntity.name} (${matchedEntity.id})`);
          }
        }
      }

      // ── Load full context (same pattern as /api/chat/execute) ───────────
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
            const { data: calData } = await calendar.events.list({
              calendarId: 'primary',
              timeMin: now.toISOString(),
              timeMax: weekOut.toISOString(),
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 20,
            });
            calendarEvents = (calData.items || []).map(ev => ({
              title: (ev.summary || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
              start: ev.start?.dateTime || ev.start?.date || '',
            }));
          }
        }
      } catch (calErr) {
        console.error('[whatsapp/inbound] calendar fetch failed:', calErr.message);
      }

      let recentMemories = [];
      try { recentMemories = await db.getRecentMemories(userId, 20); } catch {}

      let calendarNotes = [];
      try { calendarNotes = await db.getCalendarNotesForAI(userId); } catch {}

      const tz = user.timezone;
      const todayStr = getTodayLocal(tz);
      const todayDate = todayStr.split(', ')[1];
      // Build explicit weekday→date map so the model never has to compute relative dates
      const weekMapParts = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const dayAbbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
        const monthDay = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
        weekMapParts.push(`${dayAbbr}=${monthDay}`);
      }
      const weekMapStr = `This week: ${weekMapParts.join(', ')}.`;
      const activeTasks = tasks.filter(t => !t.completed);
      const recentCompleted = tasks.filter(t => t.completed && t.completionNote);
      const contextAppend = `\n\n## Live Data\nActive tasks (${activeTasks.length}): ${
        activeTasks.slice(0, 30).map(t =>
          `[${t.id}] ${t.title} (${t.priority}${t.dueDate ? ', due ' + t.dueDate : ''}${t.dueDate && t.dueDate < todayDate ? ', OVERDUE' : ''})`
        ).join('; ') || 'none'
      }${recentCompleted.length ? `\nRecently completed with notes: ${recentCompleted.slice(0, 10).map(t => `${t.title} — completed.${t.description ? ` Note at creation: ${t.description}.` : ''} Outcome note: ${t.completionNote}`).join('; ')}` : ''
      }\nRecent notes: ${notes.slice(0, 10).map(n => n.title).join(', ') || 'none'
      }${calendarNotes.length ? `\nCalendar meeting notes (recent): ${calendarNotes.slice(0, 15).map(cn => `"${cn.eventTitle}" (${cn.eventStart ? new Date(cn.eventStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'})${cn.preNote ? ' Agenda: ' + cn.preNote.slice(0, 100) : ''}${cn.postNote ? ' Outcomes: ' + cn.postNote.slice(0, 100) : ''}`).join('; ')}` : ''
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

      const assistantName = user.assistantName || 'Aria';
      const userName = user.profileName || user.displayName || 'the user';
      const currentTime = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date());
      const entityContext = matchedEntity
        ? `\nThe user's message references entity: "${matchedEntity.name}" (id: ${matchedEntity.id}). Apply this entity to any task created in this conversation by passing entity_name="${matchedEntity.name}" to create_task.`
        : '';
      const imageInstructions = imageData
        ? `\nIf the user sends an image with no message, describe what you see clearly and concisely, then recommend one specific action (create a task, log an expense, save a note). If the user sends an image with a message, use the message as context to interpret the image and act on it. If intent is unclear, ask one clarifying question only.`
        : '';
      const systemPrompt = `${profileContext}You are ${assistantName}, ${userName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything. You also have tools to create tasks, notes, and calendar events. Use tools when taking action. For everything else, respond naturally. Be warm and concise. Today is ${todayStr}. Current time: ${currentTime} (${tz}). The user's timezone is ${tz}.\n${weekMapStr}\nWhen setting due times, use the user's local timezone — NOT UTC.\nRespond via WhatsApp — max 3 sentences unless more detail is asked for. No sign-off.${imageInstructions}${entityContext}${contextAppend}`;

      // ── Agentic loop — multi-turn tool execution ─────────────────────
      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db, tz);

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
        messages: [{ role: 'user', content: userMessageContent }],
        system: systemPrompt,
        tools: ARIA_TOOLS,
        userId,
        executeTool: boundExecuteTool,
        // no onProgress — WhatsApp is fire-and-reply
      });

      const reply = text;

      // ── Reply via UltraMsg ──────────────────────────────────────────────
      const ultraInstance = process.env.ULTRAMSG_INSTANCE;
      const ultraToken = process.env.ULTRAMSG_TOKEN;
      if (ultraInstance && ultraToken && reply) {
        try {
          await fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: ultraToken, to: fromRaw, body: reply }),
          });
        } catch (replyErr) {
          console.error('[whatsapp/inbound] Reply failed:', replyErr.message);
        }
      }

      // ── Completion note follow-up prompt ────────────────────────────────
      // If a task was completed, send one follow-up asking for a note.
      const completedTool = (toolSummaries || []).find(s => s.tool === 'complete_task' && s.success);
      if (completedTool && ultraInstance && ultraToken) {
        const taskId = completedTool.result?.task_id;
        const taskTitle = completedTool.result?.title;
        if (taskId && taskTitle && !completedTool.result?.completion_note) {
          pendingCompletionNotes.set(userId, {
            taskId, taskTitle,
            expiresAt: Date.now() + 5 * 60 * 1000, // 5-minute TTL
          });
          try {
            await fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: ultraToken, to: fromRaw, body: 'Any notes on how it went? Reply with a note or just ignore this.' }),
            });
          } catch (promptErr) {
            console.error('[whatsapp/inbound] Completion note prompt failed:', promptErr.message);
          }
        }
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('[whatsapp/inbound] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
