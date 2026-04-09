'use strict';

const express = require('express');

const GCAL_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'];

module.exports = function createGcalRouter({ authenticateToken, db, makeOAuth2Client, saveGcalTokens, loadGcalTokens, loadAllGcalAccounts, google }) {
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
   * Google redirects here after consent. Exchanges code for tokens,
   * fetches the account email, and stores with dedup.
   */
  router.get('/api/gcal/callback', async (req, res) => {
    const oauth2 = makeOAuth2Client();
    if (!oauth2) return res.status(500).send('Google OAuth not configured');

    const { code, state: userId } = req.query;
    if (!code || !userId) return res.status(400).send('Missing code or state');

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
        console.warn('[gcal] Could not fetch email after auth:', e.message);
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

      console.log(`[gcal] Stored tokens for ${userId} (${googleEmail})`);
      res.redirect('/?gcal=connected');
    } catch (err) {
      console.error('[gcal] Token exchange failed:', err.message);
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
        const existing = await loadGcalTokens(userId, acct.googleEmail);
        await saveGcalTokens(userId, { ...existing, ...newTokens }, acct.googleEmail);
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
        validAccounts.push({ email: realEmail || acct.googleEmail, isPrimary: acct.isPrimary });
      } catch (err) {
        console.warn(`[gcal] status check failed for ${acct.googleEmail}:`, err.message);
        // Token revoked — remove this account
        await db.deleteGcalTokensForUser(userId, acct.googleEmail);
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
   * Body: { email } — optional. If provided, disconnects that account only.
   * If omitted, disconnects ALL accounts (legacy compat).
   */
  router.post('/api/gcal/disconnect', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { email } = req.body;

    await db.deleteGcalTokensForUser(userId, email || undefined);
    console.log(`[gcal] Disconnected ${userId}${email ? ` (${email})` : ' (all)'}`);
    res.json({ success: true });
  });

  /**
   * POST /api/gcal/set-primary
   * Body: { email } — set this account as the primary calendar.
   */
  router.post('/api/gcal/set-primary', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    await db.setGcalPrimaryAccount(userId, email);
    console.log(`[gcal] Set primary account for ${userId}: ${email}`);
    res.json({ success: true });
  });

  /**
   * GET /api/gcal/events
   * Returns calendar events from ALL connected Google accounts, merged + deduped.
   */
  router.get('/api/gcal/events', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { timeZone, days } = req.query;
    const numDays = Math.min(Math.max(parseInt(days, 10) || 1, 1), 30);

    const allAccounts = await loadAllGcalAccounts(userId);
    if (!allAccounts.length) return res.json([]);

    // Compute time boundaries
    let startOfDay, endOfDay;
    if (timeZone) {
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
      const todayStr = formatter.format(new Date());
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

    // Fetch from all accounts in parallel, fault-tolerant
    const allEvents = [];
    const seenIds = new Set();

    const results = await Promise.allSettled(allAccounts.map(async (acct) => {
      const oauth2 = makeOAuth2Client();
      if (!oauth2) return [];
      oauth2.setCredentials(acct.tokens);
      oauth2.on('tokens', async (newTokens) => {
        const existing = await loadGcalTokens(userId, acct.googleEmail);
        await saveGcalTokens(userId, { ...existing, ...newTokens }, acct.googleEmail);
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      const { data } = await calendar.events.list(listParams);
      return (data.items || []).map((ev) => ({
        id: ev.id,
        title: (ev.summary || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
        start: ev.start?.dateTime || ev.start?.date || null,
        end: ev.end?.dateTime || ev.end?.date || null,
        allDay: !ev.start?.dateTime,
        account: acct.googleEmail,
      }));
    }));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const ev of result.value) {
          if (!seenIds.has(ev.id)) {
            seenIds.add(ev.id);
            allEvents.push(ev);
          }
        }
      }
    }

    // Sort by start time
    allEvents.sort((a, b) => {
      const aStart = a.start || '';
      const bStart = b.start || '';
      return aStart < bStart ? -1 : aStart > bStart ? 1 : 0;
    });

    res.json(allEvents);
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
