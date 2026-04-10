const Sentry = require("@sentry/node");
console.log('[sentry] initializing with DSN:', process.env.SENTRY_DSN ? 'SET' : 'NOT SET');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  sendDefaultPii: true,
  tracesSampleRate: 0.2,
});

module.exports = Sentry;
