'use strict';

/**
 * server/middleware/rateLimit.cjs — Express rate limiters.
 *
 * Two tiers: a strict limiter for auth endpoints (brute-force protection)
 * and a general limiter for API routes (abuse prevention).
 *
 * @note These use in-memory stores, so limits reset on server restart
 * and are per-instance in multi-process deployments. Acceptable for
 * the current single-instance Railway setup.
 */

const rateLimit = require('express-rate-limit');

/**
 * Auth endpoint limiter: 10 requests per 15 minutes.
 * Applied to login/register to prevent credential stuffing.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * General API limiter: 100 requests per minute.
 * Applied broadly to prevent runaway clients or scraping.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authLimiter, apiLimiter };
