'use strict';

const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');

module.exports = function createAdminRouter({ authenticateToken, requireSuperAdmin, JWT_SECRET, db }) {
  const router = express.Router();

  // All admin routes require superadmin
  router.use('/api/admin', authenticateToken, requireSuperAdmin);

  // ── Organizations ───────────────────────────────────────────────────────────

  router.get('/api/admin/orgs', async (req, res) => {
    try {
      const orgs = await db.getOrganizations();
      return res.json(orgs);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/orgs', async (req, res) => {
    const { name, type, adminEmail } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    try {
      const id = `org-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      const org = await db.createOrganization({ id, name, type: type || 'household', createdBy: req.user.id });

      // Create invite for org admin
      let invite = null;
      if (adminEmail) {
        const inviteId = `inv-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        invite = await db.createInvite({ id: inviteId, token, email: adminEmail, orgId: id, role: 'admin', invitedBy: req.user.id, expiresAt });
      }

      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'create_org', targetType: 'organization', targetId: id, metadata: { name, type, adminEmail } });
      return res.json({ org, invite });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/admin/orgs/:id/suspend', async (req, res) => {
    try {
      const updated = await db.updateOrganization(req.params.id, { active: false });
      if (!updated) return res.status(404).json({ error: 'Org not found' });
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'suspend_org', targetType: 'organization', targetId: req.params.id });
      return res.json(updated);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Users ────────────────────────────────────────────────────────────────────

  router.get('/api/admin/users', async (req, res) => {
    try {
      const users = await db.getAllUsersWithOrg();
      return res.json(users);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/admin/users/:id/suspend', async (req, res) => {
    try {
      const updated = await db.updateUser(req.params.id, { active: false });
      if (!updated) return res.status(404).json({ error: 'User not found' });
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'suspend_user', targetType: 'user', targetId: req.params.id });
      return res.json(updated);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Invites ──────────────────────────────────────────────────────────────────

  router.post('/api/admin/invites', async (req, res) => {
    const { email, orgId, role } = req.body;
    if (!email || !orgId) return res.status(400).json({ error: 'email and orgId required' });
    try {
      const id = `inv-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const invite = await db.createInvite({ id, token, email, orgId, role: role || 'member', invitedBy: req.user.id, expiresAt });
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'create_invite', targetType: 'invite', targetId: id, metadata: { email, orgId, role } });
      return res.json(invite);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Impersonation ────────────────────────────────────────────────────────────

  router.post('/api/admin/impersonate/:userId', async (req, res) => {
    try {
      const target = await db.getUserById(req.params.userId);
      if (!target) return res.status(404).json({ error: 'User not found' });

      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'impersonate', targetType: 'user', targetId: req.params.userId });

      const token = jwt.sign(
        {
          id: target.id,
          username: target.username,
          displayName: target.displayName,
          email: target.email || '',
          role: target.role || 'member',
          entityIds: target.entityIds || [],
          impersonatedBy: req.user.id,
        },
        JWT_SECRET,
        { expiresIn: '1h' },
      );

      return res.json({ token, user: { id: target.id, username: target.username, displayName: target.displayName, role: target.role } });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Audit log ────────────────────────────────────────────────────────────────

  router.get('/api/admin/audit-log', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = 20;
      const offset = (page - 1) * limit;
      const entries = await db.getAuditLog(limit, offset);
      return res.json(entries);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
