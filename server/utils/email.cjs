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

module.exports = { getResendClient, getFromEmail };
