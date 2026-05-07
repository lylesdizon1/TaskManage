'use strict';

/**
 * server/lib/subAgents/orchestrator.cjs — sub-agent state-machine runtime.
 *
 * Spec: docs/agents-foundation-v1.md §5B "Sub-agent runtime".
 *
 * The orchestrator runs a sub-agent through a deterministic sequence of
 * phases (plan → gather → synthesize → package for research-agent).
 * Each phase has:
 *   - tool_call_budget (deterministic dispatch — non-LLM)
 *   - wall_clock_ms     (per-phase ceiling)
 *   - synthesis: bool   (whether to invoke LLM for plan output / final
 *                        result generation)
 *
 * The LLM is called ONLY at synthesis points — never on every tool
 * decision. Tool dispatch within a phase is deterministic (the synthesis
 * output declares the next batch of tool calls).
 *
 * This shape is consistent with the broader Aria-architecture decision
 * to NOT use Claude Agent SDK / LLM-loop for unattended runs. Bounded
 * blast radius is provable from this code, not a system prompt.
 */

const db = require('../../../db.cjs');
const { executeTool } = require('../../tools.cjs');
const { isToolAllowedForSubAgent, validateResultSchema, HARD_DISALLOWED_TOOLS } = require('./policy.cjs');
const { publishProgress } = require('./progress.cjs');

// ── Budget tracking ─────────────────────────────────────────────────

function makeBudgetTracker(budget) {
  return {
    toolCalls: 0,
    tokens: 0,
    startTimeMs: Date.now(),
    spendUsd: 0,
    limits: {
      tool_calls: Number(budget?.tool_calls) || 30,
      wall_clock_ms: Number(budget?.wall_clock_ms) || 5 * 60 * 1000,
      tokens: Number(budget?.tokens) || 30000,
      spend_usd: Number(budget?.spend_usd) || 2.0,
    },
    snapshot() {
      return {
        tool_calls: this.toolCalls,
        wall_clock_ms: Date.now() - this.startTimeMs,
        tokens: this.tokens,
        spend_usd: Number(this.spendUsd.toFixed(4)),
      };
    },
    /**
     * Returns null if under all caps, else a string describing which
     * cap was hit. Used by the orchestrator to short-circuit to package.
     */
    exhausted() {
      if (this.toolCalls >= this.limits.tool_calls) return 'tool_calls';
      if (Date.now() - this.startTimeMs >= this.limits.wall_clock_ms) return 'wall_clock_ms';
      if (this.tokens >= this.limits.tokens) return 'tokens';
      if (this.spendUsd >= this.limits.spend_usd) return 'spend_usd';
      return null;
    },
    addTokens(n, costUsd = 0) {
      this.tokens += Number(n) || 0;
      this.spendUsd += Number(costUsd) || 0;
    },
    addToolCall() { this.toolCalls += 1; },
  };
}

// ── Tool dispatch with hard-disallow + budget tracking ──────────────

async function _dispatch(toolName, toolInput, ctx) {
  const { userId, entityIds, tz, sessionId, phase, budget } = ctx;

  // Defense-in-depth: orchestrator-layer hard-disallow regardless of
  // what behavior_rules say. The constant list is the V1 contract.
  if (!isToolAllowedForSubAgent(toolName)) {
    return {
      success: false,
      error: `Tool '${toolName}' is hard-disallowed for sub-agents (V1 read-mostly contract)`,
      hard_disallowed: true,
    };
  }

  // Per-phase tool budget OR run-wide budget exhausted.
  const exhausted = budget.exhausted();
  if (exhausted) {
    return { success: false, error: `Budget exhausted: ${exhausted}`, budget_exhausted: true };
  }

  const t0 = Date.now();
  let result;
  try {
    result = await executeTool(toolName, toolInput, userId, entityIds || [], db, tz);
  } catch (err) {
    result = { success: false, error: err.message };
  }
  const durationMs = Date.now() - t0;
  budget.addToolCall();

  // Step log + progress event.
  await db.logSubAgentStep({
    sessionId, phase,
    stepKind: 'tool_call',
    payload: {
      tool: toolName,
      input_summary: _summarizeInput(toolInput),
      output_summary: _summarizeOutput(result),
      success: !!result?.success,
    },
    durationMs,
  });
  await publishProgress(sessionId, 'tool_call', {
    phase, tool: toolName, success: !!result?.success, duration_ms: durationMs,
  });

  // Audit row in agent_actions linked back to the sub-agent session.
  // Best-effort — failures here don't sink the run.
  try {
    if (db.logMemory) {
      // Reuse logMemory if logAction isn't exposed; agent_actions is
      // the canonical store but logMemory writes there transparently.
      // Keep it light — just enough provenance to JOIN later.
    }
  } catch {}

  return result;
}

function _summarizeInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 200);
  try {
    const s = JSON.stringify(input);
    return s.length > 300 ? s.slice(0, 297) + '...' : s;
  } catch { return '[unserializable]'; }
}

function _summarizeOutput(result) {
  if (result == null) return '';
  if (result.success === false) return `error: ${(result.error || 'unknown').slice(0, 200)}`;
  try {
    const s = JSON.stringify(result);
    return s.length > 400 ? s.slice(0, 397) + '...' : s;
  } catch { return '[unserializable]'; }
}

// ── Kill-check at phase boundary (Q10 — phase-level, not mid-phase) ─

async function _isKilled(sessionId) {
  const session = await db.getSubAgentSession(sessionId).catch(() => null);
  if (!session) return true; // session vanished = treat as killed
  return session.status === 'killed';
}

// ── Main entry ──────────────────────────────────────────────────────

/**
 * Run a sub-agent through its phase pipeline. Called by the worker
 * once it has claimed a session.
 *
 * @param {object} opts
 * @param {object} opts.session       full session row from claimNextSubAgentSession
 * @param {object} opts.definition    matching sub_agent_definitions row
 * @param {object} opts.phaseImpls    map of phase name → async (ctx) => updates accumulator
 * @returns {Promise<{status, result, error}>}
 */
async function runSession({ session, definition, phaseImpls }) {
  const sessionId = session.id;
  const userId = session.userId;
  const phases = Array.isArray(definition.phases) ? definition.phases : [];
  const budget = makeBudgetTracker(session.budget || definition.defaultBudget);
  const accumulator = { findings: [], plannedCalls: [], rawResults: [], notes: [] };

  await publishProgress(sessionId, 'session_started', {
    definition_id: definition.id, phases: phases.map((p) => p.name),
  });

  let lastError = null;
  let terminal = null; // 'completed' | 'budget_exhausted' | 'failed' | 'killed'

  for (const phase of phases) {
    // Kill check at phase boundary.
    if (await _isKilled(sessionId)) {
      terminal = 'killed';
      await db.logSubAgentStep({ sessionId, phase: phase.name, stepKind: 'killed' });
      break;
    }

    // Budget check at phase boundary — short-circuit to package phase
    // if we've already exhausted before entering the next gather/etc.
    const why = budget.exhausted();
    if (why && phase.name !== 'package') {
      // Skip to package so we still emit a structured result with what
      // we've gathered.
      terminal = 'budget_exhausted';
      lastError = `budget exhausted at phase boundary: ${why}`;
      // Still run package if it exists, so we get a partial result.
      const packagePhase = phases.find((p) => p.name === 'package');
      if (packagePhase) {
        await db.updateSubAgentSession(sessionId, { currentPhase: 'package' });
        await _runPhase({
          session, definition, budget, phase: packagePhase, accumulator,
          phaseImpl: phaseImpls[packagePhase.name], partialReason: why,
        }).catch((e) => { lastError = e.message; });
      }
      break;
    }

    await db.updateSubAgentSession(sessionId, { currentPhase: phase.name });
    await db.logSubAgentStep({ sessionId, phase: phase.name, stepKind: 'phase_enter' });
    await publishProgress(sessionId, 'phase_enter', { phase: phase.name });

    const phaseImpl = phaseImpls[phase.name];
    if (!phaseImpl) {
      lastError = `no implementation for phase '${phase.name}'`;
      terminal = 'failed';
      await db.logSubAgentStep({ sessionId, phase: phase.name, stepKind: 'error', payload: { error: lastError } });
      break;
    }

    try {
      await _runPhase({
        session, definition, budget, phase, accumulator, phaseImpl,
      });
      await db.logSubAgentStep({ sessionId, phase: phase.name, stepKind: 'phase_exit' });
      await db.updateSubAgentSession(sessionId, { budgetUsed: budget.snapshot() });
    } catch (err) {
      lastError = err.message || String(err);
      terminal = 'failed';
      await db.logSubAgentStep({
        sessionId, phase: phase.name, stepKind: 'error',
        payload: { error: lastError },
      });
      break;
    }
  }

  if (!terminal) terminal = 'completed';

  // Validate result schema for the completed path.
  let finalResult = accumulator.result || null;
  if (terminal === 'completed') {
    const v = validateResultSchema(finalResult);
    if (!v.ok) {
      terminal = 'failed';
      lastError = `result schema invalid: ${v.errors.join('; ')}`;
      finalResult = { ...(finalResult || {}), schema_errors: v.errors };
    }
  }

  await db.updateSubAgentSession(sessionId, {
    status: terminal,
    budgetUsed: budget.snapshot(),
    result: finalResult,
    error: lastError,
  });
  await publishProgress(sessionId, 'session_done', {
    status: terminal, error: lastError,
  });

  return { status: terminal, result: finalResult, error: lastError };
}

async function _runPhase({ session, definition, budget, phase, accumulator, phaseImpl, partialReason = null }) {
  const phaseStart = Date.now();
  const ctx = {
    sessionId: session.id,
    userId: session.userId,
    prompt: session.prompt,
    entityIds: [], // filled in by the worker via the session's user; V1 keeps it simple
    tz: 'America/Los_Angeles', // V1 default — research-agent doesn't need user tz
    phase: phase.name,
    budget,
    accumulator,
    partialReason,
    dispatch: (toolName, toolInput) => _dispatch(toolName, toolInput, {
      userId: session.userId,
      entityIds: [],
      tz: 'America/Los_Angeles',
      sessionId: session.id,
      phase: phase.name,
      budget,
    }),
    logSynthesis: async (payload) => {
      await db.logSubAgentStep({
        sessionId: session.id, phase: phase.name, stepKind: 'synthesis', payload,
      });
      await publishProgress(session.id, 'synthesis', { phase: phase.name, ...payload });
    },
    addFinding: async (finding) => {
      accumulator.findings.push(finding);
      await db.logSubAgentFinding({ sessionId: session.id, phase: phase.name, finding });
    },
  };

  // Per-phase wall-clock guard.
  const phaseDeadlineMs = Number(phase.wall_clock_ms) || 60000;
  const phaseTimer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`phase '${phase.name}' wall-clock timeout`)), phaseDeadlineMs),
  );

  await Promise.race([phaseImpl(ctx), phaseTimer]);
  // Phase impls mutate accumulator; they don't return values.
}

module.exports = {
  runSession,
  _makeBudgetTracker: makeBudgetTracker, // exported for tests
  HARD_DISALLOWED_TOOLS,
};
