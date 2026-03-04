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
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const USERS_FILE    = path.join(__dirname, 'users.json');
const DIST_DIR      = path.join(__dirname, 'dist');

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
  console.log('  GET  /health\n');
});
