'use strict';

const express = require('express');

/**
 * User preferences routes extracted from proxy-server.cjs
 *
 *   GET  /api/preferences  — read current user's preferences
 *   POST /api/preferences  — save current user's preferences
 */
module.exports = function createPreferencesRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/preferences', authenticateToken, async (req, res) => {
    try {
      const prefs = await db.getUserPreferences(req.user.id);
      return res.json(prefs || { theme: 'light', defaultTagFilter: [], defaultStatusFilter: 'all', notificationsEnabled: true });
    } catch (err) {
      console.error('[preferences] read failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/preferences', authenticateToken, async (req, res) => {
    try {
      await db.saveUserPreferences(req.user.id, req.body);
      return res.json({ success: true });
    } catch (err) {
      console.error('[preferences] write failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/preferences/dnd', authenticateToken, async (req, res) => {
    try {
      const { dndStart, dndEnd } = req.body;
      const timeRe = /^\d{2}:\d{2}$/;
      if (!timeRe.test(dndStart) || !timeRe.test(dndEnd)) {
        return res.status(400).json({ error: 'dndStart and dndEnd must be HH:MM format' });
      }
      await db.updateDndPreferences(req.user.id, dndStart, dndEnd);
      return res.json({ success: true });
    } catch (err) {
      console.error('[preferences/dnd] PUT failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
