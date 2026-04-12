'use strict';

/**
 * server/routes/learnings.cjs — Aria Learnings CRUD (read + soft-delete).
 *
 *   GET    /api/learnings       — all active learnings for req.user.id
 *   DELETE /api/learnings/:id   — deactivate a learning (scoped to user)
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');

module.exports = function createLearningsRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/learnings', authenticateToken, async (req, res) => {
    try {
      const rows = await db.getUserLearnings(req.user.id);
      res.json({ learnings: rows });
    } catch (err) {
      logger.error('learnings.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/learnings/:id', authenticateToken, async (req, res) => {
    try {
      const ok = await db.deactivateLearning(req.params.id, req.user.id);
      if (!ok) return res.status(404).json({ error: 'Learning not found' });
      res.json({ success: true });
    } catch (err) {
      logger.error('learnings.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
