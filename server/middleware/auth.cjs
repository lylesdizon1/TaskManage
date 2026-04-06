'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

// JWT secret: prefer env var, fall back to random (tokens won't survive restart)
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
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
  const isOwner  = record.user_id === req.user.id;
  const inEntity = record.entity_id &&
                   (req.user.entityIds || []).includes(record.entity_id);
  const isAdmin  = req.user.role === 'admin';
  return isOwner || inEntity || isAdmin;
}

function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

module.exports = { JWT_SECRET, authenticateToken, requireAdmin, requireSuperAdmin, requireOwnership };
