/**
 * proxy-server.cjs
 *
 * Express server that:
 *   - Serves the built React app from dist/ (production)
 *   - Relays AI requests to Claude / OpenAI APIs
 *   - Sends email via Resend API
 *   - Provides JWT-based multi-user authentication
 *   - Persists all data to PostgreSQL (DATABASE_URL)
 *
 * Environment variables (all optional, fall back to request-body values):
 *   PORT                 – server port (default 3001)
 *   DATABASE_URL         – PostgreSQL connection string (required for persistence)
 *   CLAUDE_API_KEY       – Anthropic API key
 *   OPENAI_API_KEY       – OpenAI API key
 *   RESEND_API_KEY       – Resend API key for email
 *   RESEND_FROM_EMAIL    – sender address (default: onboarding@resend.dev)
 *   ALERT_RECIPIENT_EMAIL – default alert recipient email
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
const { Resend } = require('resend');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

const db = require('./db.cjs');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');

const DIST_DIR = path.join(__dirname, 'dist');

// JWT secret: prefer env var, fall back to random (tokens won't survive restart)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

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

  try {
    const users = await db.getUsers();
    const user = users.find((u) => u.username === username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (user.active === false) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email || '',
        role: user.role || 'member',
        entityIds: user.entityIds || [],
      },
      JWT_SECRET,
      { expiresIn: '7d' },
    );

    return res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email || '',
        role: user.role || 'member',
        entityIds: user.entityIds || [],
      },
    });
  } catch (err) {
    console.error('[auth] login failed:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/auth/me
 * Returns the current user from the JWT.
 */
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  // Return fresh user data from DB (not just JWT claims)
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { passwordHash, ...safe } = user;
    res.json({ user: safe });
  } catch (err) {
    res.json({ user: req.user });
  }
});

// ── Admin middleware ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// ── Entity routes ────────────────────────────────────────────────────────────

app.get('/api/entities', authenticateToken, async (_req, res) => {
  try {
    const entities = await db.getEntities();
    return res.json(entities);
  } catch (err) {
    console.error('[entities] read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/entities', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id, name, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const entity = await db.createEntity({ id: id || `entity-${Date.now()}`, name, color, createdBy: req.user.id });
    return res.json(entity);
  } catch (err) {
    console.error('[entities] create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/entities/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const updated = await db.updateEntity(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Entity not found' });
    return res.json(updated);
  } catch (err) {
    console.error('[entities] update failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/entities/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await db.deleteEntity(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[entities] delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── User management routes ───────────────────────────────────────────────────

app.get('/api/users', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const users = await db.getUsers();
    // Strip password hashes from response
    const safe = users.map(({ passwordHash, ...u }) => u);
    return res.json(safe);
  } catch (err) {
    console.error('[users] read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { username, displayName, email, password, role, entityIds } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
    const id = `user-${Date.now().toString(36)}`;
    const passwordHash = await bcrypt.hash(password, 10);
    await db.upsertUser({ id, username, displayName: displayName || username, passwordHash, email, role, entityIds });
    return res.json({ id, username, displayName: displayName || username, email, role, entityIds });
  } catch (err) {
    console.error('[users] create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const fields = { ...req.body };
    // If password is provided, hash it
    if (fields.password) {
      fields.passwordHash = await bcrypt.hash(fields.password, 10);
      delete fields.password;
    }
    const updated = await db.updateUser(req.params.id, fields);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    return res.json(updated);
  } catch (err) {
    console.error('[users] update failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete yourself' });
    }
    await db.deleteUser(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[users] delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── AI proxy routes ───────────────────────────────────────────────────────────

/**
 * Claude proxy
 * Body: { apiKey?: string, ...anthropicPayload }
 * Falls back to CLAUDE_API_KEY env var if apiKey not in body.
 */
app.post('/api/claude', authenticateToken, async (req, res) => {
  const { apiKey: bodyKey, ...body } = req.body;
  const apiKey = (bodyKey && !bodyKey.includes('****')) ? bodyKey : process.env.CLAUDE_API_KEY;
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
app.post('/api/openai', authenticateToken, async (req, res) => {
  const { apiKey: bodyKey, ...body } = req.body;
  const apiKey = (bodyKey && !bodyKey.includes('****')) ? bodyKey : process.env.OPENAI_API_KEY;
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

// ── Email routes (Resend) ─────────────────────────────────────────────────────

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

function getFromEmail() {
  return process.env.RESEND_FROM_EMAIL || 'TaskManage <onboarding@resend.dev>';
}

/**
 * POST /api/email/test
 * Sends a test email to verify Resend is working.
 * Body: { to? } — defaults to ALERT_RECIPIENT_EMAIL env var.
 */
app.post('/api/email/test', async (req, res) => {
  console.log('[email/test] RESEND_API_KEY is set:', !!process.env.RESEND_API_KEY);
  console.log('[email/test] RESEND_API_KEY length:', process.env.RESEND_API_KEY ? process.env.RESEND_API_KEY.length : 0);

  const resend = getResendClient();
  if (!resend) {
    console.log('[email/test] getResendClient() returned null - RESEND_API_KEY missing');
    return res.status(400).json({ error: 'RESEND_API_KEY environment variable is not set' });
  }

  const to = req.body.to || req.body.recipientEmail || process.env.ALERT_RECIPIENT_EMAIL;
  console.log('[email/test] Recipient email:', to);
  console.log('[email/test] From email:', getFromEmail());

  if (!to) {
    return res.status(400).json({ error: 'No recipient email provided' });
  }

  try {
    const response = await resend.emails.send({
      from: getFromEmail(),
      to,
      subject: '[TaskManage] Connection Test',
      html: '<p>Your Resend email integration is working.</p>',
    });
    console.log('[email/test] Resend API response:', JSON.stringify(response, null, 2));
    return res.json({ success: true, message: 'Test email sent via Resend', response });
  } catch (err) {
    console.error('[email/test] Resend test failed:', err.message);
    console.error('[email/test] Full error:', JSON.stringify(err, null, 2));
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/email/send
 * Body: { to, subject, html }
 */
app.post('/api/email/send', async (req, res) => {
  const resend = getResendClient();
  if (!resend) {
    return res.status(400).json({ error: 'RESEND_API_KEY environment variable is not set' });
  }

  const { to, subject, html } = req.body;
  if (!to || !subject) {
    return res.status(400).json({ error: 'Required fields: to, subject' });
  }

  try {
    const data = await resend.emails.send({
      from: getFromEmail(),
      to,
      subject,
      html: html || '<p>(no content)</p>',
    });

    console.log(`[email/send] Sent to ${to} via Resend — id: ${data.data?.id}`);
    return res.json({ success: true, messageId: data.data?.id });
  } catch (err) {
    console.error('[email/send] Resend failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Settings routes ───────────────────────────────────────────────────────────

function maskSecret(value) {
  if (!value || value.length < 6) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/**
 * GET /api/settings
 * Merges env var values over DB settings. For env-backed fields, returns
 * masked values and an `envConfigured` map so the frontend knows which
 * fields to lock.
 */
app.get('/api/settings', async (_req, res) => {
  try {
    const file = await db.getSettings();

    // Which fields are provided by env vars?
    const envConfigured = {
      claudeKey:        !!process.env.CLAUDE_API_KEY,
      openaiKey:        !!process.env.OPENAI_API_KEY,
      resendApiKey:     !!process.env.RESEND_API_KEY,
      recipientEmail:   !!process.env.ALERT_RECIPIENT_EMAIL,
    };

    // Build effective apiKeys (env wins, then DB)
    const apiKeys = {
      claude: process.env.CLAUDE_API_KEY
        ? maskSecret(process.env.CLAUDE_API_KEY)
        : (file.apiKeys?.claude || ''),
      openai: process.env.OPENAI_API_KEY
        ? maskSecret(process.env.OPENAI_API_KEY)
        : (file.apiKeys?.openai || ''),
    };

    // Build effective emailSettings (env wins, then DB)
    const emailSettings = {
      resendConfigured: !!process.env.RESEND_API_KEY,
      recipientEmail: process.env.ALERT_RECIPIENT_EMAIL
        || file.emailSettings?.recipientEmail
        || '',
    };

    res.json({
      apiKeys,
      emailSettings,
      alertRules: file.alertRules || null,
      envConfigured,
    });
  } catch (err) {
    console.error('[settings] read failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const current = await db.getSettings();
    const merged  = { ...current, ...req.body };
    await db.saveSettings(merged);
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
    await db.setGcalTokensForUser(userId, tokens);
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

  const tokens = await db.getGcalTokensForUser(userId);
  if (!tokens) return res.json({ connected: false });

  const oauth2 = makeOAuth2Client();
  if (!oauth2) return res.json({ connected: false });

  oauth2.setCredentials(tokens);
  // Refresh if needed and persist
  oauth2.on('tokens', async (newTokens) => {
    const existing = await db.getGcalTokensForUser(userId);
    await db.setGcalTokensForUser(userId, { ...existing, ...newTokens });
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
app.post('/api/gcal/sync-task', async (req, res) => {
  const { userId, title, description, dueDate } = req.body;
  if (!userId || !title || !dueDate) {
    return res.status(400).json({ error: 'userId, title, and dueDate are required' });
  }

  const tokens = await db.getGcalTokensForUser(userId);
  if (!tokens) return res.status(401).json({ error: 'Google Calendar not connected' });

  const oauth2 = makeOAuth2Client();
  if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured' });

  oauth2.setCredentials(tokens);
  oauth2.on('tokens', async (newTokens) => {
    const existing = await db.getGcalTokensForUser(userId);
    await db.setGcalTokensForUser(userId, { ...existing, ...newTokens });
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
app.post('/api/gcal/disconnect', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  await db.deleteGcalTokensForUser(userId);
  console.log(`[gcal] Disconnected ${userId}`);
  res.json({ success: true });
});

// ── Task persistence ─────────────────────────────────────────────────────────

app.get('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const tasks = await db.getTasksForUser(req.user.id, req.user.entityIds || []);
    return res.json(tasks);
  } catch (err) {
    console.error('[tasks] read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/tasks', authenticateToken, async (req, res) => {
  try {
    const tasks = req.body;
    if (!Array.isArray(tasks)) {
      return res.status(400).json({ error: 'Body must be an array of tasks' });
    }
    await db.replaceTasks(tasks);
    return res.json({ success: true, count: tasks.length });
  } catch (err) {
    console.error('[tasks] write failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const updated = await db.updateTask(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Task not found' });
    return res.json(updated);
  } catch (err) {
    console.error('[tasks] update failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Change password ──────────────────────────────────────────────────────────

app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }

  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(user.id, newHash);
    return res.json({ success: true });
  } catch (err) {
    console.error('[auth] change-password failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Notes (privacy-first) ────────────────────────────────────────────────────

app.get('/api/notes', authenticateToken, async (req, res) => {
  try {
    const notes = await db.getNotesForUser(req.user.id);
    return res.json(notes);
  } catch (err) {
    console.error('[notes] read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/notes', authenticateToken, async (req, res) => {
  try {
    const { id, title, content, visibility } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const note = await db.createNote({ id, userId: req.user.id, title, content, visibility });
    return res.json(note);
  } catch (err) {
    console.error('[notes] create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/notes/:id', authenticateToken, async (req, res) => {
  try {
    const updated = await db.updateNote(req.params.id, req.user.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Note not found or not owned by you' });
    return res.json(updated);
  } catch (err) {
    console.error('[notes] update failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notes/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteNote(req.params.id, req.user.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[notes] delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── User preferences ─────────────────────────────────────────────────────────

app.get('/api/preferences', authenticateToken, async (req, res) => {
  try {
    const prefs = await db.getUserPreferences(req.user.id);
    return res.json(prefs || { theme: 'light', defaultTagFilter: [], defaultStatusFilter: 'all', notificationsEnabled: true });
  } catch (err) {
    console.error('[preferences] read failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/preferences', authenticateToken, async (req, res) => {
  try {
    await db.saveUserPreferences(req.user.id, req.body);
    return res.json({ success: true });
  } catch (err) {
    console.error('[preferences] write failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Chat history ─────────────────────────────────────────────────────────────

app.get('/api/chat/history', authenticateToken, async (req, res) => {
  try {
    const messages = await db.getChatHistory(req.user.id, 50);
    return res.json(messages);
  } catch (err) {
    console.error('[chat] history read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/chat/message', authenticateToken, async (req, res) => {
  try {
    const { role, content, model } = req.body;
    if (!role || !content) {
      return res.status(400).json({ error: 'role and content are required' });
    }
    const msg = await db.saveChatMessage({ userId: req.user.id, role, content, model });
    return res.json(msg);
  } catch (err) {
    console.error('[chat] message save failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/chat/history', authenticateToken, async (req, res) => {
  try {
    await db.clearChatHistory(req.user.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[chat] history clear failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Financial Accounts ────────────────────────────────────────────────────────

app.get('/api/financial/accounts', authenticateToken, async (req, res) => {
  try {
    const accounts = await db.getFinancialAccounts(req.user.id, req.user.role);
    return res.json(accounts);
  } catch (err) {
    console.error('[financial] accounts read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/financial/accounts', authenticateToken, async (req, res) => {
  try {
    const { name, type, institution, currency, entityId, accountClass } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = `fa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const account = await db.createFinancialAccount({
      id, userId: req.user.id, name, type, institution, currency, entityId, accountClass,
    });
    return res.json(account);
  } catch (err) {
    console.error('[financial] account create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/financial/accounts/:id', authenticateToken, async (req, res) => {
  try {
    const updated = await db.updateFinancialAccount(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Account not found' });
    return res.json(updated);
  } catch (err) {
    console.error('[financial] account update failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/financial/accounts/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteFinancialAccount(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[financial] account delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Financial Transactions ────────────────────────────────────────────────────

app.get('/api/financial/transactions', authenticateToken, async (req, res) => {
  try {
    const filters = {};
    if (req.query.accountId) filters.accountId = req.query.accountId;
    if (req.query.entityId) filters.entityId = req.query.entityId;
    if (req.query.accountClass) filters.accountClass = req.query.accountClass;
    if (req.query.category) filters.category = req.query.category;
    if (req.query.startDate) filters.startDate = req.query.startDate;
    if (req.query.endDate) filters.endDate = req.query.endDate;
    const txns = await db.getTransactions(req.user.id, req.user.role, filters);
    return res.json(txns);
  } catch (err) {
    console.error('[financial] transactions read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/financial/transactions', authenticateToken, async (req, res) => {
  try {
    const { accountId, date, description, amount, type, category, entityId, accountClass, notes } = req.body;
    if (!accountId || !date || amount === undefined) {
      return res.status(400).json({ error: 'accountId, date, and amount are required' });
    }
    const id = `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const txn = await db.createTransaction({
      id, accountId, userId: req.user.id, date, description, amount: Math.abs(amount),
      type: type || (amount < 0 ? 'debit' : 'credit'), category, entityId, accountClass, notes,
    });
    return res.json(txn);
  } catch (err) {
    console.error('[financial] transaction create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/financial/transactions/:id', authenticateToken, async (req, res) => {
  try {
    const updated = await db.updateTransaction(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Transaction not found' });
    return res.json(updated);
  } catch (err) {
    console.error('[financial] transaction update failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/financial/transactions/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteTransaction(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[financial] transaction delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── File Import (CSV, Excel, PDF) ─────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  function splitRow(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    result.push(current.trim());
    return result;
  }
  const headers = splitRow(lines[0]);
  const rows = lines.slice(1).map(splitRow).filter((r) => r.length >= 2);
  return { headers, rows };
}

function detectCSVFormat(headers) {
  const h = headers.map((s) => s.toLowerCase().replace(/[^a-z]/g, ''));
  if (h.includes('transactiondate') || (h.includes('date') && h.includes('description') && h.includes('amount'))) {
    return 'chase';
  }
  if (h.some((x) => x.includes('runningbal'))) return 'boa';
  if (h.includes('date') && h.includes('amount')) return 'amex';
  return 'generic';
}

function mapCSVRow(format, headers, row) {
  const h = headers.map((s) => s.toLowerCase().replace(/[^a-z]/g, ''));
  const get = (key) => {
    const idx = h.findIndex((x) => x.includes(key));
    return idx >= 0 ? row[idx] : '';
  };

  let date = get('date') || get('transactiondate');
  let description = get('description') || get('memo') || '';
  let amountStr = get('amount') || '0';
  let category = get('category') || 'Uncategorized';

  if (date && !date.match(/^\d{4}-/)) {
    const parts = date.split('/');
    if (parts.length === 3) {
      const [m, d, y] = parts;
      const year = y.length === 2 ? '20' + y : y;
      date = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }

  const amount = Math.abs(parseFloat(amountStr.replace(/[^0-9.\-]/g, '')) || 0);
  const isCredit = parseFloat(amountStr.replace(/[^0-9.\-]/g, '')) > 0;

  return { date, description, amount, type: isCredit ? 'credit' : 'debit', category };
}

function parseExcelToRows(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const jsonRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (jsonRows.length < 2) return { headers: [], rows: [] };
  const headers = jsonRows[0].map(String);
  const rows = jsonRows.slice(1).map((r) => r.map(String)).filter((r) => r.some((c) => c.trim()));
  return { headers, rows };
}

async function parsePDFWithClaude(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const pdfData = await pdfParse(buffer);
  const text = pdfData.text;

  if (!text || text.trim().length < 20) {
    throw new Error('Could not extract readable text from PDF');
  }

  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('CLAUDE_API_KEY is required for PDF parsing. Set it in your environment variables.');
  }

  // Truncate to ~12k chars to stay within token limits
  const truncatedText = text.slice(0, 12000);

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are a bank statement parser. Extract ALL transactions from this bank statement text into a JSON array.

Each transaction object must have exactly these fields:
- "date": string in YYYY-MM-DD format
- "description": string with the transaction description/payee
- "amount": number (positive value, no currency symbols)
- "type": either "debit" or "credit"
- "category": your best guess category (e.g. "Food", "Shopping", "Transfer", "Income", "Utilities", "Entertainment", "Transportation", "Healthcare", "Subscription", "Other")

Return ONLY a valid JSON array, no other text. If you cannot find any transactions, return an empty array [].

Bank statement text:
${truncatedText}`,
      }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 60_000,
    },
  );

  const content = response.data?.content?.[0]?.text || '[]';
  // Extract JSON array from response (handle markdown code blocks)
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    // Validate and normalize each transaction
    return parsed
      .filter((t) => t.date && t.amount !== undefined)
      .map((t) => ({
        date: String(t.date),
        description: String(t.description || ''),
        amount: Math.abs(parseFloat(t.amount) || 0),
        type: t.type === 'credit' ? 'credit' : 'debit',
        category: String(t.category || 'Uncategorized'),
      }))
      .filter((t) => t.amount > 0);
  } catch {
    return [];
  }
}

app.post('/api/financial/import-csv', authenticateToken, async (req, res) => {
  try {
    const { csvText, fileData, fileType, accountId, entityId, accountClass } = req.body;
    if (!accountId) {
      return res.status(400).json({ error: 'accountId is required' });
    }

    let mappedRows = [];
    let format = 'csv';

    if (fileType === 'pdf') {
      // ── PDF: extract text with pdf-parse, then parse with Claude AI ──
      if (!fileData) return res.status(400).json({ error: 'fileData (base64) is required for PDF import' });
      format = 'pdf';
      const pdfTransactions = await parsePDFWithClaude(fileData);
      if (pdfTransactions.length === 0) {
        return res.status(400).json({ error: 'No transactions could be extracted from the PDF. Ensure it contains readable bank statement data.' });
      }
      mappedRows = pdfTransactions;

    } else if (fileType === 'xlsx' || fileType === 'xls') {
      // ── Excel: parse with xlsx package ──
      if (!fileData) return res.status(400).json({ error: 'fileData (base64) is required for Excel import' });
      format = 'xlsx';
      const { headers, rows } = parseExcelToRows(fileData);
      if (rows.length === 0) return res.status(400).json({ error: 'No data rows found in Excel file' });
      const csvFormat = detectCSVFormat(headers);
      format = `xlsx (${csvFormat})`;
      mappedRows = rows.map((row) => mapCSVRow(csvFormat, headers, row)).filter((r) => r.date && r.amount > 0);

    } else {
      // ── CSV: parse text directly ──
      if (!csvText) return res.status(400).json({ error: 'csvText is required for CSV import' });
      const { headers, rows } = parseCSV(csvText);
      if (rows.length === 0) return res.status(400).json({ error: 'No data rows found in CSV' });
      const csvFormat = detectCSVFormat(headers);
      format = `csv (${csvFormat})`;
      mappedRows = rows.map((row) => mapCSVRow(csvFormat, headers, row)).filter((r) => r.date && r.amount > 0);
    }

    if (mappedRows.length === 0) {
      return res.status(400).json({ error: 'No valid transactions found in file' });
    }

    const txns = mappedRows.map((mapped) => ({
      id: `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      accountId,
      userId: req.user.id,
      date: mapped.date,
      description: mapped.description,
      amount: mapped.amount,
      type: mapped.type,
      category: mapped.category,
      entityId: entityId || '',
      accountClass: accountClass || 'personal',
      notes: `Imported from ${format}`,
    }));

    const created = await db.bulkCreateTransactions(txns);
    return res.json({ success: true, count: created.length, format, transactions: created });
  } catch (err) {
    console.error('[financial] file import failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Financial Summary ─────────────────────────────────────────────────────────

app.get('/api/financial/summary', authenticateToken, async (req, res) => {
  try {
    const summary = await db.getFinancialSummary(req.user.id, req.user.role);
    return res.json(summary);
  } catch (err) {
    console.error('[financial] summary failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
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

async function start() {
  // Initialise database tables, seed data, and run migrations
  await db.initTables();
  await db.seedUsersIfEmpty();
  await db.runMigrations();

  app.listen(PORT, () => {
    console.log(`\n✓ TaskManage server running at http://localhost:${PORT}`);
    console.log('  POST /api/auth/login    → JWT login');
    console.log('  GET  /api/auth/me       → current user');
    console.log('  POST /api/claude        → api.anthropic.com');
    console.log('  POST /api/openai        → api.openai.com');
    console.log('  POST /api/email/test    → test Resend email delivery');
    console.log('  POST /api/email/send    → send email via Resend');
    console.log('  GET  /api/settings      → read settings (PostgreSQL)');
    console.log('  POST /api/settings      → write settings (PostgreSQL)');
    console.log('  GET  /api/gcal/auth-url → Google Calendar OAuth URL');
    console.log('  GET  /api/gcal/callback → Google Calendar OAuth callback');
    console.log('  GET  /api/gcal/status   → check calendar connection');
    console.log('  POST /api/gcal/sync-task→ sync task to Google Calendar');
    console.log('  POST /api/gcal/disconnect→ remove calendar connection');
    console.log('  GET  /api/tasks        → read tasks (PostgreSQL)');
    console.log('  POST /api/tasks        → write tasks (PostgreSQL)');
    console.log('  GET  /health\n');
  });
}

start().catch((err) => {
  console.error('[startup] Fatal error:', err.message);
  process.exit(1);
});
