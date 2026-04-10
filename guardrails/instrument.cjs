const Sentry = require("@sentry/node");

if (!process.env.SENTRY_DSN) {
  console.error('[sentry] FATAL: SENTRY_DSN is not set');
} else {
  console.log('[sentry] DSN found, initializing...');
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? 'development',
    sendDefaultPii: true,
    tracesSampleRate: 0.2,
  });
  console.log('[sentry] init complete');
}

module.exports = Sentry;
