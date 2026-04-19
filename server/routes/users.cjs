'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto = require('crypto');
const logger = require('../../guardrails/logger.cjs');
const { sendWhatsApp } = require('../utils/integrations.cjs');

/**
 * User routes extracted from proxy-server.cjs
 *
 *   PUT    /api/users/settings                       — current user's persona/assistant settings
 *   POST   /api/users/whatsapp-phone/start-verify    — mint OTP, send to to-be-claimed phone
 *   POST   /api/users/whatsapp-phone/confirm         — exchange OTP for verified phone bind
 *   DELETE /api/users/whatsapp-phone                 — clear (no verification needed)
 *   GET    /api/users                                — admin: list all users
 *   POST   /api/users                                — admin: create user
 *   PUT    /api/users/:id                            — admin: update user
 *   DELETE /api/users/:id                            — admin: delete user
 */
module.exports = function createUsersRouter({ authenticateToken, requireAdmin, db }) {
  const router = express.Router();

  /**
   * PUT /api/users/settings
   * Body: { persona?, assistantName?, whatsappPhone?, profile* }
   * Updates the current user's settings.
   *
   * SECURITY: whatsappPhone CHANGES are no longer accepted here — they
   * route through the verification flow (POST /whatsapp-phone/start-verify
   * + /confirm). A no-op submission of the unchanged value is silently
   * dropped so existing UIs that re-post the full settings blob keep
   * working without a 400.
   */
  router.put('/api/users/settings', authenticateToken, async (req, res) => {
    try {
      const { persona, assistantName, whatsappPhone, profileName, profileBusinesses, profileHousehold, profileLocation, profileNotes } = req.body;
      const fields = {};
      if (persona !== undefined) fields.persona = persona;
      if (assistantName !== undefined) fields.assistantName = assistantName;
      if (profileName !== undefined) fields.profileName = profileName;
      if (profileBusinesses !== undefined) fields.profileBusinesses = profileBusinesses;
      if (profileHousehold !== undefined) fields.profileHousehold = profileHousehold;
      if (profileLocation !== undefined) fields.profileLocation = profileLocation;
      if (profileNotes !== undefined) fields.profileNotes = profileNotes;

      if (whatsappPhone !== undefined) {
        const current = await db.getUserById(req.user.id);
        const submitted = db.normalizeWhatsAppPhone(whatsappPhone);
        const stored = db.normalizeWhatsAppPhone(current?.whatsappPhone || '');
        if (submitted !== stored) {
          return res.status(400).json({
            error: 'whatsapp_verification_required',
            message: 'WhatsApp phone changes require verification. POST /api/users/whatsapp-phone/start-verify with { phone }, then /confirm with { code }.',
          });
        }
        // unchanged → silently drop from update set
      }

      const updated = await db.updateUser(req.user.id, fields);
      if (!updated) return res.status(404).json({ error: 'User not found' });
      return res.json(updated);
    } catch (err) {
      logger.error('users.settings.updateFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/users/whatsapp-phone/start-verify
   * Body: { phone: "+14155551234" }
   * Mints a 6-digit code and sends it to the submitted phone via UltraMsg.
   * Only the real owner of that number can read the code → completing the
   * /confirm step proves possession. Pre-existing claim conflicts are not
   * pre-checked to avoid leaking which numbers are taken; the conflict
   * surfaces at /confirm time as 'already_claimed'.
   */
  router.post('/api/users/whatsapp-phone/start-verify', authenticateToken, async (req, res) => {
    try {
      const phoneRaw = String(req.body?.phone || '').trim();
      const phoneNormalized = db.normalizeWhatsAppPhone(phoneRaw);
      if (phoneNormalized.length < 7 || phoneNormalized.length > 15) {
        return res.status(400).json({ error: 'invalid_phone', message: 'Phone must be 7–15 digits.' });
      }
      // 6-digit numeric, zero-padded. crypto.randomInt is uniform-random.
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      await db.mintWhatsAppVerification(req.user.id, phoneNormalized, code, 600);

      const sendResult = await sendWhatsApp(
        db, req.user.id,
        `Your Dizon.ai verification code: ${code}\n\nValid for 10 minutes. If you didn't request this, ignore this message.`,
        phoneNormalized,
      );
      if (!sendResult.ok) {
        logger.warn('users.whatsappVerify.sendFailed', { userId: req.user.id, reason: sendResult.reason });
        // Don't surface the raw reason — could distinguish "phone unreachable"
        // from "ultramsg down" which is info leakage. Generic failure.
        return res.status(502).json({ error: 'send_failed', message: 'Could not send verification code. Try again in a moment.' });
      }
      return res.json({ success: true, expires_in_seconds: 600 });
    } catch (err) {
      logger.error('users.whatsappVerify.startFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/users/whatsapp-phone/confirm
   * Body: { code: "123456" }
   * Validates the OTP for the current user and persists the phone iff the
   * UNIQUE-index check passes. The phone bound is the one captured at
   * start-verify time — caller does not get to override it here.
   */
  router.post('/api/users/whatsapp-phone/confirm', authenticateToken, async (req, res) => {
    try {
      const code = String(req.body?.code || '').trim();
      if (!/^\d{4,8}$/.test(code)) return res.status(400).json({ error: 'invalid_code' });

      const result = await db.consumeWhatsAppVerification(req.user.id, code);
      if (!result.ok) {
        const status = result.reason === 'no_pending' ? 404
          : result.reason === 'expired' ? 410
          : result.reason === 'too_many_attempts' ? 429
          : 400;
        return res.status(status).json({ error: result.reason });
      }

      const setResult = await db.setVerifiedWhatsAppPhone(req.user.id, result.phoneNormalized);
      if (!setResult.ok) {
        // Already claimed by another user — caller cannot tell which.
        logger.warn('users.whatsappVerify.alreadyClaimed', {
          userId: req.user.id, phoneNormalized: result.phoneNormalized,
        });
        return res.status(409).json({ error: 'already_claimed', message: 'This number is already in use on another account.' });
      }

      logger.info('users.whatsappVerify.success', { userId: req.user.id });
      return res.json({ success: true });
    } catch (err) {
      logger.error('users.whatsappVerify.confirmFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/users/whatsapp-phone
   * Clears the user's whatsapp_phone. No verification needed — unbinding
   * a number you control is not a takeover vector.
   */
  router.delete('/api/users/whatsapp-phone', authenticateToken, async (req, res) => {
    try {
      await db.clearUserWhatsAppPhone(req.user.id);
      logger.info('users.whatsappPhone.cleared', { userId: req.user.id });
      return res.json({ success: true });
    } catch (err) {
      logger.error('users.whatsappPhone.clearFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
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
