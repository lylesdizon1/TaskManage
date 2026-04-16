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

const VALID_SOURCE_TYPES = new Set(['task', 'event', 'project_task']);

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
      return res.status(500).json({ error: err.message });
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
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
