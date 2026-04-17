'use strict';

const express = require('express');
const { getIntegrationStatus, wrapWebhookUrl, unwrapWebhookUrl } = require('../utils/integrations.cjs');
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
      const plain = unwrapWebhookUrl(out.webhookUrl);
      out.webhookUrl = plain ? maskSecret(plain) : '';
    }
    if (type === 'ultramsg_whatsapp') {
      if (out.token) out.token = maskSecret(out.token);
    }
    return out;
  }

  router.get('/api/settings', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const [userSettings, status, emailRow] = await Promise.all([
        db.getUserSettings(userId),
        getIntegrationStatus(db, userId),
        db.getUserIntegration(userId, 'email_alerts'),
      ]);

      // Which fields are provided by env vars (server-side Resend key is
      // the only true env-backed secret exposed to the UI).
      const envConfigured = {
        claudeKey:    !!process.env.CLAUDE_API_KEY,
        openaiKey:    !!process.env.OPENAI_API_KEY,
        resendApiKey: !!process.env.RESEND_API_KEY,
        // Channel routing is user-scoped — reflect per-user status:
        recipientEmail:  status.email,
        channelSlack:    status.slack,
        channelWhatsapp: status.whatsapp,
        channelSms:      false,
        channelEmail:    status.email,
      };

      // API keys: env takes precedence (platform key); otherwise use this
      // user's saved override. Both forms are masked before returning.
      const userApiKeys = userSettings.apiKeys || {};
      const apiKeys = {
        claude: process.env.CLAUDE_API_KEY
          ? maskSecret(process.env.CLAUDE_API_KEY)
          : (userApiKeys.claude ? maskSecret(userApiKeys.claude) : ''),
        openai: process.env.OPENAI_API_KEY
          ? maskSecret(process.env.OPENAI_API_KEY)
          : (userApiKeys.openai ? maskSecret(userApiKeys.openai) : ''),
      };

      const emailSettings = {
        resendConfigured: !!process.env.RESEND_API_KEY,
        recipientEmail: emailRow?.config?.recipientEmail || '',
      };

      res.json({
        apiKeys,
        emailSettings,
        alertRules: userSettings.alertRules || null,
        envConfigured,
        integrations: status,
      });
    } catch (err) {
      logger.error('settings.read.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/settings — per-user write. Any subset of { apiKeys,
   * alertRules, emailSettings } may be provided. REPLACE semantics for
   * each top-level key — missing keys leave existing rows untouched.
   * Masked values ("abcd****wxyz") are discarded so real secrets are
   * never clobbered by a GET→POST round trip.
   */
  router.post('/api/settings', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const body = req.body || {};

      if (body.apiKeys && typeof body.apiKeys === 'object') {
        const existing = (await db.getUserSetting(userId, 'apiKeys')) || {};
        const next = { ...existing };
        for (const [k, v] of Object.entries(body.apiKeys)) {
          if (typeof v !== 'string') continue;
          if (v.includes('****')) continue;   // masked — leave existing value
          if (v === '') { delete next[k]; continue; } // explicit clear
          next[k] = v;
        }
        await db.upsertUserSetting(userId, 'apiKeys', next);
      }

      if (Array.isArray(body.alertRules)) {
        await db.upsertUserSetting(userId, 'alertRules', body.alertRules);
      }

      // emailSettings.recipientEmail is now owned by the email_alerts
      // integration — accept it here for backward compatibility with the
      // current frontend, writing through to the integration row.
      if (body.emailSettings && typeof body.emailSettings === 'object') {
        const { recipientEmail } = body.emailSettings;
        if (typeof recipientEmail === 'string') {
          const existing = await db.getUserIntegration(userId, 'email_alerts');
          const existingCfg = existing?.config || {};
          const nextCfg = { ...existingCfg, recipientEmail };
          await db.upsertUserIntegration(userId, 'email_alerts', nextCfg, existing?.isEnabled !== false);
        }
      }

      res.json({ success: true });
    } catch (err) {
      logger.error('settings.write.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
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

      // Encrypt-at-rest for Slack webhook URLs (mirrors Gmail/Outlook tokens).
      if (type === 'slack_webhook' && typeof clean.webhookUrl === 'string') {
        clean.webhookUrl = wrapWebhookUrl(clean.webhookUrl);
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
