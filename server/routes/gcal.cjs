'use strict';

const express = require('express');

const GCAL_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'];

module.exports = function createGcalRouter({ authenticateToken, db, makeOAuth2Client, saveGcalTokens, loadGcalTokens, google }) {
  const router = express.Router();

  /**
   * GET /api/gcal/auth-url
   * Returns the Google OAuth consent URL.
   */
  router.get('/api/gcal/auth-url', authenticateToken, (req, res) => {
    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)' });

    const userId = req.user.id;

    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GCAL_SCOPES,
      state: userId,
    });
    res.json({ url });
  });

  /**
   * GET /api/gcal/callback?code=...&state=userId
   * Google redirects here after consent. Exchanges code for tokens and stores them.
   */
  router.get('/api/gcal/callback', async (req, res) => {
    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.status(500).send('Google OAuth not configured');

    const { code, state: userId } = req.query;
    if (!code || !userId) return res.status(400).send('Missing code or state');

    try {
      const { tokens } = await oauth2.getToken(code);
      await saveGcalTokens(userId, tokens);
      console.log(`[gcal] Stored tokens for ${userId}`);
      // Redirect back to the app's calendar tab
      res.redirect('/?gcal=connected');
    } catch (err) {
      console.error('[gcal] Token exchange failed:', err.message);
      res.status(500).send(`Google Calendar auth failed: ${err.message}`);
    }
  });

  /**
   * GET /api/gcal/status
   * Returns { connected: bool, email?: string }
   */
  router.get('/api/gcal/status', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    const tokens = await loadGcalTokens(userId);
    if (!tokens) return res.json({ connected: false });

    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.json({ connected: false });

    oauth2.setCredentials(tokens);
    // Refresh if needed and persist
    oauth2.on('tokens', async (newTokens) => {
      const existing = await loadGcalTokens(userId);
      await saveGcalTokens(userId, { ...existing, ...newTokens });
    });

    try {
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      const { data } = await calendar.calendarList.get({ calendarId: 'primary' });
      res.json({ connected: true, email: data.id });
    } catch (err) {
      console.error('[gcal] status check failed:', err.message);
      // Token likely revoked
      await db.deleteGcalTokensForUser(userId);
      res.json({ connected: false });
    }
  });

  /**
   * POST /api/gcal/sync-task
   * Body: { userId, title, description?, dueDate (YYYY-MM-DD) }
   * Creates a Google Calendar all-day event for the task.
   */
  router.post('/api/gcal/sync-task', authenticateToken, async (req, res) => {
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
      const existing = await loadGcalTokens(userId);
      await saveGcalTokens(userId, { ...existing, ...newTokens });
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
      console.log(`[gcal] Created event ${event.data.id} for ${userId}`);
      res.json({ success: true, eventId: event.data.id, htmlLink: event.data.htmlLink });
    } catch (err) {
      console.error('[gcal] sync-task failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/gcal/disconnect
   * Body: { userId }
   * Removes stored tokens for the user.
   */
  router.post('/api/gcal/disconnect', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    await db.deleteGcalTokensForUser(userId);
    console.log(`[gcal] Disconnected ${userId}`);
    res.json({ success: true });
  });

  /**
   * GET /api/gcal/events?userId=...
   * Returns today's calendar events from Google Calendar.
   */
  router.get('/api/gcal/events', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { timeZone, days } = req.query;
    const numDays = Math.min(Math.max(parseInt(days, 10) || 1, 1), 30);

    const tokens = await loadGcalTokens(userId);
    if (!tokens) return res.json([]);

    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.json([]);

    oauth2.setCredentials(tokens);
    oauth2.on('tokens', async (newTokens) => {
      const existing = await loadGcalTokens(userId);
      await saveGcalTokens(userId, { ...existing, ...newTokens });
    });

    try {
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });

      // Use client timezone to determine "today", falling back to server local time
      let startOfDay, endOfDay;
      if (timeZone) {
        // Build today's date string in the user's timezone, then create proper boundaries
        const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
        const todayStr = formatter.format(new Date()); // YYYY-MM-DD in user's tz
        // Compute UTC offset for user's timezone so midnight is correct locally
        const midpoint = new Date(`${todayStr}T12:00:00Z`);
        const localMs = new Date(midpoint.toLocaleString('en-US', { timeZone })).getTime();
        const offsetMs = midpoint.getTime() - localMs;
        startOfDay = new Date(`${todayStr}T00:00:00Z`);
        startOfDay = new Date(startOfDay.getTime() + offsetMs);
        endOfDay = new Date(startOfDay);
        endOfDay.setDate(endOfDay.getDate() + numDays);
      } else {
        const now = new Date();
        startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endOfDay = new Date(startOfDay);
        endOfDay.setDate(endOfDay.getDate() + numDays);
      }

      const listParams = {
        calendarId: 'primary',
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: numDays > 1 ? 50 : 20,
      };
      if (timeZone) listParams.timeZone = timeZone;

      const { data } = await calendar.events.list(listParams);

      const events = (data.items || []).map((ev) => ({
        id: ev.id,
        title: (ev.summary || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
        start: ev.start?.dateTime || ev.start?.date || null,
        end: ev.end?.dateTime || ev.end?.date || null,
        allDay: !ev.start?.dateTime,
      }));

      res.json(events);
    } catch (err) {
      console.error('[gcal] events list failed:', err.message);
      res.json([]);
    }
  });

  /**
   * POST /api/calendar/events
   * Create a new Google Calendar event.
   */
  router.post('/api/calendar/events', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { summary, description, start, end, allDay } = req.body;
    if (!summary) return res.status(400).json({ error: 'summary required' });

    const tokens = await loadGcalTokens(userId);
    if (!tokens) return res.status(401).json({ error: 'Google Calendar not connected' });

    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured' });

    oauth2.setCredentials(tokens);
    oauth2.on('tokens', async (newTokens) => {
      const existing = await loadGcalTokens(userId);
      await saveGcalTokens(userId, { ...existing, ...newTokens });
    });

    try {
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      const requestBody = { summary, description: description || '' };

      if (allDay) {
        // All-day event: use date strings
        requestBody.start = { date: start.date };
        const endDate = end?.date || start.date;
        // Google requires end date to be day after for single-day all-day events
        const nextDay = new Date(endDate);
        nextDay.setDate(nextDay.getDate() + 1);
        requestBody.end = { date: nextDay.toISOString().slice(0, 10) };
      } else {
        requestBody.start = { dateTime: start.dateTime, timeZone: start.timeZone };
        requestBody.end = { dateTime: end.dateTime, timeZone: end.timeZone };
      }

      const event = await calendar.events.insert({ calendarId: 'primary', requestBody });
      console.log(`[gcal] Created event ${event.data.id} for ${userId}`);
      res.json({ success: true, eventId: event.data.id, htmlLink: event.data.htmlLink });
    } catch (err) {
      console.error('[gcal] create event failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
