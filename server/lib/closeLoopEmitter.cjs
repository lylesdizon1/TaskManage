'use strict';

/**
 * server/lib/closeLoopEmitter.cjs — fire-and-forget wrapper around
 * db.emitCloseLoopItem. Thin by design so the task/event/project
 * completion paths don't repeat the try/catch + logging scaffold.
 *
 * HARD CONTRACT:
 *   • Never throws.
 *   • Callers may await or ignore the promise — both are safe.
 */

const db = require('../../db.cjs');
const logger = require('../../guardrails/logger.cjs');

async function emitCloseLoop(userId, sourceType, sourceId, titleSnapshot) {
  try {
    if (!userId || !sourceType || !sourceId) return null;
    const row = await db.emitCloseLoopItem(userId, sourceType, String(sourceId), titleSnapshot || null);
    logger.info('closeloop.emitted', { userId, sourceType, sourceId: String(sourceId) });
    return row;
  } catch (err) {
    logger.error('closeloop.emit.failed', {
      userId,
      sourceType,
      sourceId: String(sourceId),
      error: err.message,
      stack: err.stack,
    });
    return null;
  }
}

module.exports = { emitCloseLoop };
