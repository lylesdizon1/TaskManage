/**
 * proxy-server.cjs
 *
 * Express server that:
 *   - Serves the built React app from dist/ (production)
 *   - Relays AI requests to Claude / OpenAI APIs
 *   - Handles Gmail SMTP email sending
 *   - Provides JWT-based multi-user authentication
 *   - Persists settings to settings.json
 *
 * Environment variables (all optional, fall back to request-body values):
 *   PORT                 – server port (default 3001)
 *   CLAUDE_API_KEY       – Anthropic API key
 *   OPENAI_API_KEY       – OpenAI API key
 *   GMAIL_USER           – Gmail address for SMTP
 *   GMAIL_APP_PASSWORD   – Gmail App Password
 *   JWT_SECRET           – secret for signing JWTs (default: random per restart)
 *   GOOGLE_CLIENT_ID     – Google OAuth2 client ID (for Calendar)
 *   GOOGLE_CLIENT_SECRET – Google OAuth2 client secret
 *   APP_URL              – public URL of the app (for OAuth redirect)
 *
 * Start with: node proxy-server.cjs
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

const SETTINGS_FILE    = path.join(__dirname, 'settings.json');
const USERS_FILE       = path.join(__dirname, 'users.json');
const GCAL_TOKENS_FILE = path.join(__dirname, 'gcal-tokens.json');
const DIST_DIR         = path.join(__dirname, 'dist');

// JWT secret: prefer env var, fall back to random (tokens won't survive restart)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// ── Google Calendar token persistence (keyed by app user ID) ─────────────────

function readGcalTokens() {
  try {
    return JSON.parse(fs.readFileSync(GCAL_TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeGcalTokens(data) {
  fs.writeFileSync(GCAL_TOKENS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getAppUrl() {
  return (process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/+$/, '');
}

function makeOAuth2Client() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, `${getAppUrl()}/api/gcal/callback`);
}

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));

// Simple request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Auth helpers ─────────────────────────────────────────────────────────────

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// ── Auth routes ──────────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Returns: { token, user: { id, username, displayName } }
 */
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const users = readUsers();
  const user = users.find((u) => u.username === username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, displayName: user.displayName },
    JWT_SECRET,
    { expiresIn: '7d' },
  );

  return res.json({
    token,
    user: { id: user.id, username: user.username, displayName: user.displayName },
  });
});

/**
 * GET /api/auth/me
 * Returns the current user from the JWT.
 */
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// ── AI proxy routes ───────────────────────────────────────────────────────────

/**
 * Claude proxy
 * Body: { apiKey?: string, ...anthropicPayload }
 * Falls back to CLAUDE_API_KEY env var if apiKey not in body.
 */
app.post('/api/claude', async (req, res) => {
  const { apiKey: bodyKey, ...body } = req.body;
  const apiKey = bodyKey || process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(401).json({ error: 'Missing apiKey in request body' });

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      body,
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 60_000,
      },
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    return res.status(err.response?.status || 502).json(
      err.response?.data || { error: err.message },
    );
  }
});

/**
 * OpenAI proxy
 * Body: { apiKey?: string, ...openaiPayload }
 * Falls back to OPENAI_API_KEY env var if apiKey not in body.
 */
app.post('/api/openai', async (req, res) => {
  const { apiKey: bodyKey, ...body } = req.body;
  const apiKey = bodyKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(401).json({ error: 'Missing apiKey in request body' });

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      body,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        timeout: 60_000,
      },
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    return res.status(err.response?.status || 502).json(
      err.response?.data || { error: err.message },
    );
  }
});

// ── Email routes ──────────────────────────────────────────────────────────────

function createGmailTransporter(user, pass) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

/**
 * POST /api/email/test
 * Body: { gmailUser?, gmailAppPassword? }
 * Falls back to env vars GMAIL_USER / GMAIL_APP_PASSWORD.
 */
app.post('/api/email/test', async (req, res) => {
  const gmailUser        = req.body.gmailUser        || process.env.GMAIL_USER;
  const gmailAppPassword = req.body.gmailAppPassword || process.env.GMAIL_APP_PASSWORD;

  if (!gmailUser || !gmailAppPassword) {
    return res.status(400).json({ error: 'gmailUser and gmailAppPassword are required' });
  }

  const transporter = createGmailTransporter(gmailUser, gmailAppPassword);

  try {
    await transporter.verify();
    return res.json({ success: true, message: 'SMTP connection verified successfully' });
  } catch (err) {
    console.error('[email/test] SMTP verify failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/email/send
 * Body: { gmailUser?, gmailAppPassword?, to, subject, html }
 * Falls back to env vars GMAIL_USER / GMAIL_APP_PASSWORD.
 */
app.post('/api/email/send', async (req, res) => {
  const gmailUser        = req.body.gmailUser        || process.env.GMAIL_USER;
  const gmailAppPassword = req.body.gmailAppPassword || process.env.GMAIL_APP_PASSWORD;
  const { to, subject, html } = req.body;

  if (!gmailUser || !gmailAppPassword || !to || !subject) {
    return res.status(400).json({
      error: 'Required fields: gmailUser, gmailAppPassword, to, subject',
    });
  }

  const transporter = createGmailTransporter(gmailUser, gmailAppPassword);

  try {
    const info = await transporter.sendMail({
      from: `"TaskManage" <${gmailUser}>`,
      to,
      subject,
      html: html || '<p>(no content)</p>',
    });

    console.log(`[email/send] Sent to ${to} — messageId: ${info.messageId}`);
    return res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    console.error('[email/send] Failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Settings routes ───────────────────────────────────────────────────────────

app.get('/api/settings', (_req, res) => {
  res.json(readSettings());
});

app.post('/api/settings', (req, res) => {
  try {
    const current = readSettings();
    const merged  = { ...current, ...req.body };
    writeSettings(merged);
    res.json({ success: true });
  } catch (err) {
    console.error('[settings] write failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Google Calendar routes ────────────────────────────────────────────────────

const GCAL_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.readonly'];

/**
 * GET /api/gcal/auth-url?userId=...
 * Returns the Google OAuth consent URL. userId is the app user ID (e.g. "user-lyle").
 */
app.get('/api/gcal/auth-url', (req, res) => {
  const oauth2 = makeOAuth2Client();
  if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)' });

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId query param required' });

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
app.get('/api/gcal/callback', async (req, res) => {
  const oauth2 = makeOAuth2Client();
  if (!oauth2) return res.status(500).send('Google OAuth not configured');

  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Missing code or state');

  try {
    const { tokens } = await oauth2.getToken(code);
    const allTokens = readGcalTokens();
    allTokens[userId] = tokens;
    writeGcalTokens(allTokens);
    console.log(`[gcal] Stored tokens for ${userId}`);
    // Redirect back to the app's calendar tab
    res.redirect('/?gcal=connected');
  } catch (err) {
    console.error('[gcal] Token exchange failed:', err.message);
    res.status(500).send(`Google Calendar auth failed: ${err.message}`);
  }
});

/**
 * GET /api/gcal/status?userId=...
 * Returns { connected: bool, email?: string }
 */
app.get('/api/gcal/status', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const allTokens = readGcalTokens();
  const tokens = allTokens[userId];
  if (!tokens) return res.json({ connected: false });

  const oauth2 = makeOAuth2Client();
  if (!oauth2) return res.json({ connected: false });

  oauth2.setCredentials(tokens);
  // Refresh if needed and persist
  oauth2.on('tokens', (newTokens) => {
    const updated = readGcalTokens();
    updated[userId] = { ...updated[userId], ...newTokens };
    writeGcalTokens(updated);
  });

  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2 });
    const { data } = await calendar.calendarList.get({ calendarId: 'primary' });
    res.json({ connected: true, email: data.id });
  } catch (err) {
    console.error('[gcal] status check failed:', err.message);
    // Token likely revoked
    delete allTokens[userId];
    writeGcalTokens(allTokens);
    res.json({ connected: false });
  }
});

/**
 * POST /api/gcal/sync-task
 * Body: { userId, title, description?, dueDate (YYYY-MM-DD) }
 * Creates a Google Calendar all-day event for the task.
 */
app.post('/api/gcal/sync-task', async (req, res) => {
  const { userId, title, description, dueDate } = req.body;
  if (!userId || !title || !dueDate) {
    return res.status(400).json({ error: 'userId, title, and dueDate are required' });
  }

  const allTokens = readGcalTokens();
  const tokens = allTokens[userId];
  if (!tokens) return res.status(401).json({ error: 'Google Calendar not connected' });

  const oauth2 = makeOAuth2Client();
  if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured' });

  oauth2.setCredentials(tokens);
  oauth2.on('tokens', (newTokens) => {
    const updated = readGcalTokens();
    updated[userId] = { ...updated[userId], ...newTokens };
    writeGcalTokens(updated);
  });

  try {
    const calendar = google.calendar({ version: 'v3', auth: oauth2 });
    // Create an all-day event on the due date
    const nextDay = new Date(dueDate);
    nextDay.setDate(nextDay.getDate() + 1);
    const endDate = nextDay.toISOString().slice(0, 10);

    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: `[TaskManage] ${title}`,
        description: description || '',
        start: { date: dueDate },
        end:   { date: endDate },
      },
    });

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
app.post('/api/gcal/disconnect', (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const allTokens = readGcalTokens();
  delete allTokens[userId];
  writeGcalTokens(allTokens);
  console.log(`[gcal] Disconnected ${userId}`);
  res.json({ success: true });
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', port: PORT, time: new Date().toISOString() }),
);

// ── Serve React app from dist/ (production) ──────────────────────────────────

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback: any non-API route serves index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  console.log('[static] Serving React build from dist/');
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✓ TaskManage server running at http://localhost:${PORT}`);
  console.log('  POST /api/auth/login    → JWT login');
  console.log('  GET  /api/auth/me       → current user');
  console.log('  POST /api/claude        → api.anthropic.com');
  console.log('  POST /api/openai        → api.openai.com');
  console.log('  POST /api/email/test    → verify Gmail SMTP credentials');
  console.log('  POST /api/email/send    → send email via Gmail SMTP');
  console.log('  GET  /api/settings      → read settings.json');
  console.log('  POST /api/settings      → write settings.json');
  console.log('  GET  /api/gcal/auth-url → Google Calendar OAuth URL');
  console.log('  GET  /api/gcal/callback → Google Calendar OAuth callback');
  console.log('  GET  /api/gcal/status   → check calendar connection');
  console.log('  POST /api/gcal/sync-task→ sync task to Google Calendar');
  console.log('  POST /api/gcal/disconnect→ remove calendar connection');
  console.log('  GET  /health\n');
});
