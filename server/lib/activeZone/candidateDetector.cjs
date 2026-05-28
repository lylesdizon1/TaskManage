'use strict';

/**
 * server/lib/activeZone/candidateDetector.cjs
 *
 * Deterministic rules engine that identifies "candidate situations"
 * worth surfacing in Aria's orchestration surface. Each candidate is a
 * structured record — NOT a rendered tile. The tile composer (AZ3)
 * turns candidates into user-facing headlines/bodies/actions.
 *
 * The module exports two entry points:
 *
 *   loadUserStateForActiveZone(userId, db, opts) — fetches all inputs
 *     (tasks, events, close-loops, pending confirmations, flagged inbox
 *     count, today's journal, now) into a plain state object so the
 *     detector and its unit tests share the same input shape.
 *
 *   detectAllCandidates(state) — pure function. Runs the 9 detectors,
 *     dedupes overlapping items by priority, returns top-N sorted by
 *     priority_score. No I/O; easy to unit-test.
 *
 * Per-candidate detector functions are also exported so tests can drive
 * each rule independently.
 *
 * Candidate shape:
 *   {
 *     candidate_type,    // one of CANDIDATE_TYPES below
 *     candidate_key,     // stable hash (type + sorted item ids) for UPSERT dedup
 *     priority_score,    // 0–100
 *     urgency,           // 'immediate' | 'today' | 'soon' | 'whenever'
 *     items,             // array of the underlying records
 *     context,           // extra hints for the composer
 *   }
 */

const crypto = require('crypto');

const CANDIDATE_TYPES = new Set([
  'overdue_tasks_batch',
  'close_the_loops_batch',
  'upcoming_meeting_with_prep',
  'meeting_just_ended',
  'pending_confirmation',
  'draft_resume',
  'daily_wrap_due',
  'critical_email_unacked',
  'single_urgent_task',
  'stale_relationship',
]);

// Urgency is downstream of priority — used only for tie-breaks.
function urgencyFromPriority(p) {
  if (p >= 90) return 'immediate';
  if (p >= 70) return 'today';
  if (p >= 50) return 'soon';
  return 'whenever';
}

function hashItems(type, ids) {
  const sorted = [...(ids || [])].map(String).sort().join(',');
  return `${type}:${crypto.createHash('sha1').update(sorted).digest('hex').slice(0, 12)}`;
}

// ── Helpers exposed to individual detectors ──────────────────────────────

function isOverdue(task, todayLocalIso) {
  if (task?.completed) return false;
  const due = task?.dueDate || task?.due_date || '';
  if (!due) return false;
  return due < todayLocalIso;
}

function daysOverdue(task, todayLocalIso) {
  const due = task?.dueDate || task?.due_date || '';
  if (!due) return 0;
  const t = Date.parse(`${todayLocalIso}T00:00:00Z`);
  const d = Date.parse(`${due}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(d)) return 0;
  return Math.max(0, Math.floor((t - d) / 86400000));
}

function localDateIso(date, timezone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function localHourMinute(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'America/Los_Angeles',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value, 10);
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value, 10);
    return { hour: h, minute: m };
  } catch {
    return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
  }
}

// ── Individual detectors ─────────────────────────────────────────────────

/** 1. 2+ overdue tasks → batch. Priority 80 + 5/day overdue (cap 100). */
function detectOverdueTasksBatch(state) {
  const { tasks = [], todayLocalIso } = state;
  const overdue = tasks
    .filter((t) => isOverdue(t, todayLocalIso))
    .sort((a, b) => {
      const da = (a.dueDate || a.due_date) || '';
      const db = (b.dueDate || b.due_date) || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
  if (overdue.length < 2) return null;
  const maxDays = Math.max(...overdue.map((t) => daysOverdue(t, todayLocalIso)));
  const priority = Math.min(100, 80 + 5 * maxDays);
  return {
    candidate_type: 'overdue_tasks_batch',
    candidate_key: hashItems('overdue_tasks_batch', overdue.map((t) => t.id)),
    priority_score: priority,
    urgency: urgencyFromPriority(priority),
    items: overdue,
    context: { count: overdue.length, max_days_overdue: maxDays },
  };
}

/** 2. Close-the-loops batch. 2+ open, OR any one >48h old. Priority 70 + 5/extra. */
function detectCloseTheLoopsBatch(state) {
  const { closeLoops = [], now } = state;
  if (!closeLoops.length) return null;
  const ageMs = (loop) => {
    const t = Date.parse(loop.triggered_at || loop.triggeredAt || '');
    return Number.isFinite(t) ? (now.getTime() - t) : 0;
  };
  const old = closeLoops.some((l) => ageMs(l) > 48 * 3600 * 1000);
  if (closeLoops.length < 2 && !old) return null;
  const priority = Math.min(100, 70 + 5 * Math.max(0, closeLoops.length - 1));
  return {
    candidate_type: 'close_the_loops_batch',
    candidate_key: hashItems('close_the_loops_batch', closeLoops.map((l) => l.id)),
    priority_score: priority,
    urgency: urgencyFromPriority(priority),
    items: closeLoops,
    context: { count: closeLoops.length, has_stale: old },
  };
}

/** 3. Upcoming meeting ≤30 min AND user has tasks tagged to its entity. Priority 90. */
function detectUpcomingMeetingWithPrep(state) {
  const { events = [], tasks = [], now } = state;
  const soon = events.filter((e) => {
    const t = Date.parse(e.startTime || e.start_time || e.start || '');
    if (!Number.isFinite(t)) return false;
    const deltaMin = (t - now.getTime()) / 60000;
    return deltaMin > 0 && deltaMin <= 30;
  });
  if (!soon.length) return null;
  const event = soon[0]; // nearest upcoming
  const entityId = event.entityId || event.entity_id;
  const eventTags = [entityId, ...(event.tags || [])].filter(Boolean);
  const relatedTasks = tasks.filter((t) => {
    if (t.completed) return false;
    const tagList = Array.isArray(t.tags) ? t.tags : [];
    return tagList.some((tag) => eventTags.includes(tag));
  });
  if (!relatedTasks.length) return null;
  return {
    candidate_type: 'upcoming_meeting_with_prep',
    candidate_key: hashItems('upcoming_meeting_with_prep', [event.id, ...relatedTasks.map((t) => t.id)]),
    priority_score: 90,
    urgency: 'immediate',
    items: [event, ...relatedTasks],
    context: { event, related_tasks: relatedTasks },
  };
}

/** 4. Meeting ended ≤15 min ago, no close-loop resolved for it yet. Priority 85. */
function detectMeetingJustEnded(state) {
  const { events = [], closeLoops = [], now } = state;
  const resolvedEventIds = new Set(
    closeLoops
      .filter((l) => l.source_type === 'event' || l.sourceType === 'event')
      .map((l) => l.source_id || l.sourceId),
  );
  const recent = events.filter((e) => {
    const end = Date.parse(e.endTime || e.end_time || e.end || '');
    if (!Number.isFinite(end)) return false;
    const ago = (now.getTime() - end) / 60000;
    return ago > 0 && ago <= 15 && !resolvedEventIds.has(e.id);
  });
  if (!recent.length) return null;
  const event = recent[0];
  return {
    candidate_type: 'meeting_just_ended',
    candidate_key: hashItems('meeting_just_ended', [event.id]),
    priority_score: 85,
    urgency: 'immediate',
    items: [event],
    context: { event },
  };
}

/** 5. Pending confirmation from decision engine. Priority 95. */
function detectPendingConfirmation(state) {
  const { pendingConfirmations = [] } = state;
  if (!pendingConfirmations.length) return null;
  const row = pendingConfirmations[0];
  return {
    candidate_type: 'pending_confirmation',
    candidate_key: hashItems('pending_confirmation', [row.id]),
    priority_score: 95,
    urgency: 'immediate',
    items: [row],
    context: { tool_name: row.toolName || row.tool_name, params: row.params || row.params_json },
  };
}

/** 6. In-progress draft >1h but <24h old. Priority 50.
 *  No drafts persistence layer exists yet — detector returns null. When
 *  drafts land, plug state.drafts (array of {id, type, updated_at}) in
 *  via loadUserStateForActiveZone and this function activates. */
function detectDraftResume(state) {
  const { drafts = [], now } = state;
  if (!drafts.length) return null;
  const eligible = drafts.filter((d) => {
    const t = Date.parse(d.updated_at || d.updatedAt || '');
    if (!Number.isFinite(t)) return false;
    const ageMin = (now.getTime() - t) / 60000;
    return ageMin > 60 && ageMin < 24 * 60;
  });
  if (!eligible.length) return null;
  return {
    candidate_type: 'draft_resume',
    candidate_key: hashItems('draft_resume', eligible.map((d) => d.id)),
    priority_score: 50,
    urgency: 'soon',
    items: eligible,
    context: { count: eligible.length },
  };
}

/** 7. Past 9pm local + no daily wrap today. Priority 40. */
function detectDailyWrapDue(state) {
  const { todayJournal, now, timezone } = state;
  if (todayJournal?.completed) return null;
  const { hour } = localHourMinute(now, timezone);
  if (hour < 21) return null;
  return {
    candidate_type: 'daily_wrap_due',
    candidate_key: hashItems('daily_wrap_due', [state.todayLocalIso]),
    priority_score: 40,
    urgency: 'whenever',
    items: [],
    context: { hour_local: hour },
  };
}

/** 8. 3+ unacked flagged-critical emails. Priority 60. */
function detectCriticalEmailUnacked(state) {
  const { flaggedUnackedCount = 0, flaggedItems = [] } = state;
  if (flaggedUnackedCount < 3) return null;
  return {
    candidate_type: 'critical_email_unacked',
    candidate_key: hashItems('critical_email_unacked', flaggedItems.length
      ? flaggedItems.map((i) => i.id)
      : [`count_${flaggedUnackedCount}`]),
    priority_score: 60,
    urgency: 'today',
    items: flaggedItems,
    context: { count: flaggedUnackedCount },
  };
}

/** 9. Exactly one high-priority task due today (not overdue). Priority 75. */
function detectSingleUrgentTask(state) {
  const { tasks = [], todayLocalIso } = state;
  const candidates = tasks.filter((t) => {
    if (t.completed) return false;
    const due = t.dueDate || t.due_date || '';
    return due === todayLocalIso && (t.priority === 'high');
  });
  if (candidates.length !== 1) return null;
  return {
    candidate_type: 'single_urgent_task',
    candidate_key: hashItems('single_urgent_task', [candidates[0].id]),
    priority_score: 75,
    urgency: 'today',
    items: candidates,
    context: { task: candidates[0] },
  };
}

/**
 * 10. Stale relationship — a known contact with role (relationship) set
 * whose last touch (contact.updated_at OR memory_facts.last_seen_at on
 * facts tagged to this contact) is older than the threshold (default
 * 30 days, locked per spec §8). Push-eligible — this is one of two
 * V1 detectors authorized to dispatch to WhatsApp.
 *
 * Priority formula: min(100, 40 + 2 * (days_silent - 30)) — fires at
 * 40 on day 30, caps at 100 by day 60.
 */
function detectStaleRelationshipBatch(state) {
  const { staleRelationships = [] } = state;
  if (!staleRelationships.length) return null;
  const maxDays = staleRelationships.reduce((m, c) => Math.max(m, c.daysSilent || 0), 0);
  const priority = Math.min(100, 40 + 2 * Math.max(0, maxDays - 30));
  return {
    type: 'stale_relationship',
    candidate_key: hashItems('stale_relationship_batch', staleRelationships.map((c) => c.id)),
    priority_score: priority,
    urgency: urgencyFromPriority(priority),
    push_eligible: true,
    push_min_priority: 40,
    items: staleRelationships,
    context: { count: staleRelationships.length, max_days_silent: maxDays },
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────

/**
 * Run all detectors, dedupe overlapping item ids across candidates
 * (higher priority wins, lower drops those items; if this empties the
 * lower candidate, drop it entirely), then return top N by
 * priority_score (ties broken by urgency rank, then by items-count).
 */
function detectAllCandidates(state, { topN = 3 } = {}) {
  const detectors = [
    detectPendingConfirmation,    // priority 95 — most important to evaluate first
    detectUpcomingMeetingWithPrep,
    detectMeetingJustEnded,
    detectOverdueTasksBatch,
    detectSingleUrgentTask,
    detectCloseTheLoopsBatch,
    detectCriticalEmailUnacked,
    detectDraftResume,
    detectDailyWrapDue,
    detectStaleRelationshipBatch, // P2b, push-eligible
  ];
  const raw = detectors.map((fn) => { try { return fn(state); } catch { return null; } }).filter(Boolean);
  raw.sort((a, b) => {
    if (b.priority_score !== a.priority_score) return b.priority_score - a.priority_score;
    const ur = (u) => ({ immediate: 3, today: 2, soon: 1, whenever: 0 }[u || 'whenever']);
    return ur(b.urgency) - ur(a.urgency);
  });

  // Dedup overlapping item ids — higher priority (earlier in the sorted
  // list) keeps its items; lower candidates drop any overlap; a fully
  // drained candidate is dropped entirely.
  const claimed = new Set();
  const deduped = [];
  for (const c of raw) {
    const ids = Array.isArray(c.items) ? c.items.map((i) => i?.id).filter(Boolean) : [];
    const kept = c.items?.filter((i) => !claimed.has(i?.id)) || c.items;
    // Count-less candidates (daily_wrap_due, critical_email_unacked) have
    // no items to dedupe — always keep them.
    if (ids.length && (!kept || kept.length === 0)) continue;
    for (const id of ids) claimed.add(id);
    deduped.push({ ...c, items: kept });
  }

  return deduped.slice(0, topN);
}

// ── State loader (does the I/O) ──────────────────────────────────────────

async function loadUserStateForActiveZone(userId, db, { now = new Date() } = {}) {
  const user = await db.getUserById(userId).catch(() => null);
  const timezone = user?.timezone || 'America/Los_Angeles';
  const todayLocalIso = localDateIso(now, timezone);

  // Calendar window: [now - 1h, now + 4h] — wide enough to catch
  // "just ended" + "starting within 30 min" without pulling a full day.
  const winStart = new Date(now.getTime() - 3600000).toISOString();
  const winEnd   = new Date(now.getTime() + 4 * 3600000).toISOString();

  const [tasks, events, closeLoops, pendingConfirmations, criticalFlagged, todayJournal, staleRelationships] = await Promise.all([
    db.getTasksForUser(userId, user?.entityIds || []).catch(() => []),
    db.getCalendarEventsForUser(userId, winStart, winEnd).catch(() => []),
    db.getOpenCloseLoopItems
      ? db.getOpenCloseLoopItems(userId, new Date(Date.parse(`${todayLocalIso}T00:00:00Z`) - 24 * 3600 * 1000).toISOString(), 20).catch(() => [])
      : Promise.resolve([]),
    db.getOpenPendingConfirmations
      ? db.getOpenPendingConfirmations(userId, 5).catch(() => [])
      : Promise.resolve([]),
    // Critical = flagged + unacked + classification confirms actionable.
    // The plain getFlaggedInbox{Items,Count} helpers count raw flags
    // (no classification join) and overcount when auto-flag's stale
    // marker outlives the demoting reclassify. Detector uses the joined
    // helper so the tile reflects current importance/actionRequired
    // state rather than auto-flag's history.
    db.getCriticalFlaggedInboxItems
      ? db.getCriticalFlaggedInboxItems(userId, { limit: 10 }).catch(() => ({ items: [], count: 0 }))
      : Promise.resolve({ items: [], count: 0 }),
    db.getJournalEntryByDate
      ? db.getJournalEntryByDate(userId, todayLocalIso).catch(() => null)
      : Promise.resolve(null),
    // P2b — stale relationships fed into detectStaleRelationshipBatch.
    // Returns [] when the helper isn't loaded so legacy code paths
    // (tests, older state loaders) don't break.
    db.getStaleRelationshipCandidates
      ? db.getStaleRelationshipCandidates(userId, 30, 20).catch(() => [])
      : Promise.resolve([]),
  ]);

  const flaggedUnackedCount = criticalFlagged?.count || 0;
  const flaggedItems = Array.isArray(criticalFlagged?.items) ? criticalFlagged.items : [];

  return {
    userId,
    now,
    timezone,
    todayLocalIso,
    tasks,
    events,
    closeLoops,
    pendingConfirmations,
    flaggedUnackedCount,
    flaggedItems,
    todayJournal,
    staleRelationships,
    drafts: [], // no persistence yet — see detectDraftResume comment
  };
}

module.exports = {
  CANDIDATE_TYPES,
  loadUserStateForActiveZone,
  detectAllCandidates,
  // Individual detectors exported for unit testing.
  detectOverdueTasksBatch,
  detectCloseTheLoopsBatch,
  detectUpcomingMeetingWithPrep,
  detectMeetingJustEnded,
  detectPendingConfirmation,
  detectDraftResume,
  detectDailyWrapDue,
  detectCriticalEmailUnacked,
  detectSingleUrgentTask,
  // Helpers exported for composer/test reuse.
  hashItems,
  urgencyFromPriority,
  localDateIso,
};
