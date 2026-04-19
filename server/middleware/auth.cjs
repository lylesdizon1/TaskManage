'use strict';

/**
 * server/middleware/auth.cjs — JWT authentication and authorization middleware.
 *
 * Every authenticated route passes through authenticateToken, which:
 *   1. Verifies the JWT signature
 *   2. Enriches req.user with fresh DB context (timezone, role, entityIds)
 *
 * The DB enrichment step (via getUserAuthContext) ensures that role changes,
 * entity membership updates, and timezone changes take effect immediately
 * without waiting for the JWT to expire (30-day expiry).
 *
 * @note The DB reference is injected at startup via setDb() rather than
 * importing db.cjs directly — this avoids circular dependencies since
 * db.cjs is loaded before route setup in proxy-server.cjs.
 */

const jwt = require('jsonwebtoken');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');

/**
 * JWT signing secret. Required at startup — no fallback, since a per-process
 * random secret silently invalidates every session on restart and masks a
 * misconfigured deploy as "users keep getting logged out."
 * @type {string}
 */
const JWT_SECRET = (() => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return process.env.JWT_SECRET;
})();

/** @type {Object|null} Database module reference, set via setDb(). */
let _db = null;

/**
 * Inject the database module. Called once at startup from proxy-server.cjs.
 * @param {Object} db - The db.cjs module exports.
 */
function setDb(db) { _db = db; }

/**
 * Express middleware: verify JWT and attach user context to req.user.
 *
 * After JWT verification, makes a lightweight DB call to refresh the
 * user's timezone, role, and entityIds — so authorization decisions
 * always reflect the current DB state, not stale JWT claims.
 *
 * Fails closed on enrichment failure: returns 503 rather than letting
 * a request through with stale JWT-only claims. A DB blip degrading
 * authorization freshness was a real risk worth catching loudly.
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  req.user = payload;

  if (_db) {
    try {
      const ctx = await _db.getUserAuthContext(payload.id);
      if (ctx) {
        req.user.timezone = ctx.timezone || DEFAULT_TIMEZONE;
        req.user.role = ctx.role || req.user.role;
        req.user.entityIds = ctx.entityIds || [];
        req.user.orgId = ctx.orgId || null;
      }
    } catch (err) {
      console.error('auth.context.enrichment.failed', { userId: payload.id, error: err.message });
      return res.status(503).json({ error: 'Authentication context unavailable' });
    }
  }

  next();
}

/**
 * Express middleware: reject non-admin users with 403.
 * Must be placed after authenticateToken in the middleware chain.
 */
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

/**
 * Check whether the current user is authorized to access a given record.
 * Returns true if the user owns it, shares an entity, or is privileged.
 *
 * Called imperatively in route handlers (not as middleware) because it
 * needs the fetched record to inspect ownership fields.
 *
 * @note Handles both snake_case and camelCase field names because DB
 * queries inconsistently alias columns. This is intentional — normalizing
 * all queries would be a large refactor with high regression risk.
 *
 * @param {Object} record - The DB record to check ownership of.
 * @param {Object} req - Express request with req.user attached.
 * @returns {boolean} True if the user is authorized.
 */
function requireOwnership(record, req) {
  // Normalize field names — DB returns snake_case (SELECT *) or camelCase (aliased queries)
  const ownerId = record.userId ?? record.user_id ?? record.owner ?? record.createdBy ?? record.created_by;

  // Owner-only mutation. The prior `inEntity` branch granted access if the
  // record's entity_id was in req.user.entityIds — but entityIds is a
  // legacy JWT-claim shape; canonical visibility now requires explicit
  // entity_members rows, NOT a tag match. Per CLAUDE.md "Architectural
  // Principles": owner-only mutation for entities. If a route ever
  // legitimately needs membership-based mutation, it should query
  // entity_members directly rather than relying on this helper.
  //
  // No admin/superadmin bypass — cross-tenant mutation belongs in
  // /api/admin/* routes gated by requireSuperAdmin, not this helper.
  return ownerId === req.user.id;
}

/**
 * Express middleware: reject non-superadmin users with 403.
 * Used for platform-level operations (org management, impersonation).
 */
function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

module.exports = { JWT_SECRET, authenticateToken, requireAdmin, requireSuperAdmin, requireOwnership, setDb };
