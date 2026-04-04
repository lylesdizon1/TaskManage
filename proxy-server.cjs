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
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const Anthropic  = require('@anthropic-ai/sdk');

const multer = require('multer');
const db = require('./db.cjs');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');

// ── Multer config for note image uploads (base64 fallback) ───────────────────
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only jpeg, png, gif, webp images are allowed'));
    }
  },
});

const DIST_DIR = path.join(__dirname, 'dist');

// JWT secret: prefer env var, fall back to random (tokens won't survive restart)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// ── Token encryption helpers ────────────────────────────────────────────────
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // Must be 32 chars

const encrypt = (text) => {
  if (!text || !ENCRYPTION_KEY) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
};

const decrypt = (text) => {
  if (!text || !ENCRYPTION_KEY) return text;
  try {
    const [ivHex, encrypted] = text.split(':');
    if (!ivHex || !encrypted) return text; // not encrypted, return as-is
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'utf8'), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return text; // decryption failed (likely unencrypted legacy data), return as-is
  }
};

const encryptTokens = (tokens) => {
  if (!tokens || !ENCRYPTION_KEY) return tokens;
  return encrypt(JSON.stringify(tokens));
};

const decryptTokens = (stored) => {
  if (!stored || !ENCRYPTION_KEY) return stored;
  if (typeof stored === 'object') return stored; // already a plain object (unencrypted legacy)
  try {
    return JSON.parse(decrypt(stored));
  } catch {
    return stored; // couldn't decrypt/parse, return as-is
  }
};

// Wrappers that encrypt/decrypt tokens when storing/loading from DB
// Tokens column is JSONB, so encrypted string is wrapped in { _enc: "..." }
const saveGcalTokens = async (userId, tokens) => {
  if (ENCRYPTION_KEY) {
    const encrypted = encryptTokens(tokens);
    await db.setGcalTokensForUser(userId, { _enc: encrypted });
  } else {
    await db.setGcalTokensForUser(userId, tokens);
  }
};

const loadGcalTokens = async (userId) => {
  const stored = await db.getGcalTokensForUser(userId);
  if (!stored) return null;
  if (stored._enc) return decryptTokens(stored._enc);
  return stored; // legacy unencrypted tokens
};

// ── Rate limiters ───────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

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
app.set('trust proxy', 1); // Railway sits behind a proxy
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled to not break SPA
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '4mb' }));
app.use('/api/auth/login', authLimiter);
app.use('/api/', apiLimiter);

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
      { expiresIn: '30d' },
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

/**
 * PUT /api/users/settings
 * Body: { persona?, assistantName? }
 * Updates the current user's persona and assistant name.
 */
app.put('/api/users/settings', authenticateToken, async (req, res) => {
  try {
    const { persona, assistantName } = req.body;
    const fields = {};
    if (persona !== undefined) fields.persona = persona;
    if (assistantName !== undefined) fields.assistantName = assistantName;
    const updated = await db.updateUser(req.user.id, fields);
    if (!updated) return res.status(404).json({ error: 'User not found' });
    return res.json(updated);
  } catch (err) {
    console.error('[users] settings update failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/auth/refresh
 * Accepts a valid (non-expired) token, returns a fresh token with new 30d expiry.
 * Header: Authorization: Bearer <token>
 * Returns: { token, user: { id, username, displayName, ... } }
 */
app.post('/api/auth/refresh', authenticateToken, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user || user.active === false) {
      return res.status(403).json({ error: 'Account is deactivated or not found' });
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
      { expiresIn: '30d' },
    );

    const { passwordHash, ...safe } = user;
    return res.json({ token, user: safe });
  } catch (err) {
    console.error('[auth] refresh failed:', err.message);
    return res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ── Admin middleware ──────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireOwnership(record, req) {
  const isOwner  = record.user_id === req.user.id;
  const inEntity = record.entity_id &&
                   (req.user.entityIds || []).includes(record.entity_id);
  const isAdmin  = req.user.role === 'admin';
  return isOwner || inEntity || isAdmin;
}

// ── Entity routes ────────────────────────────────────────────────────────────

app.get('/api/entities', authenticateToken, async (req, res) => {
  try {
    // Admin sees all; others see own + shared
    const entities = req.user.role === 'admin'
      ? await db.getEntities()
      : await db.getEntitiesForUser(req.user.id);
    // Add isOwner flag for admin (getEntities doesn't compute it)
    const result = entities.map((e) => ({
      ...e,
      isOwner: e.isOwner !== undefined ? e.isOwner : (e.createdBy === req.user.id || req.user.role === 'admin'),
    }));
    return res.json(result);
  } catch (err) {
    console.error('[entities] read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/entities', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { id, name, color, type, parentId, shared } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const validTypes = ['business', 'project', 'personal'];
    if (type && !validTypes.includes(type)) {
      return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
    }
    if (parentId) {
      const parent = await db.getEntityById(parentId);
      if (!parent) return res.status(400).json({ error: 'Parent entity not found' });
    }
    const entity = await db.createEntity({
      id: id || `entity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name, color, createdBy: req.user.id,
      type: type || 'business', parentId: parentId || null, shared: shared || false,
    });
    return res.json(entity);
  } catch (err) {
    console.error('[entities] create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/entities/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Ownership check for shared entities
    const existing = await db.getEntityById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Entity not found' });
    if (existing.shared && existing.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only the owner can edit this entity' });
    }
    const validTypes = ['business', 'project', 'personal'];
    if (req.body.type && !validTypes.includes(req.body.type)) {
      return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
    }
    if (req.body.parentId) {
      const parent = await db.getEntityById(req.body.parentId);
      if (!parent) return res.status(400).json({ error: 'Parent entity not found' });
    }
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
    const existing = await db.getEntityById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Entity not found' });
    if (existing.shared && existing.createdBy !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Cannot delete a shared entity' });
    }
    await db.deleteEntity(req.params.id, req.user.id);
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
 * Claude streaming proxy (SSE)
 * Body: { apiKey?: string, ...anthropicPayload }
 * Falls back to CLAUDE_API_KEY env var if apiKey not in body.
 */
app.post('/api/chat/stream', authenticateToken, async (req, res) => {
  const { apiKey: bodyKey, ...body } = req.body;
  const apiKey = (bodyKey && !bodyKey.includes('****')) ? bodyKey : process.env.CLAUDE_API_KEY;
  if (!apiKey) return res.status(401).json({ error: 'Missing apiKey' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream(body);

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ delta: text })}\n\n`);
    });

    stream.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });

    stream.on('error', (err) => {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    });

    req.on('close', () => {
      stream.abort();
    });
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
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
  return process.env.RESEND_FROM_EMAIL || 'Dizon.ai <onboarding@resend.dev>';
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
      subject: '[Dizon.ai] Connection Test',
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
      channelSlack:     !!process.env.SLACK_WEBHOOK_URL,
      channelWhatsapp:  !!(process.env.ULTRAMSG_INSTANCE && process.env.ULTRAMSG_TOKEN && process.env.ULTRAMSG_PHONE),
      channelSms:       false,
      channelEmail:     !!process.env.RESEND_API_KEY,
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
 * GET /api/gcal/status?userId=...
 * Returns { connected: bool, email?: string }
 */
app.get('/api/gcal/status', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

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
app.post('/api/gcal/sync-task', authenticateToken, async (req, res) => {
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
      const tz = timeZone || 'America/Los_Angeles';
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
app.post('/api/gcal/disconnect', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  await db.deleteGcalTokensForUser(userId);
  console.log(`[gcal] Disconnected ${userId}`);
  res.json({ success: true });
});

/**
 * GET /api/gcal/events?userId=...
 * Returns today's calendar events from Google Calendar.
 */
app.get('/api/gcal/events', authenticateToken, async (req, res) => {
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
app.post('/api/calendar/events', authenticateToken, async (req, res) => {
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

// ── Gmail OAuth + Email Intelligence config ──────────────────────────────────

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function makeGmailOAuth2Client() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return new google.auth.OAuth2(clientId, clientSecret, `${getAppUrl()}/api/gmail/callback`);
}

const saveGmailTokens = async (userId, tokens) => {
  if (ENCRYPTION_KEY) {
    const encrypted = encryptTokens(tokens);
    await db.setGmailTokensForUser(userId, { _enc: encrypted });
  } else {
    await db.setGmailTokensForUser(userId, tokens);
  }
};

const loadGmailTokens = async (userId) => {
  const stored = await db.getGmailTokensForUser(userId);
  if (!stored) return null;
  if (stored._enc) return decryptTokens(stored._enc);
  return stored;
};

/**
 * GET /api/gmail/auth-url?userId=...
 * Returns the Google OAuth consent URL for Gmail readonly access.
 */
app.get('/api/gmail/auth-url', (req, res) => {
  const oauth2 = makeGmailOAuth2Client();
  if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)' });

  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId query param required' });

  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    state: userId,
  });
  res.json({ url });
});

/**
 * GET /api/gmail/callback?code=...&state=userId
 * Google redirects here after consent. Exchanges code for tokens and stores them.
 */
app.get('/api/gmail/callback', async (req, res) => {
  const oauth2 = makeGmailOAuth2Client();
  if (!oauth2) return res.status(500).send('Google OAuth not configured');

  const { code, state: userId } = req.query;
  if (!code || !userId) return res.status(400).send('Missing code or state');

  try {
    const { tokens } = await oauth2.getToken(code);
    await saveGmailTokens(userId, tokens);
    console.log(`[gmail] Stored tokens for ${userId}`);
    res.redirect('/?gmail=connected');
  } catch (err) {
    console.error('[gmail] Token exchange failed:', err.message);
    res.status(500).send(`Gmail auth failed: ${err.message}`);
  }
});

/**
 * GET /api/gmail/status?userId=...
 * Returns { connected: bool, email?: string }
 */
app.get('/api/gmail/status', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const tokens = await loadGmailTokens(userId);
  if (!tokens) return res.json({ connected: false });

  const oauth2 = makeGmailOAuth2Client();
  if (!oauth2) return res.json({ connected: false });

  oauth2.setCredentials(tokens);
  oauth2.on('tokens', async (newTokens) => {
    const existing = await loadGmailTokens(userId);
    await saveGmailTokens(userId, { ...existing, ...newTokens });
  });

  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const { data } = await gmail.users.getProfile({ userId: 'me' });
    res.json({ connected: true, email: data.emailAddress });
  } catch (err) {
    console.error('[gmail] status check failed:', err.message);
    await db.deleteGmailTokensForUser(userId);
    res.json({ connected: false });
  }
});

/**
 * DELETE /api/gmail/disconnect?userId=...
 * Removes stored Gmail tokens for the user.
 */
app.delete('/api/gmail/disconnect', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  await db.deleteGmailTokensForUser(userId);
  console.log(`[gmail] Disconnected ${userId}`);
  res.json({ success: true });
});

/**
 * GET /api/gmail/config?userId=...
 * Returns the user's Email Intelligence config.
 */
app.get('/api/gmail/config', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const config = await db.getGmailConfigForUser(userId);
  res.json(config || { vipSenders: [], triggerKeywords: [], commitmentDetection: true, excludedSenders: [], autoExcludeNoreply: true });
});

/**
 * PUT /api/gmail/config
 * Body: { userId, config: { vipSenders, triggerKeywords, commitmentDetection } }
 */
app.put('/api/gmail/config', async (req, res) => {
  const { userId, config } = req.body;
  if (!userId || !config) return res.status(400).json({ error: 'userId and config required' });

  await db.setGmailConfigForUser(userId, config);
  console.log(`[gmail] Saved config for ${userId}`);
  res.json({ success: true });
});

/**
 * POST /api/gmail/scan
 * Scans recent emails, flags VIP/keyword/commitment matches, summarises with Claude,
 * and writes new inbox_items (deduplicated by gmail message ID).
 * Returns { newItems: number }
 */
app.post('/api/gmail/scan', authenticateToken, async (req, res) => {
  const userId = req.user.id;

  const tokens = await loadGmailTokens(userId);
  if (!tokens) return res.status(401).json({ error: 'Gmail not connected' });

  const config = (await db.getGmailConfigForUser(userId)) || { vipSenders: [], triggerKeywords: [], commitmentDetection: true, excludedSenders: [], autoExcludeNoreply: true };
  const { vipSenders, triggerKeywords, commitmentDetection, excludedSenders = [], autoExcludeNoreply = true } = config;

  const oauth2 = makeGmailOAuth2Client();
  if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured' });

  oauth2.setCredentials(tokens);
  oauth2.on('tokens', async (newTokens) => {
    const existing = await loadGmailTokens(userId);
    await saveGmailTokens(userId, { ...existing, ...newTokens });
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  try {
    // ── Fetch inbox messages ──
    const inboxList = await gmail.users.messages.list({ userId: 'me', maxResults: 50, q: 'in:inbox' });
    const inboxIds = (inboxList.data.messages || []).map((m) => m.id);

    const inboxMessages = await Promise.all(
      inboxIds.map((id) =>
        gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
          .then((r) => r.data)
          .catch(() => null),
      ),
    );

    // ── Fetch sent messages (if commitment detection) ──
    let sentMessages = [];
    if (commitmentDetection) {
      const sentList = await gmail.users.messages.list({ userId: 'me', maxResults: 20, q: 'in:sent' });
      const sentIds = (sentList.data.messages || []).map((m) => m.id);
      sentMessages = await Promise.all(
        sentIds.map((id) =>
          gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['To', 'Subject', 'Date'] })
            .then((r) => r.data)
            .catch(() => null),
        ),
      );
    }

    // ── Helper: extract header value ──
    const getHeader = (msg, name) => {
      const h = (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
      return h ? h.value : '';
    };

    // ── Flag inbox messages ──
    const flagged = [];

    const NOREPLY_PATTERN = /noreply|no-reply|donotreply|do-not-reply|notifications@|mailer@/i;

    for (const msg of inboxMessages) {
      if (!msg) continue;
      const from = getHeader(msg, 'From').toLowerCase();
      const subject = getHeader(msg, 'Subject');
      const snippet = msg.snippet || '';
      const searchText = `${subject} ${snippet}`.toLowerCase();

      // Skip excluded senders
      if (autoExcludeNoreply && NOREPLY_PATTERN.test(from)) continue;
      const isExcluded = excludedSenders.some((ex) => {
        const el = ex.toLowerCase();
        return el.startsWith('@') ? from.includes(el) : from.includes(el);
      });
      if (isExcluded) continue;

      // Check VIP
      const isVip = vipSenders.some((v) => {
        const vl = v.toLowerCase();
        return vl.startsWith('@') ? from.includes(vl) : from.includes(vl);
      });

      // Check keywords
      const matchedKeyword = triggerKeywords.find((kw) => searchText.includes(kw.toLowerCase()));

      if (isVip) {
        flagged.push({ msg, type: 'VIP', reason: `From VIP sender: ${getHeader(msg, 'From')}` });
      } else if (matchedKeyword) {
        flagged.push({ msg, type: 'KEYWORD', reason: `Contains keyword: "${matchedKeyword}"` });
      }
    }

    // ── Flag sent messages for commitments ──
    const commitmentPattern = /\bI'll\b|\bI will\b|\bsending over\b|\bI can have\b|\bI'll get\b|\bwill send\b|\bI promise\b/i;

    if (commitmentDetection) {
      for (const msg of sentMessages) {
        if (!msg) continue;
        const snippet = msg.snippet || '';
        if (commitmentPattern.test(snippet)) {
          flagged.push({ msg, type: 'COMMITMENT', reason: `Commitment detected in sent email` });
        }
      }
    }

    // ── Deduplicate against existing inbox items ──
    const newFlagged = [];
    for (const f of flagged) {
      const exists = await db.inboxItemExistsBySourceId(userId, f.msg.id);
      if (!exists) newFlagged.push(f);
    }

    if (newFlagged.length === 0) {
      return res.json({ newItems: 0 });
    }

    // ── Summarise with Claude (in chunks of 10) ──
    const apiKey = process.env.CLAUDE_API_KEY;
    const chunks = [];
    for (let i = 0; i < newFlagged.length; i += 10) {
      chunks.push(newFlagged.slice(i, i + 10));
    }

    let newCount = 0;
    for (const chunk of chunks) {
      const summaries = await Promise.allSettled(
        chunk.map(async (f) => {
          const subject = getHeader(f.msg, 'Subject');
          const snippet = f.msg.snippet || '';
          let summary = `${subject} — ${snippet}`.slice(0, 200);

          if (apiKey) {
            try {
              const resp = await axios.post(
                'https://api.anthropic.com/v1/messages',
                {
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 150,
                  messages: [{
                    role: 'user',
                    content: `Summarize this email in exactly 2 sentences. Subject: "${subject}". Preview: "${snippet}". Flagged as ${f.type} because: ${f.reason}. Return only the summary, nothing else.`,
                  }],
                },
                {
                  headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
                  timeout: 15_000,
                },
              );
              const text = resp.data?.content?.[0]?.text;
              if (text) summary = text.trim();
            } catch (err) {
              console.error(`[gmail-scan] Claude summary failed for ${f.msg.id}:`, err.message);
            }
          }

          return { ...f, summary };
        }),
      );

      for (const result of summaries) {
        if (result.status !== 'fulfilled') continue;
        const f = result.value;
        const subject = getHeader(f.msg, 'Subject');
        const id = `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

        await db.createInboxItem({
          id,
          userId,
          type: f.type,
          title: subject || '(no subject)',
          summary: f.summary,
          source: 'gmail',
          sourceId: f.msg.id,
          gmailThreadId: f.msg.threadId || null,
          gmailLink: `https://mail.google.com/mail/u/0/#inbox/${f.msg.id}`,
          sender: f.type !== 'COMMITMENT' ? getHeader(f.msg, 'From') : null,
        });
        newCount++;
      }
    }

    console.log(`[gmail-scan] ${newCount} new items for ${userId}`);
    res.json({ newItems: newCount });
  } catch (err) {
    console.error('[gmail-scan] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/inbox/items
 * Returns all inbox_items for the authenticated user.
 */
app.get('/api/inbox/items', authenticateToken, async (req, res) => {
  try {
    const items = await db.getInboxItemsForUser(req.user.id);
    res.json(items);
  } catch (err) {
    console.error('[inbox] fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/inbox/items/:id
 * Body: { action } — e.g. 'dismissed'
 * Sets action_taken on the inbox item.
 */
app.patch('/api/inbox/items/:id', authenticateToken, async (req, res) => {
  const { action } = req.body;
  if (!action) return res.status(400).json({ error: 'action required' });

  try {
    await db.updateInboxItemAction(req.params.id, action);
    res.json({ success: true });
  } catch (err) {
    console.error('[inbox] action update failed:', err.message);
    res.status(500).json({ error: err.message });
  }
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
    const results = await Promise.all(
      tasks.map((task) => db.upsertTask({ ...task, userId: req.user.id }))
    );
    return res.json({ success: true, count: results.length });
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

// Note: All /api/notes routes (GET/POST/PUT/DELETE) are defined in the notes section below

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

// ── Chat Conversations ──────────────────────────────────────────────────────

app.get('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const conversations = await db.getConversations(req.user.id);
    return res.json(conversations);
  } catch (err) {
    console.error('[conversations] list failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/conversations', authenticateToken, async (req, res) => {
  try {
    const { model } = req.body;
    const conv = await db.createConversation(req.user.id, model || 'claude');
    return res.json(conv);
  } catch (err) {
    console.error('[conversations] create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/conversations/:id', authenticateToken, async (req, res) => {
  try {
    await db.deleteConversation(parseInt(req.params.id), req.user.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[conversations] delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/conversations/:id', authenticateToken, async (req, res) => {
  try {
    const { title } = req.body;
    const updated = await db.updateConversationTitle(parseInt(req.params.id), req.user.id, title);
    if (!updated) return res.status(404).json({ error: 'Conversation not found' });
    return res.json(updated);
  } catch (err) {
    console.error('[conversations] update failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
  try {
    const messages = await db.getConversationMessages(parseInt(req.params.id), req.user.id);
    return res.json(messages);
  } catch (err) {
    console.error('[conversations] messages read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
  try {
    const { role, content, model } = req.body;
    if (!role || !content) return res.status(400).json({ error: 'role and content are required' });
    const msg = await db.addConversationMessage(parseInt(req.params.id), req.user.id, role, content, model);
    return res.json(msg);
  } catch (err) {
    console.error('[conversations] message save failed:', err.message);
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
    const record = await db.pool.query('SELECT * FROM financial_accounts WHERE id = $1', [req.params.id]).then(r => r.rows[0]);
    if (!record) return res.status(404).json({ error: 'Account not found' });
    if (!requireOwnership(record, req)) {
      return res.status(403).json({ error: 'Access denied' });
    }
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
    const record = await db.pool.query('SELECT * FROM financial_accounts WHERE id = $1', [req.params.id]).then(r => r.rows[0]);
    if (!record) return res.status(404).json({ error: 'Account not found' });
    if (!requireOwnership(record, req)) {
      return res.status(403).json({ error: 'Access denied' });
    }
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
    const { rows } = await db.pool.query('SELECT * FROM financial_transactions WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    if (!requireOwnership(rows[0], req)) return res.status(403).json({ error: 'Access denied' });
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
    const { rows } = await db.pool.query('SELECT * FROM financial_transactions WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    if (!requireOwnership(rows[0], req)) return res.status(403).json({ error: 'Access denied' });
    await db.deleteTransaction(req.params.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[financial] transaction delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── File Import (CSV, Excel, PDF) ─────────────────────────────────────────────

function splitCSVRow(line) {
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

function isValidDateField(val) {
  if (!val) return false;
  const s = String(val).trim();
  return /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s);
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  // Scan for the real header row: first row containing both "date" and "description" (case-insensitive)
  let headerIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('date') && lower.includes('description')) {
      headerIdx = i;
      break;
    }
  }

  const headers = splitCSVRow(lines[headerIdx]);
  const rows = lines.slice(headerIdx + 1)
    .map(splitCSVRow)
    .filter((r) => r.length >= 2)
    // Skip rows where the first column is not a valid date (summary/footer rows)
    .filter((r) => isValidDateField(r[0]));
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

  // Strip commas from dollar amounts (e.g. "23,110.70" → "23110.70") before parsing
  const cleanedAmount = amountStr.replace(/,/g, '').replace(/[^0-9.\-]/g, '');
  const amount = Math.abs(parseFloat(cleanedAmount) || 0);
  const isCredit = parseFloat(cleanedAmount) > 0;

  return { date, description, amount, type: isCredit ? 'credit' : 'debit', category };
}

function excelSerialToDate(serial) {
  if (typeof serial === 'number' && serial > 25000 && serial < 60000) {
    const utcDays = Math.floor(serial - 25569);
    const d = new Date(utcDays * 86400 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
}

function looksLikeDate(val) {
  if (!val) return false;
  const s = String(val).trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
  // MM/DD/YYYY or MM/DD/YY
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(s)) return true;
  // Excel serial number
  const n = Number(s);
  if (!isNaN(n) && n > 25000 && n < 60000) return true;
  return false;
}

function parseExcelToRows(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const jsonRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (jsonRows.length < 2) return { headers: [], rows: [] };

  // Find the header row — first row where at least 2 cells look like headers
  let headerIdx = 0;
  for (let i = 0; i < Math.min(jsonRows.length, 10); i++) {
    const row = jsonRows[i].map((c) => String(c).toLowerCase().replace(/[^a-z]/g, ''));
    const headerish = row.filter((c) => ['date', 'description', 'amount', 'balance', 'runningbal', 'memo', 'category', 'type', 'transactiondate', 'postdate', 'reference'].some((h) => c.includes(h)));
    if (headerish.length >= 2) { headerIdx = i; break; }
  }

  const headers = jsonRows[headerIdx].map(String);
  const dataRows = jsonRows.slice(headerIdx + 1);

  // Convert rows, handling Excel serial dates and filtering non-data rows
  const rows = dataRows
    .map((r) => {
      return r.map((cell, colIdx) => {
        // Check if this column is the date column
        const hdr = headers[colIdx]?.toLowerCase().replace(/[^a-z]/g, '') || '';
        if (hdr.includes('date') && typeof cell === 'number') {
          const converted = excelSerialToDate(cell);
          if (converted) return converted;
        }
        return String(cell);
      });
    })
    .filter((r) => {
      // Filter: must have at least a date-like value in the row
      return r.some((c) => looksLikeDate(c)) && r.some((c) => c.trim());
    });

  return { headers, rows };
}

function parsePDFTextLocally(text) {
  // Split PDF text into lines and find the header row containing "Date" and "Description"
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const transactions = [];

  // Strategy 1: Look for tabular data with a header row
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('date') && lower.includes('description')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx >= 0) {
    // Parse rows after the header using CSV-style splitting
    const headers = splitCSVRow(lines[headerIdx]);
    const format = detectCSVFormat(headers);
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const row = splitCSVRow(lines[i]);
      if (row.length < 2) continue;
      if (!isValidDateField(row[0])) continue;
      const mapped = mapCSVRow(format, headers, row);
      if (mapped.date && mapped.amount > 0) {
        transactions.push(mapped);
      }
    }
    if (transactions.length > 0) return transactions;
  }

  // Strategy 2: Scan every line for date-prefixed transaction patterns
  // Matches lines like: "01/15/2025  AMAZON.COM   -45.99" or "01/15/2025  DEPOSIT  1,234.56"
  const txnPattern = /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+([-]?\$?[\d,]+\.\d{2})\s*$/;
  for (const line of lines) {
    const match = line.trim().match(txnPattern);
    if (!match) continue;
    let [, dateStr, description, amountStr] = match;
    // Normalize date
    const parts = dateStr.split('/');
    if (parts.length === 3) {
      const [m, d, y] = parts;
      const year = y.length === 2 ? '20' + y : y;
      dateStr = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    const cleanedAmt = amountStr.replace(/[$,]/g, '');
    const amount = Math.abs(parseFloat(cleanedAmt) || 0);
    if (amount > 0) {
      transactions.push({
        date: dateStr,
        description: description.trim(),
        amount,
        type: parseFloat(cleanedAmt) > 0 ? 'credit' : 'debit',
        category: 'Uncategorized',
      });
    }
  }

  return transactions;
}

async function parsePDFWithClaude(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const pdfData = await pdfParse(buffer);
  const text = pdfData.text;

  if (!text || text.trim().length < 20) {
    throw new Error('Could not extract readable text from PDF. The file may be image-based or empty.');
  }

  // Try local text-based parsing first (no API key needed)
  const localResults = parsePDFTextLocally(text);
  if (localResults.length > 0) {
    return localResults;
  }

  // Fall back to Claude API if local parsing found nothing
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('No transactions could be parsed from the PDF text locally, and CLAUDE_API_KEY is not set for AI-assisted parsing. Please try a CSV or Excel export instead.');
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

// ── Notes ─────────────────────────────────────────────────────────────────────

app.get('/api/notes', authenticateToken, async (req, res) => {
  try {
    // Seed categories on first note-related API call
    await db.seedNoteCategoriesIfEmpty(req.user.id);
    const filters = {};
    if (req.query.pillar) filters.pillar = req.query.pillar;
    if (req.query.entityId) filters.entityId = req.query.entityId;
    if (req.query.category) filters.category = req.query.category;
    if (req.query.archived) filters.archived = req.query.archived === 'true';
    if (req.query.pinned) filters.pinned = req.query.pinned === 'true';
    const notes = await db.getNotesForUser(req.user.id, filters);
    return res.json(notes);
  } catch (err) {
    console.error('[notes] read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/notes', authenticateToken, async (req, res) => {
  try {
    const { title, content, type, pillar, category, subcategory, tags, entityId } = req.body;
    const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const note = await db.createNote({
      id, userId: req.user.id, title, content, type, pillar, category, subcategory, tags, entityId,
    });
    return res.json(note);
  } catch (err) {
    console.error('[notes] create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/notes/:id', authenticateToken, async (req, res) => {
  try {
    const note = await db.getNoteById(req.params.id, req.user.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!requireOwnership(note, req)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const updated = await db.updateNote(req.params.id, req.user.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Note not found' });
    return res.json(updated);
  } catch (err) {
    console.error('[notes] update failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notes/:id', authenticateToken, async (req, res) => {
  try {
    const note = await db.getNoteById(req.params.id, req.user.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!requireOwnership(note, req)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    await db.deleteNote(req.params.id, req.user.id);
    return res.json({ success: true });
  } catch (err) {
    console.error('[notes] delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.put('/api/notes/:id/pin', authenticateToken, async (req, res) => {
  try {
    const note = await db.getNoteById(req.params.id, req.user.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (!requireOwnership(note, req)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    const updated = await db.updateNote(req.params.id, req.user.id, { pinned: !note.pinned });
    return res.json(updated);
  } catch (err) {
    console.error('[notes] pin toggle failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/notes/categories', authenticateToken, async (req, res) => {
  try {
    await db.seedNoteCategoriesIfEmpty(req.user.id);
    const cats = await db.getNoteCategories(req.user.id);
    return res.json(cats);
  } catch (err) {
    console.error('[notes] categories read failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/notes/categories', authenticateToken, async (req, res) => {
  try {
    const { name, parentId, pillar, color } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = `ncat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const cat = await db.createNoteCategory({ id, userId: req.user.id, name, parentId, pillar, color });
    return res.json(cat);
  } catch (err) {
    console.error('[notes] category create failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/notes/:id/suggest-pillar', authenticateToken, async (req, res) => {
  try {
    const { content, apiKey: bodyKey } = req.body;
    if (!content || content.trim().split(/\s+/).length < 10) {
      return res.json({ pillar: null, category: null, confidence: 0 });
    }
    const apiKey = (bodyKey && !bodyKey.includes('****')) ? bodyKey : process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

    const prompt = `Based on this note content, suggest the most appropriate pillar and category.
Pillars: hustle, home, move, grow
Categories:
  hustle → Careific, Rose Motors, Buyflip, Care Homes, AutoVision, General Business
  home → Family, Liz, Kids, Personal
  move → Workouts, Health, Nutrition, Recovery
  grow → Ideas, Journal, Learnings, Goals, Braindump

Note content: ${content.slice(0, 500)}

Respond in JSON only:
{"pillar": "hustle", "category": "Careific", "confidence": 0.95, "reason": "Mentions MVP and TestFlight"}`;

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 30000,
      },
    );

    const text = response.data?.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return res.json({
        pillar: parsed.pillar || null,
        category: parsed.category || null,
        confidence: parseFloat(parsed.confidence) || 0,
        reason: parsed.reason || '',
      });
    }
    return res.json({ pillar: null, category: null, confidence: 0 });
  } catch (err) {
    console.error('[notes] suggest-pillar failed:', err.message);
    return res.json({ pillar: null, category: null, confidence: 0 });
  }
});

// ── Note Images ──────────────────────────────────────────────────────────────

app.get('/api/notes/:id/images', authenticateToken, async (req, res) => {
  try {
    const images = await db.getNoteImages(req.params.id, req.user.id);
    return res.json(images);
  } catch (err) {
    console.error('[notes] images list failed:', err.message);
    return res.json([]);
  }
});

app.post('/api/notes/:id/images', authenticateToken, imageUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    const noteId = req.params.id;
    // Verify note belongs to user
    const note = await db.getNoteById(noteId, req.user.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });

    const imageId = `nimg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const filename = `${imageId}.${ext}`;

    // Try filesystem storage first (Railway volume), fall back to base64 in DB
    const uploadDir = path.join(__dirname, 'uploads', 'notes', req.user.id, noteId);
    let url;
    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(path.join(uploadDir, filename), req.file.buffer);
      url = `/uploads/notes/${req.user.id}/${noteId}/${filename}`;
    } catch {
      // Fallback: store as data URI (base64)
      const base64 = req.file.buffer.toString('base64');
      url = `data:${req.file.mimetype};base64,${base64}`;
    }

    const image = await db.createNoteImage({
      id: imageId, noteId, userId: req.user.id,
      filename, originalName: req.file.originalname,
      mimeType: req.file.mimetype, size: req.file.size, url,
    });
    return res.json(image);
  } catch (err) {
    console.error('[notes] image upload failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/notes/:id/images/:imageId', authenticateToken, async (req, res) => {
  try {
    const deleted = await db.deleteNoteImage(req.params.imageId, req.user.id);
    if (deleted && deleted.url && !deleted.url.startsWith('data:')) {
      // Try to remove file from disk
      const filePath = path.join(__dirname, deleted.url);
      try { fs.unlinkSync(filePath); } catch {}
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[notes] image delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Note Search ──────────────────────────────────────────────────────────────

app.get('/api/notes/search', authenticateToken, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    const results = await db.searchNotes(req.user.id, q);
    return res.json(results);
  } catch (err) {
    console.error('[notes] search failed:', err.message);
    return res.json([]);
  }
});

// ── Daily Digest ─────────────────────────────────────────────────────────────

app.post('/api/notes/daily-digest', authenticateToken, async (req, res) => {
  try {
    const todayPST = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const today = todayPST;
    const forceRegen = req.body.force === true;

    // Check if digest already exists for today (skip if force regenerate)
    const notes = await db.getNotesForUser(req.user.id);
    const existing = notes.find((n) => n.type === 'digest' && n.createdAt && new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(n.createdAt)) === today);
    if (existing && !forceRegen) return res.json(existing);
    if (existing && forceRegen) await db.deleteNote(existing.id, req.user.id);

    // Gather context for the AI
    const tasks = await db.getTasks(req.user.id);
    const activeTasks = (Array.isArray(tasks) ? tasks : []).filter((t) => !t.completed);
    const recentNotes = notes.slice(0, 10);

    const apiKey = req.body.apiKey || process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      // No API key — create a simple summary without AI
      const overdue = activeTasks.filter((t) => t.dueDate && t.dueDate < today).length;
      const high = activeTasks.filter((t) => t.priority === 'high').length;
      const content = `**Daily Summary — ${today}**\n\nYou have ${activeTasks.length} active tasks${overdue > 0 ? `, ${overdue} overdue` : ''}${high > 0 ? `, ${high} high priority` : ''}.\n\nStay focused and tackle the most important items first.`;
      const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const digest = await db.createNote({
        id, userId: req.user.id, title: `Daily Digest — ${today}`, content, type: 'digest', pillar: 'grow',
      });
      return res.json(digest);
    }

    // Build AI prompt
    const taskSummary = activeTasks.slice(0, 15).map((t) =>
      `- [${t.priority}] ${t.title}${t.dueDate ? ` (due: ${t.dueDate})` : ''}`
    ).join('\n');
    const noteSummary = recentNotes.slice(0, 5).map((n) =>
      `- ${n.title || '(untitled)'}: ${(n.content || '').slice(0, 80)}`
    ).join('\n');

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 512,
        system: 'You are a concise personal productivity assistant. Write a brief daily digest (3-5 short paragraphs) summarizing priorities, flagging overdue items, and offering one actionable tip. Use markdown formatting. Be warm but direct.',
        messages: [{
          role: 'user',
          content: `Today is ${today}. Here are my active tasks:\n${taskSummary || '(none)'}\n\nRecent notes:\n${noteSummary || '(none)'}\n\nWrite my daily digest.`,
        }],
      },
      {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 30_000,
      },
    );

    const aiContent = response.data.content?.[0]?.text || 'No digest could be generated.';
    const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const digest = await db.createNote({
      id, userId: req.user.id, title: `Daily Digest — ${today}`, content: aiContent, type: 'digest', pillar: 'grow',
    });
    return res.json(digest);
  } catch (err) {
    console.error('[digest] generation failed:', err.message);
    return res.json({ digest: null });
  }
});

// ── Dashboard AI Brief (persona-aware) ────────────────────────────────────────

app.post('/api/dashboard/aria-brief', authenticateToken, async (req, res) => {
  try {
    const apiKey = req.body.apiKey || process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.json({ brief: '' });

    const { assistantName, persona, userName, timeOfDay, data } = req.body;

    const personaTones = {
      executive_assistant: 'warm and professional',
      coo: 'direct and strategic',
      best_friend: 'casual and real',
      life_coach: 'motivating and big-picture focused',
      cfo: 'numbers-first and analytical',
    };
    const tone = personaTones[persona] || personaTones.executive_assistant;
    const name = assistantName || 'Aria';

    const systemPrompt = `You are ${name}, the user's ${persona === 'best_friend' ? 'best friend' : persona === 'executive_assistant' ? 'executive assistant' : persona === 'coo' ? 'COO' : persona === 'life_coach' ? 'life coach' : 'CFO'}. Write a warm, ${tone} ${timeOfDay || 'morning'} brief for ${userName} in 2-3 sentences. Be specific — reference actual data below. Do not use bullet points. Write naturally like a real person. Sign off with just your name: — ${name}`;

    const dataStr = `Overdue tasks: ${data.overdue || 'None'}\nHigh priority tasks: ${data.highPriority || 'None'}\nToday's calendar events: ${data.events || 'None'}\nRecent transactions: ${data.transactions || 'None'}\nNotes this week: ${data.notesCount || 0}\nBusinesses: ${data.entities || 'None'}`;

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Write my ${timeOfDay || 'morning'} brief.\n\n${dataStr}` }],
      },
      {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 15_000,
      },
    );

    const brief = response.data.content?.[0]?.text || '';
    return res.json({ brief });
  } catch (err) {
    console.error('[aria-brief] failed:', err.message);
    return res.json({ brief: '' });
  }
});

// ── Dashboard Timeline Summary ────────────────────────────────────────────────

app.post('/api/dashboard/timeline-summary', authenticateToken, async (req, res) => {
  try {
    const apiKey = req.body.apiKey || process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.json({ summary: '' });

    const { events, tasks } = req.body;
    const eventsStr = (events || []).map((e) => `${e.time || 'All day'}: ${e.title}`).join(', ') || 'None';
    const tasksStr = (tasks || []).map((t) => `${t.title} (${t.priority}${t.overdue ? ', overdue' : ''})`).join(', ') || 'None';

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 60,
        system: 'Write ONE sentence summarizing this person\'s day. Be specific and actionable. Max 15 words. No quotes.',
        messages: [{
          role: 'user',
          content: `Today's calendar events: ${eventsStr}\nToday's tasks: ${tasksStr}\n\nSummarize the day in one sentence.`,
        }],
      },
      {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        timeout: 15_000,
      },
    );

    const summary = response.data.content?.[0]?.text || '';
    return res.json({ summary });
  } catch (err) {
    console.error('[timeline-summary] failed:', err.message);
    return res.json({ summary: '' });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', port: PORT, time: new Date().toISOString() }),
);

// ── Serve React app from dist/ (production) ──────────────────────────────────

// Serve uploaded images
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback: any non-API route serves index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  console.log('[static] Serving React build from dist/');
}

// ── Alerts ────────────────────────────────────────────────────────────────────

app.post('/api/alerts/morning', authenticateToken, async (req, res) => {
  try {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    const ultraInstance = process.env.ULTRAMSG_INSTANCE;
    const ultraToken = process.env.ULTRAMSG_TOKEN;
    const ultraPhone = process.env.ULTRAMSG_PHONE;
    if (!webhookUrl && !ultraInstance) return res.status(500).json({ error: 'No messaging channels configured (SLACK_WEBHOOK_URL or ULTRAMSG_INSTANCE)' });

    const user = await db.getUserById(req.user.id);
    const userEntities = (user?.entityIds || []);
    const tasks = await db.getTasksForUser(req.user.id, userEntities);

    const todayStr = new Date().toISOString().slice(0, 10);
    const overdue = tasks.filter((t) => !t.completed && t.dueDate && t.dueDate < todayStr);
    const todayTasks = tasks.filter((t) => !t.completed && t.dueDate === todayStr);
    const highPriority = tasks.filter((t) => !t.completed && t.priority === 'high');

    // Fetch calendar events for today
    let calendarEvents = [];
    try {
      const tokens = await loadGcalTokens(req.user.id);
      if (tokens) {
        const oauth2 = makeOAuth2Client();
        if (oauth2) {
          oauth2.setCredentials(tokens);
          const calendar = google.calendar({ version: 'v3', auth: oauth2 });
          const now = new Date();
          const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          const endOfDay = new Date(startOfDay);
          endOfDay.setDate(endOfDay.getDate() + 1);
          const { data } = await calendar.events.list({
            calendarId: 'primary',
            timeMin: startOfDay.toISOString(),
            timeMax: endOfDay.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 20,
          });
          calendarEvents = (data.items || []).map((ev) => ({
            title: (ev.summary || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
            start: ev.start?.dateTime || ev.start?.date || '',
          }));
        }
      }
    } catch (calErr) {
      console.error('[morning-brief] calendar fetch failed:', calErr.message);
    }

    // Format date
    const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    // Build message
    const lines = [`☀️ Good morning ${user?.displayName || 'Lyle'} — ${dateLabel}\n`];

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

    lines.push('');
    lines.push(`🔥 High priority: ${highPriority.length}`);

    const text = lines.join('\n');

    // Fire Slack + WhatsApp in parallel
    const channels = [];

    if (webhookUrl) {
      channels.push(
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        }).then(async (r) => {
          if (!r.ok) throw new Error(`Slack ${r.status}: ${await r.text()}`);
          return 'Slack';
        })
      );
    }

    if (ultraInstance && ultraToken && ultraPhone) {
      channels.push(
        fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: ultraToken, to: ultraPhone, body: text }),
        }).then(async (r) => {
          if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${await r.text()}`);
          return 'WhatsApp';
        })
      );
    }

    const results = await Promise.allSettled(channels);
    const sent = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
    failed.forEach((msg) => console.error('[morning-brief]', msg));

    if (sent.length === 0) return res.status(502).json({ error: `All channels failed: ${failed.join('; ')}` });
    return res.json({ success: true, message: `Morning brief sent to ${sent.join(', ')}${failed.length ? ` (failed: ${failed.join(', ')})` : ''}` });
  } catch (err) {
    console.error('[morning-brief] failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/alerts/fire', authenticateToken, async (req, res) => {
  try {
    const { message, channels = {}, recipientEmail } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const webhookUrl    = process.env.SLACK_WEBHOOK_URL;
    const ultraInstance = process.env.ULTRAMSG_INSTANCE;
    const ultraToken    = process.env.ULTRAMSG_TOKEN;
    const ultraPhone    = process.env.ULTRAMSG_PHONE;

    const sends = [];

    if (channels.slack && webhookUrl) {
      sends.push(
        fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message }),
        }).then(async (r) => {
          if (!r.ok) throw new Error(`Slack ${r.status}`);
          return 'Slack';
        })
      );
    }

    if (channels.whatsapp && ultraInstance && ultraToken && ultraPhone) {
      sends.push(
        fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: ultraToken, to: ultraPhone, body: message }),
        }).then(async (r) => {
          if (!r.ok) throw new Error(`WhatsApp ${r.status}`);
          return 'WhatsApp';
        })
      );
    }

    if (channels.email && recipientEmail) {
      const resend = getResendClient();
      if (resend) {
        sends.push(
          resend.emails.send({
            from: getFromEmail(),
            to: recipientEmail,
            subject: '[Dizon.ai] Alert',
            text: message,
          }).then(() => 'Email')
        );
      }
    }

    const skipped = [];
    if (channels.sms) {
      console.log('[SMS] not implemented — skipping');
      skipped.push('SMS');
    }

    const results = await Promise.allSettled(sends);
    const sent   = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);

    return res.json({ sent, failed, skipped });
  } catch (err) {
    console.error('[alerts/fire]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/config/status', authenticateToken, (req, res) => {
  res.json({
    slack:    !!process.env.SLACK_WEBHOOK_URL,
    whatsapp: !!(process.env.ULTRAMSG_INSTANCE && process.env.ULTRAMSG_TOKEN && process.env.ULTRAMSG_PHONE),
    sms:      false,
    email:    !!process.env.RESEND_API_KEY,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  // Initialise database tables, seed data, and run migrations
  await db.initTables();
  await db.seedUsersIfEmpty();
  try {
    await db.runMigrations();
  } catch (err) {
    console.error('[migration] Error (non-fatal):', err.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✓ Dizon.ai server running at http://localhost:${PORT}`);
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
