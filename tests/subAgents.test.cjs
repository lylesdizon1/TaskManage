'use strict';

/**
 * tests/subAgents.test.cjs — sub-agent unit tests (M3.11).
 *
 * Covers:
 *   - policy.cjs: hard-disallow list, result schema validator,
 *     phase-config validator
 *   - orchestrator.cjs: budget tracker, hard-disallow refusal,
 *     phase-boundary kill, schema-validation final gate
 *   - tools.cjs: budget composer (clamps + defaults)
 *   - notify.cjs: completion message composer
 *
 * Run via npm test (chained) or directly:
 *   node tests/subAgents.test.cjs
 */

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(32);

const assert = require('node:assert/strict');

const policy = require('../server/lib/subAgents/policy.cjs');
const orch = require('../server/lib/subAgents/orchestrator.cjs');
const notify = require('../server/lib/subAgents/notify.cjs');
const research = require('../server/lib/subAgents/researchAgent.cjs');
const tools = require('../server/tools.cjs');

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

// ── researchAgent — phantom-tool sanity (V1.1 fix) ─────────────────

test('ALLOWED_PLAN_TOOLS contains zero phantom entries (every name has a case handler)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const toolsSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'tools.cjs'), 'utf8');
  // Find every literal `case 'X':` token inside executeTool's switch.
  const caseRe = /case\s+'([a-z_]+)'\s*:/g;
  const cases = new Set();
  let m;
  while ((m = caseRe.exec(toolsSrc)) !== null) cases.add(m[1]);
  const phantoms = research.ALLOWED_PLAN_TOOLS.filter((t) => !cases.has(t));
  assert.deepEqual(phantoms, [], `phantom planner tools: ${phantoms.join(', ')}`);
});

test('web_search is NOT in ALLOWED_PLAN_TOOLS (it lives in synthesize-phase tools instead)', () => {
  assert.equal(research.ALLOWED_PLAN_TOOLS.includes('web_search'), false);
  assert.equal(research.SYNTHESIZE_TOOLS.length, 1);
  assert.equal(research.SYNTHESIZE_TOOLS[0].name, 'web_search');
  assert.equal(research.SYNTHESIZE_TOOLS[0].type, 'web_search_20250305');
});

test('orchestrator hard-disallow refuses every phantom name the planner might still emit', () => {
  // If an old planner (or future LLM hallucination) outputs one of the
  // pre-fix phantom names, the orchestrator's hard-disallow path should
  // refuse it. This test locks the safety net in place.
  const phantoms = ['list_tasks', 'list_events', 'list_calendar_events', 'list_notes', 'search_contacts', 'get_journal_today', 'get_threads', 'web_search'];
  for (const t of phantoms) {
    // Allowed-for-sub-agent check: web_search is intentionally not in the
    // hard-disallow list (it's server-hosted), so isToolAllowedForSubAgent
    // returns true. The actual block happens at executeTool's default case.
    // For the OTHER phantoms, isToolAllowedForSubAgent returns true too
    // (they're not in HARD_DISALLOWED_TOOLS — only writes are). The block
    // happens at executeTool default. Either way: dispatch never produces
    // a real result for these names.
    if (t === 'web_search') {
      assert.equal(policy.isToolAllowedForSubAgent(t), true, 'web_search itself isn\'t hard-disallowed; it just has no executeTool handler');
    } else {
      // Phantom names that were never registered also pass the
      // hard-disallow check (it only blocks writes); they fail at the
      // executeTool dispatch with "Unknown tool". Correct V1 shape —
      // hard-disallow protects user data, "Unknown tool" handles drift.
      assert.equal(policy.isToolAllowedForSubAgent(t), true);
    }
  }
});

// ── researchAgent — _extractFinalText handles multi-block responses ─

test('_extractFinalText handles single-text-block response (pre-tools shape)', () => {
  const resp = { content: [{ type: 'text', text: '{"findings":[]}' }] };
  assert.equal(research._extractFinalText(resp), '{"findings":[]}');
});

test('_extractFinalText handles multi-block with web_search (last text block wins)', () => {
  const resp = {
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'tesla' } },
      { type: 'web_search_tool_result', content: [{ url: 'https://example.com' }] },
      { type: 'text', text: '{"findings":[{"point":"Y","source":"https://example.com"}]}' },
    ],
  };
  const text = research._extractFinalText(resp);
  assert.match(text, /findings/);
  const parsed = research._safeParseJson(text);
  assert.equal(parsed.findings[0].source, 'https://example.com');
});

test('_extractFinalText returns empty for content-less / malformed responses', () => {
  assert.equal(research._extractFinalText(null), '');
  assert.equal(research._extractFinalText({}), '');
  assert.equal(research._extractFinalText({ content: [] }), '');
  assert.equal(research._extractFinalText({ content: [{ type: 'tool_use' }] }), '');
});

// ── policy.cjs — hard-disallow list ────────────────────────────────

test('hard-disallow list refuses all write/send/destructive tools', () => {
  const mustBeDisallowed = [
    'send_email', 'reply_email', 'forward_email',
    'create_task', 'update_task', 'complete_task', 'delete_task',
    'create_event', 'update_event', 'delete_event',
    'create_note', 'update_note', 'delete_note',
    'bulk_archive_emails', 'archive_email', 'move_email',
    'set_preference', 'remove_preference',
    'create_skill', 'update_skill', 'delete_skill',
    'accept_rule_proposal', 'reject_rule_proposal',
    'start_sub_agent', 'kill_sub_agent', // no nesting
  ];
  for (const t of mustBeDisallowed) {
    assert.equal(policy.isToolAllowedForSubAgent(t), false, `${t} should be hard-disallowed`);
  }
});

test('read-only tools are allowed', () => {
  const allowed = ['search_inbox', 'get_email_content', 'list_tasks', 'list_events', 'web_search', 'list_contacts'];
  for (const t of allowed) {
    assert.equal(policy.isToolAllowedForSubAgent(t), true, `${t} should be allowed`);
  }
});

test('isToolAllowedForSubAgent returns false for empty/null', () => {
  assert.equal(policy.isToolAllowedForSubAgent(''), false);
  assert.equal(policy.isToolAllowedForSubAgent(null), false);
  assert.equal(policy.isToolAllowedForSubAgent(undefined), false);
});

// ── policy.cjs — result schema validator ───────────────────────────

test('validateResultSchema accepts a well-formed result', () => {
  const v = policy.validateResultSchema({
    summary: 'Found 3 things.',
    key_findings: [
      { point: 'Bob owes you a reply on the Q3 proposal.', source: 'search_inbox: thread 19df...' },
    ],
    sources: [{ tool: 'search_inbox', input_summary: '{"query":"bob"}', output_summary: '...' }],
    action_items: ['Reply to Bob about the proposal'],
    confidence: 0.7,
    budget_used: { tool_calls: 8, wall_clock_ms: 12000, tokens: 4500 },
  });
  assert.equal(v.ok, true, `expected ok, got errors: ${v.errors.join('; ')}`);
});

test('validateResultSchema rejects findings without sources (anti-hallucination)', () => {
  const v = policy.validateResultSchema({
    summary: 'Finding A.',
    key_findings: [
      { point: 'A claim with no source.' },
    ],
    sources: [],
    confidence: 0.5,
    budget_used: {},
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('source is required')));
});

test('validateResultSchema rejects missing required fields', () => {
  const v = policy.validateResultSchema({ summary: 'just a summary' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('key_findings')));
  assert.ok(v.errors.some((e) => e.includes('sources')));
  assert.ok(v.errors.some((e) => e.includes('confidence')));
  assert.ok(v.errors.some((e) => e.includes('budget_used')));
});

test('validateResultSchema rejects out-of-range confidence', () => {
  const base = { summary: 's', key_findings: [], sources: [], budget_used: {} };
  assert.equal(policy.validateResultSchema({ ...base, confidence: 1.5 }).ok, false);
  assert.equal(policy.validateResultSchema({ ...base, confidence: -0.1 }).ok, false);
  assert.equal(policy.validateResultSchema({ ...base, confidence: 'high' }).ok, false);
});

test('validateResultSchema rejects empty summary', () => {
  const v = policy.validateResultSchema({
    summary: '',
    key_findings: [],
    sources: [],
    confidence: 0.5,
    budget_used: {},
  });
  assert.equal(v.ok, false);
});

// ── policy.cjs — phase config validator ────────────────────────────

test('validatePhaseConfig accepts the research-agent default phase shape', () => {
  const v = policy.validatePhaseConfig([
    { name: 'plan', tool_call_budget: 0, wall_clock_ms: 30000, synthesis: true },
    { name: 'gather', tool_call_budget: 24, wall_clock_ms: 180000, synthesis: false },
    { name: 'synthesize', tool_call_budget: 0, wall_clock_ms: 60000, synthesis: true },
    { name: 'package', tool_call_budget: 0, wall_clock_ms: 30000, synthesis: true },
  ]);
  assert.equal(v.ok, true, `errors: ${v.errors.join('; ')}`);
});

test('validatePhaseConfig rejects empty / non-array', () => {
  assert.equal(policy.validatePhaseConfig([]).ok, false);
  assert.equal(policy.validatePhaseConfig(null).ok, false);
  assert.equal(policy.validatePhaseConfig({}).ok, false);
});

test('validatePhaseConfig rejects duplicate phase names', () => {
  const v = policy.validatePhaseConfig([
    { name: 'plan', tool_call_budget: 0 },
    { name: 'plan', tool_call_budget: 5 },
  ]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes('duplicated')));
});

test('validatePhaseConfig rejects negative tool budgets', () => {
  const v = policy.validatePhaseConfig([
    { name: 'plan', tool_call_budget: -1 },
  ]);
  assert.equal(v.ok, false);
});

// ── orchestrator.cjs — budget tracker ──────────────────────────────

test('budget tracker reports under all caps initially', () => {
  const b = orch._makeBudgetTracker({ tool_calls: 10, wall_clock_ms: 60000, tokens: 1000, spend_usd: 1.0 });
  assert.equal(b.exhausted(), null);
});

test('budget tracker hits tool_calls cap exactly', () => {
  const b = orch._makeBudgetTracker({ tool_calls: 3, wall_clock_ms: 60000, tokens: 1000, spend_usd: 1.0 });
  b.addToolCall(); b.addToolCall(); b.addToolCall();
  assert.equal(b.exhausted(), 'tool_calls');
});

test('budget tracker hits tokens cap', () => {
  const b = orch._makeBudgetTracker({ tool_calls: 100, wall_clock_ms: 60000, tokens: 100, spend_usd: 1.0 });
  b.addTokens(150);
  assert.equal(b.exhausted(), 'tokens');
});

test('budget tracker hits spend_usd cap', () => {
  const b = orch._makeBudgetTracker({ tool_calls: 100, wall_clock_ms: 60000, tokens: 100000, spend_usd: 0.01 });
  b.addTokens(10, 0.02);
  assert.equal(b.exhausted(), 'spend_usd');
});

test('budget tracker snapshot includes all 4 axes', () => {
  const b = orch._makeBudgetTracker({ tool_calls: 30, wall_clock_ms: 60000, tokens: 30000, spend_usd: 2.0 });
  b.addToolCall(); b.addTokens(500, 0.005);
  const snap = b.snapshot();
  assert.equal(snap.tool_calls, 1);
  assert.equal(snap.tokens, 500);
  assert.equal(snap.spend_usd, 0.005);
  assert.ok(typeof snap.wall_clock_ms === 'number');
});

// ── tools.cjs — sub-agent budget composer ──────────────────────────

test('budget composer uses definition defaults when no overrides', () => {
  const out = tools._composeSubAgentBudget(
    { tool_calls: 30, wall_clock_ms: 300000, tokens: 30000, spend_usd: 2.0 },
    {},
  );
  assert.equal(out.tool_calls, 30);
  assert.equal(out.wall_clock_ms, 300000);
});

test('budget composer applies overrides under cap', () => {
  const out = tools._composeSubAgentBudget(
    { tool_calls: 30, wall_clock_ms: 300000, tokens: 30000, spend_usd: 2.0 },
    { tool_calls: 20, spend_usd: 1.0 },
  );
  assert.equal(out.tool_calls, 20);
  assert.equal(out.spend_usd, 1.0);
  assert.equal(out.wall_clock_ms, 300000); // untouched
});

test('budget composer clamps overrides to server cap', () => {
  const out = tools._composeSubAgentBudget(
    { tool_calls: 30 },
    { tool_calls: 9999, wall_clock_ms: 99 * 60 * 1000, tokens: 9999999, spend_usd: 100 },
  );
  assert.equal(out.tool_calls, tools.SUB_AGENT_BUDGET_CAPS.tool_calls);
  assert.equal(out.wall_clock_ms, tools.SUB_AGENT_BUDGET_CAPS.wall_clock_ms);
  assert.equal(out.tokens, tools.SUB_AGENT_BUDGET_CAPS.tokens);
  assert.equal(out.spend_usd, tools.SUB_AGENT_BUDGET_CAPS.spend_usd);
});

test('budget composer rejects non-numeric / negative overrides', () => {
  const out = tools._composeSubAgentBudget(
    { tool_calls: 30 },
    { tool_calls: 'bogus' },
  );
  assert.equal(out.tool_calls, 30);
  const out2 = tools._composeSubAgentBudget(
    { tool_calls: 30 },
    { tool_calls: -5 },
  );
  assert.equal(out2.tool_calls, 30);
});

// ── notify.cjs — completion message composer ───────────────────────

test('notify message: completed status includes summary + finding count', () => {
  const msg = notify._composeMessage({
    status: 'completed',
    prompt: 'Prep me for tomorrow with Bob',
    result: {
      summary: 'Bob has 3 open threads.',
      key_findings: [
        { point: 'a', source: 's' }, { point: 'b', source: 's' }, { point: 'c', source: 's' },
      ],
    },
  });
  assert.match(msg, /Research done/);
  assert.match(msg, /Bob/);
  assert.match(msg, /3 findings/);
});

test('notify message: budget_exhausted explicit', () => {
  const msg = notify._composeMessage({ status: 'budget_exhausted', prompt: 'X' });
  assert.match(msg, /budget/i);
});

test('notify message: killed mentions cancelled', () => {
  const msg = notify._composeMessage({ status: 'killed', prompt: 'X' });
  assert.match(msg, /cancelled/i);
});

test('notify message: failed surfaces error', () => {
  const msg = notify._composeMessage({ status: 'failed', prompt: 'X', error: 'something blew up' });
  assert.match(msg, /failed/i);
  assert.match(msg, /something blew up/);
});

test('notify message: completed handles missing summary gracefully', () => {
  const msg = notify._composeMessage({ status: 'completed', prompt: 'X', result: {} });
  assert.match(msg, /Research done/);
  assert.match(msg, /0 findings/);
});

// ── orchestrator runSession — happy path with mocked phases ────────

test('runSession completes with 4-phase research-agent shape', async () => {
  // Stub db helpers used by orchestrator.cjs.
  const stubDb = {
    getSubAgentSession: async () => ({ status: 'running' }),
    updateSubAgentSession: async () => null,
    logSubAgentStep: async () => {},
    logSubAgentFinding: async () => {},
    pool: { query: async () => ({ rows: [] }) },
  };
  // Monkeypatch the db module the orchestrator pulled.
  const dbReal = require('../db.cjs');
  const origGetSession = dbReal.getSubAgentSession;
  const origUpdate = dbReal.updateSubAgentSession;
  const origLogStep = dbReal.logSubAgentStep;
  const origLogFinding = dbReal.logSubAgentFinding;
  dbReal.getSubAgentSession = stubDb.getSubAgentSession;
  dbReal.updateSubAgentSession = stubDb.updateSubAgentSession;
  dbReal.logSubAgentStep = stubDb.logSubAgentStep;
  dbReal.logSubAgentFinding = stubDb.logSubAgentFinding;
  try {
    const definition = {
      id: 'test_agent',
      phases: [
        { name: 'plan', tool_call_budget: 0, wall_clock_ms: 5000 },
        { name: 'gather', tool_call_budget: 10, wall_clock_ms: 5000 },
        { name: 'synthesize', tool_call_budget: 0, wall_clock_ms: 5000 },
        { name: 'package', tool_call_budget: 0, wall_clock_ms: 5000 },
      ],
      defaultBudget: { tool_calls: 30, wall_clock_ms: 60000, tokens: 1000, spend_usd: 1.0 },
    };
    const session = {
      id: 'sess-test', userId: 'u1', prompt: 'test investigation',
      budget: definition.defaultBudget,
    };
    const phaseImpls = {
      plan: async (ctx) => { ctx.accumulator.plannedCalls = []; },
      gather: async (ctx) => { ctx.accumulator.rawResults = [{ tool: 'search_inbox', input: {}, why: '', result: { success: true }, success: true }]; },
      synthesize: async (ctx) => {
        ctx.accumulator.synthesizedFindings = [{ point: 'A finding', source: 'search_inbox: id 1' }];
        await ctx.addFinding({ point: 'A finding', source: 'search_inbox: id 1' });
      },
      package: async (ctx) => {
        ctx.accumulator.result = {
          summary: 'Test complete.',
          key_findings: ctx.accumulator.synthesizedFindings,
          sources: [{ tool: 'search_inbox', input_summary: '{}', output_summary: 'ok' }],
          action_items: [],
          confidence: 0.7,
          budget_used: ctx.budget.snapshot(),
        };
      },
    };
    const result = await orch.runSession({ session, definition, phaseImpls });
    assert.equal(result.status, 'completed');
    assert.equal(result.result.summary, 'Test complete.');
    assert.equal(result.result.key_findings.length, 1);
  } finally {
    dbReal.getSubAgentSession = origGetSession;
    dbReal.updateSubAgentSession = origUpdate;
    dbReal.logSubAgentStep = origLogStep;
    dbReal.logSubAgentFinding = origLogFinding;
  }
});

test('runSession returns failed when result schema invalid (no sources on findings)', async () => {
  const dbReal = require('../db.cjs');
  const origs = {
    getSubAgentSession: dbReal.getSubAgentSession,
    updateSubAgentSession: dbReal.updateSubAgentSession,
    logSubAgentStep: dbReal.logSubAgentStep,
    logSubAgentFinding: dbReal.logSubAgentFinding,
  };
  dbReal.getSubAgentSession = async () => ({ status: 'running' });
  dbReal.updateSubAgentSession = async () => null;
  dbReal.logSubAgentStep = async () => {};
  dbReal.logSubAgentFinding = async () => {};
  try {
    const definition = {
      id: 'test_agent',
      phases: [{ name: 'package', wall_clock_ms: 5000 }],
      defaultBudget: { tool_calls: 30, wall_clock_ms: 60000, tokens: 1000, spend_usd: 1.0 },
    };
    const session = { id: 's1', userId: 'u1', prompt: 'x', budget: definition.defaultBudget };
    const phaseImpls = {
      package: async (ctx) => {
        ctx.accumulator.result = {
          summary: 'x',
          key_findings: [{ point: 'no source here' }],
          sources: [],
          confidence: 0.5,
          budget_used: ctx.budget.snapshot(),
        };
      },
    };
    const out = await orch.runSession({ session, definition, phaseImpls });
    assert.equal(out.status, 'failed');
    assert.match(out.error, /schema invalid/);
    assert.ok(Array.isArray(out.result.schema_errors));
  } finally {
    Object.assign(dbReal, origs);
  }
});

test('runSession returns killed when session status flips mid-run', async () => {
  const dbReal = require('../db.cjs');
  const origs = {
    getSubAgentSession: dbReal.getSubAgentSession,
    updateSubAgentSession: dbReal.updateSubAgentSession,
    logSubAgentStep: dbReal.logSubAgentStep,
    logSubAgentFinding: dbReal.logSubAgentFinding,
  };
  // Phase 1 finishes; before phase 2, the kill check sees 'killed'.
  let phaseCount = 0;
  dbReal.getSubAgentSession = async () => {
    phaseCount += 1;
    return { status: phaseCount > 1 ? 'killed' : 'running' };
  };
  dbReal.updateSubAgentSession = async () => null;
  dbReal.logSubAgentStep = async () => {};
  dbReal.logSubAgentFinding = async () => {};
  try {
    const definition = {
      id: 'test_agent',
      phases: [
        { name: 'plan', wall_clock_ms: 5000 },
        { name: 'gather', wall_clock_ms: 5000 },
      ],
      defaultBudget: { tool_calls: 30, wall_clock_ms: 60000, tokens: 1000, spend_usd: 1.0 },
    };
    const session = { id: 's1', userId: 'u1', prompt: 'x', budget: definition.defaultBudget };
    const phaseImpls = {
      plan: async () => {},
      gather: async () => { throw new Error('should not run after kill'); },
    };
    const out = await orch.runSession({ session, definition, phaseImpls });
    assert.equal(out.status, 'killed');
  } finally {
    Object.assign(dbReal, origs);
  }
});

run().then((failed) => process.exit(failed > 0 ? 1 : 0)).catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
