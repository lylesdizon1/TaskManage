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
const { extractContactFacts } = require('./contactFactExtractor.cjs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_SNIPPET_CHARS = 20;

// Domain substrings that mean "not a real person" regardless of local part.
const NOISY_DOMAIN_SUBSTRINGS = [
  'calendly.com',
  'calendar.google.com',
  'group.calendar.google.com',
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'mailer',
  'bounce',
  'automatedemail',
];

// Exact local-part matches that mean "role address, not a person".
const NOISY_LOCAL_PARTS = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'notifications',
  'alerts',
  'mailer',
  'postmaster',
  'bounce',
]);

/**
 * Return true if `email` is noisy — either a self-contact (matches one
 * of the user's own connected account emails), a role address, or an
 * automated sender domain. Lowercase inputs assumed.
 */
function isNoisyContact(email, userEmails) {
  if (!email) return true;
  if (userEmails && userEmails.has(email)) return true;
  const at = email.indexOf('@');
  if (at < 0) return true;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (NOISY_LOCAL_PARTS.has(local)) return true;
  for (const needle of NOISY_DOMAIN_SUBSTRINGS) {
    if (domain.includes(needle)) return true;
  }
  return false;
}

/**
 * Load the set of connected-account emails for a user (all providers,
 * all enabled rows). Used to filter self-contacts. Returns a Set of
 * lowercased strings; empty Set on failure.
 */
async function loadUserEmailSet(userId) {
  try {
    const { rows } = await db.pool.query(
      `SELECT account_email AS email
       FROM user_integrations
       WHERE user_id = $1 AND is_enabled = TRUE
         AND account_email IS NOT NULL AND account_email <> ''`,
      [userId],
    );
    const set = new Set();
    for (const r of rows) {
      const e = (r.email || '').trim().toLowerCase();
      if (!e) continue;
      // Strip provider prefix used by Outlook cal sync (e.g. "outlook:me@ex.com").
      const colonIdx = e.indexOf(':');
      const bare = colonIdx >= 0 ? e.slice(colonIdx + 1) : e;
      set.add(bare);
    }
    // Also include the user's primary users.email when available.
    try {
      const u = await db.getUserById(userId);
      if (u?.email) set.add(String(u.email).trim().toLowerCase());
    } catch {}
    return set;
  } catch {
    return new Set();
  }
}

async function resolveOrCreateContact(userId, { email, name, source, snippet } = {}) {
  if (!userId) return null;
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) return null;

  let contact = null;
  try {
    contact = await db.resolveContactByEmail(cleanEmail, userId);
  } catch (err) {
    console.error('[contactIngestion] resolve failed:', err.message);
    return null;
  }

  if (!contact) {
    // Noise filter only on create — if a contact already exists we respect
    // prior user action (including their own manually-added email).
    const userEmails = await loadUserEmailSet(userId);
    if (isNoisyContact(cleanEmail, userEmails)) {
      console.log('[contactIngestion] skipped noisy contact:', cleanEmail);
      return null;
    }
    const cleanName = typeof name === 'string' ? name.trim() : '';
    const displayName = cleanName || cleanEmail;
    try {
      contact = await db.createContact(userId, {
        displayName,
        primaryEmail: cleanEmail,
        source: source || 'ingestion',
      });
    } catch (err) {
      // 23505 unique violation on (user_id, LOWER(primary_email)) — another
      // concurrent ingestion created it first. Re-resolve and return.
      if (err.code === '23505') {
        try { contact = await db.resolveContactByEmail(cleanEmail, userId); }
        catch { return null; }
      } else {
        console.error('[contactIngestion] create failed:', err.message);
        return null;
      }
    }
  }

  // Optional fact extraction — fire-and-forget when a snippet is present
  // and long enough to contain signal. Debounce + empty-output handling
  // live inside the extractor.
  if (contact?.id && typeof snippet === 'string' && snippet.trim().length >= MIN_SNIPPET_CHARS) {
    extractContactFacts(userId, contact.id, contact.displayName, snippet.trim())
      .catch((err) => console.error('[contactIngestion] extract:', err.message));
  }

  return contact;
}

module.exports = { resolveOrCreateContact, isNoisyContact };
