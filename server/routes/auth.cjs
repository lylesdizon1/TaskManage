'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const logger = require('../../guardrails/logger.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');

// Fixed valid bcrypt hash (cost 10, matching the app's password hashing in
// users.cjs/admin.cjs) used for a constant-time comparison when a username
// isn't found — so login latency can't reveal whether a username exists
// (enumeration). The plaintext is irrelevant; it only needs bcrypt.compare to
// do its full work. Computed once at module load. (audit: security)
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-attack-mitigation-dummy', 10);

/**
 * Auth routes extracted from proxy-server.cjs
 *
 *   POST /api/auth/login
 *   GET  /api/auth/me
 *   POST /api/auth/refresh
 *   POST /api/auth/change-password
 */
module.exports = function createAuthRouter({ authenticateToken, JWT_SECRET, db }) {
  const router = express.Router();

  /**
   * POST /api/auth/login
   * Body: { username, password }
   * Returns: { token, user: { id, username, displayName } }
   */
  router.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
      const users = await db.getUsers();
      const user = users.find((u) => u.username === username);
      // Constant-time: always run a bcrypt comparison — against a fixed dummy
      // hash when the username doesn't exist — so the not-found path costs the
      // same as a real comparison and login latency can't reveal whether a
      // username is valid. Outcomes are unchanged: missing user OR wrong
      // password → the same generic 401. (audit: security)
      const valid = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_PASSWORD_HASH);
      if (!user || !valid) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      if (user.active === false) {
        return res.status(401).json({ error: 'Account is deactivated' });
      }

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          email: user.email || '',
          role: user.role || 'member',
          entityIds: user.entityIds || [],
        },
        JWT_SECRET,
        { expiresIn: '30d' },
      );

      return res.json({
        token,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          email: user.email || '',
          role: user.role || 'member',
          entityIds: user.entityIds || [],
          timezone: user.timezone || DEFAULT_TIMEZONE,
        },
      });
    } catch (err) {
      logger.error('auth.login.failed', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/auth/me
   * Returns the current user from the JWT.
   */
  router.get('/api/auth/me', authenticateToken, async (req, res) => {
    // Return fresh user data from DB (not just JWT claims)
    try {
      const user = await db.getUserById(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      const { passwordHash, ...safe } = user;
      res.json({ user: safe });
    } catch (err) {
      res.json({ user: req.user });
    }
  });

  /**
   * POST /api/auth/refresh
   * Accepts a valid (non-expired) token, returns a fresh token with new 30d expiry.
   * Header: Authorization: Bearer <token>
   * Returns: { token, user: { id, username, displayName, ... } }
   */
  router.post('/api/auth/refresh', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserById(req.user.id);
      if (!user || user.active === false) {
        return res.status(403).json({ error: 'Account is deactivated or not found' });
      }

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          email: user.email || '',
          role: user.role || 'member',
          entityIds: user.entityIds || [],
        },
        JWT_SECRET,
        { expiresIn: '30d' },
      );

      const { passwordHash, ...safe } = user;
      return res.json({ token, user: safe });
    } catch (err) {
      logger.error('auth.refresh.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Token refresh failed' });
    }
  });

  // ── Change password ──────────────────────────────────────────────────────────

  router.post('/api/auth/change-password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters' });
    }

    try {
      const user = await db.getUserById(req.user.id);
      if (!user) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

      const newHash = await bcrypt.hash(newPassword, 10);
      await db.updateUserPassword(user.id, newHash);
      return res.json({ success: true });
    } catch (err) {
      logger.error('auth.changePassword.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Invite-only registration ────────────────────────────────────────────────

  router.post('/api/auth/register', async (req, res) => {
    const { token, username, password, displayName } = req.body;
    if (!token) {
      return res.status(403).json({ error: 'Registration is invite-only. Please use your invite link.' });
    }
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    try {
      const invite = await db.getInviteByToken(token);
      if (!invite) {
        return res.status(400).json({ error: 'Invite link is invalid or has expired.' });
      }
      if (new Date(invite.expiresAt) < new Date()) {
        return res.status(400).json({ error: 'Invite link is invalid or has expired.' });
      }
      if (invite.acceptedAt) {
        return res.status(400).json({ error: 'This invite has already been used.' });
      }

      const id = `user-${Date.now().toString(36)}`;
      const passwordHash = await bcrypt.hash(password, 10);
      await db.upsertUser({
        id,
        username,
        displayName: displayName || username,
        passwordHash,
        email: invite.email,
        role: invite.role,
        entityIds: [],
      });

      // Seed default alert cadence config
      try { await db.seedDefaultCadenceConfig(id); } catch (e) { logger.error('auth.register.cadenceSeed.failed', { error: e.message }); }

      // Seed Aria Intelligence default trust matrix (18 rows, all
      // confirm_required). Idempotent via ON CONFLICT DO NOTHING so a
      // re-registration edge case won't clobber an existing matrix.
      try { await db.seedDefaultTrustScores(id); } catch (e) { logger.error('auth.register.trustSeed.failed', { error: e.message }); }

      // Add to org
      await db.addOrgMember(invite.orgId, id, invite.role, invite.invitedBy);
      await db.acceptInvite(token, id);

      const jwtToken = jwt.sign(
        { id, username, displayName: displayName || username, email: invite.email, role: invite.role, entityIds: [] },
        JWT_SECRET,
        { expiresIn: '30d' },
      );

      return res.json({
        token: jwtToken,
        user: { id, username, displayName: displayName || username, email: invite.email, role: invite.role, entityIds: [], timezone: DEFAULT_TIMEZONE },
      });
    } catch (err) {
      logger.error('auth.register.failed', { error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Public invite info ─────────────────────────────────────────────────────

  router.get('/api/invites/:token', async (req, res) => {
    try {
      const invite = await db.getInviteByToken(req.params.token);
      if (!invite || new Date(invite.expiresAt) < new Date() || invite.acceptedAt) {
        return res.status(404).json({ error: 'Invite not found or expired' });
      }
      return res.json({ orgName: invite.orgName, role: invite.role, email: invite.email });
    } catch (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
