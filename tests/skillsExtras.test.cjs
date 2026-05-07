'use strict';

/**
 * tests/skillsExtras.test.cjs — covers the M1.6 + M1.7 surfaces that
 * skillLoader.test.cjs doesn't reach:
 *   - chip-input → predicate translation (`_composeSkillPredicate`)
 *   - token cap + priority clamping (`_clampTokenCap`, `_clampPriority`)
 *   - skill-feedback regexes (positive + negative)
 *   - processSkillFeedback dispatch (resolves name → applies trust delta)
 *
 * Run via npm test (chained) or directly: node tests/skillsExtras.test.cjs
 */

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(32);

const assert = require('node:assert/strict');

const tools = require('../server/tools.cjs');
const trust = require('../server/lib/trustFeedback.cjs');

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

// ── Chip-input → predicate translation (Q4 round-trip contract) ────────

test('keywords array → topics-contains OR predicate', () => {
  const pred = tools._composeSkillPredicate({ keywords: ['wheelworks', 'vendor'] });
  assert.deepEqual(pred, {
    input: { or: [
      { field: 'topics', op: 'contains', value: 'wheelworks' },
      { field: 'topics', op: 'contains', value: 'vendor' },
    ] },
  });
});

test('keywords trimmed + lowercased + deduped', () => {
  const pred = tools._composeSkillPredicate({ keywords: [' Wheelworks ', 'WHEELWORKS', 'wheelworks', '  vendor', ''] });
  assert.equal(pred.input.or.length, 2);
  assert.deepEqual(pred.input.or.map(c => c.value), ['wheelworks', 'vendor']);
});

test('empty keywords array → null predicate (explicit-only)', () => {
  assert.equal(tools._composeSkillPredicate({ keywords: [] }), null);
  assert.equal(tools._composeSkillPredicate({ keywords: ['', '   '] }), null);
});

test('explicit trigger_predicate overrides keywords', () => {
  const explicit = { input: { field: 'people_mentioned', op: 'contains', value: 'Kat' } };
  const pred = tools._composeSkillPredicate({
    keywords: ['ignored'],
    trigger_predicate: explicit,
  });
  assert.deepEqual(pred, explicit);
});

test('trigger_predicate null is a deliberate clear (different from undefined)', () => {
  // null → caller wants to clear the predicate. undefined → don't change.
  assert.equal(tools._composeSkillPredicate({ trigger_predicate: null }), null);
  assert.equal(tools._composeSkillPredicate({}), undefined);
});

// ── Clamps ──────────────────────────────────────────────────────────────

test('token_cap clamped to [1, 30000] with default 10000', () => {
  assert.equal(tools._clampTokenCap(undefined), 10000);
  assert.equal(tools._clampTokenCap('not a number'), 10000);
  assert.equal(tools._clampTokenCap(0), 1);
  assert.equal(tools._clampTokenCap(-50), 1);
  assert.equal(tools._clampTokenCap(50000), 30000);
  assert.equal(tools._clampTokenCap(7500), 7500);
  assert.equal(tools._clampTokenCap(7500.7), 7501); // rounded
});

test('priority clamped to [0, 10] with default 5', () => {
  assert.equal(tools._clampPriority(undefined), 5);
  assert.equal(tools._clampPriority('foo'), 5);
  assert.equal(tools._clampPriority(-3), 0);
  assert.equal(tools._clampPriority(15), 10);
  assert.equal(tools._clampPriority(7), 7);
  assert.equal(tools._clampPriority(7.6), 8);
});

// ── Skill feedback regex contract ───────────────────────────────────────

test('SKILL_NEGATIVE_RE matches "stop loading the X skill" → captures X', () => {
  const m = 'stop loading the wheelworks skill'.match(trust._SKILL_NEGATIVE_RE);
  assert.ok(m);
  assert.equal(m[1].toLowerCase(), 'wheelworks');
});

test('SKILL_NEGATIVE_RE matches "don\'t load my <name> skill"', () => {
  const m = "don't load my CFO skill".match(trust._SKILL_NEGATIVE_RE);
  assert.ok(m);
  assert.equal(m[1], 'CFO');
});

test('SKILL_NEGATIVE_RE matches "turn off the X skill"', () => {
  const m = 'turn off the marketing skill'.match(trust._SKILL_NEGATIVE_RE);
  assert.ok(m);
  assert.equal(m[1], 'marketing');
});

test('SKILL_NEGATIVE_RE handles hyphenated names', () => {
  const m = 'disable my Personal-Brand skill'.match(trust._SKILL_NEGATIVE_RE);
  assert.ok(m);
  assert.equal(m[1], 'Personal-Brand');
});

test('SKILL_NEGATIVE_RE rejects non-skill messages', () => {
  assert.equal('can you stop watching this'.match(trust._SKILL_NEGATIVE_RE), null);
  assert.equal('hello there'.match(trust._SKILL_NEGATIVE_RE), null);
});

test('SKILL_POSITIVE_RE matches "I love using my X skill"', () => {
  const m = 'I love using my morning standup skill'.match(trust._SKILL_POSITIVE_RE);
  assert.ok(m);
  assert.equal(m[1], 'morning standup');
});

test('SKILL_POSITIVE_RE matches "always loading my X skill"', () => {
  const m = 'always loading my finance skill'.match(trust._SKILL_POSITIVE_RE);
  assert.ok(m);
  assert.equal(m[1], 'finance');
});

test('SKILL_POSITIVE_RE does not collide with explicit-load phrasing', () => {
  // "use my X skill" is the chatContext.explicit_skill_request signal,
  // not a positive-feedback signal. Different code path.
  assert.equal('use my wheelworks skill please'.match(trust._SKILL_POSITIVE_RE), null);
});

// ── processSkillFeedback dispatch ───────────────────────────────────────

test('processSkillFeedback resolves name → applies negative trust delta', async () => {
  const calls = [];
  const fakeDb = {
    getSkillByName: async (uid, name) => ({ id: 'sk-x', name, userId: uid }),
    applySkillTrustFeedback: async (uid, sid, delta, counter) => {
      calls.push({ uid, sid, delta, counter });
      return { trustScore: 0.4 };
    },
  };
  const result = await trust.processSkillFeedback({
    userId: 'u1',
    userMessage: 'stop loading my wheelworks skill',
    db: fakeDb,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].signal, 'negative');
  assert.equal(result[0].delta, trust.SKILL_NEG_DELTA);
  assert.equal(calls[0].counter, 'times_rejected');
  assert.ok(calls[0].delta < 0);
});

test('processSkillFeedback applies positive trust delta', async () => {
  const calls = [];
  const fakeDb = {
    getSkillByName: async (uid, name) => ({ id: 'sk-y', name, userId: uid }),
    applySkillTrustFeedback: async (uid, sid, delta, counter) => {
      calls.push({ uid, sid, delta, counter });
      return { trustScore: 0.55 };
    },
  };
  const result = await trust.processSkillFeedback({
    userId: 'u1',
    userMessage: 'I love using my finance skill',
    db: fakeDb,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].signal, 'positive');
  assert.equal(result[0].delta, trust.SKILL_POS_DELTA);
  assert.equal(calls[0].counter, 'times_confirmed');
  assert.ok(calls[0].delta > 0);
});

test('processSkillFeedback returns empty when name does not resolve', async () => {
  const fakeDb = {
    getSkillByName: async () => null, // no skill with that name
    applySkillTrustFeedback: async () => { throw new Error('should not be called'); },
  };
  const result = await trust.processSkillFeedback({
    userId: 'u1',
    userMessage: 'stop loading my nonexistent skill',
    db: fakeDb,
  });
  assert.equal(result.length, 0);
});

test('processSkillFeedback fail-soft when db throws', async () => {
  const fakeDb = {
    getSkillByName: async () => { throw new Error('db down'); },
    applySkillTrustFeedback: async () => {},
  };
  const result = await trust.processSkillFeedback({
    userId: 'u1',
    userMessage: 'stop loading my x skill',
    db: fakeDb,
  });
  assert.equal(result.length, 0); // never throws
});

test('processSkillFeedback ignores messages with no skill phrasing', async () => {
  const fakeDb = {
    getSkillByName: async () => { throw new Error('should not be called'); },
    applySkillTrustFeedback: async () => {},
  };
  const result = await trust.processSkillFeedback({
    userId: 'u1',
    userMessage: 'what time is my next meeting',
    db: fakeDb,
  });
  assert.equal(result.length, 0);
});

test('processSkillFeedback returns empty on missing inputs', async () => {
  assert.deepEqual(await trust.processSkillFeedback({ userId: null, userMessage: 'x', db: {} }), []);
  assert.deepEqual(await trust.processSkillFeedback({ userId: 'u', userMessage: '', db: {} }), []);
  assert.deepEqual(await trust.processSkillFeedback({ userId: 'u', userMessage: 'x', db: null }), []);
});

run().then((failed) => process.exit(failed > 0 ? 1 : 0)).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
