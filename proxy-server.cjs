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
const { ARIA_TOOLS, executeTool } = require('./server/tools.cjs');

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

const { JWT_SECRET, authenticateToken, requireAdmin, requireOwnership } = require('./server/middleware/auth.cjs');

// ── Token encryption helpers ────────────────────────────────────────────────
const { encrypt, decrypt, encryptTokens, decryptTokens, ENCRYPTION_KEY } = require('./server/utils/crypto.cjs');

// Google/GCal/Gmail utils (token load/save accept db as parameter)
const { getAppUrl, makeOAuth2Client, makeGmailOAuth2Client, saveGcalTokens: _saveGcalTokens, loadGcalTokens: _loadGcalTokens, saveGmailTokens: _saveGmailTokens, loadGmailTokens: _loadGmailTokens } = require('./server/utils/google.cjs');
// Bind db for convenience in this file
const saveGcalTokens = (userId, tokens) => _saveGcalTokens(userId, tokens, db);
const loadGcalTokens = (userId) => _loadGcalTokens(userId, db);
const saveGmailTokens = (userId, tokens) => _saveGmailTokens(userId, tokens, db);
const loadGmailTokens = (userId) => _loadGmailTokens(userId, db);

const { authLimiter, apiLimiter } = require('./server/middleware/rateLimit.cjs');

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


// ── Auth routes (extracted to server/routes/auth.cjs) ────────────────────────
const authRouter = require('./server/routes/auth.cjs')({ authenticateToken, JWT_SECRET, db });
app.use('/', authRouter);

// ── User routes (extracted to server/routes/users.cjs) ───────────────────────
const usersRouter = require('./server/routes/users.cjs')({ authenticateToken, requireAdmin, db });
app.use('/', usersRouter);

// ── Entity routes (extracted to server/routes/entities.cjs) ──────────────────
const entitiesRouter = require('./server/routes/entities.cjs')({ authenticateToken, requireAdmin, db });
app.use('/', entitiesRouter);

// ── AI proxy routes (extracted to server/routes/ai.cjs) ───────────────────────
const aiRouter = require('./server/routes/ai.cjs')({ authenticateToken, db, loadGcalTokens, makeOAuth2Client, google });
app.use('/', aiRouter);

// ── Email routes (extracted to server/routes/email.cjs) ───────────────────────
const { getResendClient, getFromEmail } = require('./server/utils/email.cjs');
const emailRouter = require('./server/routes/email.cjs')({});
app.use('/', emailRouter);

// ── Settings routes (extracted to server/routes/settings.cjs) ────────────────
const settingsRouter = require('./server/routes/settings.cjs')({ db });
app.use('/', settingsRouter);

// ── Google Calendar routes (extracted to server/routes/gcal.cjs) ──────────────
const gcalRouter = require('./server/routes/gcal.cjs')({ authenticateToken, db, makeOAuth2Client, saveGcalTokens, loadGcalTokens, google });
app.use('/', gcalRouter);

// ── Gmail routes (extracted to server/routes/gmail.cjs) ───────────────────────
const gmailRouter = require('./server/routes/gmail.cjs')({ authenticateToken, db, makeGmailOAuth2Client, saveGmailTokens, loadGmailTokens, google });
app.use('/', gmailRouter);

// ── Inbox routes (extracted to server/routes/inbox.cjs) ───────────────────────
const inboxRouter = require('./server/routes/inbox.cjs')({ authenticateToken, db });
app.use('/', inboxRouter);

// ── Task persistence (extracted to server/routes/tasks.cjs) ───────────────────
const tasksRouter = require('./server/routes/tasks.cjs')({ authenticateToken, db });
app.use('/', tasksRouter);

const notesRouter = require('./server/routes/notes.cjs')({ authenticateToken, requireOwnership, db, imageUpload });
app.use('/', notesRouter);

// ── User preferences (extracted to server/routes/preferences.cjs) ────────────
const preferencesRouter = require('./server/routes/preferences.cjs')({ authenticateToken, db });
app.use('/', preferencesRouter);

// ── Chat routes (extracted to server/routes/chat.cjs) ─────────────────────────
const chatRouter = require('./server/routes/chat.cjs')({ authenticateToken, db });
app.use('/', chatRouter);

// ── Financial routes (extracted to server/routes/financial.cjs) ───────────────
const financialRouter = require('./server/routes/financial.cjs')({ authenticateToken, requireOwnership, db });
app.use('/', financialRouter);

// ── Dashboard routes (extracted to server/routes/dashboard.cjs) ───────────────
const dashboardRouter = require('./server/routes/dashboard.cjs')({ authenticateToken, db });
app.use('/', dashboardRouter);

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

// ── Alerts routes (extracted to server/routes/alerts.cjs) ─────────────────────
const alertsRouter = require('./server/routes/alerts.cjs')({ authenticateToken, db, loadGcalTokens, makeOAuth2Client, google });
app.use('/', alertsRouter);

// ── WhatsApp routes (extracted to server/routes/whatsapp.cjs) ────────────────
const whatsappRouter = require('./server/routes/whatsapp.cjs')({ db, loadGcalTokens, makeOAuth2Client, google });
app.use('/', whatsappRouter);

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
