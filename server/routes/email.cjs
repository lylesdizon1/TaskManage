'use strict';

const express = require('express');
const { getResendClient, getFromEmail } = require('../utils/email.cjs');
const { sendAlertEmail } = require('../utils/integrations.cjs');
const logger = require('../../guardrails/logger.cjs');

module.exports = function createEmailRouter({ authenticateToken, db }) {
  const router = express.Router();

  /**
   * POST /api/email/test
   * Sends a test email using the authenticated user's email_alerts integration.
   * Body: { to? } — optional override; otherwise uses the user's configured
   * recipientEmail. Never falls back to any system env var.
   */
  router.post('/api/email/test', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const resend = getResendClient();
    if (!resend) {
      return res.status(400).json({ error: 'Email sending is not configured (RESEND_API_KEY missing on server)' });
    }

    let to = req.body.to || req.body.recipientEmail || null;
    let from = getFromEmail();

    if (!to) {
      const row = await db.getUserIntegration(userId, 'email_alerts');
      if (!row || !row.isEnabled || !row.config?.recipientEmail) {
        return res.status(400).json({ error: 'No recipient email configured. Save an alert email in Settings first.' });
      }
      to = row.config.recipientEmail;
      if (row.config.fromEmail) from = row.config.fromEmail;
    }

    try {
      const response = await resend.emails.send({
        from,
        to,
        subject: '[Dizon.ai] Connection Test',
        html: '<p>Your Resend email integration is working.</p>',
      });
      logger.info('email.test.success', { requestId: req.requestId, userId, responseId: response?.data?.id });
      return res.json({ success: true, message: 'Test email sent via Resend', response });
    } catch (err) {
      logger.error('email.test.failed', { requestId: req.requestId, userId, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/email/send — authenticated send via the user's own
   * email_alerts integration. The `to` field, if provided, must match
   * either the user's configured email_alerts.recipientEmail or their
   * users.email address. Arbitrary third-party recipients are rejected.
   *
   * Body: { to?, subject, html? }
   */
  router.post('/api/email/send', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { to, subject, html } = req.body || {};
      if (!subject) return res.status(400).json({ error: 'Required field: subject' });

      // Build the allowlist of addresses this user may send to.
      const [integ, user] = await Promise.all([
        db.getUserIntegration(userId, 'email_alerts'),
        db.getUserById(userId),
      ]);
      const allowed = new Set();
      if (integ?.config?.recipientEmail) allowed.add(integ.config.recipientEmail.toLowerCase());
      if (user?.email) allowed.add(user.email.toLowerCase());

      let toOverride = null;
      if (to) {
        if (!allowed.has(String(to).toLowerCase())) {
          return res.status(403).json({ error: 'Recipient must be your configured alert email or your account email.' });
        }
        toOverride = to;
      } else if (allowed.size === 0) {
        return res.status(400).json({ error: 'No recipient available — configure an alert email or set your account email.' });
      }

      const r = await sendAlertEmail(db, userId, {
        subject,
        html: html || '<p>(no content)</p>',
        toOverride,
      });
      if (!r.ok) {
        logger.error('email.send.failed', { requestId: req.requestId, userId, reason: r.reason });
        return res.status(502).json({ error: `Send failed: ${r.reason}` });
      }
      logger.info('email.send.success', { requestId: req.requestId, userId });
      return res.json({ success: true });
    } catch (err) {
      logger.error('email.send.error', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
