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

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * JWT signing secret. Uses the JWT_SECRET env var in production.
 * Falls back to a random secret in development — tokens will not
 * survive server restarts, which is acceptable for local use.
 * @type {string}
 */
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

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
 * @note DB enrichment is best-effort. If the DB lookup fails,
 * the request proceeds with JWT-only claims — meaning role and
 * entityIds may be stale. This favors availability over strict
 * authorization freshness. Known tradeoff — revisit if stricter
 * auth guarantees are needed.
 */
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;

    // Enrich with fresh DB context (timezone, role) — non-blocking on failure
    if (_db) {
      try {
        const ctx = await _db.getUserAuthContext(payload.id);
        if (ctx) {
          req.user.timezone = ctx.timezone || 'America/Los_Angeles';
          req.user.role = ctx.role || req.user.role;
          req.user.entityIds = ctx.entityIds || [];
        }
      } catch {}
    }

    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
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
  const ownerId   = record.userId   ?? record.user_id  ?? record.owner ?? record.createdBy ?? record.created_by;
  const entityId  = record.entityId ?? record.entity_id;

  const isOwner   = ownerId === req.user.id;
  const inEntity  = entityId && (req.user.entityIds || []).includes(entityId);
  const isPrivileged = req.user.role === 'admin' || req.user.role === 'superadmin';

  return isOwner || inEntity || isPrivileged;
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
