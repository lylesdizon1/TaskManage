'use strict';

const express = require('express');
const { executeTool } = require('../tools.cjs');
const logger = require('../../guardrails/logger.cjs');

/** Map internal error messages to safe user-facing copy. */
function sanitizeError(msg) {
  const s = String(msg || '');
  if (/not found/i.test(s)) return 'Item not found';
  if (/OAuth|auth|token|not connected/i.test(s)) return 'Calendar not connected — check your integrations';
  return 'Something went wrong — please try again';
}

/**
 * tileExecute — direct tool execution for Command Center tile confirmations.
 *
 * Bypasses buildAgenticContext and the Claude API entirely. The tile UI has
 * already collected the exact fields; we just call the tool handler.
 * Target latency: < 2s.
 */
module.exports = function createTileExecuteRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.post('/api/tile/execute', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const entityIds = req.user.entityIds || [];
    const tz = req.user.timezone || 'America/Los_Angeles';
    const { type, payload = {} } = req.body || {};

    try {
      let toolName;
      let toolInput;

      if (type === 'task') {
        toolName = 'create_task';
        toolInput = {
          title: payload.title,
          due_date: payload.due_date || undefined,
          priority: payload.priority || 'medium',
        };
        if (!toolInput.title) return res.status(400).json({ success: false, error: 'title required' });
      } else if (type === 'event') {
        toolName = 'create_event';
        toolInput = {
          title: payload.title,
          start_datetime: payload.start_datetime,
          end_datetime: payload.end_datetime || undefined,
        };
        if (!toolInput.title || !toolInput.start_datetime) {
          return res.status(400).json({ success: false, error: 'title and start_datetime required' });
        }
      } else {
        return res.status(400).json({ success: false, error: `Unsupported tile type: ${type}` });
      }

      const result = await executeTool(toolName, toolInput, userId, entityIds, db, tz);
      if (result && result.success === false) {
        logger.warn('tile.execute.toolFailure', { requestId: req.requestId, userId, type, internal: result.error });
        return res.status(400).json({ success: false, error: sanitizeError(result.error) });
      }
      return res.json({ success: true, result });
    } catch (err) {
      logger.error('tile.execute.failed', { requestId: req.requestId, userId, type, error: err.message });
      return res.status(500).json({ success: false, error: sanitizeError(err.message) });
    }
  });

  return router;
};
