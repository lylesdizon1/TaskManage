'use strict';

const { Resend } = require('resend');

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

function getFromEmail() {
  return process.env.RESEND_FROM_EMAIL || 'Dizon.ai <onboarding@resend.dev>';
}

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
