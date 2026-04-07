'use strict';

const express   = require('express');
const { ARIA_TOOLS, executeTool } = require('../tools.cjs');
const { runAgenticLoop } = require('../lib/agenticLoop.cjs');

/**
 * WhatsApp inbound webhook route
 *
 *   POST /api/whatsapp/inbound  (public — no JWT auth)
 *
 * Single tool-use flow: Sonnet with ARIA_TOOLS decides whether to act,
 * then executeTool runs any requested mutations and a second Sonnet call
 * generates the confirmation text.
 */
module.exports = function createWhatsAppRouter({ db, loadGcalTokens, makeOAuth2Client, google }) {
  const router = express.Router();

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

      const tz = user.profileTimezone || 'America/Los_Angeles';
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

      const assistantName = user.assistantName || 'Aria';
      const userName = user.profileName || user.displayName || 'the user';
      const systemPrompt = `${profileContext}You are ${assistantName}, ${userName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything. You also have tools to create tasks, notes, and calendar events. Use tools when taking action. For everything else, respond naturally. Be warm and concise. Today's date is ${todayStr}. Respond via WhatsApp — max 3 sentences unless more detail is asked for. No sign-off.${contextAppend}`;

      // ── Agentic loop — multi-turn tool execution ─────────────────────
      const boundExecuteTool = (toolName, toolInput, uid) =>
        executeTool(toolName, toolInput, uid, entityIds, db);

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
