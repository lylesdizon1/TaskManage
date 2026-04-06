'use strict';

const express = require('express');
const { getResendClient, getFromEmail } = require('../utils/email.cjs');

module.exports = function createEmailRouter({}) {
  const router = express.Router();

  /**
   * POST /api/email/test
   * Sends a test email to verify Resend is working.
   * Body: { to? } — defaults to ALERT_RECIPIENT_EMAIL env var.
   */
  router.post('/api/email/test', async (req, res) => {
    console.log('[email/test] RESEND_API_KEY is set:', !!process.env.RESEND_API_KEY);
    console.log('[email/test] RESEND_API_KEY length:', process.env.RESEND_API_KEY ? process.env.RESEND_API_KEY.length : 0);

    const resend = getResendClient();
    if (!resend) {
      console.log('[email/test] getResendClient() returned null - RESEND_API_KEY missing');
      return res.status(400).json({ error: 'RESEND_API_KEY environment variable is not set' });
    }

    const to = req.body.to || req.body.recipientEmail || process.env.ALERT_RECIPIENT_EMAIL;
    console.log('[email/test] Recipient email:', to);
    console.log('[email/test] From email:', getFromEmail());

    if (!to) {
      return res.status(400).json({ error: 'No recipient email provided' });
    }

    try {
      const response = await resend.emails.send({
        from: getFromEmail(),
        to,
        subject: '[Dizon.ai] Connection Test',
        html: '<p>Your Resend email integration is working.</p>',
      });
      console.log('[email/test] Resend API response:', JSON.stringify(response, null, 2));
      return res.json({ success: true, message: 'Test email sent via Resend', response });
    } catch (err) {
      console.error('[email/test] Resend test failed:', err.message);
      console.error('[email/test] Full error:', JSON.stringify(err, null, 2));
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/email/send
   * Body: { to, subject, html }
   */
  router.post('/api/email/send', async (req, res) => {
    const resend = getResendClient();
    if (!resend) {
      return res.status(400).json({ error: 'RESEND_API_KEY environment variable is not set' });
    }

    const { to, subject, html } = req.body;
    if (!to || !subject) {
      return res.status(400).json({ error: 'Required fields: to, subject' });
    }

    try {
      const data = await resend.emails.send({
        from: getFromEmail(),
        to,
        subject,
        html: html || '<p>(no content)</p>',
      });

      console.log(`[email/send] Sent to ${to} via Resend — id: ${data.data?.id}`);
      return res.json({ success: true, messageId: data.data?.id });
    } catch (err) {
      console.error('[email/send] Resend failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
