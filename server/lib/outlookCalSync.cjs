'use strict';

/**
 * server/lib/outlookCalSync.cjs — mirror Outlook calendar events into
 * calendar_events. V1 uses option (b) from the design discussion: no
 * new columns. Outlook events are distinguished from Google events by
 * the account_email column, which carries an 'outlook:<upn>' prefix.
 * Everything downstream (buildAgenticContext, getCalendarEventsForUser)
 * is already provider-agnostic so they pick up Outlook events for free.
 */

const { GRAPH_BASE, listOutlookAccounts, withFreshAccessToken } = require('../utils/outlook.cjs');
const { localMidnightUtc } = require('./buildAgenticContext.cjs');
const { resolveOrCreateContact } = require('./contactIngestion.cjs');
const logger = require('../../guardrails/logger.cjs');

async function syncOutlookForUser(userId, tz, db) {
  console.log('[outlookCalSync] starting for userId:', userId, 'tz:', tz);
  try {
    const accounts = await listOutlookAccounts(userId, db);
    console.log('[outlookCalSync] accounts:', accounts.length, accounts.map((a) => a.accountEmail));
    for (const account of accounts) {
      // 2026-05-08: skip accounts already flagged needs_reauth — stops
      // retry-storm log noise on dead tokens. Resumes on user reconnect.
      if (account.authStatus === 'needs_reauth') continue;
      try {
        let tokens;
        try {
          tokens = await withFreshAccessToken(account, db, userId);
        } catch (refreshErr) {
          // Persist auth-revocation so the UI surfaces "Reconnect needed"
          // and the cron skips this account next tick.
          if (account?.id && db?.markIntegrationNeedsReauth) {
            await db.markIntegrationNeedsReauth(userId, account.id, refreshErr.message).catch(() => {});
          }
          logger.warn('outlook-sync.tokenRefresh.failed', { userId, accountEmail: account.accountEmail, error: refreshErr.message });
          continue;
        }
        const timeMin = localMidnightUtc(tz, 0);
        const timeMax = localMidnightUtc(tz, 14);
        const qs = new URLSearchParams({
          startDateTime: timeMin.toISOString(),
          endDateTime: timeMax.toISOString(),
          $select: 'id,subject,start,end,location,bodyPreview,isAllDay,organizer',
          $top: '100',
          $orderby: 'start/dateTime',
        });
        const url = `${GRAPH_BASE}/me/calendarView?${qs.toString()}`;
        console.log('[outlookCalSync] fetching window', { userId, accountEmail: account.accountEmail, timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() });
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            Prefer: `outlook.timezone="UTC"`,
          },
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          logger.error('outlook-sync.fetch.failed', { userId, accountEmail: account.accountEmail, status: res.status, body: body.slice(0, 500) });
          continue;
        }
        const json = await res.json();
        const items = Array.isArray(json.value) ? json.value : [];
        console.log('[outlookCalSync] events fetched:', items.length, 'for', account.accountEmail);
        const events = items.map((ev) => {
          // Graph returns start/end as { dateTime: '2026-04-14T17:00:00.0000000', timeZone: 'UTC' }
          // With Prefer=UTC, dateTime is UTC; append Z so Postgres interprets it correctly.
          const toUtcIso = (d) => {
            if (!d?.dateTime) return null;
            const s = String(d.dateTime);
            return /[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`;
          };
          return {
            id: ev.id,
            title: ev.subject || '(No title)',
            start_time: toUtcIso(ev.start),
            end_time: toUtcIso(ev.end),
            all_day: !!ev.isAllDay,
            location: ev.location?.displayName || null,
            description: ev.bodyPreview || null,
          };
        }).filter((e) => e.start_time && e.end_time);

        // Prefix account_email so downstream helpers can distinguish the
        // provider without a schema migration. The prefix is opaque to
        // reads that only display account_email (they render it as-is).
        const taggedEmail = account.accountEmail?.startsWith('outlook:')
          ? account.accountEmail
          : `outlook:${account.accountEmail || 'unknown'}`;
        console.log('[outlookCalSync] upserting', events.length, 'events under', taggedEmail);
        await db.upsertCalendarEvents(userId, taggedEmail, events);

        // Fire-and-forget contact ingestion for organizers. V1: organizer
        // only, never attendees. Dedup by (userId, email) happens in the
        // resolver via resolveContactByEmail → no-op on repeat syncs.
        for (const ev of items) {
          const org = ev.organizer?.emailAddress;
          const orgEmail = org?.address;
          if (!orgEmail) continue;
          // No snippet passed → no fact extraction from calendar events;
          // organizer resolution only (higher signal than mail senders).
          resolveOrCreateContact(userId, { email: orgEmail, name: org.name || '', source: 'calendar_sync' })
            .catch((err) => logger.warn('outlookCalSync.contactIngestion.failed', { userId, accountEmail: account.accountEmail, error: err.message }));
        }

        // Redis invalidation — same keys GCal sync purges.
        try {
          const { rediDel } = require('./redis.cjs');
          await Promise.all([1, 7, 14].map((d) => rediDel(`gcal:${userId}:${tz}:${d}`)));
        } catch { /* best-effort */ }
      } catch (e) {
        logger.error('outlook-sync.account-failed', { userId, accountEmail: account.accountEmail, error: e.message, stack: e.stack?.split('\n').slice(0, 3).join(' | ') });
      }
    }
    // Bounded retention — mirror GCal: drop end_time older than 30 days.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    await db.deleteStaleCalendarEvents(userId, cutoff);

    // After sync settles, emit close-loop rows for any events that just
    // ended without an outcome note. The sweep is idempotent so the
    // GCal sync running on the same tick doesn't double-emit.
    try {
      const { sweepEventCloseLoops } = require('./closeLoopEmitter.cjs');
      await sweepEventCloseLoops(userId);
    } catch (e) {
      logger.warn('outlook-sync.closeLoopSweep.failed', { userId, error: e.message });
    }
  } catch (e) {
    logger.error('outlook-sync.user-failed', { userId, error: e.message });
  }
}

module.exports = { syncOutlookForUser };
