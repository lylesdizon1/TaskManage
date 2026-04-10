const Sentry = require("@sentry/node");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  sendDefaultPii: true,
  tracesSampleRate: 0.2,
});

module.exports = Sentry;
