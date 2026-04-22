'use strict';

/**
 * tests/activeZoneDetector.test.cjs — unit tests for the Active Zone
 * candidate detector. Pure logic only; no DB / no network. Safe to run
 * without DATABASE_URL.
 *
 * Run with:
 *   node tests/activeZoneDetector.test.cjs
 */

const assert = require('node:assert/strict');
const {
  detectAllCandidates,
  detectOverdueTasksBatch,
  detectCloseTheLoopsBatch,
  detectUpcomingMeetingWithPrep,
  detectMeetingJustEnded,
  detectPendingConfirmation,
  detectDailyWrapDue,
  detectCriticalEmailUnacked,
  detectSingleUrgentTask,
  detectDraftResume,
} = require('../server/lib/activeZone/candidateDetector.cjs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const NOW = new Date('2026-04-22T21:30:00-07:00'); // 9:30pm PT
const TODAY_LOCAL = '2026-04-22';
const TZ = 'America/Los_Angeles';

function baseState(overrides = {}) {
  return {
    userId: 'u1',
    now: NOW,
    timezone: TZ,
    todayLocalIso: TODAY_LOCAL,
    tasks: [],
    events: [],
    closeLoops: [],
    pendingConfirmations: [],
    flaggedUnackedCount: 0,
    todayJournal: null,
    drafts: [],
    ...overrides,
  };
}

// ── 1. overdue_tasks_batch ────────────────────────────────────────────────

test('overdue_tasks_batch: 1 overdue = null', () => {
  const c = detectOverdueTasksBatch(baseState({
    tasks: [{ id: 't1', dueDate: '2026-04-20' }],
  }));
  assert.equal(c, null);
});

test('overdue_tasks_batch: 2 overdue triggers, priority 80+5/day', () => {
  const c = detectOverdueTasksBatch(baseState({
    tasks: [
      { id: 't1', dueDate: '2026-04-21' }, // 1 day overdue
      { id: 't2', dueDate: '2026-04-19' }, // 3 days overdue
    ],
  }));
  assert.ok(c, 'expected candidate');
  assert.equal(c.candidate_type, 'overdue_tasks_batch');
  assert.equal(c.priority_score, 95); // 80 + 5*3
  assert.equal(c.items.length, 2);
  assert.equal(c.items[0].id, 't2'); // sorted asc → oldest first
});

test('overdue_tasks_batch: priority caps at 100', () => {
  const c = detectOverdueTasksBatch(baseState({
    tasks: [
      { id: 't1', dueDate: '2026-04-01' }, // 21 days overdue → 185 uncapped
      { id: 't2', dueDate: '2026-04-02' },
    ],
  }));
  assert.equal(c.priority_score, 100);
});

test('overdue_tasks_batch: completed tasks not counted', () => {
  const c = detectOverdueTasksBatch(baseState({
    tasks: [
      { id: 't1', dueDate: '2026-04-20', completed: true },
      { id: 't2', dueDate: '2026-04-20', completed: true },
    ],
  }));
  assert.equal(c, null);
});

// ── 2. close_the_loops_batch ──────────────────────────────────────────────

test('close_the_loops_batch: 1 recent loop = null', () => {
  const c = detectCloseTheLoopsBatch(baseState({
    closeLoops: [{ id: 'l1', triggered_at: new Date(NOW.getTime() - 3600000).toISOString() }],
  }));
  assert.equal(c, null);
});

test('close_the_loops_batch: 2+ loops triggers, priority 70+5/extra', () => {
  const c = detectCloseTheLoopsBatch(baseState({
    closeLoops: [
      { id: 'l1', triggered_at: NOW.toISOString() },
      { id: 'l2', triggered_at: NOW.toISOString() },
      { id: 'l3', triggered_at: NOW.toISOString() },
    ],
  }));
  assert.ok(c);
  assert.equal(c.priority_score, 80); // 70 + 5*2
});

test('close_the_loops_batch: single loop >48h old triggers', () => {
  const c = detectCloseTheLoopsBatch(baseState({
    closeLoops: [{ id: 'l1', triggered_at: new Date(NOW.getTime() - 72 * 3600000).toISOString() }],
  }));
  assert.ok(c);
  assert.equal(c.context.has_stale, true);
});

// ── 3. upcoming_meeting_with_prep ─────────────────────────────────────────

test('upcoming_meeting_with_prep: event in 20 min + related task → priority 90', () => {
  const eventStart = new Date(NOW.getTime() + 20 * 60000).toISOString();
  const c = detectUpcomingMeetingWithPrep(baseState({
    events: [{ id: 'e1', startTime: eventStart, entityId: 'ent-paul' }],
    tasks: [{ id: 't1', tags: ['ent-paul'] }],
  }));
  assert.ok(c);
  assert.equal(c.priority_score, 90);
  assert.equal(c.urgency, 'immediate');
});

test('upcoming_meeting_with_prep: no related tasks = null', () => {
  const eventStart = new Date(NOW.getTime() + 20 * 60000).toISOString();
  const c = detectUpcomingMeetingWithPrep(baseState({
    events: [{ id: 'e1', startTime: eventStart, entityId: 'ent-paul' }],
    tasks: [{ id: 't1', tags: ['ent-other'] }],
  }));
  assert.equal(c, null);
});

test('upcoming_meeting_with_prep: event >30 min away = null', () => {
  const eventStart = new Date(NOW.getTime() + 60 * 60000).toISOString();
  const c = detectUpcomingMeetingWithPrep(baseState({
    events: [{ id: 'e1', startTime: eventStart, entityId: 'ent-paul' }],
    tasks: [{ id: 't1', tags: ['ent-paul'] }],
  }));
  assert.equal(c, null);
});

// ── 4. meeting_just_ended ─────────────────────────────────────────────────

test('meeting_just_ended: event ended 5 min ago, no close-loop yet → priority 85', () => {
  const c = detectMeetingJustEnded(baseState({
    events: [{ id: 'e1', endTime: new Date(NOW.getTime() - 5 * 60000).toISOString() }],
  }));
  assert.ok(c);
  assert.equal(c.priority_score, 85);
});

test('meeting_just_ended: close-loop already exists for event = null', () => {
  const c = detectMeetingJustEnded(baseState({
    events: [{ id: 'e1', endTime: new Date(NOW.getTime() - 5 * 60000).toISOString() }],
    closeLoops: [{ id: 'l1', source_type: 'event', source_id: 'e1' }],
  }));
  assert.equal(c, null);
});

// ── 5. pending_confirmation ───────────────────────────────────────────────

test('pending_confirmation: 1 pending → priority 95', () => {
  const c = detectPendingConfirmation(baseState({
    pendingConfirmations: [{ id: 'pc-1', toolName: 'send_email', params: {} }],
  }));
  assert.ok(c);
  assert.equal(c.priority_score, 95);
});

// ── 6. draft_resume ───────────────────────────────────────────────────────

test('draft_resume: no drafts (no persistence layer) = null', () => {
  const c = detectDraftResume(baseState());
  assert.equal(c, null);
});

test('draft_resume: draft 2h old triggers', () => {
  const c = detectDraftResume(baseState({
    drafts: [{ id: 'd1', updated_at: new Date(NOW.getTime() - 2 * 3600000).toISOString() }],
  }));
  assert.ok(c);
  assert.equal(c.priority_score, 50);
});

// ── 7. daily_wrap_due ─────────────────────────────────────────────────────

test('daily_wrap_due: 9:30pm + no journal → priority 40', () => {
  const c = detectDailyWrapDue(baseState({ todayJournal: null }));
  assert.ok(c);
  assert.equal(c.priority_score, 40);
});

test('daily_wrap_due: 9:30pm + completed journal = null', () => {
  const c = detectDailyWrapDue(baseState({ todayJournal: { completed: true } }));
  assert.equal(c, null);
});

test('daily_wrap_due: before 9pm = null', () => {
  const c = detectDailyWrapDue(baseState({
    now: new Date('2026-04-22T15:00:00-07:00'),
  }));
  assert.equal(c, null);
});

// ── 8. critical_email_unacked ─────────────────────────────────────────────

test('critical_email_unacked: 2 unacked = null', () => {
  const c = detectCriticalEmailUnacked(baseState({ flaggedUnackedCount: 2 }));
  assert.equal(c, null);
});

test('critical_email_unacked: 5 unacked → priority 60', () => {
  const c = detectCriticalEmailUnacked(baseState({ flaggedUnackedCount: 5 }));
  assert.ok(c);
  assert.equal(c.priority_score, 60);
});

// ── 9. single_urgent_task ─────────────────────────────────────────────────

test('single_urgent_task: exactly 1 high-priority task due today → priority 75', () => {
  const c = detectSingleUrgentTask(baseState({
    tasks: [{ id: 't1', priority: 'high', dueDate: TODAY_LOCAL }],
  }));
  assert.ok(c);
  assert.equal(c.priority_score, 75);
});

test('single_urgent_task: 2 high-priority tasks due today = null', () => {
  const c = detectSingleUrgentTask(baseState({
    tasks: [
      { id: 't1', priority: 'high', dueDate: TODAY_LOCAL },
      { id: 't2', priority: 'high', dueDate: TODAY_LOCAL },
    ],
  }));
  assert.equal(c, null);
});

// ── Orchestrator: dedup + top-N + ranking ─────────────────────────────────

test('detectAllCandidates: priority 95 pending_confirmation ranks first', () => {
  const candidates = detectAllCandidates(baseState({
    pendingConfirmations: [{ id: 'pc-1', toolName: 'send_email' }],
    tasks: [
      { id: 't1', dueDate: '2026-04-20' },
      { id: 't2', dueDate: '2026-04-19' },
    ],
  }));
  assert.equal(candidates[0].candidate_type, 'pending_confirmation');
  assert.equal(candidates[1].candidate_type, 'overdue_tasks_batch');
});

test('detectAllCandidates: caps at topN', () => {
  const candidates = detectAllCandidates(baseState({
    pendingConfirmations: [{ id: 'pc-1' }],
    tasks: [
      { id: 't1', dueDate: '2026-04-20' },
      { id: 't2', dueDate: '2026-04-19' },
      { id: 't-urg', priority: 'high', dueDate: TODAY_LOCAL },
    ],
    closeLoops: [{ id: 'l1', triggered_at: NOW.toISOString() }, { id: 'l2', triggered_at: NOW.toISOString() }],
    todayJournal: null,
  }), { topN: 3 });
  assert.equal(candidates.length, 3);
});

test('detectAllCandidates: item-level dedup — overdue_tasks_batch keeps ids, single_urgent dropped if same task', () => {
  // Overdue (priority 80+) wins the item; single_urgent has same task;
  // single_urgent's only item is already claimed → candidate drops entirely.
  // (The test constructs an overlap by putting the same id in both via
  // dueDate flip: shared as t-1.)
  const candidates = detectAllCandidates(baseState({
    tasks: [
      { id: 't-shared', dueDate: '2026-04-21' }, // overdue
      { id: 't-2', dueDate: '2026-04-21' },      // also overdue (makes batch trigger)
      // Separately craft a task that's high-priority today so the single_urgent
      // case COULD fire — but we want to test dedup, so reuse id:
      { id: 't-shared', priority: 'high', dueDate: TODAY_LOCAL },
    ],
  }));
  // The overdue batch should be present; the single_urgent candidate was
  // built from an overlapping id and should have been dropped by dedup.
  const types = candidates.map((c) => c.candidate_type);
  assert.ok(types.includes('overdue_tasks_batch'));
  assert.ok(!types.includes('single_urgent_task'));
});

// ── Runner ───────────────────────────────────────────────────────────────

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`✗ ${t.name}\n   ${err.message}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
