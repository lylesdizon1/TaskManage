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

const TZ_MARKER_RE = /([Zz]|[+-]\d{2}:?\d{2})$/;
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Normalize an ISO-8601-ish input to a bare-local "YYYY-MM-DDTHH:MM:SS"
 * string in the given timezone. Designed for the Google Calendar dateTime
 * pairing where (dateTime, timeZone) is unambiguous only when dateTime
 * has no offset/Z marker.
 *
 * Rules:
 *   - "YYYY-MM-DD" (date only)               → "YYYY-MM-DDT00:00:00"
 *   - "YYYY-MM-DDTHH:MM[:SS]" with no marker → returned as-is (treated as
 *     already in the user's local tz; this is what Aria should send)
 *   - "...T...Z" or "...±HH:MM" / "...±HHMM" → re-expressed as wall-clock
 *     in `tz` (so the absolute moment is preserved when paired with
 *     timeZone:tz on the Google API)
 *   - Falsy / unparseable                    → null
 *
 * @param {string} input
 * @param {string} tz - IANA timezone (e.g. 'America/Los_Angeles').
 * @returns {string|null}
 */
function toLocalIsoNoTz(input, tz) {
  if (!input || typeof input !== 'string') return null;
  if (!tz) throw new Error('toLocalIsoNoTz requires an explicit timezone');
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!trimmed.includes('T')) {
    // Date-only — pass through as start of day local. Validate basic shape.
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00` : null;
  }
  const hasMarker = TZ_MARKER_RE.test(trimmed);
  if (!hasMarker) {
    // Bare-local — minimum sanity check, then ensure HH:MM:SS shape.
    const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    return `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}`;
  }
  // Has TZ marker — re-express in user's tz via Intl.
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  // Intl can return "24" for hour at midnight in some locales — normalize.
  let hh = get('hour');
  if (hh === '24') hh = '00';
  const Y = get('year'); const M = get('month'); const D = get('day');
  const mm = get('minute'); const ss = get('second');
  if (!Y || !M || !D || hh == null || !mm || !ss) return null;
  return `${Y}-${M}-${D}T${hh}:${mm}:${ss}`;
}

/**
 * Add `hours` to a bare-local "YYYY-MM-DDTHH:MM:SS" string as wall-clock
 * arithmetic — handles day/month/year rollover. Independent of server
 * timezone (uses Date.UTC internally to avoid local-tz interference).
 */
function addHoursLocalIso(localIso, hours) {
  const m = String(localIso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, Y, M, D, h, mn, s] = m.map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D, h, mn, s));
  d.setUTCHours(d.getUTCHours() + Number(hours || 0));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/**
 * Compare two bare-local "YYYY-MM-DDTHH:MM:SS" strings lexicographically.
 * Returns -1 / 0 / 1 like a comparator. Both inputs MUST be in the same tz
 * for the result to be meaningful — caller's responsibility.
 */
function compareLocalIso(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Format an instant (Date, ISO string, or ms epoch) as user-local
 * wall-clock text for inclusion in LLM prompts or rendered surfaces.
 *
 * Centralizes the "render an instant in the user's timezone" pattern
 * that was being open-coded inconsistently. Critical for LLM context:
 * Aria parrots whatever digits she sees in the prompt, so any path
 * that leaks UTC strings (e.g. new Date(x).toISOString()) into her
 * context causes her to misreport event times.
 *
 * @param {string|number|Date} input - The instant to render.
 * @param {string} tz - IANA timezone (required, no fallback by design).
 * @param {Object} [opts]
 * @param {boolean} [opts.includeDate=true] - Include "Mon DD" date part.
 * @param {boolean} [opts.includeTime=true] - Include "h:MM AM" time part.
 * @returns {string} Human-readable local string, or '' if input is unparseable.
 */
function formatLocalDateTime(input, tz, opts = {}) {
  if (!input || !tz) return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const { includeDate = true, includeTime = true } = opts;
  const fmtOpts = { timeZone: tz };
  if (includeDate) { fmtOpts.month = 'short'; fmtOpts.day = 'numeric'; }
  if (includeTime) { fmtOpts.hour = 'numeric'; fmtOpts.minute = '2-digit'; fmtOpts.hour12 = true; }
  return new Intl.DateTimeFormat('en-US', fmtOpts).format(d);
}

module.exports = { getTodayLocal, toLocalIsoNoTz, addHoursLocalIso, compareLocalIso, formatLocalDateTime };
