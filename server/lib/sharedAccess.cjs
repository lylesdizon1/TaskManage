'use strict';

/**
 * server/lib/sharedAccess.cjs — permission helper for V1 read-only
 * cross-user access. Not a router. Imported by route handlers that
 * want to serve another user's data (the grantor's) on behalf of the
 * authenticated user (the grantee).
 *
 * V1 contract: grants authorize READS ONLY. There is no cross-user
 * mutation helper here, by design. If a future phase needs cross-user
 * writes it must land with an explicit audit path and a separate helper
 * so this file stays unambiguously read-only.
 */

/**
 * Pure boolean check: does granteeUserId currently hold an active
 * (not revoked, not expired) grant from grantorUserId for the given
 * scope? Defers to db.hasActiveGrant.
 */
async function hasGrant(granteeUserId, grantorUserId, scope, db) {
  if (!granteeUserId || !grantorUserId || !scope || !db?.hasActiveGrant) return false;
  try { return await db.hasActiveGrant(granteeUserId, grantorUserId, scope); }
  catch { return false; }
}

/**
 * Throw an object that Express error handlers (or ad-hoc try/catch in
 * routes) can map to 403. Use inside cross-user read handlers after
 * resolving the target grantor.
 */
async function assertGrant(granteeUserId, grantorUserId, scope, db) {
  const ok = await hasGrant(granteeUserId, grantorUserId, scope, db);
  if (!ok) {
    const err = new Error('Shared access denied');
    err.status = 403;
    err.code = 'SHARED_ACCESS_DENIED';
    throw err;
  }
}

module.exports = { hasGrant, assertGrant };
