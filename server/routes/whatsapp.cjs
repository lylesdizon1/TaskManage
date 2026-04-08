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
 * @note Media messages are acknowledged (200 OK) but not processed
 * in v1 — text body is required. Image handling is a planned
 * feature.
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
      if (!data) return res.json({ ok: true, skipped: 'no data' });

      // Only handle text messages, skip media/status/etc
      const msgBody = data.body;
      const fromRaw = data.from;
      if (!msgBody || !fromRaw) return res.json({ ok: true, skipped: 'non-text or missing sender' });

      // Normalize phone: strip non-digits
      const normalizedPhone = fromRaw.replace(/\D/g, '');
      console.log(`[whatsapp] Message from ${normalizedPhone}: "${msgBody.slice(0, 50)}${msgBody.length > 50 ? '...' : ''}"`);

      // Look up user by WhatsApp phone
      const user = await db.getUserByWhatsAppPhone(normalizedPhone);
      if (!user) {
        console.log(`[whatsapp/inbound] No user found for phone ${normalizedPhone}`);
        return res.json({ ok: true, skipped: 'unknown sender' });
      }

      // ── Load full context (same pattern as /api/chat/execute) ───────────
      const userId = user.id;
      const entityIds = user.entityIds || [];
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
      const systemPrompt = `${profileContext}You are ${assistantName}, ${userName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything. You also have tools to create tasks, notes, and calendar events. Use tools when taking action. For everything else, respond naturally. Be warm and concise. Today is ${todayStr}. Current time: ${currentTime} (${tz}). The user's timezone is ${tz}.\n${weekMapStr}\nWhen setting due times, use the user's local timezone — NOT UTC.\nRespond via WhatsApp — max 3 sentences unless more detail is asked for. No sign-off.${contextAppend}`;

      // ── Agentic loop — multi-turn tool execution ─────────────────────
      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db, tz);

      const { text } = await runAgenticLoop({
        messages: [{ role: 'user', content: msgBody }],
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

      return res.json({ ok: true });
    } catch (err) {
      console.error('[whatsapp/inbound] Error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
