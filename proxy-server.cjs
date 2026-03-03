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

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', port: PORT, time: new Date().toISOString() }),
);

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✓ TaskManage proxy running at http://localhost:${PORT}`);
  console.log('  POST /api/claude        → api.anthropic.com');
  console.log('  POST /api/openai        → api.openai.com');
  console.log('  POST /api/email/test    → verify Gmail SMTP credentials');
  console.log('  POST /api/email/send    → send email via Gmail SMTP');
  console.log('  GET  /health\n');
});
