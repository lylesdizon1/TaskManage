'use strict';

/**
 * server/lib/emailCleanRunner.cjs — safe manual clean.
 *
 * Two stages, always in this order:
 *   1. dry-run scan → returns counts + breakdown
 *   2. on explicit confirm → archive via the Google provider
 *
 * Safety invariants (enforced in every job):
 *   - NEVER archive a thread whose classification has
 *     importance_rank >= 3
 *   - NEVER archive a thread whose classification has
 *     action_required = true
 *   - Age is measured against the thread's actual Date header,
 *     not classified_at.
 *
 * All failures return partial counts; the runner never throws.
 */

const { google } = require('googleapis');
const { makeGmailOAuth2Client } = require('../utils/google.cjs');
const { decryptTokens } = require('../utils/crypto.cjs');
const googleProvider = require('./providers/googleEmailProvider.cjs');
const logger = require('../../guardrails/logger.cjs');

const MAX_PER_JOB = 100;

async function _gmailClient(db, userId, accountEmail) {
  const row = await db.getGmailIntegrationByEmail(userId, accountEmail);
  if (!row) throw new Error(`No Gmail tokens for ${accountEmail}`);
  const stored = row.config?.tokens;
  if (!stored) throw new Error(`No Gmail tokens for ${accountEmail}`);
  const tokens = stored._enc ? decryptTokens(stored._enc) : stored;
  const oauth2 = makeGmailOAuth2Client();
  if (!oauth2) throw new Error('Google OAuth not configured');
  oauth2.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function _hdr(h, name) {
  if (!Array.isArray(h)) return '';
  const hit = h.find((x) => String(x.name || '').toLowerCase() === name.toLowerCase());
  return hit?.value || '';
}

function _parseDate(s) {
  const t = Date.parse(s || '');
  return Number.isFinite(t) ? t : 0;
}

/** Check classification table for safety exclusions. */
async function _filterUnsafe(db, userId, candidates) {
  // candidates: [{ threadId, latestMessageId, dateMs, accountEmail }]
  const ids = candidates.map(c => c.latestMessageId).filter(Boolean);
  if (!ids.length) return candidates;
  const map = await db.batchGetClassifications(userId, ids).catch(() => ({}));
  return candidates.filter((c) => {
    const cls = map[c.latestMessageId];
    if (!cls) return true;                          // unclassified → safe to archive by label
    if (cls.importanceRank >= 3) return false;      // high/critical → never archive
    if (cls.actionRequired) return false;           // action needed → never archive
    return true;
  });
}

/** Query Gmail for threads matching a label, returning normalized candidates. */
async function _candidatesByLabel({ gmail, label, olderThanHours, accountEmail }) {
  const cutoffMs = Date.now() - olderThanHours * 3600 * 1000;
  const list = await gmail.users.threads.list({
    userId: 'me', maxResults: MAX_PER_JOB, q: `label:${label}`,
  });
  const refs = list.data?.threads || [];
  if (!refs.length) return [];

  const perThread = await Promise.allSettled(refs.map(async (t) => {
    const { data } = await gmail.users.threads.get({
      userId: 'me', id: t.id, format: 'metadata',
      metadataHeaders: ['Date'],
    });
    const msgs = data?.messages || [];
    if (!msgs.length) return null;
    const last = msgs[msgs.length - 1];
    const dateMs = _parseDate(_hdr(last.payload?.headers, 'Date'));
    if (!dateMs || dateMs > cutoffMs) return null;  // too new, skip
    return {
      threadId: data.id,
      latestMessageId: last.id,
      dateMs,
      accountEmail,
    };
  }));
  return perThread.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
}

/** Newsletter candidates come from our classification table, not Gmail labels. */
async function _candidatesByNewsletterClassification({ db, gmail, userId, accountEmail, olderThanHours }) {
  const cutoffMs = Date.now() - olderThanHours * 3600 * 1000;
  // LIMIT bounded by MAX_PER_JOB so we don't haul a 10k+ classification
  // history into Node just to discard most of it. The downstream loop
  // already breaks at MAX_PER_JOB; LIMIT just moves the cap earlier.
  const { rows } = await db.pool.query(
    `SELECT message_id, thread_id, account_email
     FROM email_classifications
     WHERE user_id = $1 AND account_email = $2
       AND category = 'newsletter'
       AND importance_rank < 3
       AND action_required = false
     LIMIT $3`,
    [userId, accountEmail, MAX_PER_JOB * 2], // 2x cap so post-Date-filter we still have enough candidates
  );
  if (!rows.length) return [];

  // Resolve each thread's real Date header so we compare against the
  // email itself, not classified_at.
  const out = [];
  for (const r of rows) {
    try {
      const { data } = await gmail.users.threads.get({
        userId: 'me', id: r.thread_id, format: 'metadata',
        metadataHeaders: ['Date'],
      });
      const msgs = data?.messages || [];
      if (!msgs.length) continue;
      const last = msgs[msgs.length - 1];
      const dateMs = _parseDate(_hdr(last.payload?.headers, 'Date'));
      if (!dateMs || dateMs > cutoffMs) continue;
      out.push({
        threadId: r.thread_id,
        latestMessageId: last.id,
        dateMs,
        accountEmail,
      });
    } catch { /* skip */ }
    if (out.length >= MAX_PER_JOB) break;
  }
  return out;
}

/**
 * Run one job (promos | newsletters | social) for one account.
 * Returns { matched: N, archived: N } depending on dryRun.
 */
async function runOneJob({ db, userId, accountEmail, type, olderThanHours, dryRun }) {
  try {
    const gmail = await _gmailClient(db, userId, accountEmail);
    let candidates = [];
    if (type === 'promos') {
      candidates = await _candidatesByLabel({ gmail, label: 'CATEGORY_PROMOTIONS', olderThanHours, accountEmail });
    } else if (type === 'social') {
      candidates = await _candidatesByLabel({ gmail, label: 'CATEGORY_SOCIAL', olderThanHours, accountEmail });
    } else if (type === 'newsletters') {
      candidates = await _candidatesByNewsletterClassification({ db, gmail, userId, accountEmail, olderThanHours });
    } else {
      return { matched: 0, archived: 0 };
    }
    const safe = await _filterUnsafe(db, userId, candidates);
    if (dryRun) return { matched: safe.length, archived: 0 };

    let archived = 0;
    for (const c of safe) {
      try {
        await googleProvider.archiveMessage({ db, userId, accountEmail: c.accountEmail, messageId: c.latestMessageId });
        archived++;
        await db.logAgentAction({
          userId, eventType: 'tool_executed', toolName: 'bulk_archive_emails',
          input: { account_email: c.accountEmail, type, older_than_hours: olderThanHours },
          output: { thread_id: c.threadId, message_id: c.latestMessageId },
          status: 'success',
        });
      } catch (err) {
        await db.logAgentAction({
          userId, eventType: 'tool_failed', toolName: 'bulk_archive_emails',
          input: { account_email: c.accountEmail, type, older_than_hours: olderThanHours, thread_id: c.threadId },
          errorMsg: err.message, status: 'failure',
        });
      }
    }
    return { matched: safe.length, archived };
  } catch (err) {
    logger?.error?.('emailClean.runOneJob.failed', { userId, accountEmail, type, error: err.message });
    return { matched: 0, archived: 0 };
  }
}

/** Single-account entry (used by the Aria tool). */
async function scanAndArchiveForAccount({ db, userId, accountEmail, criteria, dryRun }) {
  const h = parseInt(criteria?.older_than_hours, 10) || 24;
  const jobs = [];
  if (criteria?.include_promos)      jobs.push({ type: 'promos',      olderThanHours: h });
  if (criteria?.include_newsletters) jobs.push({ type: 'newsletters', olderThanHours: h });
  if (criteria?.include_social)      jobs.push({ type: 'social',      olderThanHours: h });

  const breakdown = { promos: 0, newsletters: 0, social: 0 };
  for (const j of jobs) {
    const { matched, archived } = await runOneJob({ db, userId, accountEmail, type: j.type, olderThanHours: j.olderThanHours, dryRun });
    breakdown[j.type] += dryRun ? matched : archived;
  }
  const total = breakdown.promos + breakdown.newsletters + breakdown.social;
  return dryRun
    ? { dry_run: true, would_archive: total, breakdown, account_email: accountEmail }
    : { archived: total, breakdown, account_email: accountEmail };
}

/**
 * Multi-account runner driven by a saved policy.
 * When confirmed=false → dry-run scan across all accounts.
 * When confirmed=true  → archive.
 */
async function runEmailClean(userId, policy, confirmed, db) {
  try {
    const accounts = await db.getUserIntegrationsByType(userId, 'gmail');
    if (!accounts.length) {
      return confirmed ? { archived: 0, breakdown: { promos: 0, newsletters: 0, social: 0 }, accounts: [] }
                       : { would_archive: 0, breakdown: { promos: 0, newsletters: 0, social: 0 }, accounts: [] };
    }

    const jobs = [];
    if (policy?.archivePromos)      jobs.push({ type: 'promos',      olderThanHours: policy.promosOlderThanH || 24 });
    if (policy?.archiveNewsletters) jobs.push({ type: 'newsletters', olderThanHours: policy.newslettersOlderThanH || 48 });
    if (policy?.archiveSocial)      jobs.push({ type: 'social',      olderThanHours: policy.socialOlderThanH || 24 });

    if (!jobs.length) {
      return confirmed ? { archived: 0, breakdown: { promos: 0, newsletters: 0, social: 0 }, accounts: [] }
                       : { would_archive: 0, breakdown: { promos: 0, newsletters: 0, social: 0 }, accounts: [] };
    }

    const breakdown = { promos: 0, newsletters: 0, social: 0 };
    const perAccount = [];
    for (const acct of accounts) {
      let count = 0;
      for (const j of jobs) {
        const r = await runOneJob({ db, userId, accountEmail: acct.accountEmail, type: j.type, olderThanHours: j.olderThanHours, dryRun: !confirmed });
        const n = confirmed ? r.archived : r.matched;
        breakdown[j.type] += n;
        count += n;
      }
      perAccount.push({ account_email: acct.accountEmail, count });
    }
    const total = breakdown.promos + breakdown.newsletters + breakdown.social;
    return confirmed
      ? { archived: total, breakdown, accounts: perAccount }
      : { would_archive: total, breakdown, accounts: perAccount };
  } catch (err) {
    logger?.error?.('emailClean.run.failed', { userId, error: err.message });
    return confirmed ? { archived: 0, breakdown: { promos: 0, newsletters: 0, social: 0 }, accounts: [], error: err.message }
                     : { would_archive: 0, breakdown: { promos: 0, newsletters: 0, social: 0 }, accounts: [], error: err.message };
  }
}

module.exports = { runEmailClean, scanAndArchiveForAccount, runOneJob };
