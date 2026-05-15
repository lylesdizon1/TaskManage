'use strict';

/**
 * server/lib/contextRendering.cjs — Shared rendering helpers for the
 * agentic system prompt.
 *
 * Pulled out of buildAgenticContext.cjs so the morning-brief endpoint
 * (/api/dashboard/aria-brief) can reuse the same bucketed calendar /
 * task / notes rendering. Before this extraction, the brief endpoint
 * had its own ad-hoc rendering (calendar as flat "title at time" list,
 * notes as title-only) that pre-dated the bucketing work in
 * buildAgenticContext — so the bucketing fix in 7c24218 never reached
 * the brief. Lyle's 12:08 AM brief reported a noon meeting past-tense
 * because of that gap.
 *
 * The helpers in this module are PURE: no DB, no HTTP, no logger. They
 * take pre-fetched data + tz and return prompt-ready strings. Callers
 * are responsible for fetching events/tasks/notes.
 *
 * Boundaries:
 *  - Bucketing logic is shared. Section labels and time-formatting are
 *    consistent across every Aria surface that consumes these helpers.
 *  - Empty buckets are dropped silently. The only way the calendar
 *    renderer emits a "none" string is when ALL buckets are empty —
 *    a single-day brief window that finds zero events will collapse
 *    cleanly to " none", not " TODAY: none / TOMORROW: (empty) / ...".
 */

const { formatLocalDateTime } = require('../utils/date.cjs');

// ── Calendar bucketing ────────────────────────────────────────────────
// Buckets events by their temporal relation to NOW in the user's tz.
// Past events from prior days are dropped. Today is split into
// completed/in-progress/upcoming so the model can't conflate "noon
// meeting" with "noon meeting already happened" when the brief fires
// early in the day.
function bucketCalendarEvents(events, tz, now = new Date()) {
  const nowMs = now.getTime();
  const dateKeyOf = (d) => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  const todayKey = dateKeyOf(now);
  const tomorrowKey = dateKeyOf(new Date(nowMs + 86400000));
  const buckets = { completedToday: [], inProgressNow: [], upcomingToday: [], tomorrow: [], laterThisWeek: [] };
  for (const ev of (events || [])) {
    if (!ev?.start) continue;
    const startMs = new Date(ev.start).getTime();
    if (!Number.isFinite(startMs)) continue;
    const endMs = ev.end ? new Date(ev.end).getTime() : null;
    const evKey = dateKeyOf(new Date(startMs));
    if (evKey === todayKey) {
      if (endMs && endMs <= nowMs) buckets.completedToday.push(ev);
      else if (startMs <= nowMs && (!endMs || endMs > nowMs)) buckets.inProgressNow.push(ev);
      else buckets.upcomingToday.push(ev);
    } else if (evKey === tomorrowKey) {
      buckets.tomorrow.push(ev);
    } else if (evKey > todayKey) {
      buckets.laterThisWeek.push(ev);
    }
  }
  return buckets;
}

function renderCalendarBuckets(buckets, tz) {
  const tFmt = (ev) => {
    if (ev.allDay) return `(all-day) ${ev.title}`;
    const t = formatLocalDateTime(ev.start, tz, { includeDate: false });
    return `${t} — ${ev.title}`;
  };
  const dtFmt = (ev) => {
    const when = formatLocalDateTime(ev.start, tz) || ev.start;
    if (ev.allDay) return `${when.split(',')[0]} (all-day) — ${ev.title}`;
    return `${when} — ${ev.title}`;
  };
  // Empty-section drop: a section is omitted entirely when its bucket
  // is empty. No "TOMORROW: (none)" or "LATER THIS WEEK: (none)" noise.
  // The prior "TODAY: none" fallback (which fired even when TOMORROW
  // had events) is gone too — if today is empty but tomorrow has
  // events, the prompt just renders TOMORROW without flagging today.
  // The only "none" path is when ALL buckets are empty.
  const lines = [];
  if (buckets.completedToday.length) lines.push(`  COMPLETED TODAY: ${buckets.completedToday.map(tFmt).join('; ')}`);
  if (buckets.inProgressNow.length)  lines.push(`  IN PROGRESS NOW: ${buckets.inProgressNow.map(tFmt).join('; ')}`);
  if (buckets.upcomingToday.length)  lines.push(`  UPCOMING TODAY: ${buckets.upcomingToday.map(tFmt).join('; ')}`);
  if (buckets.tomorrow.length)       lines.push(`  TOMORROW: ${buckets.tomorrow.map(tFmt).join('; ')}`);
  if (buckets.laterThisWeek.length)  lines.push(`  LATER THIS WEEK: ${buckets.laterThisWeek.slice(0, 10).map(dtFmt).join('; ')}`);
  return lines.length ? `\n${lines.join('\n')}` : ' none';
}

// ── Task bucketing ────────────────────────────────────────────────────
// activeTasks must be pre-filtered to !completed. Past/future
// hallucination is less of a risk here because tasks have an explicit
// completed boolean — but bucket render still helps the model find
// "what's due today" without scanning the whole list. Same empty-section
// drop semantics as the calendar renderer.
function bucketActiveTasks(activeTasks, todayDateKey) {
  const buckets = { dueToday: [], overdue: [], upcoming: [], noDate: [] };
  for (const t of (activeTasks || [])) {
    if (!t.dueDate) { buckets.noDate.push(t); continue; }
    if (t.dueDate === todayDateKey) { buckets.dueToday.push(t); continue; }
    if (t.dueDate < todayDateKey) { buckets.overdue.push(t); continue; }
    buckets.upcoming.push(t);
  }
  return buckets;
}

function renderTaskBuckets(buckets) {
  const fmt = (t) => `[${t.id}] ${t.title} (${t.priority || 'medium'}${t.dueDate ? `, due ${t.dueDate}` : ''})`;
  const lines = [];
  if (buckets.dueToday.length) lines.push(`  DUE TODAY (${buckets.dueToday.length}): ${buckets.dueToday.slice(0, 20).map(fmt).join('; ')}`);
  if (buckets.overdue.length)  lines.push(`  OVERDUE (${buckets.overdue.length}): ${buckets.overdue.slice(0, 20).map(fmt).join('; ')}`);
  if (buckets.upcoming.length) lines.push(`  UPCOMING (${buckets.upcoming.length}): ${buckets.upcoming.slice(0, 15).map(fmt).join('; ')}`);
  if (buckets.noDate.length)   lines.push(`  NO DUE DATE (${buckets.noDate.length}): ${buckets.noDate.slice(0, 10).map(fmt).join('; ')}`);
  return lines.length ? `\n${lines.join('\n')}` : ' none';
}

// ── Recent notes rendering ────────────────────────────────────────────
// Title + 150-char body excerpt + created_at date, semicolon-joined.
// Replaces the old title-only flat list (which made it impossible for
// Aria to link a query like "what's the office thing tomorrow?" to a
// note titled "San Ramon Office — Moving In" — body content + date
// scaffolding are what give the model the connection it needs).
function renderRecentNotes(notes, tz, limit = 10) {
  if (!Array.isArray(notes) || notes.length === 0) return 'none';
  return notes.slice(0, limit).map((n) => {
    const dateStr = formatLocalDateTime(n.createdAt, tz, { includeTime: false }) || '?';
    const body = (n.content || '').replace(/\s+/g, ' ').trim();
    const excerpt = body.length > 150 ? `${body.slice(0, 150).trim()}…` : body;
    const prefix = `[${dateStr}] "${n.title || '(untitled)'}"`;
    return excerpt ? `${prefix} — ${excerpt}` : prefix;
  }).join('; ');
}

module.exports = {
  bucketCalendarEvents,
  renderCalendarBuckets,
  bucketActiveTasks,
  renderTaskBuckets,
  renderRecentNotes,
};
