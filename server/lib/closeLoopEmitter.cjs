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

async function emitCloseLoop(userId, sourceType, sourceId, titleSnapshot) {
  try {
    if (!userId || !sourceType || !sourceId) return null;
    const row = await db.emitCloseLoopItem(userId, sourceType, String(sourceId), titleSnapshot || null);
    console.log('[closeLoop] emitted', { sourceType, sourceId: String(sourceId) });
    return row;
  } catch (err) {
    console.error('[closeLoop] emit failed:', err.message);
    return null;
  }
}

module.exports = { emitCloseLoop };
