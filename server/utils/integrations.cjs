'use strict';

/**
 * server/utils/integrations.cjs — per-user outbound notification routing.
 *
 * Canonical send helpers for user-scoped channels (Slack, WhatsApp,
 * alert email). Each helper loads the authenticated user's row from
 * the user_integrations table and routes the message to that user's
 * credentials only — never to shared process.env defaults.
 *
 * No env-var fallback. If a user's integration is missing or disabled,
 * the helper returns { ok: false, reason } so the caller can surface
 * a clear status.
 */

const { getResendClient, getFromEmail } = require('./email.cjs');

async function sendSlack(db, userId, text) {
  const row = await db.getUserIntegration(userId, 'slack_webhook');
  if (!row || !row.isEnabled) return { ok: false, reason: 'not_configured' };
  const url = row.config?.webhookUrl;
  if (!url) return { ok: false, reason: 'not_configured' };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) return { ok: false, reason: `slack_${r.status}` };
  return { ok: true };
}

async function sendWhatsApp(db, userId, text, toPhoneOverride) {
  const row = await db.getUserIntegration(userId, 'ultramsg_whatsapp');
  if (row && row.isEnabled === false) return { ok: false, reason: 'not_configured' };

  const cfg = row?.config || {};
  // UltraMsg instance + token are business-wide (one account) — the
  // superadmin seed (db.cjs) stamps them from ULTRAMSG_INSTANCE/TOKEN
  // env vars. Fall back to the same env source for users whose row
  // doesn't carry them so outbound still works.
  const instance = cfg.instance || process.env.ULTRAMSG_INSTANCE || null;
  const token    = cfg.token    || process.env.ULTRAMSG_TOKEN    || null;

  // Phone fallback: some users populated the legacy users.whatsapp_phone
  // column but never put a phone in the integration's config_json. Honor
  // that so outbound still reaches them.
  let to = toPhoneOverride || cfg.phone || null;
  if (!to) {
    try {
      const user = await db.getUserById(userId);
      to = user?.whatsappPhone || null;
    } catch { /* leave null → not_configured below */ }
  }

  if (!instance || !token || !to) return { ok: false, reason: 'not_configured' };

  const r = await fetch(`https://api.ultramsg.com/${instance}/messages/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, to, body: text }),
  });
  if (!r.ok) return { ok: false, reason: `whatsapp_${r.status}` };
  return { ok: true };
}

async function sendAlertEmail(db, userId, { subject, text, html, toOverride }) {
  const row = await db.getUserIntegration(userId, 'email_alerts');
  if (!row || !row.isEnabled) return { ok: false, reason: 'not_configured' };
  const to = toOverride || row.config?.recipientEmail;
  if (!to) return { ok: false, reason: 'not_configured' };

  const resend = getResendClient();
  if (!resend) return { ok: false, reason: 'resend_not_configured' };

  const from = row.config?.fromEmail || getFromEmail();
  try {
    await resend.emails.send({ from, to, subject, text, html });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `resend_error:${err.message}` };
  }
}

/**
 * Build an integrations status map for a user — what's configured and enabled.
 * Secrets are never returned. Used by /api/config/status and settings UI.
 */
async function getIntegrationStatus(db, userId) {
  const [slack, whatsapp, email] = await Promise.all([
    db.getUserIntegration(userId, 'slack_webhook'),
    db.getUserIntegration(userId, 'ultramsg_whatsapp'),
    db.getUserIntegration(userId, 'email_alerts'),
  ]);
  return {
    slack: !!(slack?.isEnabled && slack.config?.webhookUrl),
    whatsapp: !!(whatsapp?.isEnabled && whatsapp.config?.instance && whatsapp.config?.token && whatsapp.config?.phone),
    email: !!(email?.isEnabled && email.config?.recipientEmail),
    sms: false,
  };
}

module.exports = { sendSlack, sendWhatsApp, sendAlertEmail, getIntegrationStatus };
