'use strict';

/**
 * server/routes/outcomes.cjs — Outcome Intelligence capture endpoints.
 *
 *   POST /api/outcomes      Create an outcome_records row for a
 *                           completed task or event.
 *   GET  /api/outcomes      List the authenticated user's outcomes,
 *                           newest first (paginated).
 *
 * User-scoped via authenticateToken + helpers that accept userId.
 * No admin bypass — cross-tenant visibility belongs in /api/admin/*.
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { enrichOutcomeRecord } = require('../lib/outcomeEnrichment.cjs');

const VALID_SOURCE_TYPES = new Set(['task', 'event']);
const VALID_STATUSES = new Set(['success', 'mixed', 'neutral', 'failed', 'cancelled', 'no_show']);
const VALID_ENTERED_BY = new Set(['user', 'assistant', 'system', 'staff']);

module.exports = function createOutcomesRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.post('/api/outcomes', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const {
        sourceType, sourceId, completedAt, titleSnapshot,
        rawNote, outcomeStatus, followUpNeeded, followUpBy,
        enteredBy,
      } = req.body || {};

      if (!sourceType || !VALID_SOURCE_TYPES.has(sourceType)) {
        return res.status(400).json({ error: 'sourceType must be "task" or "event"' });
      }
      if (!sourceId) return res.status(400).json({ error: 'sourceId required' });
      if (outcomeStatus && !VALID_STATUSES.has(outcomeStatus)) {
        return res.status(400).json({ error: `outcomeStatus must be one of: ${[...VALID_STATUSES].join(', ')}` });
      }
      const safeEnteredBy = enteredBy && VALID_ENTERED_BY.has(enteredBy) ? enteredBy : 'user';

      const outcome = await db.createOutcomeRecord(userId, {
        sourceType,
        sourceId: String(sourceId),
        completedAt: completedAt || null,
        titleSnapshot: titleSnapshot || null,
        rawNote: rawNote || null,
        outcomeStatus: outcomeStatus || null,
        followUpNeeded: !!followUpNeeded,
        followUpBy: followUpBy || null,
        enteredBy: safeEnteredBy,
      });

      // Fire-and-forget Haiku enrichment — never blocks the response.
      enrichOutcomeRecord(outcome.id, userId, outcome)
        .catch((err) => console.error('[outcome-enrichment] failed:', err.message));

      return res.json({ success: true, outcome });
    } catch (err) {
      logger.error('outcomes.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/outcomes', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const outcomes = await db.getOutcomeRecordsForUser(userId, limit, offset);
      return res.json({ outcomes });
    } catch (err) {
      logger.error('outcomes.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json({ outcomes: [] });
    }
  });

  return router;
};
