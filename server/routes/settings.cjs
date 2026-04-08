'use strict';

const express = require('express');

/**
 * Settings routes extracted from proxy-server.cjs
 *
 *   GET  /api/settings  — read merged env + DB settings (masked secrets)
 *   POST /api/settings  — write settings to DB
 */
module.exports = function createSettingsRouter({ authenticateToken, db }) {
  const router = express.Router();

  function maskSecret(value) {
    if (!value || value.length < 6) return '****';
    return value.slice(0, 4) + '****' + value.slice(-4);
  }

  /**
   * GET /api/settings
   * Merges env var values over DB settings. For env-backed fields, returns
   * masked values and an `envConfigured` map so the frontend knows which
   * fields to lock.
   */
  router.get('/api/settings', authenticateToken, async (_req, res) => {
    try {
      const file = await db.getSettings();

      // Which fields are provided by env vars?
      const envConfigured = {
        claudeKey:        !!process.env.CLAUDE_API_KEY,
        openaiKey:        !!process.env.OPENAI_API_KEY,
        resendApiKey:     !!process.env.RESEND_API_KEY,
        recipientEmail:   !!process.env.ALERT_RECIPIENT_EMAIL,
        channelSlack:     !!process.env.SLACK_WEBHOOK_URL,
        channelWhatsapp:  !!(process.env.ULTRAMSG_INSTANCE && process.env.ULTRAMSG_TOKEN && process.env.ULTRAMSG_PHONE),
        channelSms:       false,
        channelEmail:     !!process.env.RESEND_API_KEY,
      };

      // Build effective apiKeys (env wins, then DB)
      const apiKeys = {
        claude: process.env.CLAUDE_API_KEY
          ? maskSecret(process.env.CLAUDE_API_KEY)
          : (file.apiKeys?.claude || ''),
        openai: process.env.OPENAI_API_KEY
          ? maskSecret(process.env.OPENAI_API_KEY)
          : (file.apiKeys?.openai || ''),
      };

      // Build effective emailSettings (env wins, then DB)
      const emailSettings = {
        resendConfigured: !!process.env.RESEND_API_KEY,
        recipientEmail: process.env.ALERT_RECIPIENT_EMAIL
          || file.emailSettings?.recipientEmail
          || '',
      };

      res.json({
        apiKeys,
        emailSettings,
        alertRules: file.alertRules || null,
        envConfigured,
      });
    } catch (err) {
      console.error('[settings] read failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/settings', authenticateToken, async (req, res) => {
    try {
      const current = await db.getSettings();
      const merged  = { ...current, ...req.body };
      await db.saveSettings(merged);
      res.json({ success: true });
    } catch (err) {
      console.error('[settings] write failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
