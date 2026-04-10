'use strict';

const express = require('express');
const { getResendClient, getFromEmail } = require('../utils/email.cjs');
const logger = require('../../guardrails/logger.cjs');

module.exports = function createAlertsRouter({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, makeOAuth2Client, google }) {
  const router = express.Router();

  router.post('/api/alerts/morning', authenticateToken, async (req, res) => {
    try {
      const webhookUrl = process.env.SLACK_WEBHOOK_URL;
      const ultraInstance = process.env.ULTRAMSG_INSTANCE;
      const ultraToken = process.env.ULTRAMSG_TOKEN;
      if (!webhookUrl && !ultraInstance) return res.status(500).json({ error: 'No messaging channels configured (SLACK_WEBHOOK_URL or ULTRAMSG_INSTANCE)' });

      const user = await db.getUserById(req.user.id);
      const ultraPhone = user?.whatsappPhone ||
        (req.user.role === 'superadmin' ? process.env.ULTRAMSG_PHONE : null);
      const userEntities = (user?.entityIds || []);
      const tasks = await db.getTasksForUser(req.user.id, userEntities);

      const tz = user?.timezone || req.user.timezone;
      const todayStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
      const overdue = tasks.filter((t) => !t.completed && t.dueDate && t.dueDate < todayStr);
      const todayTasks = tasks.filter((t) => !t.completed && t.dueDate === todayStr);
      const highPriority = tasks.filter((t) => !t.completed && t.priority === 'high');

      // Fetch calendar events for today from ALL connected accounts
      let calendarEvents = [];
      try {
        const allAccounts = loadAllGcalAccounts ? await loadAllGcalAccounts(req.user.id) : [];
        if (allAccounts.length > 0 && makeOAuth2Client && google) {
          const userTz = tz || 'America/Los_Angeles';
          // Convert local midnight to UTC ISO string GCal accepts
          const todayLocal = new Intl.DateTimeFormat('en-CA', {
            timeZone: userTz, year: 'numeric', month: '2-digit', day: '2-digit',
          }).format(new Date());
          const noonUtc = new Date(`${todayLocal}T12:00:00Z`);
          const noonLocal = new Date(noonUtc.toLocaleString('en-US', { timeZone: userTz }));
          const offsetMs = noonUtc.getTime() - noonLocal.getTime();
          const timeMin = new Date(noonUtc.getTime() - 12 * 3600000 + offsetMs).toISOString();
          const timeMax = new Date(noonUtc.getTime() + 12 * 3600000 + offsetMs).toISOString();

          const results = await Promise.allSettled(allAccounts.map(async (acct) => {
            const oauth2 = makeOAuth2Client();
            if (!oauth2) return [];
            oauth2.setCredentials(acct.tokens);
            oauth2.on('tokens', async (newTokens) => {
              try {
                const existing = await loadGcalTokens(req.user.id, acct.googleEmail);
                await saveGcalTokens(req.user.id, { ...existing, ...newTokens }, acct.googleEmail);
              } catch (e) { logger.error('morningBrief.tokenRefresh.failed', { userId: req.user.id, googleEmail: acct.googleEmail, error: e.message }); }
            });
            const calendar = google.calendar({ version: 'v3', auth: oauth2 });
            const { data } = await calendar.events.list({
              calendarId: 'primary',
              timeMin,
              timeMax,
              timeZone: userTz,
              singleEvents: true,
              orderBy: 'startTime',
              maxResults: 20,
            });
            return (data.items || []).map((ev) => ({
              title: (ev.summary || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
              start: ev.start?.dateTime || ev.start?.date || '',
            }));
          }));

          const seen = new Set();
          for (const r of results) {
            if (r.status === 'fulfilled') {
              for (const ev of r.value) {
                const key = `${ev.title}::${ev.start}`;
                if (!seen.has(key)) { seen.add(key); calendarEvents.push(ev); }
              }
            }
          }
          calendarEvents.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
        }
      } catch (calErr) {
        logger.error('morningBrief.calendarFetch.failed', { requestId: req.requestId, userId: req.user?.id, error: calErr.message });
      }

      // Format date
      const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });

      // Build message
      const lines = [`☀️ Good morning ${user?.displayName || 'Lyle'} — ${dateLabel}\n`];

      lines.push(`📋 *OVERDUE (${overdue.length})*`);
      if (overdue.length === 0) lines.push('- None! You\'re all caught up');
      else overdue.forEach((t) => {
        const daysOver = Math.floor((new Date(todayStr) - new Date(t.dueDate)) / 86400000);
        lines.push(`- ${t.title} (${daysOver} day${daysOver !== 1 ? 's' : ''} overdue)`);
      });

      lines.push('');
      lines.push(`📅 *TODAY (${todayTasks.length + calendarEvents.length})*`);
      calendarEvents.forEach((ev) => {
        const time = ev.start.includes('T') ? new Date(ev.start).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : 'All day';
        lines.push(`- ${time} — ${ev.title}`);
      });
      todayTasks.forEach((t) => lines.push(`- Task: ${t.title}`));
      if (todayTasks.length === 0 && calendarEvents.length === 0) lines.push('- Nothing scheduled');

      lines.push('');
      lines.push(`🔥 High priority: ${highPriority.length}`);

      const text = lines.join('\n');

      // Fire Slack + WhatsApp in parallel
      const channels = [];

      if (webhookUrl) {
        channels.push(
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
          }).then(async (r) => {
            if (!r.ok) throw new Error(`Slack ${r.status}: ${await r.text()}`);
            return 'Slack';
          })
        );
      }

      if (ultraInstance && ultraToken && ultraPhone) {
        channels.push(
          fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: ultraToken, to: ultraPhone, body: text }),
          }).then(async (r) => {
            if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${await r.text()}`);
            return 'WhatsApp';
          })
        );
      }

      const results = await Promise.allSettled(channels);
      const sent = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
      failed.forEach((msg) => logger.error('morningBrief.channelFailed', { requestId: req.requestId, userId: req.user?.id, error: msg }));

      if (sent.length === 0) return res.status(502).json({ error: `All channels failed: ${failed.join('; ')}` });
      return res.json({ success: true, message: `Morning brief sent to ${sent.join(', ')}${failed.length ? ` (failed: ${failed.join(', ')})` : ''}` });
    } catch (err) {
      logger.error('morningBrief.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/alerts/fire', authenticateToken, async (req, res) => {
    try {
      const { message, channels = {}, recipientEmail } = req.body;
      if (!message) return res.status(400).json({ error: 'message required' });

      const webhookUrl    = process.env.SLACK_WEBHOOK_URL;
      const ultraInstance = process.env.ULTRAMSG_INSTANCE;
      const ultraToken    = process.env.ULTRAMSG_TOKEN;

      const user = await db.getUserById(req.user.id);
      const ultraPhone = user?.whatsappPhone ||
        (req.user.role === 'superadmin' ? process.env.ULTRAMSG_PHONE : null);

      const sends = [];

      if (channels.slack && webhookUrl) {
        sends.push(
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: message }),
          }).then(async (r) => {
            if (!r.ok) throw new Error(`Slack ${r.status}`);
            return 'Slack';
          })
        );
      }

      if (channels.whatsapp && ultraInstance && ultraToken && ultraPhone) {
        sends.push(
          fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: ultraToken, to: ultraPhone, body: message }),
          }).then(async (r) => {
            if (!r.ok) throw new Error(`WhatsApp ${r.status}`);
            return 'WhatsApp';
          })
        );
      }

      if (channels.email && recipientEmail) {
        const resend = getResendClient();
        if (resend) {
          sends.push(
            resend.emails.send({
              from: getFromEmail(),
              to: recipientEmail,
              subject: '[Dizon.ai] Alert',
              text: message,
            }).then(() => 'Email')
          );
        }
      }

      const skipped = [];
      if (channels.sms) {
        logger.info('alerts.sms.skipped', { requestId: req.requestId, userId: req.user?.id });
        skipped.push('SMS');
      }

      const results = await Promise.allSettled(sends);
      const sent   = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);

      return res.json({ sent, failed, skipped });
    } catch (err) {
      logger.error('alerts.fire.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Server-side alert deduplication ──────────────────────────────────────

  router.post('/api/alerts/check-fired', authenticateToken, async (req, res) => {
    try {
      const { keys } = req.body;
      if (!Array.isArray(keys)) return res.status(400).json({ error: 'keys must be an array' });
      const fired = await db.checkFiredAlerts(req.user.id, keys);
      return res.json({ fired });
    } catch (err) {
      logger.error('alerts.checkFired.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/alerts/mark-fired', authenticateToken, async (req, res) => {
    try {
      const { key } = req.body;
      if (!key) return res.status(400).json({ error: 'key required' });
      await db.markFiredAlert(req.user.id, key);
      return res.json({ success: true });
    } catch (err) {
      logger.error('alerts.markFired.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Cadence config endpoints ────────────────────────────────────────────

  router.get('/api/alerts/cadence', authenticateToken, async (req, res) => {
    try {
      let configs = await db.getCadenceConfigForUser(req.user.id);
      if (!configs.length) {
        // Seed defaults on first access
        await db.seedDefaultCadenceConfig(req.user.id);
        configs = await db.getCadenceConfigForUser(req.user.id);
      }
      return res.json(configs);
    } catch (err) {
      logger.error('alerts.cadence.getFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/alerts/cadence/:priority', authenticateToken, async (req, res) => {
    try {
      const { priority } = req.params;
      if (!['high', 'medium', 'low', 'floating'].includes(priority)) {
        return res.status(400).json({ error: 'priority must be one of: high, medium, low, floating' });
      }
      const { offsets, channels, enabled } = req.body;
      if (!Array.isArray(offsets)) return res.status(400).json({ error: 'offsets must be an array' });
      if (!Array.isArray(channels)) return res.status(400).json({ error: 'channels must be an array' });

      await db.upsertCadenceConfig(req.user.id, priority, offsets, channels, enabled !== false);
      const configs = await db.getCadenceConfigForUser(req.user.id);
      return res.json(configs);
    } catch (err) {
      logger.error('alerts.cadence.putFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/config/status', authenticateToken, (req, res) => {
    res.json({
      slack:    !!process.env.SLACK_WEBHOOK_URL,
      whatsapp: !!(process.env.ULTRAMSG_INSTANCE && process.env.ULTRAMSG_TOKEN && process.env.ULTRAMSG_PHONE),
      sms:      false,
      email:    !!process.env.RESEND_API_KEY,
    });
  });

  return router;
};
