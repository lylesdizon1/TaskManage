'use strict';

/**
 * server/lib/staleClassificationSweep.cjs — force re-classify stale
 * unacked flagged emails so they pick up the current classifier version.
 *
 * Background: classifyEmail's freshness check refuses to honor a cached
 * row whose classifier_version is stale, so re-classification IS the
 * intended behavior — but only "on next sight" via inbox sync. Old
 * flagged threads aren't in the recent inbox window so they never
 * naturally re-touch. Result (per the May 5 audit): for user-lyle,
 * 12 of 15 unacked flagged classifications were stuck on v1.3 even
 * after v1.5 shipped, and the critical_email_unacked tile inflated.
 *
 * This sweep closes that gap. For each user, it fetches the email
 * content for unacked flagged items still on a stale version, and
 * runs them through classifyEmail. classifyEmail then handles
 * auto-flag-or-unflag automatically (auto-unflag-on-demote shipped
 * in commit 9fd3bb5 means demoted Hubstaff weeklies, paid receipts,
 * etc. drop the flag without manual intervention).
 *
 * Bounds (per user, per run):
 *   • MAX_PER_USER_PER_RUN — Gmail API call ceiling
 *   • PER_EMAIL_TIMEOUT_MS — propagated through getEmailContent
 *   • Sequential (not parallel) — keeps Gmail rate-limit budget
 *
 * V1 scope: Gmail only. Outlook items skipped (account_email LIKE
 * 'outlook:%' filter). Outlook content fetcher uses a different
 * provider; backfill for that is a follow-up.
 *
 * Fire-and-forget. Never throws past the boundary.
 */

const logger = require('../../guardrails/logger.cjs');
const db = require('../../db.cjs');
const { CLASSIFIER_VERSION, classifyEmail } = require('./classificationEngine.cjs');
const { getEmailContent } = require('./emailContent.cjs');

const MAX_PER_USER_PER_RUN = 20;

async function sweepStaleClassificationsForUser(userId, opts = {}) {
  const limit = opts.limit ?? MAX_PER_USER_PER_RUN;
  const stats = { swept: 0, candidates: 0, fetch_failed: 0, classify_failed: 0 };
  try {
    if (!userId) return stats;
    // Find unacked flagged inbox_items whose classification is stale.
    // Newest-flagged first so the most user-visible rows fix soonest.
    const { rows } = await db.pool.query(
      `SELECT ii.source_id,
              ec.message_id, ec.account_email, ec.is_read,
              ec.classification_reasoning->>'classifier_version' AS version
         FROM inbox_items ii
         JOIN email_classifications ec
           ON ec.user_id = ii.user_id AND ec.thread_id = ii.source_id
        WHERE ii.user_id = $1
          AND ii.flagged_at IS NOT NULL
          AND ii.flagged_acked_at IS NULL
          AND (ec.classification_reasoning->>'classifier_version' IS DISTINCT FROM $2)
          AND COALESCE(ec.account_email, '') NOT LIKE 'outlook:%'
        ORDER BY ii.flagged_at DESC
        LIMIT $3`,
      [userId, CLASSIFIER_VERSION, limit],
    );
    stats.candidates = rows.length;
    if (rows.length === 0) return stats;

    for (const r of rows) {
      try {
        const content = await getEmailContent(userId, r.message_id, r.account_email, db, { allowMetadataFallback: true });
        if (!content?.hasContent) {
          stats.fetch_failed++;
          continue;
        }
        // Re-run classifyEmail. Pass labelIds + content. headers omitted
        // (full-payload Gmail fetches return headers, but emailContent
        // only surfaces extracted from/to/subject — bulk-heuristic still
        // catches sender + subject + body patterns, which covers the
        // common demotion paths: bulk_sender, promo_subject,
        // unsubscribe_body). Re-classify for these picks up v1.5's
        // newsletter/low → actionRequired=false invariant and triggers
        // auto-unflag-on-demote when the new classification falls below
        // auto-flag thresholds.
        const result = await classifyEmail({
          userId,
          messageId: r.message_id,
          threadId: r.source_id,
          accountEmail: r.account_email,
          from: content.from,
          subject: content.subject,
          body: content.body || '',
          isRead: !!r.is_read,
          labelIds: content.labelIds || [],
          headers: [],
          db,
        });
        if (result) stats.swept++;
        else stats.classify_failed++;
      } catch (err) {
        stats.classify_failed++;
        logger.warn('staleClassification.row.failed', {
          userId, messageId: r.message_id, error: err.message,
        });
      }
    }
    logger.info('staleClassification.user.complete', { userId, ...stats });
    return stats;
  } catch (err) {
    logger.error('staleClassification.user.failed', { userId, error: err.message });
    return { ...stats, error: err.message };
  }
}

async function sweepStaleClassificationsAllUsers() {
  const totals = { userCount: 0, swept: 0, candidates: 0, fetch_failed: 0, classify_failed: 0 };
  try {
    const userIds = await db.getAllUserIds();
    totals.userCount = userIds.length;
    for (const userId of userIds) {
      const r = await sweepStaleClassificationsForUser(userId);
      totals.swept         += r.swept || 0;
      totals.candidates    += r.candidates || 0;
      totals.fetch_failed  += r.fetch_failed || 0;
      totals.classify_failed += r.classify_failed || 0;
    }
    logger.info('staleClassification.all.complete', totals);
    return totals;
  } catch (err) {
    logger.error('staleClassification.all.failed', { error: err.message });
    return { ...totals, error: err.message };
  }
}

module.exports = {
  sweepStaleClassificationsForUser,
  sweepStaleClassificationsAllUsers,
  MAX_PER_USER_PER_RUN,
};
