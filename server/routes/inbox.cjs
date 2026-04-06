'use strict';

const express = require('express');

module.exports = function createInboxRouter({ authenticateToken, db }) {
  const router = express.Router();

  /**
   * GET /api/inbox/items
   * Returns all inbox_items for the authenticated user.
   */
  router.get('/api/inbox/items', authenticateToken, async (req, res) => {
    try {
      const items = await db.getInboxItemsForUser(req.user.id);
      res.json(items);
    } catch (err) {
      console.error('[inbox] fetch failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PATCH /api/inbox/items/:id
   * Body: { action } — e.g. 'dismissed'
   * Sets action_taken on the inbox item.
   */
  router.patch('/api/inbox/items/:id', authenticateToken, async (req, res) => {
    const { action } = req.body;
    if (!action) return res.status(400).json({ error: 'action required' });

    try {
      await db.updateInboxItemAction(req.params.id, action);
      res.json({ success: true });
    } catch (err) {
      console.error('[inbox] action update failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
