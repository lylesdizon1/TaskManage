require('./guardrails/instrument.cjs');

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
const { makeOAuth2Client, makeGmailOAuth2Client, saveGcalTokens: _saveGcalTokens, loadGcalTokens: _loadGcalTokens, loadAllGcalAccounts: _loadAllGcalAccounts } = require('./server/utils/google.cjs');

const saveGcalTokens  = (userId, tokens, googleEmail) => _saveGcalTokens(userId, tokens, db, googleEmail);
const loadGcalTokens  = (userId, googleEmail) => _loadGcalTokens(userId, db, googleEmail);
const loadAllGcalAccounts = (userId) => _loadAllGcalAccounts(userId, db);

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

const logger = require('./guardrails/logger.cjs');
app.use(logger.attachRequestId);

// ── Route mounts ─────────────────────────────────────────────────────────────
app.use('/', require('./server/routes/auth.cjs')({ authenticateToken, JWT_SECRET, db }));
app.use('/', require('./server/routes/users.cjs')({ authenticateToken, requireAdmin, db }));
app.use('/', require('./server/routes/entities.cjs')({ authenticateToken, requireAdmin, db }));
app.use('/', require('./server/routes/ai.cjs')({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/email.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/settings.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/gcal.cjs')({ authenticateToken, db, makeOAuth2Client, saveGcalTokens, loadGcalTokens, loadAllGcalAccounts, google }));
app.use('/', require('./server/routes/gmail.cjs')({ authenticateToken, db, makeGmailOAuth2Client, google }));
app.use('/', require('./server/routes/inbox.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/tasks.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/notes.cjs')({ authenticateToken, requireOwnership, db, imageUpload }));
app.use('/', require('./server/routes/preferences.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/chat.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/financial.cjs')({ authenticateToken, requireOwnership, db }));
app.use('/', require('./server/routes/dashboard.cjs')({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/alerts.cjs')({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/calendar-notes.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/whatsapp.cjs')({ db, loadGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/admin.cjs')({ authenticateToken, requireSuperAdmin, JWT_SECRET, db }));
app.use('/', require('./server/routes/agentActions.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/learnings.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/classification.cjs')({ authenticateToken, db }));

// ── Sentry error handler ────────────────────────────────────────────────────
const Sentry = require('./guardrails/instrument.cjs');
Sentry.setupExpressErrorHandler(app);

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
const { sendWhatsApp: _sendWhatsApp, sendAlertEmail: _sendAlertEmail } = require('./server/utils/integrations.cjs');

cron.schedule('* * * * *', async () => {
  try {
    const alerts = await db.getUnfiredAlerts();
    if (!alerts.length) return;

    for (const alert of alerts) {
      try {
        const channels = alert.channels || [];
        const sent = [];
        const failed = [];

        if (channels.includes('whatsapp')) {
          const r = await _sendWhatsApp(db, alert.user_id, alert.message);
          if (r.ok) sent.push('WhatsApp');
          else failed.push(`WhatsApp:${r.reason}`);
        }

        if (channels.includes('email')) {
          const r = await _sendAlertEmail(db, alert.user_id, {
            subject: 'Reminder from Aria',
            text: alert.message,
          });
          if (r.ok) sent.push('Email');
          else failed.push(`Email:${r.reason}`);
        }

        await db.markScheduledAlertFired(alert.id);
        if (sent.length) console.log(`[cron] Fired alert ${alert.id}: ${sent.join(', ')}`);
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

// ── Post-meeting note reminder cron — runs every minute ─────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const events = await db.getRecentlyEndedEventsForAlerts();
    if (!events.length) return;

    for (const ev of events) {
      try {
        const msg = `Your meeting "${ev.eventTitle || 'Untitled'}" just ended. Reply with your outcomes & decisions — Aria will save them for you.`;
        let sent = false;

        const wa = await _sendWhatsApp(db, ev.userId, msg);
        if (wa.ok) { sent = true; console.log(`[cron] Post-meeting alert sent (WhatsApp) for event "${ev.eventTitle}"`); }

        if (!sent) {
          const em = await _sendAlertEmail(db, ev.userId, {
            subject: `Meeting ended: ${ev.eventTitle || 'Untitled'}`,
            text: msg,
          });
          if (em.ok) { sent = true; console.log(`[cron] Post-meeting alert sent (Email) for event "${ev.eventTitle}"`); }
        }

        await db.markCalendarNoteAlertSent(ev.userId, ev.eventId);
      } catch (err) {
        console.error(`[cron] Post-meeting alert failed for ${ev.eventId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[cron] Post-meeting cron error:', err.message);
  }
});
console.log('[cron] Post-meeting alert scheduler started');
