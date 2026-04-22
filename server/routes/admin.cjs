'use strict';

const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const logger = require('../../guardrails/logger.cjs');

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
      logger.error('admin.orgs.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
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
      logger.error('admin.orgs.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/orgs/:id/suspend', async (req, res) => {
    try {
      const updated = await db.updateOrganization(req.params.id, { active: false });
      if (!updated) return res.status(404).json({ error: 'Org not found' });
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'suspend_org', targetType: 'organization', targetId: req.params.id });
      return res.json(updated);
    } catch (err) {
      logger.error('admin.orgs.suspend.failed', { requestId: req.requestId, userId: req.user?.id, orgId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Users ────────────────────────────────────────────────────────────────────

  router.get('/api/admin/users', async (req, res) => {
    try {
      const users = await db.getAllUsersWithOrg();
      return res.json(users);
    } catch (err) {
      logger.error('admin.users.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
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
      logger.error('admin.users.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/admin/users/:id/suspend', async (req, res) => {
    try {
      const updated = await db.updateUser(req.params.id, { active: false });
      if (!updated) return res.status(404).json({ error: 'User not found' });
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'suspend_user', targetType: 'user', targetId: req.params.id });
      return res.json(updated);
    } catch (err) {
      logger.error('admin.users.suspend.failed', { requestId: req.requestId, userId: req.user?.id, targetId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
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
      logger.error('admin.users.password.failed', { requestId: req.requestId, userId: req.user?.id, targetId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
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
      logger.error('admin.users.email.failed', { requestId: req.requestId, userId: req.user?.id, targetId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
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
      logger.error('admin.users.assignOrg.failed', { requestId: req.requestId, userId: req.user?.id, targetId: req.params.id, orgId, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/admin/users/:id', async (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
    try {
      await db.deleteUser(req.params.id);
      await db.logAdminAction({ superAdminUserId: req.user.id, action: 'delete_user', targetType: 'user', targetId: req.params.id });
      return res.json({ success: true });
    } catch (err) {
      logger.error('admin.users.delete.failed', { requestId: req.requestId, userId: req.user?.id, targetId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
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
      logger.error('admin.invites.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
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
      logger.error('admin.impersonate.failed', { requestId: req.requestId, userId: req.user?.id, targetId: req.params.userId, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Audit log ────────────────────────────────────────────────────────────────

  router.get('/api/admin/audit-log', async (req, res) => {
    try {
      const page = parseInt(req.query.page, 10) || 1;
      const limit = 20;
      const offset = (page - 1) * limit;
      const entries = await db.getAuditLog(limit, offset);
      return res.json(entries);
    } catch (err) {
      logger.error('admin.auditLog.read.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Agent Memory ─────────────────────────────────────────────────────────

  router.get('/api/admin/memory', async (req, res) => {
    try {
      const page = parseInt(req.query.page, 10) || 1;
      // 20 rows/page to match the frontend's page size and give the
      // "Prev / Next" controls a true server-paged backend.
      const limit = 20;
      const offset = (page - 1) * limit;
      const userId = req.query.userId || null;
      const memories = await db.getAllMemories({ limit, offset, userId });
      return res.json(memories);
    } catch (err) {
      logger.error('admin.memory.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
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
      logger.error('admin.memory.delete.failed', { requestId: req.requestId, userId: req.user?.id, memoryId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Phase 5: Aria Decisions visibility ─────────────────────────────────
  // Read-only diagnostic endpoints for the AdminPanel Decisions tab.
  // Cross-tenant by design (super-admin only). Optional ?userId filter
  // narrows to one tenant; ?limit caps row count.

  router.get('/api/admin/decisions', async (req, res) => {
    try {
      const decisions = await db.getAdminDecisions({
        userId: req.query.userId || undefined,
        toolCalled: req.query.tool || undefined,
        outcome: req.query.outcome || undefined,
        limit: req.query.limit,
      });
      return res.json(decisions);
    } catch (err) {
      logger.error('admin.decisions.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/admin/trust-matrix', async (req, res) => {
    try {
      const rows = await db.getAdminTrustMatrix({ userId: req.query.userId || undefined });
      return res.json(rows);
    } catch (err) {
      logger.error('admin.trustMatrix.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/admin/corrections', async (req, res) => {
    try {
      const rows = await db.getAdminCorrections({
        userId: req.query.userId || undefined,
        limit: req.query.limit,
      });
      return res.json(rows);
    } catch (err) {
      logger.error('admin.corrections.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/admin/backfill-flagged-from-critical
   * One-time backfill: finds all critical/high-classified emails without
   * a flagged inbox_item and creates+flags them. Acked_at is set to NOW()
   * because users have already seen these via the alerts panel.
   * Idempotent: skips rows that already have flagged_at.
   * Query param ?dry_run=true to preview without writing.
   */
  router.post('/api/admin/backfill-flagged-from-critical', async (req, res) => {
    const dryRun = req.query.dry_run === 'true';
    const stats = { scanned: 0, matched: 0, backfilled: 0, already_flagged: 0, created_item: 0, unmatched: 0, errors: [] };
    try {
      // Find all critical/high classified emails (importance_rank >= 3)
      const { rows: classifications } = await db.pool.query(
        `SELECT ec.user_id, ec.message_id, ec.thread_id, ec.account_email,
                ec.category, ec.importance, ec.importance_rank, ec.summary,
                ec.classified_at, ec.vendor
         FROM email_classifications ec
         WHERE ec.importance_rank >= 3
         ORDER BY ec.classified_at DESC`,
      );
      stats.scanned = classifications.length;

      for (const cls of classifications) {
        try {
          // Check if inbox_item already exists for this thread
          const { rows: existing } = await db.pool.query(
            'SELECT id, flagged_at FROM inbox_items WHERE user_id = $1 AND source_id = $2',
            [cls.user_id, cls.thread_id],
          );

          if (existing[0]?.flagged_at) {
            stats.already_flagged++;
            stats.matched++;
            continue;
          }

          stats.matched++;

          if (dryRun) {
            stats.backfilled++;
            continue;
          }

          // Create inbox_item if missing
          if (!existing[0]) {
            const id = `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            await db.createInboxItem({
              id,
              userId: cls.user_id,
              type: 'EMAIL',
              title: cls.summary || '(classified email)',
              summary: cls.vendor ? `${cls.category} — ${cls.vendor}` : cls.category,
              source: cls.account_email?.includes('outlook') ? 'outlook' : 'gmail',
              sourceId: cls.thread_id,
              gmailThreadId: cls.thread_id,
              gmailLink: `https://mail.google.com/mail/u/0/#inbox/${cls.thread_id}`,
            });
            stats.created_item++;
          }

          // Flag + ack the item
          const { rows: itemRows } = await db.pool.query(
            'SELECT id FROM inbox_items WHERE user_id = $1 AND source_id = $2',
            [cls.user_id, cls.thread_id],
          );
          if (itemRows[0]) {
            await db.pool.query(
              `UPDATE inbox_items SET flagged_at = $3, flagged_reason = 'aria_critical_backfill', flagged_acked_at = NOW()
               WHERE id = $1 AND user_id = $2 AND flagged_at IS NULL`,
              [itemRows[0].id, cls.user_id, cls.classified_at || new Date()],
            );
            stats.backfilled++;
          } else {
            stats.unmatched++;
          }
        } catch (rowErr) {
          stats.errors.push({ threadId: cls.thread_id, error: rowErr.message });
        }
      }

      logger.info('admin.backfillFlagged.complete', { dryRun, ...stats });
      res.json({ dryRun, ...stats });
    } catch (err) {
      logger.error('admin.backfillFlagged.failed', { error: err.message });
      res.status(500).json({ error: err.message, stats });
    }
  });

  return router;
};
