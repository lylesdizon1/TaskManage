'use strict';

const express = require('express');
const logger = require('../../guardrails/logger.cjs');

/**
 * Entity routes extracted from proxy-server.cjs
 *
 *   GET    /api/entities      — list entities (admin sees all, others see own + shared)
 *   POST   /api/entities      — any user: create entity
 *   PUT    /api/entities/:id  — owner or admin: update entity
 *   DELETE /api/entities/:id  — owner or admin: delete entity
 */
module.exports = function createEntitiesRouter({ authenticateToken, requireAdmin, db }) {
  const router = express.Router();

  router.get('/api/entities', authenticateToken, async (req, res) => {
    try {
      // Canonical access path (Phase 2): creator + org-wide-with-user's-org
      // + explicit entity_members membership. orgId is null when the user
      // has no org — the org clause simply won't match.
      const entities = await db.getEntitiesForUserWithMembership(
        req.user.id,
        req.user.orgId || null,
      );
      return res.json(entities);
    } catch (err) {
      logger.error('entities.read.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  router.post('/api/entities', authenticateToken, async (req, res) => {
    try {
      const { id, name, color, type, parentId, shared } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      // Members can only create private entities
      const isPrivileged = req.user.role === 'admin' || req.user.role === 'superadmin';
      const entityShared = isPrivileged ? (shared || false) : false;
      const validTypes = ['business', 'project', 'personal'];
      if (type && !validTypes.includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
      }
      if (parentId) {
        const parent = await db.getEntityById(parentId);
        if (!parent) return res.status(400).json({ error: 'Parent entity not found' });
      }
      const entity = await db.createEntity({
        id: id || `entity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name, color, createdBy: req.user.id,
        type: type || 'business', parentId: parentId || null, shared: entityShared,
      });
      return res.json(entity);
    } catch (err) {
      logger.error('entities.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      if (err.message.includes('already exists')) {
        return res.status(409).json({ error: err.message });
      }
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/entities/:id', authenticateToken, async (req, res) => {
    try {
      // Owner-only mutation — no admin/superadmin bypass. Cross-tenant
      // mutation (if ever needed) belongs in /api/admin/* routes.
      const existing = await db.getEntityById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Entity not found' });
      if (existing.createdBy !== req.user.id) {
        return res.status(403).json({ error: 'You can only edit your own entities' });
      }
      const validTypes = ['business', 'project', 'personal'];
      if (req.body.type && !validTypes.includes(req.body.type)) {
        return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
      }
      if (req.body.parentId) {
        const parent = await db.getEntityById(req.body.parentId);
        if (!parent) return res.status(400).json({ error: 'Parent entity not found' });
      }
      const updated = await db.updateEntity(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Entity not found' });
      return res.json(updated);
    } catch (err) {
      logger.error('entities.update.failed', { requestId: req.requestId, userId: req.user?.id, entityId: req.params.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/entities/:id', authenticateToken, async (req, res) => {
    try {
      // Owner-only deletion — no admin/superadmin bypass.
      const existing = await db.getEntityById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Entity not found' });
      if (existing.createdBy !== req.user.id) {
        return res.status(403).json({ error: 'Only the owner can delete this entity' });
      }
      await db.deleteEntity(req.params.id, req.user.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('entities.delete.failed', { requestId: req.requestId, userId: req.user?.id, entityId: req.params.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
