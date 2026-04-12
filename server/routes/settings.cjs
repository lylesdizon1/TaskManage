'use strict';

const express = require('express');
const { getIntegrationStatus } = require('../utils/integrations.cjs');
const logger = require('../../guardrails/logger.cjs');

const INTEGRATION_TYPES = new Set(['email_alerts', 'slack_webhook', 'ultramsg_whatsapp']);

/**
 * Settings + integrations routes.
 *
 *   GET  /api/settings         — read merged env + DB settings (masked secrets)
 *   POST /api/settings         — write settings to DB
 *   GET  /api/integrations     — list current user's integration rows (secrets masked)
 *   PUT  /api/integrations/:type — upsert user's integration config
 *   DELETE /api/integrations/:type — remove user's integration
 */
module.exports = function createSettingsRouter({ authenticateToken, db }) {
  const router = express.Router();

  function maskSecret(value) {
    if (!value || value.length < 6) return '****';
    return value.slice(0, 4) + '****' + value.slice(-4);
  }

  /** Redact secret-ish fields in a config object for GET responses. */
  function maskIntegrationConfig(type, cfg = {}) {
    const out = { ...cfg };
    if (type === 'slack_webhook' && out.webhookUrl) {
      out.webhookUrl = maskSecret(out.webhookUrl);
    }
    if (type === 'ultramsg_whatsapp') {
      if (out.token) out.token = maskSecret(out.token);
    }
    return out;
  }

  router.get('/api/settings', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const file = await db.getSettings();
      const status = await getIntegrationStatus(db, userId);
      const emailRow = await db.getUserIntegration(userId, 'email_alerts');

      // Which fields are provided by env vars (server-side Resend key is
      // the only true env-backed secret exposed to the UI).
      const envConfigured = {
        claudeKey:    !!process.env.CLAUDE_API_KEY,
        openaiKey:    !!process.env.OPENAI_API_KEY,
        resendApiKey: !!process.env.RESEND_API_KEY,
        // Channel routing is now user-scoped — reflect per-user status:
        recipientEmail:  status.email,
        channelSlack:    status.slack,
        channelWhatsapp: status.whatsapp,
        channelSms:      false,
        channelEmail:    status.email,
      };

      const apiKeys = {
        claude: process.env.CLAUDE_API_KEY
          ? maskSecret(process.env.CLAUDE_API_KEY)
          : (file.apiKeys?.claude || ''),
        openai: process.env.OPENAI_API_KEY
          ? maskSecret(process.env.OPENAI_API_KEY)
          : (file.apiKeys?.openai || ''),
      };

      const emailSettings = {
        resendConfigured: !!process.env.RESEND_API_KEY,
        recipientEmail: emailRow?.config?.recipientEmail || '',
      };

      res.json({
        apiKeys,
        emailSettings,
        alertRules: file.alertRules || null,
        envConfigured,
        integrations: status,
      });
    } catch (err) {
      logger.error('settings.read.failed', { requestId: req.requestId, error: err.message });
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
      logger.error('settings.write.failed', { requestId: req.requestId, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── /api/integrations ───────────────────────────────────────────────────

  router.get('/api/integrations', authenticateToken, async (req, res) => {
    try {
      const rows = await db.getUserIntegrations(req.user.id);
      const masked = rows.map((r) => ({
        type: r.type,
        isEnabled: r.isEnabled,
        config: maskIntegrationConfig(r.type, r.config || {}),
        updatedAt: r.updatedAt,
      }));
      res.json({ integrations: masked });
    } catch (err) {
      logger.error('integrations.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/integrations/:type', authenticateToken, async (req, res) => {
    try {
      const { type } = req.params;
      if (!INTEGRATION_TYPES.has(type)) {
        return res.status(400).json({ error: `Unsupported integration type: ${type}` });
      }
      const { config = {}, isEnabled = true } = req.body || {};

      // Strip masked values (frontend may send back "abcd****wxyz" — never overwrite real secret with mask)
      const clean = {};
      for (const [k, v] of Object.entries(config)) {
        if (typeof v === 'string' && v.includes('****')) continue;
        clean[k] = v;
      }

      const row = await db.upsertUserIntegration(req.user.id, type, clean, isEnabled);
      res.json({
        type: row.type,
        isEnabled: row.isEnabled,
        config: maskIntegrationConfig(row.type, row.config || {}),
      });
    } catch (err) {
      logger.error('integrations.put.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/integrations/:type', authenticateToken, async (req, res) => {
    try {
      const { type } = req.params;
      if (!INTEGRATION_TYPES.has(type)) {
        return res.status(400).json({ error: `Unsupported integration type: ${type}` });
      }
      await db.deleteUserIntegration(req.user.id, type);
      res.json({ success: true });
    } catch (err) {
      logger.error('integrations.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
