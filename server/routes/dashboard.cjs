'use strict';

const express = require('express');
const axios = require('axios');

module.exports = function createDashboardRouter({ authenticateToken, db }) {
  const router = express.Router();

  // ── Command Center ───────────────────────────────────────────────────────────

  router.get('/api/dashboard/command-center/session', authenticateToken, async (req, res) => {
    try {
      const todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());

      const conversation = await db.getOrCreateCommandCenterConversation(req.user.id, todayStr);
      const messages = await db.getConversationMessages(conversation.id, req.user.id);
      return res.json({ conversation, messages });
    } catch (err) {
      console.error('[command-center] session failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/dashboard/command-center/updates', authenticateToken, async (req, res) => {
    try {
      const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 60000);
      const userId = req.user.id;
      const todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());

      const updates = [];

      // Check new inbox items
      const inboxResult = await db.pool.query(
        `SELECT * FROM inbox_items
         WHERE user_id = $1 AND created_at > $2 AND action_taken IS NULL
         ORDER BY created_at ASC`,
        [userId, since]
      );
      for (const item of inboxResult.rows) {
        updates.push({
          type: 'inbox',
          content: `📬 New ${item.type === 'VIP' ? 'VIP ' : ''}email from ${item.sender || 'unknown'}: ${item.title}${item.summary ? ` — ${item.summary}` : ''}`
        });
      }

      // Check newly overdue tasks (due_date < today, completed = false, updated_at > since)
      const overdueResult = await db.pool.query(
        `SELECT * FROM tasks
         WHERE created_by = $1 AND completed = false
         AND due_date < $2 AND due_date IS NOT NULL AND due_date != ''
         AND updated_at > $3`,
        [userId, todayStr, since]
      );
      for (const task of overdueResult.rows) {
        updates.push({
          type: 'overdue',
          content: `⚠️ Task now overdue: "${task.title}"${task.priority === 'high' ? ' — high priority' : ''}`
        });
      }

      return res.json({ updates });
    } catch (err) {
      console.error('[command-center] updates failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Dashboard AI Brief (persona-aware) ────────────────────────────────────────

  router.post('/api/dashboard/aria-brief', authenticateToken, async (req, res) => {
    try {
      const apiKey = req.body.apiKey || process.env.CLAUDE_API_KEY;
      if (!apiKey) return res.json({ brief: '' });

      const { assistantName, persona, userName, timeOfDay, data } = req.body;

      const personaTones = {
        executive_assistant: 'warm and professional',
        coo: 'direct and strategic',
        best_friend: 'casual and real',
        life_coach: 'motivating and big-picture focused',
        cfo: 'numbers-first and analytical',
      };
      const tone = personaTones[persona] || personaTones.executive_assistant;
      const name = assistantName || 'Aria';

      const systemPrompt = `You are ${name}, the user's ${persona === 'best_friend' ? 'best friend' : persona === 'executive_assistant' ? 'executive assistant' : persona === 'coo' ? 'COO' : persona === 'life_coach' ? 'life coach' : 'CFO'}. Write a warm, ${tone} ${timeOfDay || 'morning'} brief for ${userName} in 2-3 sentences. Be specific — reference actual data below. Do not use bullet points. Write naturally like a real person. Only reference tasks, calendar events, and notes that are explicitly listed in the context below. Do not infer or reference activities from memory, business context, or profile information when summarizing the day. Sign off with just your name: — ${name}`;

      const dataStr = `Overdue tasks: ${data.overdue || 'None'}\nHigh priority tasks: ${data.highPriority || 'None'}\nTasks due today: ${data.todayTasks || 'None'}\nToday's calendar events: ${data.events || 'None'}\nNotes this week: ${data.notesCount || 0}\nBusinesses: ${data.entities || 'None'}`;

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 150,
          system: systemPrompt,
          messages: [{ role: 'user', content: `Write my ${timeOfDay || 'morning'} brief.\n\n${dataStr}` }],
        },
        {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          timeout: 15_000,
        },
      );

      const brief = response.data.content?.[0]?.text || '';
      return res.json({ brief });
    } catch (err) {
      console.error('[aria-brief] failed:', err.message);
      return res.json({ brief: '' });
    }
  });

  // ── Dashboard Timeline Summary ────────────────────────────────────────────────

  router.post('/api/dashboard/timeline-summary', authenticateToken, async (req, res) => {
    try {
      const apiKey = req.body.apiKey || process.env.CLAUDE_API_KEY;
      if (!apiKey) return res.json({ summary: '' });

      const { events, tasks } = req.body;
      const eventsStr = (events || []).map((e) => `${e.time || 'All day'}: ${e.title}`).join(', ') || 'None';
      const tasksStr = (tasks || []).map((t) => `${t.title} (${t.priority}${t.overdue ? ', overdue' : ''})`).join(', ') || 'None';

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 60,
          system: 'Write ONE sentence summarizing this person\'s day. Be specific and actionable. Max 15 words. No quotes.',
          messages: [{
            role: 'user',
            content: `Today's calendar events: ${eventsStr}\nToday's tasks: ${tasksStr}\n\nSummarize the day in one sentence.`,
          }],
        },
        {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          timeout: 15_000,
        },
      );

      const summary = response.data.content?.[0]?.text || '';
      return res.json({ summary });
    } catch (err) {
      console.error('[timeline-summary] failed:', err.message);
      return res.json({ summary: '' });
    }
  });

  return router;
};
