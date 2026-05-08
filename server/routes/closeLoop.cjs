'use strict';

/**
 * server/routes/closeLoop.cjs — ambient-capture queue mutation endpoints.
 *
 * Writers:
 *   POST /api/close-loop/dismiss   { source_type, source_id }
 *   POST /api/close-loop/resolve   { source_type, source_id }
 *
 * Both routes are user-scoped via req.user.id and never accept the
 * userId from the body. They return 404 when the row doesn't exist for
 * the authenticated user — the DB helpers already scope by user_id, so
 * a stolen row id returns rowCount=0 and we map that to 404 without
 * leaking existence.
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { enrichOutcomeRecord } = require('../lib/outcomeEnrichment.cjs');

const VALID_SOURCE_TYPES = new Set(['task', 'event', 'project_task']);
const VALID_OUTCOME_STATUSES = new Set(['success', 'mixed', 'neutral', 'failed', 'cancelled', 'no_show']);
const MAX_BATCH_ITEMS = 50;
const MAX_RAW_NOTE_CHARS = 2000;

module.exports = function createCloseLoopRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.post('/api/close-loop/dismiss', authenticateToken, async (req, res) => {
    try {
      const { source_type: sourceType, source_id: sourceId } = req.body || {};
      if (!sourceType || !VALID_SOURCE_TYPES.has(sourceType)) {
        return res.status(400).json({ error: `source_type must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}` });
      }
      if (!sourceId) return res.status(400).json({ error: 'source_id required' });
      const ok = await db.dismissCloseLoopItem(req.user.id, sourceType, String(sourceId));
      if (!ok) return res.status(404).json({ error: 'Pending close-loop item not found' });
      return res.json({ success: true });
    } catch (err) {
      logger.error('closeLoop.dismiss.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/close-loop/resolve', authenticateToken, async (req, res) => {
    try {
      const { source_type: sourceType, source_id: sourceId } = req.body || {};
      if (!sourceType || !VALID_SOURCE_TYPES.has(sourceType)) {
        return res.status(400).json({ error: `source_type must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}` });
      }
      if (!sourceId) return res.status(400).json({ error: 'source_id required' });
      // Resolve is idempotent: if no row exists (e.g. task completion-note
      // saved on a task that never triggered a close-loop), return success.
      // This keeps client callers simple — fire-and-forget with no need to
      // check whether a row exists first.
      await db.resolveCloseLoopItem(req.user.id, sourceType, String(sourceId));
      return res.json({ success: true });
    } catch (err) {
      logger.error('closeLoop.resolve.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/close-loop/resolve-batch — bulk close + outcome ──────
  // Body: { items: [{ source_type, source_id, outcome_status?,
  //                   raw_note?, title_snapshot? }, ...] }
  //
  // Per-item:
  //   - Always flips pending_close_loop.resolved_at (matches single
  //     /resolve behavior).
  //   - When outcome_status is set, ALSO writes outcome_records and
  //     fires fire-and-forget enrichOutcomeRecord (Haiku — sentiment,
  //     follow-up suggestions, themes, durable memory facts).
  //
  // Idempotent on outcome_records via existence check inside the
  // transaction — preserves any prior OutcomePrompt capture for the
  // same (user, source). Doesn't require a unique constraint
  // migration on the production table.
  //
  // The batch wraps in BEGIN/COMMIT — partial-success is impossible.
  // Either the whole batch lands or the whole batch rolls back.
  router.post('/api/close-loop/resolve-batch', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const items = Array.isArray(req.body?.items) ? req.body.items : null;
      if (!items || items.length === 0) {
        return res.status(400).json({ error: 'items array is required and must be non-empty' });
      }
      if (items.length > MAX_BATCH_ITEMS) {
        return res.status(400).json({ error: `Too many items (max ${MAX_BATCH_ITEMS} per batch)` });
      }

      // Validate every item up front so a bad item rejects the whole
      // batch with a clear message rather than silently dropping it.
      const normalized = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const sourceType = it.source_type;
        const sourceId = it.source_id;
        if (!sourceType || !VALID_SOURCE_TYPES.has(sourceType)) {
          return res.status(400).json({ error: `items[${i}].source_type must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}` });
        }
        if (!sourceId) return res.status(400).json({ error: `items[${i}].source_id required` });

        const outcomeStatus = it.outcome_status || null;
        if (outcomeStatus && !VALID_OUTCOME_STATUSES.has(outcomeStatus)) {
          return res.status(400).json({
            error: `items[${i}].outcome_status must be one of: ${[...VALID_OUTCOME_STATUSES].join(', ')}`,
          });
        }
        const rawNote = it.raw_note ? String(it.raw_note).slice(0, MAX_RAW_NOTE_CHARS) : null;

        normalized.push({
          sourceType,
          sourceId: String(sourceId),
          outcomeStatus,
          rawNote,
          titleSnapshot: it.title_snapshot ? String(it.title_snapshot).slice(0, 500) : null,
        });
      }

      const result = await db.resolveCloseLoopBatch(userId, normalized);

      // Fire-and-forget enrichment for each new outcome row. Safe-no-op
      // when CLAUDE_API_KEY missing or when rawNote is empty (the
      // enricher skips empty notes internally). enrichOutcomeRecord
      // never throws past its boundary — fire and continue.
      for (const o of (result.newOutcomes || [])) {
        enrichOutcomeRecord(o.id, userId, o)
          .catch((err) => logger.warn('closeLoop.batch.enrichmentFailed', {
            requestId: req.requestId, userId, outcomeId: o.id, error: err.message,
          }));
      }

      logger.info('closeLoop.batch.resolved', {
        requestId: req.requestId, userId,
        items: normalized.length,
        resolved: result.resolved,
        withOutcome: result.withOutcome,
      });

      return res.json({
        success: true,
        resolved: result.resolved,
        withOutcome: result.withOutcome,
      });
    } catch (err) {
      logger.error('closeLoop.batch.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/close-loop/capture-rate — observability ──────────────
  // Tiny endpoint for the user (or upcoming /api/admin/sync-health)
  // to measure the V1 lift. Returns capture rate over last N days.
  router.get('/api/close-loop/capture-rate', authenticateToken, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 7));
      const stats = await db.getOutcomeCaptureRate(req.user.id, days);
      return res.json({ days, ...stats });
    } catch (err) {
      logger.error('closeLoop.captureRate.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
