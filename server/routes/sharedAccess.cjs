'use strict';

/**
 * server/routes/sharedAccess.cjs — grant/revoke/list routes for V1
 * cross-user read access.
 *
 * Security invariants:
 *   • req.user.id is ALWAYS the grantor on writes (create/revoke).
 *   • req.user.id is ALWAYS the grantee on reads from granted-to-me.
 *   • Grantee is resolved server-side from email via getUserByIdentifier
 *     — never trusted from the request body.
 *   • Self-grants refused with 400.
 *   • Revocation never deletes; it sets revoked_at (auditable history).
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');

const VALID_SCOPES = new Set(['calendar_read', 'tasks_read', 'inbox_read', 'people_read', 'full_read']);

module.exports = function createSharedAccessRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/shared-access/grants', authenticateToken, async (req, res) => {
    try {
      const grants = await db.getGrantsForGrantor(req.user.id);
      res.json({ grants });
    } catch (err) {
      logger.error('sharedAccess.grants.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/shared-access/granted-to-me', authenticateToken, async (req, res) => {
    try {
      const grants = await db.getGrantsForGrantee(req.user.id);
      res.json({ grants });
    } catch (err) {
      logger.error('sharedAccess.granted-to-me.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/shared-access/grants', authenticateToken, async (req, res) => {
    try {
      const { grantee_email: granteeEmail, scope, expires_at: expiresAt } = req.body || {};
      if (!granteeEmail || !String(granteeEmail).trim()) return res.status(400).json({ error: 'grantee_email required' });
      if (!scope) return res.status(400).json({ error: 'scope required' });
      if (!VALID_SCOPES.has(scope)) return res.status(400).json({ error: `Invalid scope. Allowed: ${[...VALID_SCOPES].join(', ')}` });

      const grantee = await db.getUserByIdentifier(String(granteeEmail).trim());
      if (!grantee) return res.status(404).json({ error: 'User not on platform' });
      if (grantee.id === req.user.id) return res.status(400).json({ error: 'Cannot grant access to yourself' });

      const expiresAtDate = expiresAt ? new Date(expiresAt) : null;
      if (expiresAt && Number.isNaN(expiresAtDate?.getTime())) {
        return res.status(400).json({ error: 'expires_at must be a valid ISO timestamp' });
      }

      try {
        const grant = await db.createGrant(req.user.id, grantee.id, scope, null, expiresAtDate);
        logger.info('sharedAccess.granted', { grantor: req.user.id, grantee: grantee.id, scope });
        return res.json({ grant });
      } catch (e) {
        if (e.code === '23505') {
          return res.status(409).json({ error: 'Grant already exists for this grantee + scope' });
        }
        throw e;
      }
    } catch (err) {
      logger.error('sharedAccess.grant.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/shared-access/grants/:id', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
      // revokeGrant is scoped to the grantor, so unknown ids + stolen ids
      // from other grantors both produce rowCount 0 → 404.
      const ok = await db.revokeGrant(id, req.user.id);
      if (!ok) return res.status(404).json({ error: 'Grant not found' });
      logger.info('sharedAccess.revoked', { grantor: req.user.id, grantId: id });
      res.json({ success: true });
    } catch (err) {
      logger.error('sharedAccess.grant.revoke.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
