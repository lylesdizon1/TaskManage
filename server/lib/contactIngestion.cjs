'use strict';

/**
 * server/lib/contactIngestion.cjs — fire-and-forget contact resolver.
 *
 * Called from mail scan + calendar sync whenever we see a person on
 * inbound data. V1 is strictly single-tenant: the contact belongs to
 * the ingesting user, never to the correspondent. Bare minimum work
 * so callers can `.catch()` and move on.
 *
 * HARD CONTRACT:
 *   • Never throws — every await is wrapped.
 *   • Callers invoke as fire-and-forget; the returned promise is
 *     optional (used only in tests).
 *   • Skips silently when email is missing/invalid or userId is empty.
 */

const db = require('../../db.cjs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function resolveOrCreateContact(userId, { email, name, source } = {}) {
  if (!userId) return null;
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) return null;

  try {
    const existing = await db.resolveContactByEmail(cleanEmail, userId);
    if (existing) return existing;
  } catch (err) {
    console.error('[contactIngestion] resolve failed:', err.message);
    return null;
  }

  const cleanName = typeof name === 'string' ? name.trim() : '';
  const displayName = cleanName || cleanEmail;
  try {
    const created = await db.createContact(userId, {
      displayName,
      primaryEmail: cleanEmail,
      source: source || 'ingestion',
    });
    return created;
  } catch (err) {
    // 23505 unique violation on (user_id, LOWER(primary_email)) — another
    // concurrent ingestion created it first. Re-resolve and return.
    if (err.code === '23505') {
      try { return await db.resolveContactByEmail(cleanEmail, userId); }
      catch { return null; }
    }
    console.error('[contactIngestion] create failed:', err.message);
    return null;
  }
}

module.exports = { resolveOrCreateContact };
