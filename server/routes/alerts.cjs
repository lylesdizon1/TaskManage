'use strict';

const express = require('express');
const { sendSlack, sendWhatsApp, sendAlertEmail, getIntegrationStatus } = require('../utils/integrations.cjs');
const { fetchCalendarWindow, localMidnightUtc } = require('../lib/buildAgenticContext.cjs');
const logger = require('../../guardrails/logger.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');

module.exports = function createAlertsRouter({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google }) {
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

    const tz = user?.timezone || DEFAULT_TIMEZONE;
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const overdue = tasks.filter((t) => !t.completed && t.dueDate && t.dueDate < todayStr);
    const todayTasks = tasks.filter((t) => !t.completed && t.dueDate === todayStr);
    const highPriority = tasks.filter((t) => !t.completed && t.priority === 'high');

    // Fetch calendar events for today — DB cache first, live fallback.
    let calendarEvents = [];
    try {
      if (db.getCalendarEventsForUser) {
        try {
          const startUtc = localMidnightUtc(tz, 0);
          const endUtc   = localMidnightUtc(tz, 1);
          const cached = await db.getCalendarEventsForUser(userId, startUtc, endUtc);
          if (cached && cached.length > 0) {
            calendarEvents = cached.map((e) => ({
              title: (e.title || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
              start: e.startTime ? new Date(e.startTime).toISOString() : '',
            }));
          }
        } catch { /* silent */ }
      }
      if (calendarEvents.length === 0) {
        const fetchResult = await fetchCalendarWindow({
          userId, tz, days: 1,
          loadAllGcalAccounts, loadGcalTokens, saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google,
          logger, requestId,
        });
        calendarEvents = fetchResult.events || [];
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
      const time = ev.start.includes('T') ? new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }) : 'All day';
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

    // Yesterday's wrap: forward-looking signal only (tomorrow_focus +
    // frustrations carry-over). Wins and raw_freeform stay out — past
    // wins aren't actionable; freeform is too noisy for the brief.
    try {
      if (db.getJournalEntryByDate) {
        const yesterdayKey = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(Date.now() - 86400000));
        const yWrap = await db.getJournalEntryByDate(userId, yesterdayKey);
        if (yWrap?.completedAt) {
          const focus = (yWrap.tomorrowFocus || '').trim();
          const unresolved = (yWrap.frustrations || '').trim();
          if (focus || unresolved) {
            const wrapLines = ['', '📔 *From yesterday\'s wrap*'];
            if (focus) wrapLines.push(`Focus: ${focus}`);
            if (unresolved) wrapLines.push(`Unresolved: ${unresolved}`);
            let wrapBlock = wrapLines.join('\n');
            if (wrapBlock.length > 200) wrapBlock = wrapBlock.slice(0, 197) + '...';
            lines.push(wrapBlock);
          }
        }
      }
    } catch (e) {
      logger.error('morningBrief.yesterdayWrap.failed', { requestId, userId, error: e.message });
    }

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

  /**
   * Build and send the end-of-day Daily Wrap push across the user's
   * configured channels. Message is short by design — the wrap ritual
   * itself happens on the web; the push is the nudge.
   *
   * Shared between the cron and (future) POST /api/alerts/daily-wrap.
   */
  async function buildAndSendDailyWrap(userId, opts = {}) {
    const requestId = opts.requestId || null;
    const status = await getIntegrationStatus(db, userId);
    if (!status.slack && !status.whatsapp) {
      return { ok: false, reason: 'no_channels', sent: [], failed: [] };
    }

    const user = await db.getUserById(userId);
    const userEntities = (user?.entityIds || []);
    const tasks = await db.getTasksForUser(userId, userEntities);

    const tz = user?.timezone || DEFAULT_TIMEZONE;
    const todayStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    // Completed today: completed === true AND completed_at falls within today local.
    const completedToday = (tasks || []).filter((t) => {
      if (!t.completed || !t.completedAt) return false;
      try {
        const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
          .format(new Date(t.completedAt));
        return d === todayStr;
      } catch { return false; }
    });
    const pendingHighPriority = (tasks || []).filter((t) => !t.completed && t.priority === 'high');

    const greetingName = user?.displayName || user?.username || 'there';
    const lines = [`🌙 Ready to wrap your day, ${greetingName}?`, ''];

    lines.push(`Here's a quick look at today:`);
    lines.push('');
    if (completedToday.length > 0) {
      lines.push(`✅ *Completed (${completedToday.length})*`);
      completedToday.slice(0, 3).forEach((t) => lines.push(`- ${t.title}`));
      if (completedToday.length > 3) lines.push(`  (+${completedToday.length - 3} more)`);
    } else {
      lines.push(`✅ Nothing completed yet — tomorrow's a new run.`);
    }

    if (pendingHighPriority.length > 0) {
      lines.push('');
      lines.push(`🔥 *Still open — high priority (${pendingHighPriority.length})*`);
      pendingHighPriority.slice(0, 2).forEach((t) => lines.push(`- ${t.title}`));
      if (pendingHighPriority.length > 2) lines.push(`  (+${pendingHighPriority.length - 2} more)`);
    }

    lines.push('');
    lines.push('Reply here or open Dizon to close the loop.');

    const text = lines.join('\n');

    const channels = [];
    if (status.slack) channels.push(sendSlack(db, userId, text).then(r => ({ name: 'Slack', ...r })));
    if (status.whatsapp) channels.push(sendWhatsApp(db, userId, text).then(r => ({ name: 'WhatsApp', ...r })));

    const settled = await Promise.all(channels);
    const sent = settled.filter(r => r.ok).map(r => r.name);
    const failed = settled.filter(r => !r.ok).map(r => `${r.name}:${r.reason}`);
    failed.forEach((msg) => logger.error('dailyWrap.channelFailed', { requestId, userId, error: msg }));

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
      return res.status(500).json({ error: 'Internal server error' });
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
      return res.status(500).json({ error: 'Internal server error' });
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
      return res.status(500).json({ error: 'Internal server error' });
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
      return res.status(500).json({ error: 'Internal server error' });
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
      return res.status(500).json({ error: 'Internal server error' });
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
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/config/status', authenticateToken, async (req, res) => {
    try {
      const status = await getIntegrationStatus(db, req.user.id);
      res.json(status);
    } catch (err) {
      logger.error('config.status.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return { router, buildAndSendMorningBrief, buildAndSendDailyWrap };
};
