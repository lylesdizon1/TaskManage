'use strict';

/**
 * server/utils/email.cjs — Resend email client wrapper.
 *
 * Thin abstraction over the Resend SDK so callers don't need to know
 * about API keys or sender addresses. Returns null when unconfigured
 * to allow graceful degradation in environments without email.
 */

const { Resend } = require('resend');

/**
 * Create a Resend client using the RESEND_API_KEY env var.
 * Returns null if the key is not set — callers should check before sending.
 *
 * @returns {Resend|null}
 */
function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

/**
 * Return the configured sender address for outgoing emails.
 * Falls back to Resend's sandbox address for development.
 *
 * @returns {string} RFC 5322 formatted sender (e.g. "Name <email>").
 */
function getFromEmail() {
  return process.env.RESEND_FROM_EMAIL || 'Dizon.ai <onboarding@resend.dev>';
}

/**
 * Send an email via Resend.
 *
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient address(es).
 * @param {string} options.subject - Email subject line.
 * @param {string} [options.text] - Plaintext body.
 * @param {string} [options.html] - HTML body.
 * @returns {Promise<Object>} Resend API response.
 * @throws {Error} If Resend is not configured (RESEND_API_KEY missing).
 */
async function sendEmail({ to, subject, text, html }) {
  const resend = getResendClient();
  if (!resend) throw new Error('Resend not configured');
  return resend.emails.send({
    from: getFromEmail(),
    to,
    subject,
    text,
    html,
  });
}

module.exports = { getResendClient, getFromEmail, sendEmail };
