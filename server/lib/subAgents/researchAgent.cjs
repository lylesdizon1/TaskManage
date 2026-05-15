'use strict';

/**
 * server/lib/subAgents/researchAgent.cjs — phase implementations for the
 * research_agent sub-agent type.
 *
 * Spec: docs/agents-foundation-v1.md §5B + research-agents-spec-v1.md.
 *
 * The orchestrator (./orchestrator.cjs) drives the phase loop; this
 * module owns what each phase actually does:
 *
 *   plan       LLM produces a list of tool calls (read-only) to gather
 *              evidence about the user's prompt.
 *   gather     Deterministic dispatch — runs each planned tool call,
 *              accumulates raw results in accumulator.rawResults.
 *   synthesize LLM reads the gathered results, produces structured
 *              findings (each with a source locator).
 *   package    LLM produces the final result schema: summary +
 *              key_findings + sources + action_items + confidence +
 *              budget_used. Validated by orchestrator.
 *
 * The LLM is called only at synthesis points (plan / synthesize /
 * package). Tool dispatch in gather is non-LLM — it just walks the
 * planned list.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('../anthropicRetry.cjs');

const PLAN_MODEL = 'claude-haiku-4-5-20251001';      // cheaper for the planner
const SYNTHESIS_MODEL = 'claude-sonnet-4-6';   // richer for synthesis + final
const PLAN_TIMEOUT_MS = 30000;
const SYNTHESIS_TIMEOUT_MS = 60000;

let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.CLAUDE_API_KEY) return null;
  try {
    _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
    return _client;
  } catch { return null; }
}

// Allowlist of tools the planner may call. ONLY entries that have a
// matching `case` handler in tools.cjs::executeTool — no phantoms.
// Drift caught by tests/subAgents.test.cjs (planner-allowlist sanity
// check). Web search is intentionally absent — it's an Anthropic
// server-hosted tool that resolves at the LLM layer; the synthesize
// phase wires it in via the synthesis Sonnet call (see SYNTHESIZE_TOOLS
// below) rather than as a deterministic dispatch in gather.
const ALLOWED_PLAN_TOOLS = [
  'search_inbox', 'get_email_content', 'search_email_content',
  'list_email_labels',
  'search_tasks',
  'search_notes',
  'list_contacts', 'get_contact',
  'list_journal_entries', 'get_today_close_loop_context',
];

// Anthropic's server-hosted web search. Mirror of the constant in
// tools.cjs (kept inline to avoid a require cycle through the agentic
// loop). Attached to synthesis-phase Sonnet calls so the LLM can
// search inline and incorporate cited results into findings. Future
// sub-agent templates that need web search should attach this to
// their own synthesis-phase calls — NOT try to dispatch it through
// executeTool (which has no handler — server-hosted tools resolve at
// the API layer).
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,
};
const SYNTHESIZE_TOOLS = [WEB_SEARCH_TOOL];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

function safeParseJson(text) {
  if (!text) return null;
  const stripped = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const m = stripped.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Anthropic responses with server-hosted tools (e.g. web_search) have
// content arrays mixing server_tool_use + web_search_tool_result + text
// blocks. Grab the LAST text block — that's the model's final output
// after any tool results have been incorporated. Tolerates the
// pre-tools shape (single text block at index 0) by virtue of "last".
function _extractFinalText(resp) {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === 'text' && typeof blocks[i].text === 'string') {
      return blocks[i].text;
    }
  }
  return '';
}

// ── Plan phase ──────────────────────────────────────────────────────

const PLAN_SYSTEM = `You are a research planner. Given a user's investigation prompt, produce a JSON plan: a list of tool calls to gather evidence.

Output STRICT JSON of this shape (no preamble, no markdown):
{
  "rationale": "1-2 sentences on the strategy",
  "calls": [
    { "tool": "search_inbox", "input": { "query": "..." }, "why": "short reason" },
    ...
  ]
}

Rules:
- Each call must be from this allowlist: ${ALLOWED_PLAN_TOOLS.join(', ')}.
- 0-15 calls total. Fewer is better when fewer suffice. ZERO is correct when the prompt requires only external/web evidence — the synthesize phase has its own web_search and doesn't need a gather plan.
- Prefer search tools first; specific gets only when you have an id.
- Don't include duplicates or near-duplicates of the same query.
- Don't plan write or send tools — they will be refused.
- Don't plan web_search — it's not in the allowlist for gather. The synthesize phase invokes it directly when needed; planning it here just wastes a call.
- Don't plan calls that will obviously return empty (e.g. searching for the user's own name in their inbox).`;

async function planPhase(ctx) {
  const c = client();
  if (!c) {
    ctx.accumulator.plannedCalls = [];
    await ctx.logSynthesis({ note: 'no claude api key — skipping plan, gather will be empty' });
    return;
  }

  let resp;
  try {
    resp = await withTimeout(
      withRetry(
        () => c.messages.create({
          model: PLAN_MODEL,
          max_tokens: 1500,
          system: PLAN_SYSTEM,
          messages: [{
            role: 'user',
            content: `Investigation prompt:\n\n${ctx.prompt}\n\nProduce the JSON plan.`,
          }],
        }),
        'subagent-plan',
      ),
      PLAN_TIMEOUT_MS,
      'subagent-plan',
    );
  } catch (err) {
    ctx.accumulator.plannedCalls = [];
    await ctx.logSynthesis({ error: `plan failed: ${err.message}` });
    return;
  }

  // Track tokens against the run budget.
  const usage = resp?.usage || {};
  const planTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  // Haiku: ~$0.0008/Mtok input, ~$0.004/Mtok output. Approx blended.
  const planCost = (planTokens / 1_000_000) * 2.0;
  ctx.budget.addTokens(planTokens, planCost);

  const text = resp?.content?.[0]?.text || '';
  const parsed = safeParseJson(text);
  const calls = Array.isArray(parsed?.calls) ? parsed.calls : [];

  // Filter to allowlisted tools + cap at 15.
  const validCalls = calls
    .filter((c) => c && typeof c.tool === 'string' && ALLOWED_PLAN_TOOLS.includes(c.tool))
    .slice(0, 15)
    .map((c) => ({
      tool: c.tool,
      input: c.input && typeof c.input === 'object' ? c.input : {},
      why: typeof c.why === 'string' ? c.why.slice(0, 160) : '',
    }));

  ctx.accumulator.plannedCalls = validCalls;
  ctx.accumulator.planRationale = typeof parsed?.rationale === 'string' ? parsed.rationale : '';
  await ctx.logSynthesis({
    rationale: ctx.accumulator.planRationale,
    plannedCallCount: validCalls.length,
    tokens: planTokens,
  });
}

// ── Gather phase (deterministic) ────────────────────────────────────

async function gatherPhase(ctx) {
  const planned = ctx.accumulator.plannedCalls || [];
  const phaseToolBudget = 24; // matches sub_agent_definitions phase config
  const cap = Math.min(planned.length, phaseToolBudget);

  for (let i = 0; i < cap; i++) {
    if (ctx.budget.exhausted()) {
      ctx.accumulator.gatherStoppedEarly = `budget exhausted after ${i} calls`;
      break;
    }
    const call = planned[i];
    const result = await ctx.dispatch(call.tool, call.input);
    ctx.accumulator.rawResults.push({
      tool: call.tool,
      input: call.input,
      why: call.why,
      result,
      success: !!result?.success && !result?.hard_disallowed && !result?.budget_exhausted,
    });
  }
}

// ── Synthesize phase ────────────────────────────────────────────────

const SYNTHESIZE_SYSTEM = `You synthesize structured findings for a research investigation.

You have access to web_search (server-hosted, max 5 uses per call). USE IT when local raw results are thin or empty AND the prompt benefits from external evidence, when the prompt explicitly asks you to search the web, or when specific facts (specs, prices, news, reviews) need authoritative external sources. Do not use it when the local evidence is sufficient.

Output STRICT JSON of this shape (no preamble, no markdown):
{
  "findings": [
    { "point": "concrete finding sentence", "source": "tool: locator (e.g. search_inbox: thread 19df...) OR full URL for web-derived findings" },
    ...
  ]
}

Rules:
- Each finding MUST cite a source string. For local-data findings: tool name + locator. For web-derived findings: the full URL you got the fact from (https://…). Citations are mandatory — no source = the finding gets dropped.
- 3-10 findings. Be selective — only include findings the evidence supports.
- Don't speculate. If neither local nor web evidence supports a claim, don't include it.
- Findings should be useful to a busy operator: action-relevant facts, names, dates, amounts, status.`;

async function synthesizePhase(ctx) {
  const c = client();
  if (!c) {
    ctx.accumulator.synthesizedFindings = [];
    await ctx.logSynthesis({ error: 'no claude api key' });
    return;
  }

  // Compress raw results into a digestible form for the LLM.
  const rawSummary = (ctx.accumulator.rawResults || []).map((r, i) => {
    const out = r.result;
    let summary;
    if (!out || out.success === false) {
      summary = `error: ${(out?.error || 'unknown').slice(0, 160)}`;
    } else {
      try {
        const s = JSON.stringify(out);
        summary = s.length > 800 ? s.slice(0, 797) + '...' : s;
      } catch { summary = '[unserializable]'; }
    }
    return `[${i}] ${r.tool} (${r.why || 'no reason'}) → ${summary}`;
  }).join('\n\n');

  let resp;
  try {
    resp = await withTimeout(
      withRetry(
        () => c.messages.create({
          model: SYNTHESIS_MODEL,
          max_tokens: 4000,
          system: SYNTHESIZE_SYSTEM,
          tools: SYNTHESIZE_TOOLS,
          messages: [{
            role: 'user',
            content: `Investigation prompt:\n\n${ctx.prompt}\n\nLocal raw evidence (${ctx.accumulator.rawResults.length} tool results):\n\n${rawSummary || '(none — local gather returned no usable results)'}\n\nProduce the JSON findings. Use web_search if local evidence is thin or the prompt asks for web research.`,
          }],
        }),
        'subagent-synthesize',
      ),
      SYNTHESIS_TIMEOUT_MS,
      'subagent-synthesize',
    );
  } catch (err) {
    ctx.accumulator.synthesizedFindings = [];
    await ctx.logSynthesis({ error: `synthesize failed: ${err.message}` });
    return;
  }

  const usage = resp?.usage || {};
  const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  // Sonnet: ~$3/Mtok input, ~$15/Mtok output. Blended approximation.
  // web_search adds server-side token usage; Anthropic counts it in
  // input_tokens so the addTokens call below captures it correctly.
  const cost = (tokens / 1_000_000) * 9.0;
  ctx.budget.addTokens(tokens, cost);

  // Multi-block response handling — when web_search runs, content is a
  // mix of server_tool_use + web_search_tool_result + text blocks.
  // Grab the LAST text block (the model's JSON output after the search
  // results landed). content[0] used to work pre-tools but breaks now.
  const text = _extractFinalText(resp);
  const webSearchHits = (resp?.content || []).filter((b) => b?.type === 'web_search_tool_result').length;
  const parsed = safeParseJson(text);
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];

  // Validate per-finding source requirement at synthesis time too —
  // double safety net before package validation.
  const cleaned = findings
    .filter((f) => f && typeof f.point === 'string' && f.point.trim() && typeof f.source === 'string' && f.source.trim())
    .slice(0, 10);

  ctx.accumulator.synthesizedFindings = cleaned;
  for (const f of cleaned) await ctx.addFinding(f);
  await ctx.logSynthesis({ count: cleaned.length, tokens, web_search_hits: webSearchHits });
}

// ── Package phase ───────────────────────────────────────────────────

const PACKAGE_SYSTEM = `Produce the final structured result for a research run.

Output STRICT JSON of this shape (no preamble, no markdown):
{
  "summary": "1-3 sentence headline answering the user's prompt",
  "key_findings": [
    { "point": "...", "source": "..." }, ...
  ],
  "sources": [
    { "tool": "search_inbox", "input_summary": "...", "output_summary": "..." }, ...
  ],
  "action_items": [ "what the user should do next", ... ],
  "confidence": 0.0
}

Rules:
- key_findings are the same shape the synthesis phase produced. Carry them through faithfully.
- sources is the deduped list of tool calls that materially backed the findings.
- action_items: 0-5 concrete next steps. Empty array if the prompt was informational.
- confidence: 0.0–1.0 reflecting how well the evidence answers the prompt.
- summary must be honest about gaps if the evidence was thin.`;

async function packagePhase(ctx) {
  const findings = ctx.accumulator.synthesizedFindings || [];
  const sources = (ctx.accumulator.rawResults || []).map((r) => ({
    tool: r.tool,
    input_summary: _safeStringify(r.input).slice(0, 200),
    output_summary: r.success
      ? _safeStringify(r.result).slice(0, 200)
      : `error: ${(r.result?.error || 'unknown').slice(0, 200)}`,
  }));

  const c = client();
  // If LLM unavailable, build a minimal valid result deterministically.
  if (!c || findings.length === 0) {
    const summary = findings.length
      ? `Found ${findings.length} relevant items for: ${ctx.prompt.slice(0, 120)}`
      : `No findings — investigation came up empty for: ${ctx.prompt.slice(0, 120)}${ctx.partialReason ? ` (${ctx.partialReason})` : ''}`;
    ctx.accumulator.result = {
      summary,
      key_findings: findings,
      sources,
      action_items: [],
      confidence: findings.length > 0 ? 0.4 : 0.1,
      budget_used: ctx.budget.snapshot(),
    };
    await ctx.logSynthesis({ deterministic_package: true, finding_count: findings.length });
    return;
  }

  let resp;
  try {
    resp = await withTimeout(
      withRetry(
        () => c.messages.create({
          model: SYNTHESIS_MODEL,
          max_tokens: 2000,
          system: PACKAGE_SYSTEM,
          messages: [{
            role: 'user',
            content: `Investigation prompt:\n\n${ctx.prompt}\n\nFindings (validated, with sources):\n${JSON.stringify(findings, null, 2)}\n\nTool sources (${sources.length}):\n${JSON.stringify(sources.slice(0, 12), null, 2)}\n\n${ctx.partialReason ? `Note: run ended early (${ctx.partialReason}).\n\n` : ''}Produce the JSON result.`,
          }],
        }),
        'subagent-package',
      ),
      SYNTHESIS_TIMEOUT_MS,
      'subagent-package',
    );
  } catch (err) {
    // Fall back to deterministic packaging.
    ctx.accumulator.result = {
      summary: `Package phase failed (${err.message}); returning ${findings.length} findings.`,
      key_findings: findings,
      sources,
      action_items: [],
      confidence: 0.2,
      budget_used: ctx.budget.snapshot(),
    };
    await ctx.logSynthesis({ error: `package failed: ${err.message}` });
    return;
  }

  const usage = resp?.usage || {};
  const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  const cost = (tokens / 1_000_000) * 9.0;
  ctx.budget.addTokens(tokens, cost);

  // Same multi-block-tolerant text extraction — package is single-block
  // today (no tools attached), but using the helper means a future
  // attach of WEB_SEARCH_TOOL here doesn't silently break parsing.
  const text = _extractFinalText(resp);
  const parsed = safeParseJson(text);

  // Build final result with budget_used always added authoritatively
  // by us (LLM might omit/lie about it) + carry findings + sources from
  // the deterministic record (LLM doesn't get the privilege of
  // dropping sources).
  ctx.accumulator.result = {
    summary: typeof parsed?.summary === 'string' ? parsed.summary : `Investigation completed with ${findings.length} findings.`,
    key_findings: findings,
    sources,
    action_items: Array.isArray(parsed?.action_items) ? parsed.action_items.slice(0, 5).filter((a) => typeof a === 'string') : [],
    confidence: typeof parsed?.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : (findings.length > 2 ? 0.6 : 0.3),
    budget_used: ctx.budget.snapshot(),
  };
  await ctx.logSynthesis({ tokens, finding_count: findings.length });
}

function _safeStringify(v) {
  try { return JSON.stringify(v); } catch { return '[unserializable]'; }
}

// ── Phase registry ──────────────────────────────────────────────────

const PHASES = {
  plan: planPhase,
  gather: gatherPhase,
  synthesize: synthesizePhase,
  package: packagePhase,
};

module.exports = {
  PHASES,
  // Exported for tests:
  ALLOWED_PLAN_TOOLS,
  WEB_SEARCH_TOOL,
  SYNTHESIZE_TOOLS,
  _planPhase: planPhase,
  _gatherPhase: gatherPhase,
  _synthesizePhase: synthesizePhase,
  _packagePhase: packagePhase,
  _extractFinalText,
  _safeParseJson: safeParseJson,
};
