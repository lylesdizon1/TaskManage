/**
 * proxy-server.cjs — Dizon.ai entry point
 * Start with: node proxy-server.cjs
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const { google } = require('googleapis');
const fs       = require('fs');
const path     = require('path');
const multer   = require('multer');
const db       = require('./db.cjs');

// ── Utils & middleware ───────────────────────────────────────────────────────
const { JWT_SECRET, authenticateToken, requireAdmin, requireSuperAdmin, requireOwnership, setDb } = require('./server/middleware/auth.cjs');
setDb(db);
const { authLimiter, apiLimiter } = require('./server/middleware/rateLimit.cjs');
const { makeOAuth2Client, makeGmailOAuth2Client, saveGcalTokens: _saveGcalTokens, loadGcalTokens: _loadGcalTokens, saveGmailTokens: _saveGmailTokens, loadGmailTokens: _loadGmailTokens } = require('./server/utils/google.cjs');

const saveGcalTokens  = (userId, tokens) => _saveGcalTokens(userId, tokens, db);
const loadGcalTokens  = (userId) => _loadGcalTokens(userId, db);
const saveGmailTokens = (userId, tokens) => _saveGmailTokens(userId, tokens, db);
const loadGmailTokens = (userId) => _loadGmailTokens(userId, db);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)
      ? cb(null, true) : cb(new Error('Only jpeg, png, gif, webp images are allowed'));
  },
});

// ── Express app ──────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3001;
const DIST_DIR = path.join(__dirname, 'dist');

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '4mb' }));
app.use('/api/auth/login', authLimiter);
app.use('/api/', apiLimiter);
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

// ── Route mounts ─────────────────────────────────────────────────────────────
app.use('/', require('./server/routes/auth.cjs')({ authenticateToken, JWT_SECRET, db }));
app.use('/', require('./server/routes/users.cjs')({ authenticateToken, requireAdmin, db }));
app.use('/', require('./server/routes/entities.cjs')({ authenticateToken, requireAdmin, db }));
app.use('/', require('./server/routes/ai.cjs')({ authenticateToken, db, loadGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/email.cjs')({ authenticateToken }));
app.use('/', require('./server/routes/settings.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/gcal.cjs')({ authenticateToken, db, makeOAuth2Client, saveGcalTokens, loadGcalTokens, google }));
app.use('/', require('./server/routes/gmail.cjs')({ authenticateToken, db, makeGmailOAuth2Client, saveGmailTokens, loadGmailTokens, google }));
app.use('/', require('./server/routes/inbox.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/tasks.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/notes.cjs')({ authenticateToken, requireOwnership, db, imageUpload }));
app.use('/', require('./server/routes/preferences.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/chat.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/financial.cjs')({ authenticateToken, requireOwnership, db }));
app.use('/', require('./server/routes/dashboard.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/alerts.cjs')({ authenticateToken, db, loadGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/whatsapp.cjs')({ db, loadGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/admin.cjs')({ authenticateToken, requireSuperAdmin, JWT_SECRET, db }));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', port: PORT, time: new Date().toISOString() }));

// ── Static files ─────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get('*', (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')));
}

// ── Start ────────────────────────────────────────────────────────────────────
async function start() {
  await db.initTables();
  await db.seedUsersIfEmpty();
  try { await db.runMigrations(); } catch (err) { console.error('[migration]', err.message); }
  app.listen(PORT, '0.0.0.0', () => console.log(`\n✓ Dizon.ai server running at http://localhost:${PORT}\n`));
}

start().catch((err) => { console.error('[startup] Fatal:', err.message); process.exit(1); });

// ── Server-side alert cron — runs every minute ──────────────────────────────
const cron = require('node-cron');
const { getResendClient: _getResendClient, getFromEmail: _getFromEmail } = require('./server/utils/email.cjs');

cron.schedule('* * * * *', async () => {
  try {
    const alerts = await db.getUnfiredAlerts();
    if (!alerts.length) return;

    for (const alert of alerts) {
      try {
        const channels = alert.channels || [];
        const sent = [];
        const failed = [];

        if (channels.includes('whatsapp') && alert.whatsappPhone) {
          const ultraInstance = process.env.ULTRAMSG_INSTANCE;
          const ultraToken = process.env.ULTRAMSG_TOKEN;
          if (ultraInstance && ultraToken) {
            try {
              const waRes = await fetch(`https://api.ultramsg.com/${ultraInstance}/messages/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: ultraToken, to: alert.whatsappPhone, body: alert.message }),
              });
              if (waRes.ok) sent.push('WhatsApp');
              else failed.push('WhatsApp');
            } catch { failed.push('WhatsApp'); }
          }
        }

        if (channels.includes('email') && alert.email) {
          const resend = _getResendClient();
          if (resend) {
            try {
              await resend.emails.send({
                from: _getFromEmail(),
                to: alert.email,
                subject: 'Reminder from Aria',
                text: alert.message,
              });
              sent.push('Email');
            } catch { failed.push('Email'); }
          }
        }

        await db.markScheduledAlertFired(alert.id);
        if (sent.length) console.log(`[cron] Fired alert ${alert.id} for ${alert.user_id}: ${sent.join(', ')}`);
        if (failed.length) console.error(`[cron] Alert ${alert.id} partial failure: ${failed.join(', ')}`);
      } catch (err) {
        console.error(`[cron] Failed to fire alert ${alert.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] Scheduler error:', err.message);
  }
});
console.log('[cron] Alert scheduler started');
