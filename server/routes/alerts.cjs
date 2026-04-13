'use strict';

const express = require('express');
const { sendSlack, sendWhatsApp, sendAlertEmail, getIntegrationStatus } = require('../utils/integrations.cjs');
const logger = require('../../guardrails/logger.cjs');

module.exports = function createAlertsRouter({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, makeOAuth2Client, google }) {
  const router = express.Router();

  /**
   * Build and send the morning brief for one user across their configured
   * channels (Slack, WhatsApp). Returns a structured summary; throws only
   * on unrecoverable setup errors. Per-channel failures are returned in
   * `failed` rather than thrown so one channel failure doesn't stop others.
   *
   * Shared between the POST /api/alerts/morning route and the morning-brief
   * cron — behavior is identical on both paths.
   */
  async function buildAndSendMorningBrief(userId, opts = {}) {
    const requestId = opts.requestId || null;
    const status = await getIntegrationStatus(db, userId);
    if (!status.slack && !status.whatsapp) {
      return { ok: false, reason: 'no_channels', sent: [], failed: [] };
    }

    const user = await db.getUserById(userId);
    const userEntities = (user?.entityIds || []);
    const tasks = await db.getTasksForUser(userId, userEntities);

    const tz = user?.timezone || 'America/Los_Angeles';
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
      const allAccounts = loadAllGcalAccounts ? await loadAllGcalAccounts(userId) : [];
      if (allAccounts.length > 0 && makeOAuth2Client && google) {
        const userTz = tz;
        const todayLocal = new Intl.DateTimeFormat('en-CA', {
          timeZone: userTz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        const noonUtc = new Date(`${todayLocal}T12:00:00Z`);
        const noonLocal = new Date(noonUtc.toLocaleString('en-US', { timeZone: userTz }));
        const offsetMs = noonUtc.getTime() - noonLocal.getTime();
        const timeMin = new Date(noonUtc.getTime() - 12 * 3600000 + offsetMs).toISOString();
        const timeMax = new Date(noonUtc.getTime() + 12 * 3600000 + offsetMs).toISOString();

        const gcalResults = await Promise.allSettled(allAccounts.map(async (acct) => {
          const oauth2 = makeOAuth2Client();
          if (!oauth2) return [];
          oauth2.setCredentials(acct.tokens);
          oauth2.on('tokens', async (newTokens) => {
            try {
              const existing = await loadGcalTokens(userId, acct.googleEmail);
              await saveGcalTokens(userId, { ...existing, ...newTokens }, acct.googleEmail);
            } catch (e) { logger.error('morningBrief.tokenRefresh.failed', { userId, googleEmail: acct.googleEmail, error: e.message }); }
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
        for (const r of gcalResults) {
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
      logger.error('morningBrief.calendarFetch.failed', { requestId, userId, error: calErr.message });
    }

    // Important unread emails (rank >= 3, unread, classified <= 7d).
    // Non-fatal: if the lookup fails the brief still sends without
    // the email section.
    let importantEmails = [];
    try {
      importantEmails = await db.getImportantUnread(userId, 3);
    } catch (e) {
      logger.error('morningBrief.importantEmails.failed', { requestId, userId, error: e.message });
    }

    const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });
    const greetingName = user?.displayName || user?.username || 'there';
    const lines = [`☀️ Good morning ${greetingName} — ${dateLabel}\n`];

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

    if (importantEmails.length > 0) {
      lines.push('');
      lines.push(`📧 *IMPORTANT EMAILS (${importantEmails.length})*`);
      importantEmails.slice(0, 5).forEach((email) => {
        const summary = email.summary || email.category || 'No summary';
        const action = email.actionRequired ? ' ⚡ Action required' : '';
        lines.push(`• ${summary}${action}`);
      });
      if (importantEmails.length > 5) {
        lines.push(`  (+${importantEmails.length - 5} more)`);
      }
    }

    lines.push('');
    lines.push(`🔥 High priority: ${highPriority.length}`);

    const text = lines.join('\n');

    const channels = [];
    if (status.slack) channels.push(sendSlack(db, userId, text).then(r => ({ name: 'Slack', ...r })));
    if (status.whatsapp) channels.push(sendWhatsApp(db, userId, text).then(r => ({ name: 'WhatsApp', ...r })));

    const settled = await Promise.all(channels);
    const sent = settled.filter(r => r.ok).map(r => r.name);
    const failed = settled.filter(r => !r.ok).map(r => `${r.name}:${r.reason}`);
    failed.forEach((msg) => logger.error('morningBrief.channelFailed', { requestId, userId, error: msg }));

    return { ok: sent.length > 0, sent, failed };
  }

  router.post('/api/alerts/morning', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const result = await buildAndSendMorningBrief(userId, { requestId: req.requestId });
      if (result.reason === 'no_channels') {
        return res.status(400).json({ error: 'No messaging channels configured. Configure Slack or WhatsApp in Settings.' });
      }
      if (!result.ok) {
        return res.status(502).json({ error: `All channels failed: ${result.failed.join('; ')}` });
      }
      return res.json({ success: true, message: `Morning brief sent to ${result.sent.join(', ')}${result.failed.length ? ` (failed: ${result.failed.join(', ')})` : ''}` });
    } catch (err) {
      logger.error('morningBrief.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/alerts/fire', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { message, channels = {}, recipientEmail } = req.body;
      if (!message) return res.status(400).json({ error: 'message required' });

      const sends = [];
      if (channels.slack) sends.push(sendSlack(db, userId, message).then(r => ({ name: 'Slack', ...r })));
      if (channels.whatsapp) sends.push(sendWhatsApp(db, userId, message).then(r => ({ name: 'WhatsApp', ...r })));
      if (channels.email) {
        sends.push(sendAlertEmail(db, userId, {
          subject: '[Dizon.ai] Alert',
          text: message,
          toOverride: recipientEmail || null,
        }).then(r => ({ name: 'Email', ...r })));
      }

      const skipped = [];
      if (channels.sms) {
        logger.info('alerts.sms.skipped', { requestId: req.requestId, userId });
        skipped.push('SMS');
      }

      const results = await Promise.all(sends);
      const sent = results.filter(r => r.ok).map(r => r.name);
      const failed = results.filter(r => !r.ok).map(r => `${r.name}:${r.reason}`);

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

  router.get('/api/config/status', authenticateToken, async (req, res) => {
    try {
      const status = await getIntegrationStatus(db, req.user.id);
      res.json(status);
    } catch (err) {
      logger.error('config.status.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return { router, buildAndSendMorningBrief };
};
