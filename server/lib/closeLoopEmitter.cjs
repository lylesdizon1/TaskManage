'use strict';

/**
 * server/lib/closeLoopEmitter.cjs — fire-and-forget wrapper around
 * db.emitCloseLoopItem. Thin by design so the task/event/project
 * completion paths don't repeat the try/catch + logging scaffold.
 *
 * HARD CONTRACT:
 *   • Never throws.
 *   • Callers may await or ignore the promise — both are safe.
 */

const db = require('../../db.cjs');
const logger = require('../../guardrails/logger.cjs');

async function emitCloseLoop(userId, sourceType, sourceId, titleSnapshot) {
  try {
    if (!userId || !sourceType || !sourceId) return null;
    const row = await db.emitCloseLoopItem(userId, sourceType, String(sourceId), titleSnapshot || null);
    logger.info('closeloop.emitted', { userId, sourceType, sourceId: String(sourceId) });
    return row;
  } catch (err) {
    logger.error('closeloop.emit.failed', {
      userId,
      sourceType,
      sourceId: String(sourceId),
      error: err.message,
      stack: err.stack,
    });
    return null;
  }
}

/**
 * Sweep recently-ended events with no outcome note and no existing
 * pcl row, emit a 'event' close-loop for each so the Active Zone can
 * surface "How did your meeting go?" prompts.
 *
 * Called from the calendar sync paths (Outlook + GCal) so the sweep
 * runs every 15 min on the same cron tick that already touches each
 * user's calendar. Bounded to events that ended within the last 24h
 * so we don't keep re-emitting on day-old meetings the user ignored.
 *
 * Idempotent — the LEFT JOIN ... IS NULL guards plus the unique
 * (user_id, source_type, source_id) constraint on pending_close_loop
 * mean repeat sweeps in the same window no-op.
 *
 * Fire-and-forget. Never throws.
 */
async function sweepEventCloseLoops(userId) {
  try {
    if (!userId) return 0;
    // 2026-05-26 (Path C) — multi-account calendars produce N ce rows
    // per logical meeting. Without DISTINCT ON, the sweep would attempt
    // N inserts per meeting; pending_close_loop's UNIQUE constraint
    // makes the 2nd/Nth inserts no-op so behavior is correct, but
    // emitCloseLoop's logger reports N spurious "emitted" entries.
    // DISTINCT ON keeps the audit log honest and saves N-1 inserts per
    // meeting on busy sweeps.
    const { rows } = await db.pool.query(
      `SELECT DISTINCT ON (ce.user_id, ce.id) ce.id, ce.title
       FROM calendar_events ce
       LEFT JOIN calendar_notes cn
         ON cn.user_id = ce.user_id AND cn.event_id = ce.id AND cn.post_note IS NOT NULL
       LEFT JOIN pending_close_loop pcl
         ON pcl.user_id = ce.user_id AND pcl.source_type = 'event' AND pcl.source_id = ce.id
       WHERE ce.user_id = $1
         AND ce.end_time < NOW()
         AND ce.end_time > NOW() - INTERVAL '24 hours'
         AND ce.all_day = false
         AND cn.id IS NULL
         AND pcl.id IS NULL
       ORDER BY ce.user_id, ce.id, ce.synced_at DESC`,
      [userId],
    );
    let emitted = 0;
    for (const r of rows) {
      const row = await emitCloseLoop(userId, 'event', r.id, r.title);
      if (row) emitted++;
    }
    if (emitted > 0) {
      logger.info('closeloop.event.swept', { userId, emitted, candidates: rows.length });
    }
    return emitted;
  } catch (err) {
    logger.error('closeloop.event.sweep.failed', { userId, error: err.message });
    return 0;
  }
}

module.exports = { emitCloseLoop, sweepEventCloseLoops };
