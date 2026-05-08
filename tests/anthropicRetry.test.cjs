'use strict';

/**
 * tests/anthropicRetry.test.cjs — unit tests for the upgraded retry
 * helper.
 *
 * Covers the V1.1 spec (2026-05-08):
 *   a. retries on 529
 *   b. retries on 503/502/500
 *   c. retries on ECONNRESET/ETIMEDOUT
 *   d. does NOT retry on 4xx (400, 401, 403, 404, 422)
 *   e. retries on 429 with longer base delay
 *   f. honors retry-after header (numeric seconds)
 *   g. honors retry-after header (HTTP-date)
 *   h. caps retry-after at 30s (pathological retry-after-3600)
 *   i. throws original error after MAX_RETRIES
 *   j. heuristic message-text detection still works (preserves old path)
 *
 * Plus: APIError instanceof + Sentry breadcrumb integration probes.
 *
 * Each test installs a tight delay shim so the suite runs in milliseconds
 * even when the production retry uses 1-30s waits.
 */

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(32);

const assert = require('node:assert/strict');

// Override setTimeout so retry waits don't actually wait. Restored after
// the suite. Captures every wait duration into _delays for assertions.
const _realSetTimeout = global.setTimeout;
const _delays = [];
global.setTimeout = (fn, ms, ...args) => {
  _delays.push(ms);
  return _realSetTimeout(fn, 0, ...args);
};

const retry = require('../server/lib/anthropicRetry.cjs');
const { APIError } = require('@anthropic-ai/sdk');

// Restore at end of suite.
process.on('exit', () => { global.setTimeout = _realSetTimeout; });

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function run() {
  let passed = 0, failed = 0;
  for (const t of tests) {
    _delays.length = 0;
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

// ── Helpers ──────────────────────────────────────────────────────────

function makeError({ status, errno, message, headers }) {
  const e = new Error(message || `mock error (${status || errno})`);
  if (status != null) e.status = status;
  if (errno) e.code = errno;
  if (headers) e.headers = headers;
  return e;
}

function makeAttempts(...errorsOrValues) {
  // Returns a fn that, on each call, throws/returns the next item.
  let i = 0;
  return async () => {
    const item = errorsOrValues[i++];
    if (item instanceof Error) throw item;
    return item;
  };
}

// ── (a) retries on 529 ───────────────────────────────────────────────

test('retries on 529 then succeeds', async () => {
  const fn = makeAttempts(makeError({ status: 529 }), { ok: true });
  const result = await retry.withRetry(fn, 'test');
  assert.deepEqual(result, { ok: true });
});

// ── (b) retries on 503/502/500 ──────────────────────────────────────

test('retries on 503', async () => {
  const fn = makeAttempts(makeError({ status: 503 }), { ok: true });
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

test('retries on 502', async () => {
  const fn = makeAttempts(makeError({ status: 502 }), { ok: true });
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

test('retries on 500', async () => {
  const fn = makeAttempts(makeError({ status: 500 }), { ok: true });
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

// ── (c) retries on network errnos ───────────────────────────────────

test('retries on ECONNRESET', async () => {
  const fn = makeAttempts(makeError({ errno: 'ECONNRESET' }), { ok: true });
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

test('retries on ETIMEDOUT', async () => {
  const fn = makeAttempts(makeError({ errno: 'ETIMEDOUT' }), { ok: true });
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

test('retries on ENETUNREACH', async () => {
  const fn = makeAttempts(makeError({ errno: 'ENETUNREACH' }), { ok: true });
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

test('retries on errno via err.cause.code (some node http errors nest there)', async () => {
  const e = new Error('socket hang up');
  e.cause = { code: 'ECONNRESET' };
  const fn = makeAttempts(e, { ok: true });
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

// ── (d) does NOT retry on 4xx ───────────────────────────────────────

test('does NOT retry on 400 (caller bug — malformed prompt / credit balance)', async () => {
  let calls = 0;
  const fn = async () => { calls++; throw makeError({ status: 400, message: 'credit balance is too low' }); };
  await assert.rejects(retry.withRetry(fn, 'test'), (e) => e.status === 400);
  assert.equal(calls, 1, 'must throw immediately, no retries');
});

test('does NOT retry on 401', async () => {
  let calls = 0;
  const fn = async () => { calls++; throw makeError({ status: 401 }); };
  await assert.rejects(retry.withRetry(fn, 'test'));
  assert.equal(calls, 1);
});

test('does NOT retry on 403', async () => {
  let calls = 0;
  const fn = async () => { calls++; throw makeError({ status: 403 }); };
  await assert.rejects(retry.withRetry(fn, 'test'));
  assert.equal(calls, 1);
});

test('does NOT retry on 404', async () => {
  let calls = 0;
  const fn = async () => { calls++; throw makeError({ status: 404 }); };
  await assert.rejects(retry.withRetry(fn, 'test'));
  assert.equal(calls, 1);
});

test('does NOT retry on 422 (schema violation)', async () => {
  let calls = 0;
  const fn = async () => { calls++; throw makeError({ status: 422 }); };
  await assert.rejects(retry.withRetry(fn, 'test'));
  assert.equal(calls, 1);
});

// ── (e) 429 — longer base delay ─────────────────────────────────────

test('retries on 429 with longer base delay (≥5s on attempt 1)', async () => {
  const fn = makeAttempts(makeError({ status: 429 }), { ok: true });
  await retry.withRetry(fn, 'test');
  // First (and only) backoff must be ≥5000ms (RATE_LIMIT_BASE_DELAY_MS).
  assert.ok(_delays.length >= 1, 'expected at least one backoff');
  assert.ok(_delays[0] >= 5000, `expected first delay ≥ 5000ms, got ${_delays[0]}`);
});

// ── (f) honors retry-after numeric header ───────────────────────────

test('honors retry-after numeric seconds on 429', async () => {
  const fn = makeAttempts(
    makeError({ status: 429, headers: { 'retry-after': '7' } }),
    { ok: true },
  );
  await retry.withRetry(fn, 'test');
  // 7 seconds → 7000ms (no random jitter when retry-after is honored).
  assert.equal(_delays[0], 7000);
});

test('honors retry-after via Headers-like .get()', async () => {
  const headers = { get: (k) => (k === 'retry-after' ? '3' : null) };
  const fn = makeAttempts(
    makeError({ status: 429, headers }),
    { ok: true },
  );
  await retry.withRetry(fn, 'test');
  assert.equal(_delays[0], 3000);
});

// ── (g) honors retry-after HTTP-date ─────────────────────────────────

test('honors retry-after HTTP-date on 429', async () => {
  // HTTP-date format has 1-second resolution (toUTCString rounds down),
  // so up to 999ms is lost in the round-trip + a few hundred ms of test
  // execution lag. Widen the tolerance accordingly: pick a 5s offset and
  // accept anywhere in [3000, 5500] ms.
  const future = new Date(Date.now() + 5000).toUTCString();
  const fn = makeAttempts(
    makeError({ status: 429, headers: { 'retry-after': future } }),
    { ok: true },
  );
  await retry.withRetry(fn, 'test');
  assert.ok(_delays[0] >= 3000 && _delays[0] <= 5500,
    `expected 3000-5500ms (5s offset minus second-resolution + lag), got ${_delays[0]}`);
});

// ── (h) caps retry-after at 30s ─────────────────────────────────────

test('caps retry-after at 30s (pathological retry-after-3600)', async () => {
  const fn = makeAttempts(
    makeError({ status: 429, headers: { 'retry-after': '3600' } }),
    { ok: true },
  );
  await retry.withRetry(fn, 'test');
  assert.equal(_delays[0], retry.MAX_RETRY_AFTER_MS);
  assert.equal(_delays[0], 30_000);
});

// ── (i) throws original error after MAX_RETRIES ─────────────────────

test('throws original error after MAX_RETRIES exhausted', async () => {
  const persistent529 = makeError({ status: 529, message: 'overloaded_error' });
  const fn = async () => { throw persistent529; };
  await assert.rejects(retry.withRetry(fn, 'test'), (e) => e === persistent529);
  // 1 initial + 3 retries = 4 attempts → 3 backoff delays
  assert.equal(_delays.length, retry.MAX_RETRIES, `expected ${retry.MAX_RETRIES} delays, got ${_delays.length}`);
});

// ── (j) heuristic message detection ─────────────────────────────────

test('retries on err.message containing "overloaded" even without status', async () => {
  const fn = makeAttempts(
    new Error('upstream overloaded'),  // no status, no errno
    { ok: true },
  );
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

test('retries on err.message containing "529" even without status', async () => {
  const fn = makeAttempts(
    new Error('Got HTTP 529 from upstream'),
    { ok: true },
  );
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

test('does NOT retry on a non-retryable plain-message error', async () => {
  let calls = 0;
  const fn = async () => { calls++; throw new Error('something quite specific'); };
  await assert.rejects(retry.withRetry(fn, 'test'));
  assert.equal(calls, 1, 'plain non-matching error must not trigger retry');
});

// ── APIError instanceof path ────────────────────────────────────────

test('treats APIError instances by their .status field', async () => {
  // Build a real APIError subclass instance. The SDK's APIError
  // constructor isn't easy to invoke directly; spoof a plain object
  // and re-prototype it.
  const fakeApiErr = Object.create(APIError.prototype);
  fakeApiErr.status = 503;
  fakeApiErr.message = 'mock-api-error';
  const fn = makeAttempts(fakeApiErr, { ok: true });
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

test('treats APIError 400 as non-retryable (instanceof + status precedence)', async () => {
  const fakeApiErr = Object.create(APIError.prototype);
  fakeApiErr.status = 400;
  fakeApiErr.message = 'credit balance is too low';
  let calls = 0;
  const fn = async () => { calls++; throw fakeApiErr; };
  await assert.rejects(retry.withRetry(fn, 'test'));
  assert.equal(calls, 1, 'APIError 400 must not retry');
});

// ── Backoff shape on standard retryables ────────────────────────────

test('standard backoff: ≥1s on attempt 1, ≥2s on attempt 2', async () => {
  const fn = makeAttempts(
    makeError({ status: 529 }),
    makeError({ status: 529 }),
    { ok: true },
  );
  await retry.withRetry(fn, 'test');
  assert.ok(_delays[0] >= 1000, `attempt 1 delay ${_delays[0]} should be ≥1000`);
  assert.ok(_delays[1] >= 2000, `attempt 2 delay ${_delays[1]} should be ≥2000`);
});

// ── Sentry breadcrumb integration probe ─────────────────────────────

test('breadcrumb is best-effort — Sentry being uninitialized does not throw', async () => {
  // Sentry.addBreadcrumb is a no-op when DSN is unset (which is the
  // case in this test env). If breadcrumb code threw, withRetry would
  // not return successfully. So a passing 529→retry→success run
  // confirms the breadcrumb path is safe.
  const fn = makeAttempts(makeError({ status: 529 }), { ok: true });
  assert.deepEqual(await retry.withRetry(fn, 'test'), { ok: true });
});

run().then((failed) => process.exit(failed > 0 ? 1 : 0)).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
