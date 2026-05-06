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

  /**
   * GET /api/admin/active-zone/metrics?sinceHours=24
   * Aggregate counts grouped by candidate_type × composer_source × status.
   * The frontend rolls these into cache-hit-rate, fallback-rate, and
   * candidate-distribution numbers. Caller is super-admin via the
   * `router.use('/api/admin', requireSuperAdmin)` mount above.
   */
  router.get('/api/admin/active-zone/metrics', async (req, res) => {
    try {
      const sinceHours = Math.max(1, Math.min(parseInt(req.query.sinceHours, 10) || 24, 168));
      const rows = await db.getActiveZoneMetrics({ sinceHours });
      // Roll up into the headline metrics the dashboard wants.
      let totalTiles = 0, llm = 0, cache = 0, fallback = 0;
      for (const r of rows) {
        totalTiles += r.n;
        if (r.composerSource === 'llm') llm += r.n;
        else if (r.composerSource === 'cache') cache += r.n;
        else if (r.composerSource === 'fallback') fallback += r.n;
      }
      const composerCalls = llm + cache + fallback;
      const cacheHitRate  = composerCalls ? Math.round((cache / composerCalls) * 1000) / 10 : 0;
      const fallbackRate  = composerCalls ? Math.round((fallback / composerCalls) * 1000) / 10 : 0;
      const llmCallRate   = composerCalls ? Math.round((llm / composerCalls) * 1000) / 10 : 0;
      res.json({
        sinceHours, totalTiles, llm, cache, fallback,
        cacheHitRate, fallbackRate, llmCallRate,
        breakdown: rows,
      });
    } catch (err) {
      logger.error('admin.activeZone.metrics.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
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

  // ── Aria Intelligence health ────────────────────────────────────────────
  // Cross-tenant health rollup for the 5-phase intelligence stack. Built
  // after the May 5 audit found the trust loop had been silently no-op'ing
  // for 2 weeks because nobody had a dashboard to spot the empty
  // trust_scores table. Surfaces the load-bearing tables + per-user
  // breakdown so silent failures get loud.
  //
  // Optional ?userId=<id> scopes the per-user section to a single user.
  router.get('/api/admin/aria-health', async (req, res) => {
    try {
      const focusUser = req.query.userId ? String(req.query.userId) : null;

      // System-wide rollups — single query each, parallel.
      const [
        trustRollup, decisionRollup, behaviorRollup, correctionRollup,
        pclRollup, classificationRollup, agentActionRollup, pendingConfRollup,
      ] = await Promise.all([
        db.pool.query(`SELECT COUNT(*)::int AS rows, COUNT(DISTINCT user_id)::int AS users FROM trust_scores`),
        db.pool.query(`SELECT disposition, outcome, COUNT(*)::int AS n FROM decision_log
                        WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY 1,2 ORDER BY n DESC`),
        db.pool.query(`SELECT source, is_active, COUNT(*)::int AS n FROM behavior_rules GROUP BY 1,2 ORDER BY 1,2`),
        db.pool.query(`SELECT COUNT(*)::int AS rows, COUNT(*) FILTER (WHERE generated_rule_id IS NOT NULL)::int AS materialized FROM correction_events`),
        db.pool.query(`SELECT source_type,
                              COUNT(*) FILTER (WHERE resolved_at IS NULL AND dismissed_at IS NULL)::int AS open,
                              COUNT(*) FILTER (WHERE resolved_at IS NOT NULL)::int AS resolved,
                              COUNT(*)::int AS total
                         FROM pending_close_loop GROUP BY 1`),
        db.pool.query(`SELECT classification_reasoning->>'classifier_version' AS v, COUNT(*)::int AS n
                         FROM email_classifications GROUP BY 1 ORDER BY n DESC LIMIT 10`),
        db.pool.query(`SELECT event_type, COUNT(*)::int AS n FROM agent_actions
                        WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY 1 ORDER BY n DESC`),
        db.pool.query(`SELECT status, COUNT(*)::int AS n FROM pending_confirmations
                        WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY 1`),
      ]);

      // Per-user trust-row presence (the audit's canary metric).
      const trustPerUser = await db.pool.query(
        `SELECT u.id, u.email,
                COALESCE(ts.row_count, 0)::int AS trust_rows,
                COALESCE(dl.decisions_30d, 0)::int AS decisions_30d
           FROM users u
           LEFT JOIN (SELECT user_id, COUNT(*) AS row_count FROM trust_scores GROUP BY user_id) ts
             ON ts.user_id = u.id
           LEFT JOIN (SELECT user_id, COUNT(*) AS decisions_30d FROM decision_log
                       WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY user_id) dl
             ON dl.user_id = u.id
          ORDER BY decisions_30d DESC NULLS LAST, trust_rows ASC`,
      );

      // Health verdict — load-bearing canaries.
      const trust = trustRollup.rows[0];
      const correction = correctionRollup.rows[0];
      const decisionRows = decisionRollup.rows;
      const decisionsLast30 = decisionRows.reduce((a, r) => a + r.n, 0);
      const usersWithDecisions = trustPerUser.rows.filter((r) => r.decisions_30d > 0).length;
      const usersWithTrust = trustPerUser.rows.filter((r) => r.trust_rows > 0).length;
      const trustCoverage = usersWithDecisions > 0
        ? trustPerUser.rows.filter((r) => r.decisions_30d > 0 && r.trust_rows > 0).length / usersWithDecisions
        : null;

      // Predicate evaluator error tracker — surfaces silently-broken
      // behavior_rules whose predicate threw during conflictsWithAction.
      // Counter is in-memory, resets on process restart.
      let ruleEvalErrors = { count: 0, lastErrors: [] };
      try {
        const { getRuleEvaluationErrors } = require('../lib/decisionEngine.cjs');
        ruleEvalErrors = getRuleEvaluationErrors();
      } catch { /* engine not loaded yet — leave defaults */ }

      const canaries = {
        trust_loop_writes: trust.rows > 0
          ? 'healthy'
          : (decisionsLast30 > 0 ? 'BROKEN — 0 trust_scores rows despite recent decisions' : 'unknown — no recent decisions'),
        correction_loop: correction.rows > 0
          ? `healthy — ${correction.rows} events, ${correction.materialized} materialized into rules`
          : (decisionsLast30 > 0 ? 'no rejection signal recorded yet' : 'unknown'),
        decision_engine_active: decisionsLast30 > 0
          ? `healthy — ${decisionsLast30} decisions in 30d`
          : 'no recent decisions',
        trust_coverage: trustCoverage === null
          ? 'unknown'
          : `${(trustCoverage * 100).toFixed(0)}% of active users have trust_scores rows`,
        rule_evaluation_errors: ruleEvalErrors.count === 0
          ? 'healthy'
          : `${ruleEvalErrors.count} predicate errors since process start — see lastErrors below`,
      };

      const out = {
        canaries,
        rollups: {
          trust_scores: trust,
          decision_log_30d: decisionRows,
          behavior_rules: behaviorRollup.rows,
          correction_events: correction,
          pending_close_loop: pclRollup.rows,
          email_classifications_by_version: classificationRollup.rows,
          agent_actions_7d: agentActionRollup.rows,
          pending_confirmations_30d: pendingConfRollup.rows,
        },
        users: trustPerUser.rows.map((r) => ({
          id: r.id,
          email: r.email,
          trust_rows: r.trust_rows,
          decisions_30d: r.decisions_30d,
          has_trust: r.trust_rows > 0,
        })),
        rule_evaluation_errors: ruleEvalErrors,
      };

      // Optional per-user deep dive
      if (focusUser) {
        const [behaviorR, decisionsR, correctionR, recentR] = await Promise.all([
          db.pool.query(`SELECT rule_type, pattern_type, rule_text, source, strength, signal_count, is_active, created_at
                           FROM behavior_rules WHERE user_id = $1 ORDER BY is_active DESC, strength DESC LIMIT 25`, [focusUser]),
          db.pool.query(`SELECT tool_called, disposition, outcome, conflict_level, COUNT(*)::int AS n
                           FROM decision_log WHERE user_id = $1
                          GROUP BY 1,2,3,4 ORDER BY n DESC LIMIT 30`, [focusUser]),
          db.pool.query(`SELECT original_action, correction_type, generated_rule_id, created_at
                           FROM correction_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [focusUser]),
          db.pool.query(`SELECT tool_name, event_type, status, created_at FROM agent_actions
                          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15`, [focusUser]),
        ]);
        out.focus = {
          userId: focusUser,
          behavior_rules: behaviorR.rows,
          decision_distribution: decisionsR.rows,
          correction_events: correctionR.rows,
          recent_agent_actions: recentR.rows,
        };
      }

      res.json(out);
    } catch (err) {
      logger.error('admin.ariaHealth.failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Trust-floor threshold (Ext 3 of engine-extensions workstream) ───────
  // GET /api/admin/aria-health/trust-floor?userId=<id>
  // POST /api/admin/aria-health/trust-floor   body: { userId, threshold }
  // Threshold is a number in [0, 1] stored in user_preferences_v2.
  // decisionEngine Tier 5 reads it at evaluate-time; default 0.3 when unset.
  router.get('/api/admin/aria-health/trust-floor', async (req, res) => {
    try {
      const userId = req.query.userId ? String(req.query.userId) : null;
      if (!userId) return res.status(400).json({ error: 'userId query param required' });
      const threshold = await db.getTrustFloorThreshold(userId);
      const isDefault = threshold === db.DEFAULT_TRUST_FLOOR_THRESHOLD;
      res.json({ userId, threshold, default: db.DEFAULT_TRUST_FLOOR_THRESHOLD, is_default: isDefault });
    } catch (err) {
      logger.error('admin.trustFloor.get.failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/aria-health/trust-floor', async (req, res) => {
    try {
      const { userId, threshold } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId required in body' });
      const row = await db.setTrustFloorThreshold(userId, threshold);
      logger.info('admin.trustFloor.set', { triggeredBy: req.user.id, userId, threshold });
      res.json({ userId, threshold: Number(row.preferenceValue), updated_at: row.updatedAt });
    } catch (err) {
      logger.error('admin.trustFloor.set.failed', { error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  // ── Autonomous-action rate limit (Ext 4 of engine-extensions workstream)
  // GET  /api/admin/aria-health/rate-limit?userId=<id>
  // POST /api/admin/aria-health/rate-limit  body: { userId, count }
  // count is per-user tunable (1..1000). Window is hardcoded 60min v1.
  router.get('/api/admin/aria-health/rate-limit', async (req, res) => {
    try {
      const userId = req.query.userId ? String(req.query.userId) : null;
      if (!userId) return res.status(400).json({ error: 'userId query param required' });
      const config = await db.getRateLimit(userId);
      const recentCount = await db.countAutonomousActions(userId, config.windowMinutes);
      res.json({
        userId,
        config,
        default: db.DEFAULT_RATE_LIMIT,
        is_default: config.count === db.DEFAULT_RATE_LIMIT.count,
        recent_autonomous_count: recentCount,
        approaching_limit: recentCount >= Math.floor(config.count * 0.8),
      });
    } catch (err) {
      logger.error('admin.rateLimit.get.failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/admin/aria-health/rate-limit', async (req, res) => {
    try {
      const { userId, count } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId required in body' });
      const row = await db.setRateLimit(userId, { count });
      logger.info('admin.rateLimit.set', { triggeredBy: req.user.id, userId, count });
      res.json({ userId, config: row.preferenceValue, updated_at: row.updatedAt });
    } catch (err) {
      logger.error('admin.rateLimit.set.failed', { error: err.message });
      res.status(400).json({ error: err.message });
    }
  });

  // ── Stale classification sweep — manual trigger ─────────────────────────
  // Fires the same sweep that runs at 4am UTC daily. Useful right after
  // a CLASSIFIER_VERSION bump to drop the critical_email_unacked tile
  // count without waiting for the cron tick. Optional ?userId=<id>
  // scopes to a single user (default: all users).
  router.post('/api/admin/aria-health/sweep-stale-classifications', async (req, res) => {
    try {
      const targetUserId = req.query.userId ? String(req.query.userId) : null;
      const { sweepStaleClassificationsForUser, sweepStaleClassificationsAllUsers } =
        require('../lib/staleClassificationSweep.cjs');
      const result = targetUserId
        ? await sweepStaleClassificationsForUser(targetUserId)
        : await sweepStaleClassificationsAllUsers();
      logger.info('admin.sweepStale.complete', { triggeredBy: req.user.id, scope: targetUserId || 'all', ...result });
      res.json({ scope: targetUserId || 'all', ...result });
    } catch (err) {
      logger.error('admin.sweepStale.failed', { error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
