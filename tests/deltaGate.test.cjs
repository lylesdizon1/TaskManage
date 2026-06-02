'use strict';

// Unit tests for the Active Zone delta-gate (pure). Run:
//   node tests/deltaGate.test.cjs
const assert = require('assert');
const { gateCandidates, isEscalation, parseSignature } = require('../server/lib/activeZone/deltaGate.cjs');
const { annotateDelta } = require('../server/lib/activeZone/candidateDetector.cjs');

let pass = 0;
function t(name, fn) { fn(); console.log(`  ✓ ${name}`); pass++; }

const KIND = 'overdue_tasks_batch';
const key = (itemKey) => `${KIND} ${itemKey}`;

// ── isEscalation ──────────────────────────────────────────────────────────
t('not in ledger (stored null) → escalation/new', () => {
  assert.equal(isEscalation(null, 't1@4'), true);
});
t('identical signature → not escalation', () => {
  assert.equal(isEscalation('t1@4', 't1@4'), false);
});
t('member tier increased → escalation', () => {
  assert.equal(isEscalation('t1@4', 't1@5'), true);
});
t('new member added → escalation', () => {
  assert.equal(isEscalation('t1@4', 't1@4,t2@4'), true);
});
t('member removed (de-escalation) → NOT escalation', () => {
  assert.equal(isEscalation('t1@4,t2@4', 't1@4'), false);
});
t('member tier decreased → NOT escalation', () => {
  assert.equal(isEscalation('t1@5', 't1@4'), false);
});
t('singleton same rank → not escalation', () => {
  assert.equal(isEscalation('4', '4'), false);
});
t('singleton rank up → escalation', () => {
  assert.equal(isEscalation('3', '4'), true);
});

// ── parseSignature ──────────────────────────────────────────────────────────
t('parse batch + singleton', () => {
  assert.deepEqual([...parseSignature('a@4,b@6')], [['a', 4], ['b', 6]]);
  assert.deepEqual([...parseSignature('3')], [['_', 3]]);
  assert.deepEqual([...parseSignature('')], []);
});

// ── gateCandidates decisions ────────────────────────────────────────────────
const cand = (item_key, sig) => ({ candidate_type: KIND, item_key, state_signature: sig });

t('NEW when absent from ledger', () => {
  const { surfaced, decisions } = gateCandidates([cand('overdue_tasks_batch', 't1@4')], new Map());
  assert.equal(decisions[0].decision, 'new');
  assert.equal(surfaced.length, 1);
});
t('SUPPRESS when same signature', () => {
  const stored = new Map([[key('overdue_tasks_batch'), 't1@4']]);
  const { surfaced, decisions } = gateCandidates([cand('overdue_tasks_batch', 't1@4')], stored);
  assert.equal(decisions[0].decision, 'suppress');
  assert.equal(surfaced.length, 0);
});
t('RESURFACE when escalated (tier up)', () => {
  const stored = new Map([[key('overdue_tasks_batch'), 't1@4']]);
  const { surfaced, decisions } = gateCandidates([cand('overdue_tasks_batch', 't1@5')], stored);
  assert.equal(decisions[0].decision, 'resurface');
  assert.equal(surfaced.length, 1);
});
t('RESURFACE when a NEW overdue task joins (newly overdue must still surface)', () => {
  const stored = new Map([[key('overdue_tasks_batch'), 't1@4']]);
  const { decisions } = gateCandidates([cand('overdue_tasks_batch', 't1@4,t2@4')], stored);
  assert.equal(decisions[0].decision, 'resurface');
});
t('SUPPRESS when only de-escalated (a task handled, set shrank)', () => {
  const stored = new Map([[key('overdue_tasks_batch'), 't1@4,t2@4']]);
  const { decisions } = gateCandidates([cand('overdue_tasks_batch', 't1@4')], stored);
  assert.equal(decisions[0].decision, 'suppress');
});

// ── annotateDelta → gate integration (the canonical signatures) ─────────────
const stateNow = { todayLocalIso: '2026-06-02', now: new Date('2026-06-02T18:00:00Z') };

t('overdue batch: more-overdue same task escalates', () => {
  const c1 = annotateDelta({ candidate_type: 'overdue_tasks_batch', items: [{ id: 9, due_date: '2026-06-01' }] }, stateNow); // 1 day → rank 4
  const c2 = annotateDelta({ candidate_type: 'overdue_tasks_batch', items: [{ id: 9, due_date: '2026-05-26' }] }, stateNow); // 7 days → rank 6
  assert.equal(isEscalation(c1.state_signature, c2.state_signature), true);
});
t('pending_confirmation: distinct id = distinct item_key (each surfaces once)', () => {
  const a = annotateDelta({ candidate_type: 'pending_confirmation', items: [{ id: 1 }] }, stateNow);
  const b = annotateDelta({ candidate_type: 'pending_confirmation', items: [{ id: 2 }] }, stateNow);
  assert.notEqual(a.item_key, b.item_key);
  assert.equal(a.state_signature, '4');
});
t('daily_wrap_due: per-day item_key, steady within the day', () => {
  const c = annotateDelta({ candidate_type: 'daily_wrap_due', items: [] }, stateNow);
  assert.equal(c.item_key, 'daily_wrap_due:2026-06-02');
  assert.equal(isEscalation(c.state_signature, c.state_signature), false);
});

// ── critical_email_unacked: viewed/unviewed + close-the-loop nag ────────────
const emailCand = (items) => annotateDelta({ candidate_type: 'critical_email_unacked', items, context: {} }, stateNow);
const email = (id, is_read, daysAgo = 0) => ({
  id, is_read,
  flagged_at: new Date(stateNow.now.getTime() - daysAgo * 86400000).toISOString(),
});

t('email: unviewed sits at baseline rank 3', () => {
  const c = emailCand([email('e1', false)]);
  assert.equal(c.state_signature, 'e1@3');
  assert.equal(c.escalation_tier, 3);
});
t('email: steady unviewed → suppress', () => {
  const a = emailCand([email('e1', false)]);
  const b = emailCand([email('e1', false)]);
  assert.equal(isEscalation(a.state_signature, b.state_signature), false);
});
t('email: unviewed → viewed transition → escalation (close-the-loop nag)', () => {
  const unv = emailCand([email('e1', false)]);
  const viewedFresh = emailCand([email('e1', true, 0)]); // rank 4
  assert.equal(isEscalation(unv.state_signature, viewedFresh.state_signature), true);
});
t('email: viewed age deepening (0–2d → 7d+) → escalation', () => {
  const fresh = emailCand([email('e1', true, 1)]);  // rank 4
  const old = emailCand([email('e1', true, 9)]);    // rank 6
  assert.equal(isEscalation(fresh.state_signature, old.state_signature), true);
});
t('email: steady viewed same age bucket → suppress', () => {
  const a = emailCand([email('e1', true, 4)]); // rank 5
  const b = emailCand([email('e1', true, 5)]); // rank 5 (same bucket 3–6d)
  assert.equal(a.state_signature, b.state_signature);
  assert.equal(isEscalation(a.state_signature, b.state_signature), false);
});
t('email: a NEW unviewed critical email arriving → escalation (new member)', () => {
  const before = emailCand([email('e1', true, 2)]);
  const after = emailCand([email('e1', true, 2), email('e2', false)]);
  assert.equal(isEscalation(before.state_signature, after.state_signature), true);
});

console.log(`\n${pass} passed, 0 failed`);
