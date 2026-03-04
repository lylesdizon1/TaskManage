/**
 * proxy-server.cjs
 *
 * Lightweight Express proxy that relays requests to:
 *   POST /api/claude        → https://api.anthropic.com/v1/messages
 *   POST /api/openai        → https://api.openai.com/v1/chat/completions
 *   POST /api/email/send    → Gmail SMTP via Nodemailer
 *   POST /api/email/test    → Verify Gmail SMTP credentials
 *
 * API keys and email credentials are passed in the request body and never
 * stored or logged by this server.
 *
 * Start with: node proxy-server.cjs
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const TASKS_FILE    = path.join(__dirname, 'tasks.json');

// ── Hardcoded users (passwords from env vars) ─────────────────────────────────
const USERS = {
  lyle: process.env.LYLE_PASSWORD || 'lyle123',
  wife: process.env.WIFE_PASSWORD || 'wife123',
};

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

function readTasks() {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    return { tasks: [] };
  }
}

function writeTasks(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * On first run (no settings.json yet), seed API keys + email from env vars
 * so Railway deployments can be configured entirely via environment variables.
 */
function initSettingsFromEnv() {
  if (fs.existsSync(SETTINGS_FILE)) return;
  const seed = {};
  if (process.env.CLAUDE_API_KEY || process.env.OPENAI_API_KEY) {
    seed.apiKeys = {
      claude: process.env.CLAUDE_API_KEY || '',
      openai: process.env.OPENAI_API_KEY || '',
    };
  }
  if (process.env.GMAIL_USER) {
    seed.emailSettings = {
      gmailUser:        process.env.GMAIL_USER || '',
      gmailAppPassword: process.env.GMAIL_APP_PASSWORD || '',
      recipientEmail:   process.env.RECIPIENT_EMAIL || '',
    };
  }
  if (Object.keys(seed).length > 0) {
    writeSettings(seed);
    console.log('[settings] Seeded from environment variables');
  }
}

initSettingsFromEnv();

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));

// Simple request logger (credentials are never in the path or logged)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── AI proxy routes ───────────────────────────────────────────────────────────

/**
 * Claude proxy
 * Body: { apiKey: string, ...anthropicPayload }
 */
app.post('/api/claude', async (req, res) => {
  const { apiKey, ...body } = req.body;
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
 * Body: { apiKey: string, ...openaiPayload }
 */
app.post('/api/openai', async (req, res) => {
  const { apiKey, ...body } = req.body;
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

/**
 * Build a Nodemailer transporter for Gmail.
 * Uses an App Password (not the account password) so 2FA accounts work fine.
 */
function createGmailTransporter(user, pass) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, // TLS
    auth: { user, pass },
  });
}

/**
 * POST /api/email/test
 * Verify Gmail SMTP credentials without sending a message.
 * Body: { gmailUser: string, gmailAppPassword: string }
 */
app.post('/api/email/test', async (req, res) => {
  const { gmailUser, gmailAppPassword } = req.body;

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
 * Send an email via Gmail SMTP.
 * Body: { gmailUser, gmailAppPassword, to, subject, html }
 */
app.post('/api/email/send', async (req, res) => {
  const { gmailUser, gmailAppPassword, to, subject, html } = req.body;

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

/**
 * GET /api/settings
 * Returns the persisted settings object (empty object if file doesn't exist).
 */
app.get('/api/settings', (_req, res) => {
  res.json(readSettings());
});

/**
 * POST /api/settings
 * Merges the incoming body into settings.json and writes it to disk.
 * Body: { apiKeys, emailSettings, alertRules }
 */
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

// ── Auth route ────────────────────────────────────────────────────────────────

/**
 * POST /api/login
 * Body: { username: string, password: string }
 * Returns: { success: true, user: string } or 401.
 */
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const key = (username || '').toLowerCase().trim();
  if (USERS[key] && USERS[key] === password) {
    return res.json({ success: true, user: key });
  }
  return res.status(401).json({ error: 'Invalid username or password' });
});

// ── Tasks routes ──────────────────────────────────────────────────────────────

/**
 * GET /api/tasks
 * Returns the full tasks list from tasks.json.
 */
app.get('/api/tasks', (_req, res) => {
  res.json(readTasks());
});

/**
 * POST /api/tasks
 * Persists the full tasks array to tasks.json.
 * Body: { tasks: Task[] }
 */
app.post('/api/tasks', (req, res) => {
  try {
    writeTasks({ tasks: req.body.tasks || [] });
    res.json({ success: true });
  } catch (err) {
    console.error('[tasks] write failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', port: PORT, time: new Date().toISOString() }),
);

// ── Serve frontend static build (Railway / production) ────────────────────────
// In development Vite's own dev server handles the frontend; in production the
// built `dist/` folder is served here so a single Railway service covers both.

const DIST_DIR = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback — all non-API routes return index.html
  app.get('*', (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✓ TaskManage proxy running at http://localhost:${PORT}`);
  console.log('  POST /api/claude        → api.anthropic.com');
  console.log('  POST /api/openai        → api.openai.com');
  console.log('  POST /api/email/test    → verify Gmail SMTP credentials');
  console.log('  POST /api/email/send    → send email via Gmail SMTP');
  console.log('  GET  /api/settings      → read settings.json');
  console.log('  POST /api/settings      → write settings.json');
  console.log('  POST /api/login         → authenticate lyle / wife');
  console.log('  GET  /api/tasks         → read tasks.json');
  console.log('  POST /api/tasks         → write tasks.json');
  console.log('  GET  /health\n');
  if (fs.existsSync(DIST_DIR)) {
    console.log('  Serving frontend from dist/ (production mode)\n');
  }
});
