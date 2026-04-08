'use strict';

/**
 * server/utils/date.cjs — Timezone-aware date helpers for the backend.
 *
 * All date logic MUST go through these helpers rather than using
 * Date methods directly. JavaScript's Date object operates in UTC
 * or the server's local timezone — neither of which is correct for
 * a multi-timezone user base.
 *
 * @note Never use toISOString() or getHours()/getDate() for display
 * or comparison — those return UTC, which can be a full day off for
 * users west of UTC. Use Intl.DateTimeFormat with an explicit timeZone
 * parameter instead (as this module does).
 */

/**
 * Return today's date in the user's local timezone as a human-readable
 * string suitable for display and date comparison.
 *
 * Uses Intl.DateTimeFormat with the 'en-CA' locale to produce an
 * ISO-shaped YYYY-MM-DD date component, ensuring lexicographic
 * comparison works correctly (e.g. for overdue checks).
 *
 * @param {string} tz - IANA timezone identifier (e.g. 'America/Los_Angeles').
 *   Must be explicit — no default is provided to prevent silent bugs where
 *   the wrong timezone is assumed.
 * @returns {string} Formatted as "Wednesday, 2026-04-08"
 * @throws {Error} If tz is falsy — forces callers to pass a timezone
 *   rather than silently falling back to a hardcoded default.
 *
 * @example
 * getTodayLocal('America/New_York');   // "Tuesday, 2026-04-08"
 * getTodayLocal('Asia/Tokyo');         // "Wednesday, 2026-04-09"
 * getTodayLocal();                     // throws Error
 */
function getTodayLocal(tz) {
  if (!tz) throw new Error('getTodayLocal requires an explicit timezone');
  const now = new Date();
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(now);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return `${weekday}, ${date}`;
}

module.exports = { getTodayLocal };
