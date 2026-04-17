'use strict';

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { writeAudit } = require('../../guardrails/audit.cjs');
const { mintState, consumeState } = require('../utils/oauthState.cjs');

const GCAL_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'];

module.exports = function createGcalRouter({ authenticateToken, db, makeOAuth2Client, saveGcalTokens, loadGcalTokens, loadAllGcalAccounts, mergeAndSaveGcalTokens, google }) {
  const router = express.Router();

  /**
   * GET /api/gcal/auth-url
   * Returns the Google OAuth consent URL.
   */
  router.get('/api/gcal/auth-url', authenticateToken, async (req, res) => {
    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)' });

    let state;
    try {
      state = await mintState(req.user.id);
    } catch (e) {
      logger.error('gcal.authUrl.stateMint.failed', { userId: req.user.id, error: e.message });
      return res.status(503).json({ error: 'OAuth temporarily unavailable; please retry' });
    }

    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GCAL_SCOPES,
      state,
    });
    res.json({ url });
  });

  /**
   * GET /api/gcal/callback?code=...&state=...
   * Google redirects here after consent. Exchanges code for tokens,
   * fetches the account email, and stores with dedup. The state is a
   * one-time CSRF token bound to the initiating userId in Redis.
   */
  router.get('/api/gcal/callback', async (req, res) => {
    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.status(500).send('Google OAuth not configured');

    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing code or state');

    const userId = await consumeState(state);
    if (!userId) {
      logger.warn('gcal.callback.invalidState', { state: typeof state === 'string' ? state.slice(0, 8) : 'non-string' });
      return res.status(400).send('Invalid or expired OAuth state');
    }

    try {
      const { tokens } = await oauth2.getToken(code);

      // Fetch the Google account email for dedup
      oauth2.setCredentials(tokens);
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      let googleEmail;
      try {
        const { data } = await calendar.calendarList.get({ calendarId: 'primary' });
        googleEmail = (data.id || '').toLowerCase();
      } catch (e) {
        logger.warn('gcal.callback.emailFetch.failed', { userId, error: e.message });
        googleEmail = `unknown-${Date.now()}`;
      }

      await saveGcalTokens(userId, tokens, googleEmail);

      // Replace any legacy placeholder rows for this user
      try {
        await db.pool.query(
          `DELETE FROM gcal_tokens WHERE user_id = $1 AND google_email = 'primary@placeholder'`,
          [userId],
        );
      } catch (e) { /* ignore — placeholder may not exist */ }

      logger.info('gcal.tokens.stored', { userId, googleEmail });
      res.redirect('/?gcal=connected');
    } catch (err) {
      logger.error('gcal.tokenExchange.failed', { userId, error: err.message });
      res.status(500).send(`Google Calendar auth failed: ${err.message}`);
    }
  });

  /**
   * GET /api/gcal/status
   * Returns { connected: bool, email?: string, accounts: [...] }
   */
  router.get('/api/gcal/status', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    const allAccounts = await loadAllGcalAccounts(userId);
    if (!allAccounts.length) return res.json({ connected: false, accounts: [] });

    const oauth2Base = makeOAuth2Client();
    if (!oauth2Base) return res.json({ connected: false, accounts: [] });

    const validAccounts = [];
    for (const acct of allAccounts) {
      const oauth2 = makeOAuth2Client();
      oauth2.setCredentials(acct.tokens);
      oauth2.on('tokens', async (newTokens) => {
        try { await mergeAndSaveGcalTokens(userId, newTokens, acct.googleEmail); }
        catch (e) { logger.error('gcal.tokenRefresh.failed', { userId, googleEmail: acct.googleEmail, error: e.message }); }
      });

      try {
        const calendar = google.calendar({ version: 'v3', auth: oauth2 });
        const { data } = await calendar.calendarList.get({ calendarId: 'primary' });
        // Update placeholder email if we now know the real one
        const realEmail = (data.id || '').toLowerCase();
        if (acct.googleEmail === 'primary@placeholder' && realEmail) {
          await db.pool.query(
            `UPDATE gcal_tokens SET google_email = $1 WHERE user_id = $2 AND google_email = 'primary@placeholder'`,
            [realEmail, userId],
          ).catch(() => {});
          acct.googleEmail = realEmail;
        }
        validAccounts.push({ email: realEmail || acct.googleEmail, isPrimary: acct.isPrimary, needsReconnect: false });
      } catch (err) {
        // Do NOT hard-delete the token row on a transient Graph API error.
        // A refresh hiccup, rate limit, or network blip would otherwise
        // permanently remove a connected account until the user manually
        // reconnects. Flag it needsReconnect so the UI can prompt, and
        // only the explicit disconnect routes delete rows.
        logger.warn('gcal.status.probe.failed', { requestId: req.requestId, userId, googleEmail: acct.googleEmail, error: err.message });
        validAccounts.push({
          email: acct.googleEmail,
          isPrimary: acct.isPrimary,
          needsReconnect: true,
          error: err.message,
        });
      }
    }

    // Backward compat: connected + email from primary
    const primary = validAccounts.find(a => a.isPrimary) || validAccounts[0];
    res.json({
      connected: validAccounts.length > 0,
      email: primary?.email || null,
      accounts: validAccounts,
    });
  });

  /**
   * POST /api/gcal/sync-task
   * Body: { userId, title, description?, dueDate (YYYY-MM-DD) }
   * Creates a Google Calendar all-day event for the task.
   */
  router.post('/api/gcal/sync-task', authenticateToken, logger.tool('syncTask'), async (req, res) => {
    const userId = req.user.id;
    const { title, description, dueDate, dueTime, timeZone } = req.body;
    if (!title || !dueDate) {
      return res.status(400).json({ error: 'title and dueDate are required' });
    }

    const tokens = await loadGcalTokens(userId);
    if (!tokens) return res.status(401).json({ error: 'Google Calendar not connected' });

    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured' });

    oauth2.setCredentials(tokens);
    oauth2.on('tokens', async (newTokens) => {
      try { await mergeAndSaveGcalTokens(userId, newTokens); }
      catch (e) { logger.error('gcal.tokenRefresh.failed', { userId, error: e.message }); }
    });

    try {
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      const requestBody = { summary: title, description: description || '' };

      if (dueTime) {
        // Timed event: use dateTime
        const tz = timeZone || req.user.timezone;
        requestBody.start = { dateTime: `${dueDate}T${dueTime}:00`, timeZone: tz };
        // Default 1-hour duration
        const [h, m] = dueTime.split(':').map(Number);
        const endH = String(h + 1).padStart(2, '0');
        requestBody.end = { dateTime: `${dueDate}T${endH}:${String(m).padStart(2, '0')}:00`, timeZone: tz };
      } else {
        // All-day event
        const nextDay = new Date(dueDate);
        nextDay.setDate(nextDay.getDate() + 1);
        requestBody.start = { date: dueDate };
        requestBody.end = { date: nextDay.toISOString().slice(0, 10) };
      }

      const event = await calendar.events.insert({ calendarId: 'primary', requestBody });
      logger.info('gcal.event.created', { requestId: req.requestId, userId, eventId: event.data.id });
      try { await writeAudit({ userId, entityType: 'event', entityId: event.data.id, action: 'created', after: { id: event.data.id, title, dueDate, dueTime, htmlLink: event.data.htmlLink }, requestId: req.requestId }); } catch {}
      res.json({ success: true, eventId: event.data.id, htmlLink: event.data.htmlLink });
    } catch (err) {
      logger.error('gcal.syncTask.failed', { requestId: req.requestId, userId, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/gcal/disconnect
   * Body: { email } — optional. If provided, disconnects that account only.
   * If omitted, disconnects ALL accounts (legacy compat).
   */
  router.post('/api/gcal/disconnect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { email } = req.body;
      await db.deleteGcalTokensForUser(userId, email || undefined);
      logger.info('gcal.disconnected', { requestId: req.requestId, userId, email: email || 'all' });
      res.json({ success: true });
    } catch (err) {
      logger.error('gcal.disconnect.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/gcal/set-primary
   * Body: { email } — set this account as the primary calendar.
   */
  router.post('/api/gcal/set-primary', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'email is required' });
      await db.setGcalPrimaryAccount(userId, email);
      logger.info('gcal.primarySet', { requestId: req.requestId, userId, email });
      res.json({ success: true });
    } catch (err) {
      logger.error('gcal.setPrimary.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/gcal/calendars
   * Returns all calendars from all connected GCal accounts for the user.
   */
  router.get('/api/gcal/calendars', authenticateToken, logger.tool('getCalendars'), async (req, res) => {
    try {
      const userId = req.user.id;
      const allAccounts = await loadAllGcalAccounts(userId);
      if (!allAccounts.length) return res.json([]);

      const allCalendars = [];
      const results = await Promise.allSettled(allAccounts.map(async (acct) => {
        const oauth2 = makeOAuth2Client();
        if (!oauth2) return [];
        oauth2.setCredentials(acct.tokens);
        const calendar = google.calendar({ version: 'v3', auth: oauth2 });
        const { data } = await calendar.calendarList.list();
        return (data.items || []).map(cal => ({
          calendarId: cal.id,
          summary: cal.summary || cal.id,
          backgroundColor: cal.backgroundColor || null,
          account: acct.googleEmail,
        }));
      }));

      for (const result of results) {
        if (result.status === 'fulfilled') allCalendars.push(...result.value);
      }
      return res.json(allCalendars);
    } catch (err) {
      logger.error('gcal.calendars.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/gcal/events
   * Returns calendar events from ALL connected Google accounts, merged + deduped.
   */
  router.get('/api/gcal/events', authenticateToken, logger.tool('getEvents'), async (req, res) => {
    const userId = req.user.id;
    const { timeZone, days, startDate: startDateParam } = req.query;
    const numDays = Math.min(Math.max(parseInt(days, 10) || 1, 1), 62);

    const allAccounts = await loadAllGcalAccounts(userId);
    logger.info('gcal.events.fetching', { requestId: req.requestId, userId, accountCount: allAccounts.length });
    if (!allAccounts.length) return res.json([]);

    // Compute time boundaries
    let timeMin, timeMax;
    if (startDateParam) {
      // Client specified an explicit start date (YYYY-MM-DD)
      timeMin = new Date(`${startDateParam}T00:00:00`);
      timeMax = new Date(timeMin);
      timeMax.setDate(timeMax.getDate() + numDays);
    } else if (timeZone) {
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      const todayStr = formatter.format(new Date());
      const midpoint = new Date(`${todayStr}T12:00:00Z`);
      const localMs = new Date(midpoint.toLocaleString('en-US', { timeZone })).getTime();
      const offsetMs = midpoint.getTime() - localMs;
      timeMin = new Date(`${todayStr}T00:00:00Z`);
      timeMin = new Date(timeMin.getTime() + offsetMs);
      timeMax = new Date(timeMin);
      timeMax.setDate(timeMax.getDate() + numDays);
    } else {
      const now = new Date();
      timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      timeMax = new Date(timeMin);
      timeMax.setDate(timeMax.getDate() + numDays);
    }

    // Fetch from all accounts in parallel, fault-tolerant
    const allEvents = [];
    const seenIds = new Set();

    const results = await Promise.allSettled(allAccounts.map(async (acct) => {
      const oauth2 = makeOAuth2Client();
      if (!oauth2) return [];
      oauth2.setCredentials(acct.tokens);
      oauth2.on('tokens', async (newTokens) => {
        try { await mergeAndSaveGcalTokens(userId, newTokens, acct.googleEmail); }
        catch (e) { logger.error('gcal.tokenRefresh.failed', { userId, googleEmail: acct.googleEmail, error: e.message }); }
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      // Each account gets its own params copy to prevent any mutation cross-talk
      const params = {
        calendarId: 'primary',
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: numDays > 1 ? 50 : 20,
        fields: 'items(id,summary,description,start,end,organizer,extendedProperties)',
      };
      if (timeZone) params.timeZone = timeZone;

      const { data } = await calendar.events.list(params);
      const items = data.items || [];
      logger.info('gcal.events.accountResult', { userId, googleEmail: acct.googleEmail, eventCount: items.length });
      return items.map((ev) => {
        const description = ev.description || '';
        const entityMatch = description.match(/\[([^\]]+)\]/);
        const entityName = entityMatch ? entityMatch[1] : '';
        return {
          id: `${acct.googleEmail}::${ev.id}`,
          title: (ev.summary || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
          start: ev.start?.dateTime || ev.start?.date || null,
          end: ev.end?.dateTime || ev.end?.date || null,
          allDay: !ev.start?.dateTime,
          calendarId: ev.organizer?.email || acct.googleEmail,
          account: acct.googleEmail,
          entityName,
        };
      });
    }));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const ev of result.value) {
          if (!seenIds.has(ev.id)) {
            seenIds.add(ev.id);
            allEvents.push(ev);
          }
        }
      } else {
        logger.error('gcal.events.accountFailed', { requestId: req.requestId, userId, error: result.reason?.message || String(result.reason) });
      }
    }

    // Sort by start time
    allEvents.sort((a, b) => {
      const aStart = a.start || '';
      const bStart = b.start || '';
      return aStart < bStart ? -1 : aStart > bStart ? 1 : 0;
    });

    logger.info('gcal.events.returning', { requestId: req.requestId, userId, totalEvents: allEvents.length, accountCount: allAccounts.length });
    res.json(allEvents);
  });

  /**
   * POST /api/gcal/events
   * Create a new Google Calendar event on a specific account.
   * Body: { title, start, end, googleEmail, description?, entityTag? }
   */
  router.post('/api/gcal/events', authenticateToken, logger.tool('createEvent'), async (req, res) => {
    const userId = req.user.id;
    const { title, start, end, googleEmail, description, entityTag } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!googleEmail) return res.status(400).json({ error: 'googleEmail is required' });

    const tokens = await loadGcalTokens(userId, googleEmail);
    if (!tokens) return res.status(401).json({ error: `Google Calendar not connected for ${googleEmail}` });

    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured' });

    oauth2.setCredentials(tokens);
    oauth2.on('tokens', async (newTokens) => {
      try { await mergeAndSaveGcalTokens(userId, newTokens, googleEmail); }
      catch (e) { logger.error('gcal.tokenRefresh.failed', { userId, error: e.message }); }
    });

    try {
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      const descParts = [];
      if (entityTag) descParts.push(`[${entityTag}]`);
      if (description) descParts.push(description);
      const requestBody = { summary: title, description: descParts.join('\n\n') };
      const tz = req.user.timezone || 'America/Los_Angeles';

      if (start.date && !start.dateTime) {
        // All-day event
        requestBody.start = { date: start.date };
        const endDate = end?.date || start.date;
        const nextDay = new Date(endDate);
        nextDay.setDate(nextDay.getDate() + 1);
        requestBody.end = { date: nextDay.toISOString().slice(0, 10) };
      } else {
        requestBody.start = { dateTime: start.dateTime, timeZone: start.timeZone || tz };
        requestBody.end = { dateTime: end.dateTime, timeZone: end.timeZone || tz };
      }

      const event = await calendar.events.insert({ calendarId: 'primary', requestBody });
      logger.info('gcal.event.created', { requestId: req.requestId, userId, eventId: event.data.id, googleEmail });
      try { await writeAudit({ userId, entityType: 'event', entityId: event.data.id, action: 'created', after: { id: event.data.id, title, start, end, googleEmail, entityTag }, requestId: req.requestId }); } catch {}
      res.json({ success: true, eventId: event.data.id, htmlLink: event.data.htmlLink });
    } catch (err) {
      logger.error('gcal.createEvent.failed', { requestId: req.requestId, userId, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/gcal/events/:eventId
   * Delete an event from a specific Google account + clean up calendar_notes.
   * Body: { googleEmail }
   */
  router.delete('/api/gcal/events/:eventId', authenticateToken, logger.tool('deleteEvent'), async (req, res) => {
    const userId = req.user.id;
    const { eventId } = req.params;
    const { googleEmail } = req.body;
    if (!googleEmail) return res.status(400).json({ error: 'googleEmail is required' });

    const tokens = await loadGcalTokens(userId, googleEmail);
    if (!tokens) return res.status(401).json({ error: `Google Calendar not connected for ${googleEmail}` });

    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured' });

    oauth2.setCredentials(tokens);
    oauth2.on('tokens', async (newTokens) => {
      try { await mergeAndSaveGcalTokens(userId, newTokens, googleEmail); }
      catch (e) { logger.error('gcal.tokenRefresh.failed', { userId, error: e.message }); }
    });

    try {
      // Snapshot before delete for audit
      let beforeSnapshot = null;
      try {
        const { rows } = await db.pool.query(
          `SELECT * FROM calendar_notes WHERE user_id = $1 AND event_id = $2`, [userId, eventId]
        );
        beforeSnapshot = rows[0] || { eventId, googleEmail };
      } catch { beforeSnapshot = { eventId, googleEmail }; }

      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      await calendar.events.delete({ calendarId: 'primary', eventId });
      logger.info('gcal.event.deleted', { requestId: req.requestId, userId, eventId, googleEmail });
      try { await writeAudit({ userId, entityType: 'event', entityId: eventId, action: 'deleted', before: beforeSnapshot, requestId: req.requestId, source: req.headers['x-source'] === 'agent' ? 'agent' : 'api' }); } catch {}

      // Clean up calendar_notes
      try {
        await db.pool.query(
          `DELETE FROM calendar_notes WHERE user_id = $1 AND event_id = $2`,
          [userId, eventId],
        );
      } catch (e) { /* calendar_notes row may not exist */ }

      res.json({ success: true });
    } catch (err) {
      logger.error('gcal.deleteEvent.failed', { requestId: req.requestId, userId, eventId, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
