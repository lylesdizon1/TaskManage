'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');

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
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
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
          timezone: user.timezone || 'America/Los_Angeles',
        },
      });
    } catch (err) {
      console.error('[auth] login failed:', err.message);
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
      console.error('[auth] refresh failed:', err.message);
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
      console.error('[auth] change-password failed:', err.message);
      return res.status(500).json({ error: err.message });
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
      try { await db.seedDefaultCadenceConfig(id); } catch (e) { console.error('[register] cadence seed failed:', e.message); }

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
        user: { id, username, displayName: displayName || username, email: invite.email, role: invite.role, entityIds: [], timezone: 'America/Los_Angeles' },
      });
    } catch (err) {
      console.error('[auth] register failed:', err.message);
      return res.status(500).json({ error: err.message });
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
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
