'use strict';

/**
 * server/lib/gmailTokenSaver.cjs — single-source lock for Gmail token saves.
 *
 * Both server/tools.cjs (Aria send/reply/archive paths) and
 * server/routes/gmail.cjs (mail scan) attach `oauth2.on('tokens')`
 * callbacks that fire when the googleapis client refreshes an access
 * token. Without serialization, two concurrent callbacks can each
 * spread their stale closure over a freshly-rotated refresh_token,
 * persisting the older one and bricking the connection on next use.
 *
 * This module exports a process-wide lock keyed on (userId, accountEmail).
 * Both call sites import the same `mergeAndSave` so their callbacks
 * actually serialize against each other, not just within their own file.
 *
 * Single-instance deployment assumption (Railway). For multi-instance,
 * the right answer is a Postgres advisory lock keyed on
 * hash(userId, accountEmail) inside the upsert helper itself.
 */

const { encryptTokens, decryptTokens, ENCRYPTION_KEY } = require('../utils/crypto.cjs');

const _locks = new Map();

function _wrap(tokens) {
  return ENCRYPTION_KEY ? { _enc: encryptTokens(tokens) } : tokens;
}

function _unwrap(stored) {
  if (!stored) return null;
  if (typeof stored === 'object' && stored._enc) return decryptTokens(stored._enc);
  return stored; // legacy unencrypted
}

/**
 * Persist `partial` (the freshly-emitted token diff from googleapis)
 * merged on top of the latest stored tokens for (userId, accountEmail).
 * Serializes against any other call for the same pair.
 */
async function mergeAndSaveGmailTokens(db, userId, accountEmail, partial) {
  const key = `${userId}:${(accountEmail || '').toLowerCase()}`;
  const prior = _locks.get(key) || Promise.resolve();
  const next = (async () => {
    try { await prior; } catch { /* prior failed; proceed */ }
    // Re-read inside the lock so we always merge against the latest
    // persisted state, not a closure-stale snapshot from before the
    // refresh fired.
    const row = await db.getGmailIntegrationByEmail(userId, accountEmail);
    const current = _unwrap(row?.config?.tokens) || {};
    const merged = { ...current, ...(partial || {}) };
    await db.upsertUserIntegration(
      userId, 'gmail', { tokens: _wrap(merged) }, true, accountEmail || '',
    );
  })();
  _locks.set(key, next);
  next.finally(() => {
    if (_locks.get(key) === next) _locks.delete(key);
  }).catch(() => {});
  return next;
}

module.exports = { mergeAndSaveGmailTokens };
