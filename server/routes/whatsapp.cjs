'use strict';

const express   = require('express');
const crypto    = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { ARIA_TOOLS, executeTool } = require('../tools.cjs');

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
      console.log(`[whatsapp/inbound] From: ${normalizedPhone}, Message: "${msgBody}"`);

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

      const todayStr = new Date().toISOString().slice(0, 10);
      const activeTasks = tasks.filter(t => !t.completed);
      const contextAppend = `\n\n## Live Data\nActive tasks (${activeTasks.length}): ${
        activeTasks.slice(0, 30).map(t =>
          `[${t.id}] ${t.title} (${t.priority}${t.dueDate ? ', due ' + t.dueDate : ''}${t.dueDate && t.dueDate < todayStr ? ', OVERDUE' : ''})`
        ).join('; ') || 'none'
      }\nRecent notes: ${notes.slice(0, 10).map(n => n.title).join(', ') || 'none'
      }\nCalendar next 7 days: ${calendarEvents.map(ev => `${ev.start} — ${ev.title}`).join('; ') || 'none'}`;

      const profileParts = [];
      if (user.profileName)       profileParts.push(`You are helping ${user.profileName}.`);
      if (user.profileBusinesses) profileParts.push(`Businesses: ${user.profileBusinesses}.`);
      if (user.profileHousehold)  profileParts.push(`Household context: ${user.profileHousehold}.`);
      if (user.profileLocation)   profileParts.push(`Based in: ${user.profileLocation}.`);
      if (user.profileNotes)      profileParts.push(`Additional context: ${user.profileNotes}.`);
      const profileContext = profileParts.length ? profileParts.join(' ') + '\n\n' : '';

      const systemPrompt = `${profileContext}You are Aria, the AI core of Dizon.ai — a Life OS for ${user.profileName || user.displayName || 'the user'}. Today's date is ${todayStr}. You have full context of their life below. Respond via WhatsApp — warm, direct, concise. Max 3 sentences. No bullet points unless creating a list they asked for. Sign off with — Aria only if it's a closing reply.${contextAppend}`;

      // ── Call 1 — Sonnet with tools + full context (non-streaming) ───────
      const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
      const messages = [{ role: 'user', content: msgBody }];

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        tools: ARIA_TOOLS,
        messages,
      });

      let reply;

      if (response.stop_reason === 'tool_use') {
        // Execute each tool block
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
        const toolResults = [];

        for (const block of toolUseBlocks) {
          const result = await executeTool(block.name, block.input, userId, entityIds, db);
          toolResults.push(result);
          console.log(`[whatsapp/inbound] Tool ${block.name}: ${JSON.stringify(result)}`);
        }

        // Call 2 — Sonnet with tool results for confirmation text
        const followUpMessages = [
          ...messages,
          { role: 'assistant', content: response.content },
          {
            role: 'user',
            content: toolUseBlocks.map((block, i) => ({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(toolResults[i]),
            })),
          },
        ];

        const finalResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 300,
          system: systemPrompt,
          tools: ARIA_TOOLS,
          messages: followUpMessages,
        });

        reply = finalResponse.content.find(b => b.type === 'text')?.text || '';
      } else {
        // No tool use — use text directly
        reply = response.content.find(b => b.type === 'text')?.text || '';
      }

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
