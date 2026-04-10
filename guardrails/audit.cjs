const db = require('../db.cjs');
const logger = require('./logger.cjs');

async function writeAudit({ userId, actorId, entityType, entityId, action, before, after, requestId, metadata, source = 'api' }) {
  try {
    await db.pool.query(
      `INSERT INTO audit_log
         (user_id, actor_id, entity_type, entity_id, action, changes, request_id, metadata, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        userId,
        actorId ?? userId,
        entityType,
        String(entityId),
        action,
        JSON.stringify({ before: before ?? null, after: after ?? null }),
        requestId ?? null,
        JSON.stringify(metadata ?? {}),
        source,
      ]
    );
  } catch (err) {
    logger.error('audit.write.failed', { userId, entityType, entityId, action, requestId, error: err.message });
  }
}

module.exports = { writeAudit };
