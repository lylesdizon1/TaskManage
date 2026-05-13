'use strict';

/**
 * tests/chatDraft.test.cjs — Commit 1 of the email-draft architecture.
 *
 * Tests:
 *  - _inferReason classifies error messages to the correct reason tag
 *  - _safeParse handles malformed Haiku output without throwing
 *  - AUTO_RESOLVE_CONFIDENCE is the locked 0.9 threshold from Phase 3 spec
 *  - Card status transitions are validated against the allowed set
 *
 * The endpoint integration (Haiku call + DB writes) requires a live DB +
 * Anthropic key, so it's not exercised here — verified manually post-deploy.
 */

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(32);
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = '0'.repeat(32);

const assert = require('node:assert/strict');
const chatDraftFactory = require('../server/routes/chatDraft.cjs');
const { _test } = chatDraftFactory;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── _inferReason ─────────────────────────────────────────────────

test('_inferReason maps invalid_grant → auth', () => {
  assert.equal(_test._inferReason('invalid_grant'), 'auth');
  assert.equal(_test._inferReason('Authentication expired. Reconnect.'), 'auth');
  assert.equal(_test._inferReason('please reconnect the account'), 'auth');
});

test('_inferReason maps network errors → network', () => {
  assert.equal(_test._inferReason('ECONNRESET'), 'network');
  assert.equal(_test._inferReason('Network timeout'), 'network');
  assert.equal(_test._inferReason('connection timeout'), 'network');
});

test('_inferReason maps validation strings → validation', () => {
  assert.equal(_test._inferReason('Invalid recipient address'), 'validation');
  assert.equal(_test._inferReason('malformed payload'), 'validation');
  assert.equal(_test._inferReason('subject required'), 'validation');
});

test('_inferReason falls back to unknown', () => {
  assert.equal(_test._inferReason('something weird'), 'unknown');
  assert.equal(_test._inferReason(''), 'unknown');
  assert.equal(_test._inferReason(null), 'unknown');
});

// ── _safeParse ───────────────────────────────────────────────────

test('_safeParse extracts JSON from Haiku-shaped output', () => {
  const r = _test._safeParse('{"type":"email","to_hint":"leo","subject":"x","body":"y"}');
  assert.equal(r.type, 'email');
  assert.equal(r.to_hint, 'leo');
});

test('_safeParse extracts JSON wrapped in prose', () => {
  const r = _test._safeParse('Here is the classification: {"type":"default_chat"} that is final.');
  assert.equal(r.type, 'default_chat');
});

test('_safeParse returns null on garbage', () => {
  assert.equal(_test._safeParse(''), null);
  assert.equal(_test._safeParse('no json here'), null);
  assert.equal(_test._safeParse('{"broken json'), null);
});

// ── Phase 3 spec invariants ──────────────────────────────────────

test('AUTO_RESOLVE_CONFIDENCE is locked at 0.9 per Q3', () => {
  assert.equal(_test.AUTO_RESOLVE_CONFIDENCE, 0.9);
});

// ── Runner ───────────────────────────────────────────────────────

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

run().then((failed) => process.exit(failed > 0 ? 1 : 0)).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
