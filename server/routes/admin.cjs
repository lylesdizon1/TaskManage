'use strict';

const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');

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

  router.post('/api/admin/users', async (req, res) => {
    const { username, displayName, email, password, role, orgId } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      const id = `user-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
      await db.upsertUser({ id, username, displayName: displayName || username, passwordHash, email: email || '', role: role || 'member', entityIds: [] });
      if (orgId) {
        await db.addOrgMember(orgId, id, role || 'member', req.user.id);
      }
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'create_user', targetType: 'user', targetId: id, metadata: { username, email, orgId } });
      return res.json({ id, username, displayName: displayName || username, email, role: role || 'member' });
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

  router.put('/api/admin/users/:id/password', async (req, res) => {
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    try {
      const hash = await bcrypt.hash(password, 10);
      await db.updateUserPassword(req.params.id, hash);
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'reset_password', targetType: 'user', targetId: req.params.id });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/admin/users/:id/email', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });
    try {
      const updated = await db.updateUser(req.params.id, { email });
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'update_email', targetType: 'user', targetId: req.params.id, metadata: { email } });
      return res.json(updated);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/admin/users/:id/org', async (req, res) => {
    const { orgId, role } = req.body;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    try {
      await db.addOrgMember(orgId, req.params.id, role || 'member', req.user.id);
      // Update role if they're already a member
      await db.pool.query(
        `UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3`,
        [role || 'member', orgId, req.params.id]
      );
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'assign_org', targetType: 'user', targetId: req.params.id, metadata: { orgId, role } });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/admin/users/:id', async (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
    try {
      await db.deleteUser(req.params.id);
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'delete_user', targetType: 'user', targetId: req.params.id });
      return res.json({ success: true });
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

  // ── Agent Memory ─────────────────────────────────────────────────────────

  router.get('/api/admin/memory', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = 30;
      const offset = (page - 1) * limit;
      const userId = req.query.userId || null;
      const memories = await db.getAllMemories({ limit, offset, userId });
      return res.json(memories);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/admin/memory/:id', async (req, res) => {
    try {
      await db.deleteMemory(req.params.id);
      await db.logAdminAction({
        superAdminUserId: req.user.id,
        action: 'delete_memory',
        targetType: 'memory',
        targetId: req.params.id,
      });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
