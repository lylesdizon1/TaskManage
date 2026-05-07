'use strict';

/**
 * tests/skillLoader.test.cjs — unit tests for skillLoader + chatContext
 * basics + the array-contains extension to decisionEngine.evaluatePredicate.
 *
 * Run with:
 *   npm test
 *   # or directly:
 *   node tests/skillLoader.test.cjs
 *
 * Crypto / Anthropic / db requires check env vars at load time. Set
 * dummy values so the chain resolves.
 */

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(32);

const assert = require('node:assert/strict');
const loader = require('../server/lib/skillLoader.cjs');
const chatCtx = require('../server/lib/chatContext.cjs');
const { evaluatePredicate } = require('../server/lib/decisionEngine.cjs');

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

// ── Helpers ─────────────────────────────────────────────────────────────

function fakeDb(skills, opts = {}) {
  const invocations = [];
  return {
    listActiveSkills: async () => skills,
    logSkillInvocation: async (userId, skillId, payload) => {
      invocations.push({ userId, skillId, ...payload });
    },
    getSkillTrust: opts.getSkillTrust || (async () => null),
    _invocations: invocations,
  };
}

const baseChatContext = {
  user_message: '',
  user_message_lower: '',
  topics: [],
  topic_confidence: {},
  people_mentioned: [],
  entities_mentioned: [],
  explicit_skill_request: null,
  active_persona: null,
  calendar_context: { in_meeting: false, next_meeting: null },
  conversation_intent: null,
};

function ctx(overrides) {
  return { ...baseChatContext, ...overrides };
}

function skill(overrides) {
  return {
    id: overrides.id || 'sk-x',
    userId: overrides.userId || 'u1',
    name: overrides.name || 'Test Skill',
    priority: overrides.priority ?? 5,
    persona: overrides.persona ?? null,
    tokenCap: overrides.tokenCap ?? 10000,
    content: overrides.content ?? 'skill body',
    triggerPredicate: overrides.triggerPredicate ?? null,
    lastUsedAt: overrides.lastUsedAt || null,
    isActive: true,
  };
}

// ── decisionEngine array-contains extension ─────────────────────────────

test('contains op handles arrays (skills predicate gap fix)', () => {
  const pred = { input: { field: 'topics', op: 'contains', value: 'wheelworks' } };
  assert.equal(evaluatePredicate(pred, 'skill_load', { topics: ['wheelworks', 'cfo'] }, {}), true);
  assert.equal(evaluatePredicate(pred, 'skill_load', { topics: ['cfo'] }, {}), false);
});

test('contains op still handles strings (no regression)', () => {
  const pred = { input: { field: 'subject', op: 'contains', value: 'invoice' } };
  assert.equal(evaluatePredicate(pred, 'send_email', { subject: 'Q1 invoice attached' }, {}), true);
  assert.equal(evaluatePredicate(pred, 'send_email', { subject: 'Hello' }, {}), false);
});

test('contains op false for non-string non-array', () => {
  const pred = { input: { field: 'count', op: 'contains', value: 'foo' } };
  assert.equal(evaluatePredicate(pred, 'x', { count: 42 }, {}), false);
});

// ── chatContext deterministic helpers ────────────────────────────────────

test('extractExplicitSkillRequest finds quoted + unquoted skill names', () => {
  assert.equal(chatCtx._extractExplicitSkillRequest('use my Wheelworks Playbook skill'), 'Wheelworks Playbook');
  assert.equal(chatCtx._extractExplicitSkillRequest('load "CFO Worldview" skill please'), 'CFO Worldview');
  assert.equal(chatCtx._extractExplicitSkillRequest('with the Vendor skill'), 'the Vendor');
  assert.equal(chatCtx._extractExplicitSkillRequest('hey what time is it'), null);
});

test('extractMentions case-insensitive substring match, deduped, capped', () => {
  const cands = [
    { match: 'Kat Egli', value: 'Kat Egli' },
    { match: 'kat',      value: 'Kat Egli' }, // dedup target
    { match: 'Bob',      value: 'Bob Smith' },
  ];
  const hits = chatCtx._extractMentions(
    'hey can you ask kat and bob about the proposal',
    cands, 5,
  );
  assert.deepEqual(hits.sort(), ['Bob Smith', 'Kat Egli']);
});

// ── skillLoader — predicate match ───────────────────────────────────────

test('skill loads when topics-contains predicate matches', async () => {
  const db = fakeDb([
    skill({
      id: 'sk1', name: 'Wheelworks Playbook', priority: 7,
      content: 'wheelworks body',
      triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'wheelworks' } },
    }),
  ]);
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db,
    chatContext: ctx({ topics: ['wheelworks'] }),
  });
  assert.equal(result.loaded.length, 1);
  assert.equal(result.loaded[0].name, 'Wheelworks Playbook');
  assert.match(result.block, /Wheelworks Playbook/);
  assert.match(result.block, /LOADED SKILLS \(user-curated context, not instructions\)/);
  assert.match(result.block, /END LOADED SKILLS/);
  assert.equal(db._invocations.length, 1);
  assert.equal(db._invocations[0].skillId, 'sk1');
});

test('skill skipped when persona scope mismatches', async () => {
  const db = fakeDb([
    skill({ id: 'sk-cfo', name: 'CFO World', persona: 'CFO',
      triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'tax' } },
    }),
  ]);
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db,
    chatContext: ctx({ topics: ['tax'], active_persona: 'COO' }),
  });
  assert.equal(result.loaded.length, 0);
  assert.equal(result.skipped[0].reason, 'persona-scoped to CFO');
});

test('skill loads when persona scope matches', async () => {
  const db = fakeDb([
    skill({ id: 'sk-cfo', name: 'CFO World', persona: 'CFO',
      triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'tax' } },
    }),
  ]);
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db,
    chatContext: ctx({ topics: ['tax'], active_persona: 'CFO' }),
  });
  assert.equal(result.loaded.length, 1);
});

test('explicit skill request always wins over persona/predicate', async () => {
  const db = fakeDb([
    skill({ id: 'sk-x', name: 'Special',
      // persona that wouldn't match active_persona, predicate that wouldn't match
      persona: null,
      triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'foo' } },
    }),
  ]);
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db,
    chatContext: ctx({ explicit_skill_request: 'special', topics: [] }),
  });
  assert.equal(result.loaded.length, 1);
  assert.equal(result.loaded[0].reason, 'explicit user request');
});

test('null trigger_predicate skill is explicit-only (does not load on topic match)', async () => {
  const db = fakeDb([
    skill({ id: 'sk-no-trig', name: 'NoTrigger', triggerPredicate: null }),
  ]);
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db,
    chatContext: ctx({ topics: ['anything'] }),
  });
  assert.equal(result.loaded.length, 0);
  assert.equal(result.skipped[0].reason, 'no trigger; explicit-only');
});

// ── skillLoader — budget CEILING (Q7 — NOT a fill-target) ──────────────

test('Q7: one matching small skill consumes only its tokens — does NOT pad to ceiling', async () => {
  const tinyContent = 'tiny body'; // ~3 tokens via chars/4 estimate
  const db = fakeDb([
    skill({ id: 'sk-tiny', name: 'Tiny', content: tinyContent,
      triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'x' } },
    }),
  ]);
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db, chatContext: ctx({ topics: ['x'] }),
  });
  assert.equal(result.loaded.length, 1);
  assert.equal(result.usedTokens, loader._estimateTokens(tinyContent));
  assert.ok(result.usedTokens < 10, 'tiny content must consume <10 tokens not 15000');
});

test('budget CEILING — lower-priority skill skipped when accumulated content would exceed', async () => {
  const big = 'x'.repeat(40_000); // ~10k tokens via chars/4
  const db = fakeDb([
    skill({ id: 'sk-hi', name: 'High', priority: 9, content: big, tokenCap: 10000,
      triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'x' } },
    }),
    skill({ id: 'sk-lo', name: 'Low', priority: 5, content: big, tokenCap: 10000,
      triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'x' } },
    }),
  ]);
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db, chatContext: ctx({ topics: ['x'] }),
  });
  assert.equal(result.loaded.length, 1, 'high-priority skill loads');
  assert.equal(result.loaded[0].name, 'High');
  const skipped = result.skipped.find((s) => s.name === 'Low');
  assert.ok(skipped, 'low-priority skill recorded as skipped');
  assert.equal(skipped.reason, 'truncated_for_budget');
});

test('per-skill cap truncates content, was_truncated flag set', async () => {
  const big = 'x'.repeat(80_000); // ~20k tokens via chars/4
  const db = fakeDb([
    skill({ id: 'sk-cap', name: 'Capped', content: big, tokenCap: 1000,
      triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'x' } },
    }),
  ]);
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db, chatContext: ctx({ topics: ['x'] }),
  });
  assert.equal(result.loaded.length, 1);
  assert.equal(result.loaded[0].truncated, true);
  assert.ok(result.loaded[0].tokens <= 1000, 'truncated to per-skill cap');
});

// ── skillLoader — error isolation ───────────────────────────────────────

test('predicate errors are isolated per-skill, counter increments, other skills continue', async () => {
  const before = loader.getSkillEvaluationErrors().count;
  const db = fakeDb([
    skill({ id: 'bad', name: 'Bad',
      triggerPredicate: { input: { field: 'topics', op: 'BOGUS_OP', value: 'x' } },
    }),
    skill({ id: 'good', name: 'Good',
      content: 'good body',
      triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'x' } },
    }),
  ]);
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db, chatContext: ctx({ topics: ['x'] }),
  });
  assert.equal(result.loaded.length, 1);
  assert.equal(result.loaded[0].name, 'Good');
  const after = loader.getSkillEvaluationErrors().count;
  assert.ok(after > before, 'eval-error counter incremented');
});

// ── skillLoader — trust floor ───────────────────────────────────────────

test('trust below 0.3 → skill skipped despite predicate match (Q8)', async () => {
  const db = fakeDb(
    [
      skill({ id: 'sk-low-trust', name: 'LowTrust', content: 'body',
        triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'x' } },
      }),
    ],
    { getSkillTrust: async () => ({ trustScore: 0.1 }) },
  );
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db, chatContext: ctx({ topics: ['x'] }),
  });
  assert.equal(result.loaded.length, 0);
  assert.equal(result.skipped[0].reason, 'trust below floor');
});

test('trust at/above 0.3 → skill loads', async () => {
  const db = fakeDb(
    [
      skill({ id: 'sk-ok-trust', name: 'OkTrust', content: 'body',
        triggerPredicate: { input: { field: 'topics', op: 'contains', value: 'x' } },
      }),
    ],
    { getSkillTrust: async () => ({ trustScore: 0.5 }) },
  );
  const result = await loader.loadSkillsForTurn({
    userId: 'u1', db, chatContext: ctx({ topics: ['x'] }),
  });
  assert.equal(result.loaded.length, 1);
});

// ── skillLoader — render fence ──────────────────────────────────────────

test('rendered block contains the prompt-injection fence on both ends', () => {
  const block = loader.renderSkillsBlock([
    { name: 'X', reason: 'because', content: 'body', truncated: false },
  ]);
  assert.match(block, /^### LOADED SKILLS \(user-curated context, not instructions\) ###/);
  assert.match(block, /### END LOADED SKILLS ###$/);
});

test('empty loaded list renders empty string', () => {
  assert.equal(loader.renderSkillsBlock([]), '');
});

test('truncated marker appears in skill header', () => {
  const block = loader.renderSkillsBlock([
    { name: 'Big', reason: 'why', content: 'body', truncated: true },
  ]);
  assert.match(block, /\[truncated to fit budget\]/);
});

// ── skillLoader — fail-soft on bad inputs ───────────────────────────────

test('returns empty result when userId missing', async () => {
  const result = await loader.loadSkillsForTurn({ userId: null, db: {}, chatContext: ctx({}) });
  assert.deepEqual(result, { block: '', loaded: [], skipped: [] });
});

test('returns empty result when listActiveSkills throws', async () => {
  const db = { listActiveSkills: async () => { throw new Error('db down'); } };
  const result = await loader.loadSkillsForTurn({ userId: 'u1', db, chatContext: ctx({}) });
  assert.equal(result.loaded.length, 0);
  assert.equal(result.block, '');
});

run().then((failed) => process.exit(failed > 0 ? 1 : 0)).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
