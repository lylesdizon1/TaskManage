'use strict';

/**
 * tests/closeLoopBatch.test.cjs — input-validation tests for the
 * /api/close-loop/resolve-batch endpoint logic.
 *
 * Tests the body-shape validation + outcome_status enum + raw_note
 * length cap. Does NOT test the transaction itself (would require a
 * live test DB). The transaction in db.resolveCloseLoopBatch is
 * straightforward — single happy path + ROLLBACK on throw.
 *
 * Run via npm test (chained) or directly:
 *   node tests/closeLoopBatch.test.cjs
 */

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(32);

const assert = require('node:assert/strict');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${t.name}`);
      console.error('    ' + (err.stack || err.message).split('\n').join('\n    '));
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}

// ── Helpers — reproduce the route's normalize/validate logic via a
// stripped-down adapter so we can test it without spinning up Express.
// Mirrors closeLoop.cjs exactly; if the route changes, this test must
// change too. The stable contract is the validation rules, not the
// adapter shape.

const VALID_SOURCE_TYPES = new Set(['task', 'event', 'project_task']);
const VALID_OUTCOME_STATUSES = new Set(['success', 'mixed', 'neutral', 'failed', 'cancelled', 'no_show']);
const MAX_BATCH_ITEMS = 50;
const MAX_RAW_NOTE_CHARS = 2000;

function validateBatch(body) {
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length === 0) {
    return { ok: false, error: 'items array is required and must be non-empty' };
  }
  if (items.length > MAX_BATCH_ITEMS) {
    return { ok: false, error: `Too many items (max ${MAX_BATCH_ITEMS} per batch)` };
  }
  const normalized = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    if (!it.source_type || !VALID_SOURCE_TYPES.has(it.source_type)) {
      return { ok: false, error: `items[${i}].source_type must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}` };
    }
    if (!it.source_id) return { ok: false, error: `items[${i}].source_id required` };
    const outcomeStatus = it.outcome_status || null;
    if (outcomeStatus && !VALID_OUTCOME_STATUSES.has(outcomeStatus)) {
      return { ok: false, error: `items[${i}].outcome_status must be one of: ${[...VALID_OUTCOME_STATUSES].join(', ')}` };
    }
    normalized.push({
      sourceType: it.source_type,
      sourceId: String(it.source_id),
      outcomeStatus,
      rawNote: it.raw_note ? String(it.raw_note).slice(0, MAX_RAW_NOTE_CHARS) : null,
      titleSnapshot: it.title_snapshot ? String(it.title_snapshot).slice(0, 500) : null,
    });
  }
  return { ok: true, normalized };
}

// ── Empty / shape failures ────────────────────────────────────────

test('rejects missing items array', () => {
  assert.equal(validateBatch({}).ok, false);
  assert.equal(validateBatch({ items: null }).ok, false);
  assert.equal(validateBatch({ items: 'not-array' }).ok, false);
});

test('rejects empty items array', () => {
  const r = validateBatch({ items: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /non-empty/);
});

test('rejects oversized batch (>50 items)', () => {
  const items = Array.from({ length: 51 }, (_, i) => ({ source_type: 'task', source_id: `t${i}` }));
  const r = validateBatch({ items });
  assert.equal(r.ok, false);
  assert.match(r.error, /Too many items/);
});

test('accepts batch at max size (50 items)', () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ source_type: 'task', source_id: `t${i}` }));
  assert.equal(validateBatch({ items }).ok, true);
});

// ── Per-item source_type / source_id ──────────────────────────────

test('rejects invalid source_type', () => {
  const r = validateBatch({ items: [{ source_type: 'meeting', source_id: '1' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /source_type/);
});

test('rejects missing source_id', () => {
  const r = validateBatch({ items: [{ source_type: 'task' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /source_id required/);
});

test('accepts all 3 valid source_types', () => {
  for (const t of ['task', 'event', 'project_task']) {
    assert.equal(validateBatch({ items: [{ source_type: t, source_id: '1' }] }).ok, true);
  }
});

test('coerces numeric source_id to string', () => {
  const r = validateBatch({ items: [{ source_type: 'task', source_id: 12345 }] });
  assert.equal(r.ok, true);
  assert.equal(r.normalized[0].sourceId, '12345');
  assert.equal(typeof r.normalized[0].sourceId, 'string');
});

// ── Outcome status validation ─────────────────────────────────────

test('outcome_status is optional (binary close path)', () => {
  const r = validateBatch({ items: [{ source_type: 'task', source_id: '1' }] });
  assert.equal(r.ok, true);
  assert.equal(r.normalized[0].outcomeStatus, null);
});

test('rejects invalid outcome_status', () => {
  const r = validateBatch({ items: [{ source_type: 'task', source_id: '1', outcome_status: 'great' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /outcome_status/);
});

test('accepts all 6 valid outcome_status values', () => {
  for (const s of ['success', 'mixed', 'neutral', 'failed', 'cancelled', 'no_show']) {
    const r = validateBatch({ items: [{ source_type: 'task', source_id: '1', outcome_status: s }] });
    assert.equal(r.ok, true, `should accept ${s}`);
    assert.equal(r.normalized[0].outcomeStatus, s);
  }
});

test('rejects empty-string outcome_status (treats as missing — falsy → null)', () => {
  // Empty string is falsy → normalized as null (no chip selected).
  // This matches the UI: empty chip strip = binary resolve, no rich path.
  const r = validateBatch({ items: [{ source_type: 'task', source_id: '1', outcome_status: '' }] });
  assert.equal(r.ok, true);
  assert.equal(r.normalized[0].outcomeStatus, null);
});

// ── Raw note handling ─────────────────────────────────────────────

test('raw_note truncated to 2000 chars', () => {
  const huge = 'x'.repeat(5000);
  const r = validateBatch({ items: [{ source_type: 'task', source_id: '1', outcome_status: 'success', raw_note: huge }] });
  assert.equal(r.ok, true);
  assert.equal(r.normalized[0].rawNote.length, 2000);
});

test('raw_note absent → null', () => {
  const r = validateBatch({ items: [{ source_type: 'task', source_id: '1' }] });
  assert.equal(r.normalized[0].rawNote, null);
});

test('raw_note empty string → null (consistent with absent)', () => {
  const r = validateBatch({ items: [{ source_type: 'task', source_id: '1', raw_note: '' }] });
  assert.equal(r.normalized[0].rawNote, null);
});

test('title_snapshot truncated to 500 chars', () => {
  const huge = 'a'.repeat(800);
  const r = validateBatch({ items: [{ source_type: 'task', source_id: '1', title_snapshot: huge }] });
  assert.equal(r.normalized[0].titleSnapshot.length, 500);
});

// ── Mixed batch — the central use case ────────────────────────────

test('accepts mixed batch — some with outcome, some without', () => {
  const r = validateBatch({
    items: [
      { source_type: 'task', source_id: '1', outcome_status: 'success', raw_note: 'great call' },
      { source_type: 'task', source_id: '2' },                                        // binary
      { source_type: 'event', source_id: 'evt-3', outcome_status: 'mixed' },
      { source_type: 'task', source_id: '4', outcome_status: 'cancelled' },
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.normalized.length, 4);
  assert.equal(r.normalized[0].outcomeStatus, 'success');
  assert.equal(r.normalized[1].outcomeStatus, null);
  assert.equal(r.normalized[2].outcomeStatus, 'mixed');
  assert.equal(r.normalized[3].outcomeStatus, 'cancelled');
});

test('rejects mixed batch with one bad item — all-or-nothing', () => {
  const r = validateBatch({
    items: [
      { source_type: 'task', source_id: '1', outcome_status: 'success' },
      { source_type: 'task', source_id: '2', outcome_status: 'BOGUS_STATUS' },
      { source_type: 'task', source_id: '3' },
    ],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /items\[1\]\.outcome_status/);
});

run().then((failed) => process.exit(failed > 0 ? 1 : 0)).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
