'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

// JWT secret: prefer env var, fall back to random (tokens won't survive restart)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// db reference — set via setDb() from proxy-server at startup
let _db = null;
function setDb(db) { _db = db; }

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
        }
      } catch {}
    }

    next();
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireOwnership(record, req) {
  // Normalize field names — DB returns snake_case (SELECT *) or camelCase (aliased queries)
  const ownerId   = record.userId   ?? record.user_id  ?? record.owner ?? record.createdBy ?? record.created_by;
  const entityId  = record.entityId ?? record.entity_id;

  const isOwner   = ownerId === req.user.id;
  const inEntity  = entityId && (req.user.entityIds || []).includes(entityId);
  const isPrivileged = req.user.role === 'admin' || req.user.role === 'superadmin';

  return isOwner || inEntity || isPrivileged;
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

module.exports = { JWT_SECRET, authenticateToken, requireAdmin, requireSuperAdmin, requireOwnership, setDb };
