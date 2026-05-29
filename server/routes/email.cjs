'use strict';

const express = require('express');
const { getResendClient, getFromEmail } = require('../utils/email.cjs');
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
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
