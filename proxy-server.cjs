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
const { router: alertsRouter, buildAndSendMorningBrief } = require('./server/routes/alerts.cjs')({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, makeOAuth2Client, google });
app.use('/', alertsRouter);
app.use('/', require('./server/routes/calendar-notes.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/whatsapp.cjs')({ db, loadGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/admin.cjs')({ authenticateToken, requireSuperAdmin, JWT_SECRET, db }));
app.use('/', require('./server/routes/agentActions.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/learnings.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/classification.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/emailClean.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/ariaDraft.cjs')({ authenticateToken }));
app.use('/', require('./server/routes/tileExecute.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/outcomes.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/projects.cjs')({ authenticateToken, db }));

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
const { sendSlack: _sendSlack, sendWhatsApp: _sendWhatsApp, sendAlertEmail: _sendAlertEmail } = require('./server/utils/integrations.cjs');
const cronLogger = require('./guardrails/logger.cjs');

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

// ── Morning brief cron — runs every minute, fires per-user at HH:MM in their tz ──
function getLocalHHMM(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const h = parts.find(p => p.type === 'hour').value.padStart(2, '0');
    const m = parts.find(p => p.type === 'minute').value.padStart(2, '0');
    return `${h}:${m}`;
  } catch { return null; }
}

function getLocalDateKey(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

// Lazy Redis helpers — optional fast-path in front of the DB dedup lock.
const { rediGet: _rediGet, rediSet: _rediSet, rediDel: _rediDel } = require('./server/lib/redis.cjs');

cron.schedule('* * * * *', async () => {
  try {
    const users = await db.getUsersWithMorningBriefEnabled();
    for (const user of users) {
      try {
        const localTime = getLocalHHMM(user.timezone);
        if (!localTime || localTime !== user.briefTime) continue;

        const dateKey = getLocalDateKey(user.timezone);
        const redisKey = `morning-brief:${user.id}:${dateKey}`;

        // Redis fast-path: if the key is present, we already sent today.
        // Avoids a DB roundtrip per cron tick. Redis is best-effort — if
        // it returns null (miss OR connection down), fall through to the
        // DB lock which is authoritative.
        const cachedSent = await _rediGet(redisKey);
        if (cachedSent) continue;

        const alreadySent = await db.checkAndLockMorningBriefSent(user.id, dateKey);
        if (alreadySent) {
          // Mirror the DB state into Redis so subsequent ticks short-circuit.
          await _rediSet(redisKey, true, 86400);
          continue;
        }

        await buildAndSendMorningBrief(user.id, {
          requestId: `cron-morning-brief-${user.id}`,
        });
        // Mark as sent in Redis for the next 24h.
        await _rediSet(redisKey, true, 86400);
        cronLogger.info('morning-brief-cron.sent', { userId: user.id });
      } catch (e) {
        cronLogger.error('morning-brief-cron.user-failed', { userId: user.id, error: e.message });
      }
    }
  } catch (e) {
    cronLogger.error('morning-brief-cron.failed', { error: e.message });
  }
});
console.log('[cron] Morning brief scheduler started');

// ── Pending-confirmations sweep — runs hourly ──────────────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const { expired, deleted } = await db.cleanupPendingConfirmations();
    cronLogger.info('pending-confirmations.sweep.done', { expired, deleted });
  } catch (e) {
    cronLogger.error('pending-confirmations.sweep.failed', { error: e.message });
  }
});
console.log('[cron] Pending-confirmations sweep scheduler started');

// ── GCal sync — every 15 min, mirrors 14-day window into calendar_events ──
const { localMidnightUtc } = require('./server/lib/buildAgenticContext.cjs');

async function syncGcalForUser(userId, tz) {
  try {
    const accounts = await loadAllGcalAccounts(userId);
    for (const account of accounts) {
      try {
        const { googleEmail, tokens } = account;
        const oauth2Client = makeOAuth2Client();
        if (!oauth2Client) continue;
        oauth2Client.setCredentials(tokens);
        // Persist refreshed tokens back to user_integrations so the next
        // cron tick doesn't re-auth from a stale refresh_token.
        oauth2Client.on('tokens', async (newTokens) => {
          try {
            const existing = await loadGcalTokens(userId, googleEmail);
            await saveGcalTokens(userId, { ...existing, ...newTokens }, googleEmail);
          } catch (e) {
            cronLogger.error('gcal-sync.tokenRefresh.failed', { userId, googleEmail, error: e.message });
          }
        });

        // Anchor the window to the user's local midnight, not the server's.
        // Without this, a Railway-hosted (UTC) server skews the window for
        // non-UTC users — in the worst case losing up to a day of events.
        const timeMin = localMidnightUtc(tz, 0);
        const timeMax = localMidnightUtc(tz, 14);

        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const res = await calendar.events.list({
          calendarId: 'primary',
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 100,
          timeZone: tz,
        });

        const events = (res.data.items || []).map((ev) => ({
          id: ev.id,
          title: ev.summary || '(No title)',
          start_time: ev.start?.dateTime || ev.start?.date,
          end_time:   ev.end?.dateTime   || ev.end?.date,
          all_day: !ev.start?.dateTime,
          location: ev.location || null,
          description: ev.description || null,
        }));

        await db.upsertCalendarEvents(userId, googleEmail, events);
        // Invalidate the Redis cache for the common fetchCalendarWindow
        // window sizes so downstream reads pick up fresh DB data.
        try {
          await Promise.all([1, 7, 14].map((d) =>
            _rediDel(`gcal:${userId}:${tz}:${d}`)
          ));
        } catch { /* silent — cache purge is best-effort */ }
      } catch (e) {
        cronLogger.error('gcal-sync.account-failed', { userId, error: e.message });
      }
    }
    // Drop rows whose end_time is older than 30 days so the table stays bounded.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    await db.deleteStaleCalendarEvents(userId, cutoff);
  } catch (e) {
    cronLogger.error('gcal-sync.user-failed', { userId, error: e.message });
  }
}

cron.schedule('*/15 * * * *', async () => {
  try {
    const users = await db.getUsersWithGcalConnected();
    for (const user of users) {
      await syncGcalForUser(user.id, user.timezone || 'America/Los_Angeles');
    }
    cronLogger.info('gcal-sync.complete', { userCount: users.length });
  } catch (e) {
    cronLogger.error('gcal-sync.failed', { error: e.message });
  }
});
console.log('[cron] GCal sync scheduler started');

// ── Startup sync — trigger one pass for all connected users on boot so
// new deploys don't wait up to 15 min for the first tick. Non-blocking;
// per-user failures are isolated to that user.
(async () => {
  // Small delay so runMigrations + initTables have definitely settled on
  // the server start() path before we start hitting the DB + Google API.
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const users = await db.getUsersWithGcalConnected();
    cronLogger.info('gcal-sync.startup.begin', { userCount: users.length });
    for (const user of users) {
      try { await syncGcalForUser(user.id, user.timezone || 'America/Los_Angeles'); }
      catch (e) { cronLogger.error('gcal-sync.startup.user-failed', { userId: user.id, error: e.message }); }
    }
    cronLogger.info('gcal-sync.startup.complete', { userCount: users.length });
  } catch (e) {
    cronLogger.error('gcal-sync.startup.failed', { error: e.message });
  }
})();
