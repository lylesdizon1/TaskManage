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
const { DEFAULT_TIMEZONE } = require('./server/utils/timezone.cjs');
setDb(db);
const { authLimiter, apiLimiter } = require('./server/middleware/rateLimit.cjs');
const { makeOAuth2Client, makeGmailOAuth2Client, saveGcalTokens: _saveGcalTokens, loadGcalTokens: _loadGcalTokens, loadAllGcalAccounts: _loadAllGcalAccounts, mergeAndSaveGcalTokens: _mergeAndSaveGcalTokens } = require('./server/utils/google.cjs');

const saveGcalTokens  = (userId, tokens, googleEmail) => _saveGcalTokens(userId, tokens, db, googleEmail);
const loadGcalTokens  = (userId, googleEmail) => _loadGcalTokens(userId, db, googleEmail);
const loadAllGcalAccounts = (userId) => _loadAllGcalAccounts(userId, db);
const mergeAndSaveGcalTokens = (userId, newTokens, googleEmail) => _mergeAndSaveGcalTokens(userId, newTokens, db, googleEmail);

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
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"],
      // Voice mode (2026-05-29): TTS audio arrives from /api/tts/synthesize
      // and gets wrapped in a blob URL via URL.createObjectURL — that's
      // a 'blob:' scheme. The autoplay-policy primer uses a tiny silent
      // mp3 data URI ('data:'). Both must be allowed for browser audio
      // playback to work. Without these, audio is silently CSP-blocked
      // and the only signal is a console.warn buried in DevTools.
      mediaSrc: ["'self'", 'data:', 'blob:'],
      frameSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) || ['http://localhost:3000'],
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
// Per-route body limits BEFORE the global default — order matters in
// Express. The global parser claims req.body for whichever middleware
// runs first; route-prefixed parsers must register earlier to win.
app.use('/api/financial/import-csv', express.json({ limit: '5mb' })); // base64 PDF/Excel
app.use(express.json({ limit: '1mb' })); // global default — was 4mb
app.use('/api/auth/login', authLimiter);
app.use('/api/', apiLimiter);
app.use((req, _res, next) => { console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`); next(); });

const logger = require('./guardrails/logger.cjs');
app.use(logger.attachRequestId);

// ── Route mounts ─────────────────────────────────────────────────────────────
app.use('/', require('./server/routes/auth.cjs')({ authenticateToken, JWT_SECRET, db }));
app.use('/', require('./server/routes/users.cjs')({ authenticateToken, requireAdmin, db }));
app.use('/', require('./server/routes/entities.cjs')({ authenticateToken, requireAdmin, db }));
app.use('/', require('./server/routes/ai.cjs')({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/email.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/settings.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/gcal.cjs')({ authenticateToken, db, makeOAuth2Client, saveGcalTokens, loadGcalTokens, loadAllGcalAccounts, mergeAndSaveGcalTokens, google }));
app.use('/', require('./server/routes/gmail.cjs')({ authenticateToken, db, makeGmailOAuth2Client, google }));
app.use('/', require('./server/routes/inbox.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/tasks.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/notes.cjs')({ authenticateToken, requireOwnership, db, imageUpload }));
app.use('/', require('./server/routes/preferences.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/chat.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/financial.cjs')({ authenticateToken, requireOwnership, db }));
app.use('/', require('./server/routes/food.cjs')({ authenticateToken, requireOwnership, db }));
app.use('/', require('./server/routes/dashboard.cjs')({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google }));
const { router: alertsRouter, buildAndSendMorningBrief, buildAndSendDailyWrap } = require('./server/routes/alerts.cjs')({ authenticateToken, db, loadGcalTokens, loadAllGcalAccounts, saveGcalTokens, mergeAndSaveGcalTokens, makeOAuth2Client, google });
app.use('/', alertsRouter);
app.use('/', require('./server/routes/calendar-notes.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/whatsapp.cjs')({ db, loadGcalTokens, makeOAuth2Client, google }));
app.use('/', require('./server/routes/admin.cjs')({ authenticateToken, requireSuperAdmin, JWT_SECRET, db }));
app.use('/', require('./server/routes/agentActions.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/learnings.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/classification.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/emailClean.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/ariaDraft.cjs')({ authenticateToken }));
app.use('/', require('./server/routes/chatDraft.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/tileExecute.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/outcomes.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/projects.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/outlook.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/quickbooks.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/contacts.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/sharedAccess.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/closeLoop.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/imageBlobs.cjs')({ authenticateToken, db, imageUpload }));
app.use('/', require('./server/routes/journal.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/activeZone.cjs')({ authenticateToken, db }));
app.use('/', require('./server/routes/skills.cjs')({ authenticateToken, db }));

// ── Sentry error handler ────────────────────────────────────────────────────
const Sentry = require('./guardrails/instrument.cjs');
Sentry.setupExpressErrorHandler(app);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', port: PORT, time: new Date().toISOString() }));

// ── Static files ─────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
if (fs.existsSync(DIST_DIR)) {
  // Hashed assets (Vite builds /assets/index-<hash>.js etc.) — safe to
  // cache for a year because the filename itself changes on every build.
  // index.html is NOT cached: Safari was serving stale copies that
  // pointed at asset hashes Railway no longer had on disk, surfacing
  // as "text/html is not a valid JavaScript MIME type" after deploys.
  app.use(express.static(DIST_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  }));
  // Asset 404s must NOT fall through to the SPA — a missing
  // /assets/index-OldHash.js needs to return a real 404 so the browser
  // refetches index.html and picks up the new hash. Returning HTML for
  // an asset request is what created the MIME-type error.
  app.get('/assets/*', (_req, res) => res.status(404).end());
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

// ── Start ────────────────────────────────────────────────────────────────────
let server = null;

async function start() {
  await db.initTables();
  await db.seedUsersIfEmpty();
  try {
    await db.runMigrations();
  } catch (err) {
    // criticalMigration throws here. Schema is in an unknown state —
    // refuse to start so ops can investigate rather than serving traffic
    // against a half-migrated DB.
    logger.error('migration.failed.fatal', { error: err.message });
    process.exit(1);
  }
  try {
    const { migrateSlackWebhooksToEncrypted } = require('./server/utils/integrations.cjs');
    const migrated = await migrateSlackWebhooksToEncrypted(db);
    if (migrated > 0) console.log(`[migration] Encrypted ${migrated} legacy Slack webhook(s)`);
  } catch (err) { console.error('[migration] slack-webhook-encrypt:', err.message); }
  server = app.listen(PORT, '0.0.0.0', () => console.log(`\n✓ Dizon.ai server running at http://localhost:${PORT}\n`));

  // Sub-agent worker (M3.8) — drains queued sub_agent_sessions. Boots
  // after a short startup delay so the DB pool + schema migrations
  // settle first. Idempotent — repeated calls no-op when already running.
  try {
    const { startSubAgentWorker } = require('./server/lib/subAgents/worker.cjs');
    startSubAgentWorker();
  } catch (err) {
    console.error('[startup] subAgents.worker:', err.message);
  }
}

start().catch((err) => { console.error('[startup] Fatal:', err.message); process.exit(1); });

// ── Graceful shutdown ───────────────────────────────────────────────────────
// Railway sends SIGTERM with ~30s grace before SIGKILL. Stop accepting new
// connections, drain DB pool + Redis client, then exit. Hard timeout at 25s
// so we exit cleanly before SIGKILL would force-kill mid-cleanup.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received — draining…`);

  const hardExit = setTimeout(() => {
    console.error('[shutdown] grace period exceeded — forcing exit');
    process.exit(1);
  }, 25_000);
  hardExit.unref();

  if (server) {
    await new Promise((resolve) => server.close((err) => {
      if (err) console.error('[shutdown] server.close error:', err.message);
      else console.log('[shutdown] http server closed');
      resolve();
    }));
  }

  try { await db.pool.end(); console.log('[shutdown] pg pool closed'); }
  catch (err) { console.error('[shutdown] pg pool close error:', err.message); }

  try {
    const { getRedisClient } = require('./server/lib/redis.cjs');
    const c = await getRedisClient();
    if (c) { await c.quit(); console.log('[shutdown] redis client closed'); }
  } catch (err) { console.error('[shutdown] redis close error:', err.message); }

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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

        // Three outcomes, three branches — the prior code unconditionally
        // marked fired even when every channel failed, silently dropping
        // the reminder forever. Now: success → fire; partial → fire (≥1
        // channel got through); total failure → bump attempts and retry
        // next tick, with a dead-letter give-up at MAX_ATTEMPTS so the row
        // doesn't block the cron forever.
        if (sent.length > 0) {
          await db.markScheduledAlertFired(alert.id);
          cronLogger.info('alert.fired', {
            alertId: alert.id, userId: alert.user_id,
            sent, failed: failed.length ? failed : undefined,
          });
        } else if ((alert.attempts || 0) + 1 >= db.SCHEDULED_ALERT_MAX_ATTEMPTS) {
          // Out of retries — dead-letter. Mark fired with last_error so the
          // row stops being scanned, but capture why for postmortem.
          await db.markScheduledAlertFired(alert.id, failed.join(', '));
          cronLogger.error('alert.deadLettered', {
            alertId: alert.id, userId: alert.user_id,
            attempts: (alert.attempts || 0) + 1, failed,
          });
        } else {
          await db.incrementAlertAttempt(alert.id, failed.join(', '));
          cronLogger.warn('alert.deliveryFailed', {
            alertId: alert.id, userId: alert.user_id,
            attempt: (alert.attempts || 0) + 1, failed,
          });
        }
      } catch (err) {
        cronLogger.error('alert.iteration.failed', {
          alertId: alert.id, userId: alert.user_id, error: err.message,
        });
      }
    }
  } catch (err) {
    cronLogger.error('alert.scheduler.failed', { error: err.message });
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
        const failed = [];

        const wa = await _sendWhatsApp(db, ev.userId, msg);
        if (wa.ok) sent = true;
        else failed.push(`WhatsApp:${wa.reason}`);

        if (!sent) {
          const em = await _sendAlertEmail(db, ev.userId, {
            subject: `Meeting ended: ${ev.eventTitle || 'Untitled'}`,
            text: msg,
          });
          if (em.ok) sent = true;
          else failed.push(`Email:${em.reason}`);
        }

        // Only mark sent when at least one channel succeeded — the prior code
        // unconditionally flipped post_alert_sent=true so failed deliveries
        // were never retried. The 5-min eligibility window in
        // getRecentlyEndedEventsForAlerts naturally caps retries (~5 ticks)
        // without spamming the user once the meeting is stale.
        if (sent) {
          await db.markCalendarNoteAlertSent(ev.userId, ev.eventId);
          cronLogger.info('alert.postMeeting.sent', {
            userId: ev.userId, eventId: ev.eventId, eventTitle: ev.eventTitle,
          });
        } else {
          cronLogger.warn('alert.postMeeting.deliveryFailed', {
            userId: ev.userId, eventId: ev.eventId, eventTitle: ev.eventTitle, failed,
          });
        }
      } catch (err) {
        cronLogger.error('alert.postMeeting.iteration.failed', {
          userId: ev.userId, eventId: ev.eventId, error: err.message,
        });
      }
    }
  } catch (err) {
    cronLogger.error('alert.postMeeting.scheduler.failed', { error: err.message });
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

// ── Daily Wrap cron — runs every minute, fires per-user at HH:MM in their tz ──
// Mirrors morning-brief exactly: Redis fast-path → DB atomic lock →
// buildAndSendDailyWrap. The web-side nudge uses a separate alert_key
// (`daily-wrap-web:…`) so the cron push and the web prompt are
// independently idempotent per (user, local day).
cron.schedule('* * * * *', async () => {
  try {
    const users = await db.getUsersWithDailyWrapEnabled();
    for (const user of users) {
      try {
        const localTime = getLocalHHMM(user.timezone);
        if (!localTime || localTime !== user.wrapTime) continue;

        const dateKey = getLocalDateKey(user.timezone);
        const redisKey = `daily-wrap:${user.id}:${dateKey}`;

        // Redis fast-path short-circuits before the DB lock when possible.
        const cachedSent = await _rediGet(redisKey);
        if (cachedSent) continue;

        const alreadySent = await db.checkAndLockDailyWrapSent(user.id, dateKey);
        if (alreadySent) {
          await _rediSet(redisKey, true, 86400);
          continue;
        }

        await buildAndSendDailyWrap(user.id, {
          requestId: `cron-daily-wrap-${user.id}`,
        });
        await _rediSet(redisKey, true, 86400);
        cronLogger.info('daily-wrap-cron.sent', { userId: user.id });
      } catch (e) {
        cronLogger.error('daily-wrap-cron.user-failed', { userId: user.id, error: e.message });
      }
    }
  } catch (e) {
    cronLogger.error('daily-wrap-cron.failed', { error: e.message });
  }
});
console.log('[cron] Daily Wrap scheduler started');

// ── Daily Wrap startup catch-up — for any user whose wrap time already
// passed today locally and who hasn't been sent the push, fire once on
// boot. Mirrors the GCal/Outlook startup pattern — 8s delay so migrations
// + route mounts are settled.
(async () => {
  await new Promise((r) => setTimeout(r, 8000));
  try {
    const users = await db.getUsersWithDailyWrapEnabled();
    cronLogger.info('daily-wrap.startup.begin', { userCount: users.length });
    for (const user of users) {
      try {
        const localTime = getLocalHHMM(user.timezone);
        if (!localTime || localTime < user.wrapTime) continue; // wrap time hasn't hit yet today
        const dateKey = getLocalDateKey(user.timezone);
        // If user already completed the wrap on web, don't push.
        const wrapped = db.hasCompletedWrap ? await db.hasCompletedWrap(user.id, dateKey) : false;
        if (wrapped) continue;
        const alreadySent = await db.checkAndLockDailyWrapSent(user.id, dateKey);
        if (alreadySent) continue;
        await buildAndSendDailyWrap(user.id, { requestId: `startup-daily-wrap-${user.id}` });
        await _rediSet(`daily-wrap:${user.id}:${dateKey}`, true, 86400);
        cronLogger.info('daily-wrap.startup.sent', { userId: user.id });
      } catch (e) {
        cronLogger.error('daily-wrap.startup.user-failed', { userId: user.id, error: e.message });
      }
    }
    cronLogger.info('daily-wrap.startup.complete', { userCount: users.length });
  } catch (e) {
    cronLogger.error('daily-wrap.startup.failed', { error: e.message });
  }
})();

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

// ── Aria Intelligence rule decay — 3am daily ─────────────────────────────
// Applies the 0.95^days decay formula to every active behavior_rule row,
// archives anything that drops below the 0.1 floor, invalidates the rule
// cache for affected users. Sequential per-user — fire-soft, never
// blocks anything.
const { processRuleDecay } = require('./server/lib/ruleDecay.cjs');
cron.schedule('0 3 * * *', async () => {
  try {
    const stats = await processRuleDecay();
    cronLogger.info('ruleDecay.cron.done', stats);
  } catch (e) {
    cronLogger.error('ruleDecay.cron.failed', { error: e.message });
  }
});
console.log('[cron] Aria rule decay scheduler started');

// ── Stale classification sweep — 4am daily ───────────────────────────────
// Force re-classifies stale unacked flagged emails so they pick up the
// current CLASSIFIER_VERSION. classifyEmail already invalidates stale-
// version cache rows on next sight, but old flagged threads aren't in
// the recent inbox window so they never re-touch organically. This
// sweep closes the gap, paired with auto-unflag-on-demote (9fd3bb5):
// demoted rows now actually drop out of the critical_email_unacked tile.
// Bounded at 20 emails per user per run; Gmail-only in V1.
const { sweepStaleClassificationsAllUsers } = require('./server/lib/staleClassificationSweep.cjs');
cron.schedule('0 4 * * *', async () => {
  try {
    const totals = await sweepStaleClassificationsAllUsers();
    cronLogger.info('staleClassification.cron.done', totals);
  } catch (e) {
    cronLogger.error('staleClassification.cron.failed', { error: e.message });
  }
});
console.log('[cron] Stale classification sweep scheduler started');

// ── GCal sync — every 15 min, mirrors 14-day window into calendar_events ──
const { localMidnightUtc } = require('./server/lib/buildAgenticContext.cjs');
const { resolveOrCreateContact } = require('./server/lib/contactIngestion.cjs');

async function syncGcalForUser(userId, tz) {
  try {
    const accounts = await loadAllGcalAccounts(userId);
    for (const account of accounts) {
      // 2026-05-08 fix — skip accounts already flagged needs_reauth so
      // we stop the per-tick invalid_grant log spam (was 3 errors × 96
      // ticks/day = ~288 silent failures per day for one user). User
      // clicks reconnect, OAuth callback flips back to 'ok', sync resumes.
      if (account.authStatus === 'needs_reauth') continue;
      try {
        const { googleEmail, tokens } = account;
        const oauth2Client = makeOAuth2Client();
        if (!oauth2Client) continue;
        oauth2Client.setCredentials(tokens);
        // Persist refreshed tokens back to user_integrations so the next
        // cron tick doesn't re-auth from a stale refresh_token.
        oauth2Client.on('tokens', async (newTokens) => {
          try {
            await mergeAndSaveGcalTokens(userId, newTokens, googleEmail);
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
          // Human attendees only — drop meeting-room resources. Stored
          // lowercased for case-insensitive matching against contact emails.
          attendees: (ev.attendees || [])
            .filter((a) => a?.email && !a.resource)
            .map((a) => a.email.toLowerCase()),
        }));

        await db.upsertCalendarEvents(userId, googleEmail, events);

        // Drop cached rows in this window that Google didn't return.
        // Without this, edited/replaced recurring series leave orphan
        // instances stuck in cache forever (the May 2026 "Careific:
        // Standup Call" 3x bug — three concurrent series IDs, two
        // already abandoned upstream, no automatic cleanup).
        //
        // The helper itself guards against empty responses (treats as
        // suspect — see deleteUnreturnedCalendarEvents docstring); the
        // !events.length check here is belt-and-suspenders + saves a
        // pointless DB roundtrip when Google returned zero events.
        if (events.length > 0) {
          try {
            const deleted = await db.deleteUnreturnedCalendarEvents(
              userId, googleEmail, timeMin, timeMax,
              events.map((e) => e.id),
            );
            if (deleted > 0) {
              cronLogger.info('gcal-sync.staleDropped', { userId, googleEmail, deleted });
            }
          } catch (delErr) {
            cronLogger.warn('gcal-sync.staleDrop.failed', { userId, googleEmail, error: delErr.message });
          }
        }

        // Fire-and-forget contact ingestion for organizers. V1: organizer
        // only, never attendees. Resolver dedups so repeat syncs no-op.
        for (const ev of (res.data.items || [])) {
          const orgEmail = ev.organizer?.email;
          if (!orgEmail) continue;
          resolveOrCreateContact(userId, { email: orgEmail, name: ev.organizer?.displayName || '', source: 'calendar_sync' })
            .catch((err) => console.error('[contactIngestion] gcal:', err.message));
        }
        // Invalidate the Redis cache for the common fetchCalendarWindow
        // window sizes so downstream reads pick up fresh DB data.
        try {
          await Promise.all([1, 7, 14].map((d) =>
            _rediDel(`gcal:${userId}:${tz}:${d}`)
          ));
        } catch { /* silent — cache purge is best-effort */ }
        // Successful pull → clear any stale needs_reauth flag on this
        // gcal_tokens row (also flips the row back after reconnect).
        await db.clearGcalAuthStatus(userId, googleEmail).catch(() => {});
      } catch (e) {
        // 2026-05-08 fix: persist invalid_grant to DB. Pre-fix this was
        // logged-only — the user's 3 dead Google calendars produced ~288
        // log entries/day forever with NO DB state change and NO UI
        // signal. Mark needs_reauth so the cron skips the row next tick
        // and the UI can surface the reconnect prompt.
        const msg = e.message || '';
        if (msg.includes('invalid_grant') || msg.includes('Token has been expired or revoked')) {
          const flipped = await db.markGcalNeedsReauth(userId, account.googleEmail, msg).catch(() => false);
          if (flipped) {
            cronLogger.warn('gcal-sync.needsReauth', { userId, googleEmail: account.googleEmail });
          }
        }
        cronLogger.error('gcal-sync.account-failed', { userId, googleEmail: account.googleEmail, error: msg });
      }
    }
    // Drop rows whose end_time is older than 30 days so the table stays bounded.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    await db.deleteStaleCalendarEvents(userId, cutoff);

    // Emit close-loop rows for events that just ended without an
    // outcome note. Idempotent across sync paths — sweepEventCloseLoops
    // uses LEFT JOIN ... IS NULL + the pcl unique index to skip
    // already-queued events.
    try {
      const { sweepEventCloseLoops } = require('./server/lib/closeLoopEmitter.cjs');
      await sweepEventCloseLoops(userId);
    } catch (e) {
      cronLogger.warn('gcal-sync.closeLoopSweep.failed', { userId, error: e.message });
    }
  } catch (e) {
    cronLogger.error('gcal-sync.user-failed', { userId, error: e.message });
  }
}

cron.schedule('*/15 * * * *', async () => {
  try {
    const users = await db.getUsersWithGcalConnected();
    for (const user of users) {
      await syncGcalForUser(user.id, user.timezone || DEFAULT_TIMEZONE);
    }
    cronLogger.info('gcal-sync.complete', { userCount: users.length });
  } catch (e) {
    cronLogger.error('gcal-sync.failed', { error: e.message });
  }
});
console.log('[cron] GCal sync scheduler started');

// ── Outlook sync — every 15 min, same window as GCal ──────────────────────
const { syncOutlookForUser } = require('./server/lib/outlookCalSync.cjs');
const { scanOutlookMailForUser } = require('./server/lib/outlookMailScan.cjs');
const { syncAllQbConnections } = require('./server/lib/quickbooksSync.cjs');

cron.schedule('*/15 * * * *', async () => {
  try {
    const users = await db.getUsersWithOutlookConnected();
    for (const user of users) {
      await syncOutlookForUser(user.id, user.timezone || DEFAULT_TIMEZONE, db);
      // Mail scan piggybacks the same cron tick so we don't double-schedule.
      try { await scanOutlookMailForUser({ userId: user.id, db, requestId: `cron-outlook-${user.id}` }); }
      catch (e) { cronLogger.error('outlook-mail-scan.user-failed', { userId: user.id, error: e.message }); }
    }
    cronLogger.info('outlook-sync.complete', { userCount: users.length });
  } catch (e) {
    cronLogger.error('outlook-sync.failed', { error: e.message });
  }

  // QB sync piggybacks the same */15 tick — fewer cron slots, and QB API
  // rate limits (~60 req/min per realm) are well within our budget at
  // ~4 calls per connection per cycle.
  try {
    await syncAllQbConnections(db);
  } catch (e) {
    cronLogger.error('quickbooks-sync.failed', { error: e.message });
  }
});
console.log('[cron] Outlook sync scheduler started');

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
      try { await syncGcalForUser(user.id, user.timezone || DEFAULT_TIMEZONE); }
      catch (e) { cronLogger.error('gcal-sync.startup.user-failed', { userId: user.id, error: e.message }); }
    }
    cronLogger.info('gcal-sync.startup.complete', { userCount: users.length });
  } catch (e) {
    cronLogger.error('gcal-sync.startup.failed', { error: e.message });
  }
})();

// ── Outlook startup sync — same shape as GCal startup sync ──────────────
(async () => {
  await new Promise((r) => setTimeout(r, 7000));
  try {
    const users = await db.getUsersWithOutlookConnected();
    cronLogger.info('outlook-sync.startup.begin', { userCount: users.length });
    for (const user of users) {
      try { await syncOutlookForUser(user.id, user.timezone || DEFAULT_TIMEZONE, db); }
      catch (e) { cronLogger.error('outlook-sync.startup.user-failed', { userId: user.id, error: e.message }); }
    }
    cronLogger.info('outlook-sync.startup.complete', { userCount: users.length });
  } catch (e) {
    cronLogger.error('outlook-sync.startup.failed', { error: e.message });
  }
})();

// ── Trust scores pre-warm at startup ─────────────────────────────────────
// Pairs with the 174f62a UPSERT fix. The audit found that pre-Phase-4
// users had no trust_scores rows; UPSERT covers forward decisions but
// also needs each user to have the matrix-default rows seeded so the
// Decisions admin view shows a complete picture and trust_score reads
// (decisionEngine Tier 5) hit something on the very first decision
// rather than waiting for the first signal-bearing outcome to seed.
//
// seedDefaultTrustScores is idempotent — uses ON CONFLICT DO NOTHING —
// so this is a safe-to-rerun startup migration. Bounded per-user work:
// ~18 INSERT-or-noop rows from DEFAULT_TRUST_MATRIX. Sequential across
// users so a transient failure can't fan out.
(async () => {
  await new Promise((r) => setTimeout(r, 9000)); // settle after migrations + sync starters
  try {
    const userIds = await db.getAllUserIds();
    let seeded = 0;
    for (const userId of userIds) {
      try {
        const n = await db.seedDefaultTrustScores(userId);
        if (n > 0) seeded += n;
      } catch (e) {
        cronLogger.warn('trust-prewarm.user-failed', { userId, error: e.message });
      }
    }
    cronLogger.info('trust-prewarm.startup.complete', { userCount: userIds.length, rowsSeeded: seeded });
  } catch (e) {
    cronLogger.error('trust-prewarm.startup.failed', { error: e.message });
  }
})();

// ── Gmail token refresh cron — runs every 30 minutes ─────────────────────
// Keeps Gmail tokens alive even when no user opens the app, preventing
// invalid_grant expiry. Uses the same user_integrations-backed helpers
// as the refactored gmail.cjs.
const { encryptTokens: _encTokens, decryptTokens: _decTokens, ENCRYPTION_KEY } = require('./server/utils/crypto.cjs');

cron.schedule('*/30 * * * *', async () => {
  try {
    const userIds = await db.getAllGmailConnectedUsers();
    if (!userIds.length) return;

    for (const userId of userIds) {
      try {
        const rows = await db.getUserIntegrationsByType(userId, 'gmail');
        if (!rows.length) continue;

        for (const row of rows) {
          // 2026-05-08 fix: skip rows already flagged needs_reauth so we
          // stop hammering dead tokens (was 96 ticks/day × 3 accounts =
          // 288 invalid_grant log entries/day for one user). User clicks
          // reconnect, OAuth callback flips back to 'ok', cron resumes.
          if (row.authStatus === 'needs_reauth') continue;

          try {
            let tokens = row.config?.tokens;
            if (!tokens) continue;
            if (tokens._enc) tokens = _decTokens(tokens._enc);

            const oauth2 = makeGmailOAuth2Client();
            if (!oauth2) continue;

            oauth2.setCredentials(tokens);
            const { credentials } = await oauth2.refreshAccessToken();

            // Merge refreshed credentials back into stored config
            const merged = { ...tokens, ...credentials };
            const wrapped = ENCRYPTION_KEY ? { _enc: _encTokens(merged) } : merged;
            await db.upsertUserIntegration(userId, 'gmail', { tokens: wrapped }, true, row.accountEmail || '');
            // Clear any stale needs_reauth flag on successful refresh —
            // this is also the path that flips the row back after a
            // user reconnects via OAuth (callback writes fresh tokens
            // → next cron tick succeeds → flag clears).
            await db.clearIntegrationAuthStatus(userId, row.id).catch(() => {});
            cronLogger.info('gmail-refresh.ok', { userId, account: row.accountEmail });
          } catch (acctErr) {
            cronLogger.error('gmail-refresh.account-failed', { userId, account: row.accountEmail, error: acctErr.message });

            // 2026-05-08 fix: STOP hard-deleting integration rows on
            // invalid_grant. Pre-fix this destroyed Lyle's
            // lylesdizon@gmail.com integration along with thousands of
            // other rows over time (max id 8387 with only 9 live rows
            // in 2-user prod = ~8378 destroy/recreate cycles). Mark
            // needs_reauth instead — UI surfaces the flag, user clicks
            // reconnect, OAuth callback rehydrates the same row.
            if (acctErr.message?.includes('invalid_grant')) {
              const flipped = await db.markIntegrationNeedsReauth(userId, row.id, acctErr.message).catch(() => false);
              if (flipped) {
                cronLogger.warn('gmail-refresh.needsReauth', { userId, account: row.accountEmail });
              }
            }
          }
        }
      } catch (err) {
        cronLogger.error('gmail-refresh.user-failed', { userId, error: err.message });
      }
    }
  } catch (err) {
    cronLogger.error('gmail-refresh.cron-failed', { error: err.message });
  }
});
console.log('[cron] Gmail token refresh scheduler started');

// ── Proactive Surfacer cron — runs every 30 min ──────────────────────────
// P2b (2026-05-28). Walks opted-in users, dispatches push-eligible
// candidates from candidateDetector via the user's preferred channel
// (WhatsApp first, Slack fallback). DND + daily cap + per-candidate
// cooldown enforced inside the surfacer. Tick gated by PROACTIVE_SURFACER_ENABLED
// so the cron can be hot-disabled in prod without a redeploy.
const { runProactiveSurfacerTick } = require('./server/lib/proactiveSurfacer.cjs');
cron.schedule('*/30 * * * *', async () => {
  if (process.env.PROACTIVE_SURFACER_ENABLED !== 'true') return;
  try {
    await runProactiveSurfacerTick({ db, logger: cronLogger });
  } catch (err) {
    cronLogger.error('proactive-surfacer.cron-failed', { error: err.message });
  }
});
console.log('[cron] Proactive surfacer scheduler started (inert until PROACTIVE_SURFACER_ENABLED=true)');
