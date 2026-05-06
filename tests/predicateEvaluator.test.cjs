'use strict';

/**
 * tests/predicateEvaluator.test.cjs
 *
 * Pure-function tests for the decisionEngine predicate evaluator
 * (Extension 2 of the engine-extensions workstream). No DB or network.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   node tests/predicateEvaluator.test.cjs
 *
 * Exits non-zero on any assertion failure.
 */

// decisionEngine transitively requires crypto.cjs which validates
// ENCRYPTION_KEY at load time. Tests don't exercise crypto — provide a
// 32-char dummy so requires don't blow up. Real prod env always sets this.
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(32);

const assert = require('node:assert/strict');
const {
  evaluatePredicate,
  conflictsWithAction,
  getRuleEvaluationErrors,
} = require('../server/lib/decisionEngine.cjs');

// Tiny inline runner — same shape as tests/isolation.test.cjs.
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

// ── Spec test 1: existing rules with NULL predicate continue evaluating ──
test('NULL predicate falls through to keyword path (legacy compat)', () => {
  // Mimics the shape of a real rule from getUserPreferences — no predicate,
  // preference_type='never', rule_text mentioning "delete".
  const rule = {
    id: 1,
    description: 'Never delete tasks without asking me first',
    preferenceType: 'never',
    category: 'tasks',
    strength: 5,
    predicate: null,
  };
  // delete_task's TOOL_ACTION_KEYWORDS includes 'delete' → keyword match.
  assert.equal(conflictsWithAction(rule, 'delete_task', {}), true);
  // create_task's TOOL_ACTION_KEYWORDS does not include 'delete' → no match.
  assert.equal(conflictsWithAction(rule, 'create_task', {}), false);
});

test('Undefined predicate (column never set) also falls through', () => {
  const rule = { id: 2, description: 'never delete things', preferenceType: 'never' };
  assert.equal(conflictsWithAction(rule, 'delete_task', {}), true);
});

// ── Spec test 2: numeric predicate gt/gte/lt/lte/eq/neq ───────────────────
test('numeric predicate: gt boundary semantics', () => {
  const p = { tool_names: ['bulk_archive_emails'], input: { field: 'expected_count', op: 'gt', value: 50 } };
  assert.equal(evaluatePredicate(p, 'bulk_archive_emails', { expected_count: 25 }), false);
  assert.equal(evaluatePredicate(p, 'bulk_archive_emails', { expected_count: 50 }), false); // strict gt
  assert.equal(evaluatePredicate(p, 'bulk_archive_emails', { expected_count: 51 }), true);
});

test('numeric predicate: gte / lt / lte / eq / neq', () => {
  const gte = { input: { field: 'n', op: 'gte', value: 10 } };
  const lt  = { input: { field: 'n', op: 'lt',  value: 10 } };
  const lte = { input: { field: 'n', op: 'lte', value: 10 } };
  const eq  = { input: { field: 'n', op: 'eq',  value: 10 } };
  const neq = { input: { field: 'n', op: 'neq', value: 10 } };
  assert.equal(evaluatePredicate(gte, 'x', { n: 10 }), true);
  assert.equal(evaluatePredicate(gte, 'x', { n: 9 }),  false);
  assert.equal(evaluatePredicate(lt,  'x', { n: 9 }),  true);
  assert.equal(evaluatePredicate(lt,  'x', { n: 10 }), false);
  assert.equal(evaluatePredicate(lte, 'x', { n: 10 }), true);
  assert.equal(evaluatePredicate(lte, 'x', { n: 11 }), false);
  assert.equal(evaluatePredicate(eq,  'x', { n: 10 }), true);
  assert.equal(evaluatePredicate(eq,  'x', { n: 11 }), false);
  assert.equal(evaluatePredicate(neq, 'x', { n: 11 }), true);
  assert.equal(evaluatePredicate(neq, 'x', { n: 10 }), false);
});

test('numeric predicate: missing field returns false (no implicit truthy)', () => {
  const p = { input: { field: 'expected_count', op: 'gt', value: 0 } };
  assert.equal(evaluatePredicate(p, 'x', {}), false);
});

// ── Spec test 3: IN / NOT IN ───────────────────────────────────────────────
test('in / not_in membership', () => {
  const inPred  = { input: { field: 'domain', op: 'in',     value: ['internal.com', 'corp.com'] } };
  const notIn   = { input: { field: 'domain', op: 'not_in', value: ['internal.com', 'corp.com'] } };
  assert.equal(evaluatePredicate(inPred, 'x', { domain: 'internal.com' }), true);
  assert.equal(evaluatePredicate(inPred, 'x', { domain: 'external.com' }), false);
  assert.equal(evaluatePredicate(notIn,  'x', { domain: 'external.com' }), true);
  assert.equal(evaluatePredicate(notIn,  'x', { domain: 'internal.com' }), false);
});

test('contains / exists / not_exists', () => {
  const contains  = { input: { field: 'subject', op: 'contains',  value: 'urgent' } };
  const exists    = { input: { field: 'amount',  op: 'exists',    value: null } };
  const notExists = { input: { field: 'amount',  op: 'not_exists', value: null } };
  assert.equal(evaluatePredicate(contains,  'x', { subject: 'urgent: please review' }), true);
  assert.equal(evaluatePredicate(contains,  'x', { subject: 'fyi only' }), false);
  assert.equal(evaluatePredicate(exists,    'x', { amount: 0 }),  true);
  assert.equal(evaluatePredicate(exists,    'x', {}),             false);
  assert.equal(evaluatePredicate(notExists, 'x', {}),             true);
  assert.equal(evaluatePredicate(notExists, 'x', { amount: 0 }),  false);
});

// ── Spec test 4: AND / OR / NOT composition ──────────────────────────────
test('and: all children must match', () => {
  const p = {
    input: {
      and: [
        { field: 'count',    op: 'gt', value: 50 },
        { field: 'category', op: 'eq', value: 'newsletter' },
      ],
    },
  };
  assert.equal(evaluatePredicate(p, 'x', { count: 51, category: 'newsletter' }), true);
  assert.equal(evaluatePredicate(p, 'x', { count: 49, category: 'newsletter' }), false);
  assert.equal(evaluatePredicate(p, 'x', { count: 51, category: 'invoice'    }), false);
});

test('or: any child matches', () => {
  const p = {
    input: {
      or: [
        { field: 'urgent',  op: 'eq', value: true },
        { field: 'overdue', op: 'eq', value: true },
      ],
    },
  };
  assert.equal(evaluatePredicate(p, 'x', { urgent: true,  overdue: false }), true);
  assert.equal(evaluatePredicate(p, 'x', { urgent: false, overdue: true  }), true);
  assert.equal(evaluatePredicate(p, 'x', { urgent: false, overdue: false }), false);
});

test('not: negation', () => {
  const p = { input: { not: { field: 'is_read', op: 'eq', value: true } } };
  assert.equal(evaluatePredicate(p, 'x', { is_read: true }),  false);
  assert.equal(evaluatePredicate(p, 'x', { is_read: false }), true);
  assert.equal(evaluatePredicate(p, 'x', {}),                 true); // missing field → eq false → not → true
});

test('nested and/or/not', () => {
  const p = {
    input: {
      or: [
        { and: [
          { field: 'count', op: 'gt', value: 50 },
          { not: { field: 'confirmed', op: 'eq', value: true } },
        ] },
        { field: 'risk', op: 'eq', value: 'high' },
      ],
    },
  };
  assert.equal(evaluatePredicate(p, 'x', { count: 100, confirmed: false, risk: 'low' }), true); // and-branch
  assert.equal(evaluatePredicate(p, 'x', { count: 100, confirmed: true,  risk: 'low' }), false);
  assert.equal(evaluatePredicate(p, 'x', { count: 0,   confirmed: true,  risk: 'high' }), true); // or-branch
  assert.equal(evaluatePredicate(p, 'x', { count: 0,   confirmed: true,  risk: 'low' }), false);
});

// ── Dotted-path resolution ───────────────────────────────────────────────
test('dotted field path resolves into nested objects', () => {
  const p = { input: { field: 'criteria.older_than_hours', op: 'gte', value: 24 } };
  assert.equal(evaluatePredicate(p, 'x', { criteria: { older_than_hours: 48 } }), true);
  assert.equal(evaluatePredicate(p, 'x', { criteria: { older_than_hours: 12 } }), false);
  assert.equal(evaluatePredicate(p, 'x', { criteria: {} }),                       false);
  assert.equal(evaluatePredicate(p, 'x', {}),                                     false);
});

// ── tool_names allowlist ──────────────────────────────────────────────────
test('tool_names allowlist gates predicate', () => {
  const p = {
    tool_names: ['bulk_archive_emails'],
    input: { field: 'expected_count', op: 'gt', value: 0 },
  };
  assert.equal(evaluatePredicate(p, 'bulk_archive_emails', { expected_count: 1 }), true);
  assert.equal(evaluatePredicate(p, 'send_email',          { expected_count: 1 }), false);
});

test('tool_names without input matches by name alone', () => {
  const p = { tool_names: ['delete_task', 'delete_event'] };
  assert.equal(evaluatePredicate(p, 'delete_task',  {}), true);
  assert.equal(evaluatePredicate(p, 'create_task',  {}), false);
});

// ── Reserved-key throws (forward-compat for Extensions 3-5) ──────────────
test('reserved future keys throw (trust / rate)', () => {
  // external_recipients was reserved in the bc2c464 commit; Ext 5 (this
  // commit) implements it, so it's no longer reserved.
  for (const key of ['trust', 'rate']) {
    assert.throws(
      () => evaluatePredicate({ [key]: { whatever: true } }, 'x', {}),
      /reserved for a future engine extension/i,
      `expected throw for reserved key "${key}"`,
    );
  }
});

test('unknown operator throws', () => {
  assert.throws(
    () => evaluatePredicate({ input: { field: 'x', op: 'frobnicate', value: 1 } }, 'x', { x: 1 }),
    /Unknown predicate operator: frobnicate/,
  );
});

test('unknown node shape throws', () => {
  assert.throws(
    () => evaluatePredicate({ input: { wat: 'no field, no op, no and/or/not' } }, 'x', {}),
    /Unknown predicate node shape/,
  );
});

// ── Spec test (failure isolation): one bad rule doesn't sink the turn ────
test('conflictsWithAction isolates predicate errors per-rule, increments counter, returns false', () => {
  const before = getRuleEvaluationErrors();
  const beforeCount = before.count;

  const badRule = {
    id: 'test-bad-rule',
    userId: 'test-user',
    predicate: { input: { field: 'x', op: 'no_such_op', value: 1 } },
  };
  const goodRule = {
    id: 'test-good-rule',
    description: 'never delete things',
    preferenceType: 'never',
    predicate: null,
  };

  // Bad rule: returns false (skipped), error tracked.
  assert.equal(conflictsWithAction(badRule, 'delete_task', { x: 1 }), false);

  // Good rule: keyword path still works (proves errors are per-rule).
  assert.equal(conflictsWithAction(goodRule, 'delete_task', {}), true);

  const after = getRuleEvaluationErrors();
  assert.equal(after.count, beforeCount + 1, 'error counter should have incremented by 1');
  assert.equal(after.lastErrors[0].rule_id, 'test-bad-rule');
  assert.match(after.lastErrors[0].error, /no_such_op/);
});

// ── Extension 3: trust-floor threshold helper ─────────────────────────────
test('getTrustFloorThreshold defaults to 0.3 with no userId', async () => {
  const db = require('../db.cjs');
  // Skip the live-DB section; the no-userId path is pure defaulting.
  const t = await db.getTrustFloorThreshold(null);
  assert.equal(t, 0.3);
});

test('DEFAULT_TRUST_FLOOR_THRESHOLD constant is 0.3', () => {
  const db = require('../db.cjs');
  assert.equal(db.DEFAULT_TRUST_FLOOR_THRESHOLD, 0.3);
});

test('setTrustFloorThreshold rejects out-of-range values', async () => {
  const db = require('../db.cjs');
  await assert.rejects(() => db.setTrustFloorThreshold('any-user', -0.1), /Invalid threshold/);
  await assert.rejects(() => db.setTrustFloorThreshold('any-user', 1.5), /Invalid threshold/);
  await assert.rejects(() => db.setTrustFloorThreshold('any-user', 'abc'), /Invalid threshold/);
  await assert.rejects(() => db.setTrustFloorThreshold('any-user', NaN), /Invalid threshold/);
  await assert.rejects(() => db.setTrustFloorThreshold(null, 0.5), /requires userId/);
});

// ── Extension 4: autonomous-action rate limit ────────────────────────────
test('getRateLimit defaults to {count: 20, windowMinutes: 60} with no userId', async () => {
  const db = require('../db.cjs');
  const r = await db.getRateLimit(null);
  assert.deepEqual(r, { count: 20, windowMinutes: 60 });
});

test('DEFAULT_RATE_LIMIT constant is {count: 20, windowMinutes: 60}', () => {
  const db = require('../db.cjs');
  assert.deepEqual(db.DEFAULT_RATE_LIMIT, { count: 20, windowMinutes: 60 });
});

test('setRateLimit rejects out-of-range counts', async () => {
  const db = require('../db.cjs');
  await assert.rejects(() => db.setRateLimit('any-user', { count: 0 }), /Invalid rate limit/);
  await assert.rejects(() => db.setRateLimit('any-user', { count: -5 }), /Invalid rate limit/);
  await assert.rejects(() => db.setRateLimit('any-user', { count: 1001 }), /Invalid rate limit/);
  await assert.rejects(() => db.setRateLimit('any-user', { count: 'abc' }), /Invalid rate limit/);
  await assert.rejects(() => db.setRateLimit('any-user', null), /Invalid rate limit/);
  await assert.rejects(() => db.setRateLimit(null, { count: 10 }), /requires userId/);
});

test('countAutonomousActions returns 0 with no userId', async () => {
  const db = require('../db.cjs');
  const n = await db.countAutonomousActions(null);
  assert.equal(n, 0);
});

// ── Extension 5: contact-list / recipients predicate ─────────────────────
test('recipients not_in_contacts: fires when ANY recipient is unknown', () => {
  const p = {
    tool_names: ['send_email'],
    recipients: { field: 'to', not_in_contacts: true },
  };
  const ctx = { contactEmails: new Set(['internal@corp.com', 'lyle@dizon.ai']) };
  // All known → no fire
  assert.equal(evaluatePredicate(p, 'send_email', { to: 'internal@corp.com, lyle@dizon.ai' }, ctx), false);
  // One external → fires
  assert.equal(evaluatePredicate(p, 'send_email', { to: 'internal@corp.com, stranger@x.com' }, ctx), true);
  // All external → fires
  assert.equal(evaluatePredicate(p, 'send_email', { to: 'a@x.com, b@y.com' }, ctx), true);
  // Empty → no fire
  assert.equal(evaluatePredicate(p, 'send_email', { to: '' }, ctx), false);
  assert.equal(evaluatePredicate(p, 'send_email', {}, ctx), false);
});

test('recipients in_contacts: fires only when ALL are known', () => {
  const p = {
    tool_names: ['send_email'],
    recipients: { field: 'to', in_contacts: true },
  };
  const ctx = { contactEmails: new Set(['a@x.com', 'b@y.com']) };
  assert.equal(evaluatePredicate(p, 'send_email', { to: 'a@x.com, b@y.com' }, ctx), true);
  assert.equal(evaluatePredicate(p, 'send_email', { to: 'a@x.com, stranger@z.com' }, ctx), false);
  assert.equal(evaluatePredicate(p, 'send_email', { to: '' }, ctx), false);
});

test('external_recipients: true is shorthand for { recipients: { field: to, not_in_contacts: true } }', () => {
  const p = { tool_names: ['send_email'], external_recipients: true };
  const ctx = { contactEmails: new Set(['known@corp.com']) };
  assert.equal(evaluatePredicate(p, 'send_email', { to: 'unknown@x.com' }, ctx), true);
  assert.equal(evaluatePredicate(p, 'send_email', { to: 'known@corp.com' }, ctx), false);
});

test('recipients accepts array OR comma-separated string', () => {
  const p = { recipients: { field: 'to', not_in_contacts: true } };
  const ctx = { contactEmails: new Set(['k@x.com']) };
  assert.equal(evaluatePredicate(p, 'x', { to: ['k@x.com', 'u@y.com'] }, ctx), true);
  assert.equal(evaluatePredicate(p, 'x', { to: 'k@x.com; u@y.com' }, ctx), true);
  assert.equal(evaluatePredicate(p, 'x', { to: ['k@x.com'] }, ctx), false);
});

test('recipients normalizes "Name <email@host>" form', () => {
  const p = { recipients: { field: 'to', not_in_contacts: true } };
  const ctx = { contactEmails: new Set(['alice@x.com']) };
  assert.equal(evaluatePredicate(p, 'x', { to: 'Alice Wonder <alice@x.com>' }, ctx), false);
  assert.equal(evaluatePredicate(p, 'x', { to: '"Alice" <alice@x.com>, Bob <bob@y.com>' }, ctx), true);
});

test('recipients without context throws (forces context plumbing)', () => {
  const p = { recipients: { field: 'to', not_in_contacts: true } };
  assert.throws(
    () => evaluatePredicate(p, 'send_email', { to: 'a@x.com' }, null),
    /requires context.contactEmails/,
  );
});

test('recipients without in_contacts/not_in_contacts throws', () => {
  const p = { recipients: { field: 'to' } };
  const ctx = { contactEmails: new Set() };
  assert.throws(
    () => evaluatePredicate(p, 'x', { to: 'a@x.com' }, ctx),
    /must specify in_contacts or not_in_contacts/,
  );
});

test('recipients defaults field to "to" when omitted', () => {
  const p = { recipients: { not_in_contacts: true } };
  const ctx = { contactEmails: new Set(['known@corp.com']) };
  assert.equal(evaluatePredicate(p, 'x', { to: 'unknown@x.com' }, ctx), true);
  assert.equal(evaluatePredicate(p, 'x', { to: 'known@corp.com' }, ctx), false);
});

test('reserved future keys list now: trust + rate (external_recipients removed)', () => {
  // trust + rate still throw
  assert.throws(() => evaluatePredicate({ trust: { lt: 0.6 } }, 'x', {}), /reserved/);
  assert.throws(() => evaluatePredicate({ rate: { count: 1 } }, 'x', {}), /reserved/);
  // external_recipients no longer throws — it's the Ext 5 shorthand now
  const ctx = { contactEmails: new Set() };
  assert.doesNotThrow(() => evaluatePredicate({ external_recipients: true }, 'x', { to: 'a@x.com' }, ctx));
});

test('getContactEmails returns empty Set with no userId', async () => {
  const db = require('../db.cjs');
  const s = await db.getContactEmails(null);
  assert.ok(s instanceof Set);
  assert.equal(s.size, 0);
});

// ── Rule-proposal flow validation (Phase 2 capability) ───────────────────
test('createRuleProposal rejects empty proposed_rule', async () => {
  const db = require('../db.cjs');
  await assert.rejects(() => db.createRuleProposal('any-user', {}), /requires proposed_rule/);
  await assert.rejects(() => db.createRuleProposal('any-user', { proposed_rule: {} }), /requires proposed_rule|ruleText required/);
  await assert.rejects(() => db.createRuleProposal(null, { proposed_rule: { ruleText: 'x' } }), /requires userId/);
});

test('listRuleProposals returns empty array with no userId', async () => {
  const db = require('../db.cjs');
  const r = await db.listRuleProposals(null);
  assert.deepEqual(r, []);
});

test('countPendingRuleProposals returns 0 with no userId', async () => {
  const db = require('../db.cjs');
  const n = await db.countPendingRuleProposals(null);
  assert.equal(n, 0);
});

test('acceptRuleProposal / rejectRuleProposal validate inputs', async () => {
  const db = require('../db.cjs');
  await assert.rejects(() => db.acceptRuleProposal(null, 'user'), /requires proposalId/);
  await assert.rejects(() => db.acceptRuleProposal('id', null), /requires proposalId/);
  await assert.rejects(() => db.rejectRuleProposal(null, 'user'), /requires proposalId/);
  await assert.rejects(() => db.rejectRuleProposal('id', null), /requires proposalId/);
});

test('RULE_PROPOSAL_EXPIRY_DAYS constant is 30', () => {
  const db = require('../db.cjs');
  assert.equal(db.RULE_PROPOSAL_EXPIRY_DAYS, 30);
});

// ── Performance: predicate evaluation stays well under budget ────────────
test('1000 evaluations of a 5-deep nested predicate complete in <50ms', () => {
  const p = {
    tool_names: ['bulk_archive_emails'],
    input: {
      and: [
        { field: 'expected_count', op: 'gt', value: 50 },
        { or: [
          { field: 'criteria.include_promos',      op: 'eq', value: true },
          { field: 'criteria.include_newsletters', op: 'eq', value: true },
        ] },
        { not: { field: 'dry_run', op: 'eq', value: true } },
      ],
    },
  };
  const input = {
    expected_count: 75,
    criteria: { include_promos: true, include_newsletters: false },
    dry_run: false,
  };
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    assert.equal(evaluatePredicate(p, 'bulk_archive_emails', input), true);
  }
  const elapsed = Date.now() - t0;
  // 1000 evals → far under the 300ms decisionEngine budget per CALL.
  // Each call is one of N rules, so per-rule budget is ~30ms / N rules
  // — even a 50-rule user gets ~0.6ms per rule. Asserting <50ms total
  // for 1000 evals = <50µs per eval, comfortably under.
  assert.ok(elapsed < 50, `1000 evals took ${elapsed}ms — expected <50ms`);
});

// Run + exit
run().then((failed) => process.exit(failed > 0 ? 1 : 0)).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
