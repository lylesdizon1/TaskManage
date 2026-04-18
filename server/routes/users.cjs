'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const logger = require('../../guardrails/logger.cjs');

/**
 * User routes extracted from proxy-server.cjs
 *
 *   PUT    /api/users/settings  — current user's persona/assistant/whatsapp settings
 *   GET    /api/users           — admin: list all users
 *   POST   /api/users           — admin: create user
 *   PUT    /api/users/:id       — admin: update user
 *   DELETE /api/users/:id       — admin: delete user
 */
module.exports = function createUsersRouter({ authenticateToken, requireAdmin, db }) {
  const router = express.Router();

  /**
   * PUT /api/users/settings
   * Body: { persona?, assistantName?, whatsappPhone? }
   * Updates the current user's persona, assistant name, and WhatsApp phone.
   */
  router.put('/api/users/settings', authenticateToken, async (req, res) => {
    try {
      const { persona, assistantName, whatsappPhone, profileName, profileBusinesses, profileHousehold, profileLocation, profileNotes } = req.body;
      const fields = {};
      if (persona !== undefined) fields.persona = persona;
      if (assistantName !== undefined) fields.assistantName = assistantName;
      if (whatsappPhone !== undefined) fields.whatsappPhone = whatsappPhone;
      if (profileName !== undefined) fields.profileName = profileName;
      if (profileBusinesses !== undefined) fields.profileBusinesses = profileBusinesses;
      if (profileHousehold !== undefined) fields.profileHousehold = profileHousehold;
      if (profileLocation !== undefined) fields.profileLocation = profileLocation;
      if (profileNotes !== undefined) fields.profileNotes = profileNotes;
      const updated = await db.updateUser(req.user.id, fields);
      if (!updated) return res.status(404).json({ error: 'User not found' });
      return res.json(updated);
    } catch (err) {
      logger.error('users.settings.updateFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── User management routes ───────────────────────────────────────────────────

  router.get('/api/users', authenticateToken, requireAdmin, async (_req, res) => {
    try {
      const users = await db.getUsers();
      // Strip password hashes from response
      const safe = users.map(({ passwordHash, ...u }) => u);
      return res.json(safe);
    } catch (err) {
      logger.error('users.read.failed', { requestId: req.requestId, error: err.message });
      return res.json([]);
    }
  });

  router.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const { username, displayName, email, password, role, entityIds } = req.body;
      if (!username || !password) return res.status(400).json({ error: 'username and password are required' });
      const id = `user-${Date.now().toString(36)}`;
      const passwordHash = await bcrypt.hash(password, 10);
      await db.upsertUser({ id, username, displayName: displayName || username, passwordHash, email, role, entityIds });
      return res.json({ id, username, displayName: displayName || username, email, role, entityIds });
    } catch (err) {
      logger.error('users.create.failed', { requestId: req.requestId, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      const fields = { ...req.body };
      // If password is provided, hash it
      if (fields.password) {
        fields.passwordHash = await bcrypt.hash(fields.password, 10);
        delete fields.password;
      }
      const updated = await db.updateUser(req.params.id, fields);
      if (!updated) return res.status(404).json({ error: 'User not found' });
      return res.json(updated);
    } catch (err) {
      logger.error('users.update.failed', { requestId: req.requestId, userId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: 'Cannot delete yourself' });
      }
      await db.deleteUser(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('users.delete.failed', { requestId: req.requestId, userId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
