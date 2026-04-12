'use strict';

/**
 * server/routes/agentActions.cjs — read-only feed of Aria's actions.
 *
 *   GET /api/agent-actions
 *     ?days=N      (1-30, default 7)
 *     ?date=YYYY-MM-DD (single day; takes precedence over `days`)
 *
 * Returns actions ordered by created_at DESC, scoped to req.user.id,
 * plus a summary count bucket used by the Aria Activity page header.
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');

module.exports = function createAgentActionsRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/agent-actions', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;

      let whereClause = `user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`;
      const params = [userId];

      if (req.query.date) {
        const d = String(req.query.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
          return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
        }
        whereClause = `user_id = $1 AND created_at::date = $2::date`;
        params.push(d);
      } else if (req.query.days) {
        const n = parseInt(req.query.days, 10);
        if (!Number.isFinite(n) || n < 1 || n > 30) {
          return res.status(400).json({ error: 'days must be an integer between 1 and 30' });
        }
        whereClause = `user_id = $1 AND created_at >= NOW() - ($2 || ' days')::INTERVAL`;
        params.push(String(n));
      }

      const { rows } = await db.pool.query(
        `SELECT id, event_type, tool_name, input_json, output_json, status, error_msg,
                confidence, risk, confirm_id, created_at
         FROM agent_actions
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT 500`,
        params,
      );

      const summary = { total: rows.length, completed: 0, cancelled: 0, failed: 0, pending: 0 };
      for (const r of rows) {
        if (r.event_type === 'tool_executed' && r.status !== 'failure') summary.completed++;
        else if (r.event_type === 'tool_failed' || r.status === 'failure') summary.failed++;
        else if (r.event_type === 'tool_cancelled' || r.event_type === 'confirmation_rejected') summary.cancelled++;
        else if (r.event_type === 'confirmation_requested') summary.pending++;
      }

      res.json({ actions: rows, summary });
    } catch (err) {
      logger.error('agentActions.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
