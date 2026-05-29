'use strict';

/**
 * server/lib/agenticLoop.cjs — Aria's multi-turn tool-use execution loop.
 *
 * Implements the Anthropic Messages API tool_use contract. Unchanged
 * core mechanism: call → tool_use? → execute → feed result → loop until
 * end_turn or MAX_ITERATIONS.
 *
 * Extensions added (optional, backward-compatible):
 *   - parses <decision>{...}</decision> blocks emitted by the model and
 *     passes them to the gate hook with each tool_use
 *   - optional `gateToolExecution({ tool, input, decision })` hook that
 *     can block execution (e.g. to request user confirmation) and
 *     substitute the tool_result content
 *   - optional `logAction(event)` hook for agent_actions audit logging
 *
 * Callers that don't pass these hooks get the original behavior.
 */

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const logger = require('../../guardrails/logger.cjs');
const { getToolByName } = require('../tools.cjs');
const { trackedAnthropicCall } = require('./anthropicCall.cjs');
const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const MAX_ITERATIONS = 5;
// Stagnation guard — when the model retries the SAME (tool, input) twice
// in a row, force it to stop tool-calling and respond in plain text on
// the next turn. Catches the "locate the file" hang where the LLM
// hallucinates a non-existent tool and keeps re-trying it.
const REPEAT_FAILURE_LIMIT = 2;
function _toolFingerprint(toolName, toolInput) {
  return `${toolName}:${crypto.createHash('sha1').update(JSON.stringify(toolInput || {})).digest('hex').slice(0, 12)}`;
}

/** Centralised logAction wrapper that surfaces failures instead of swallowing
 *  them — Phase 4 trust scoring + decision_log analytics depend on these
 *  audit rows being durable. Returns void; never throws. */
async function _safeLogAction(logAction, event) {
  if (!logAction) return;
  try { await logAction(event); }
  catch (err) {
    logger.error('agenticLoop.logAction.failed', {
      eventType: event?.eventType, toolName: event?.toolName || null, error: err.message,
    });
  }
}

/** Extract the most recent <decision>{...}</decision> JSON object from text blocks. */
function parseDecision(textBlocks) {
  for (let i = textBlocks.length - 1; i >= 0; i--) {
    const t = textBlocks[i]?.text || '';
    const m = t.match(/<decision>\s*([\s\S]*?)\s*<\/decision>/i);
    if (m) {
      try { return JSON.parse(m[1]); } catch { return { _raw: m[1], _parseError: true }; }
    }
  }
  return null;
}

async function runAgenticLoop({ messages, system, tools, userId, executeTool, onProgress, model, gateToolExecution, logAction, channel }) {
  // M1a (2026-05-26) — `channel` (one of the source_channel enum values,
  // typically 'web_chat' or 'whatsapp') threaded through so tools can
  // attribute writes to the originating surface (memory_facts.source_channel).
  // Routes pass this in: ai.cjs → 'web_chat', whatsapp.cjs → 'whatsapp'.
  // Undefined is acceptable (callers haven't migrated); the strict enum
  // helper treats undefined as "no channel context".
  let currentMessages = [...messages];
  const toolSummaries = [];
  let iterations = 0;
  // Tracks consecutive failures of the same (tool, input) so we can break
  // out of a tool-hallucination loop instead of burning all iterations.
  const failureFingerprintCounts = new Map();

  // Prompt-caching prep (2026-05-29). System is accepted as either a
  // string (legacy callers) or an array of content blocks (callers that
  // want to mark a cache breakpoint). Tools array gets a cache_control
  // marker on its last element — caches the full ~5–10k-token tool
  // schema array across all turns. Both cache markers default to
  // ephemeral (5 min TTL) which matches conversational pacing.
  const systemParam = Array.isArray(system)
    ? system
    : (typeof system === 'string' ? system : '');
  const cachedTools = Array.isArray(tools) && tools.length > 0
    ? tools.map((t, i) =>
        i === tools.length - 1
          ? { ...t, cache_control: { type: 'ephemeral' } }
          : t)
    : (tools ?? []);

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await Promise.race([
      trackedAnthropicCall(client, {
        model: model || 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: systemParam,
        tools: cachedTools,
        messages: currentMessages,
      }, { userId, scope: 'agentic_loop' }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Aria is taking too long to respond. Please try again.')), 30_000)
      ),
    ]);

    const textBlocks    = response.content.filter(b => b.type === 'text');
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const decision      = parseDecision(textBlocks);

    currentMessages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
      return {
        text: textBlocks.map(b => b.text).join('\n').replace(/<decision>[\s\S]*?<\/decision>/gi, '').trim(),
        toolSummaries,
        maxIterationsReached: false,
        decision,
      };
    }

    if (decision) {
      await _safeLogAction(logAction, { eventType: 'decision_created', decision });
    }

    // Tool dispatch (2026-05-29). When the model emits multiple tool_use
    // blocks in one iteration, parallel execution cuts the per-iteration
    // wall clock from sum(tool_durations) to max(tool_durations). Common
    // case is read-tool fan-out (list_contacts + search_tasks + web_search
    // in one shot) — each is independent, often 1-3s each, so parallel
    // saves 4-6s on a 3-tool turn.
    //
    // Safety conditions for parallel:
    //   • All tools known (unknowns fail fast individually anyway)
    //   • No tool requires_confirmation (the gate sends user-facing
    //     prompts; parallel would fire multiple prompts at once)
    //   • Single-tool iterations stay serial (no benefit, simpler)
    //
    // The handler is extracted to a closure so both modes share logic.
    const handleToolUse = async (toolUse) => {
      if (onProgress) onProgress({ type: 'tool_start', tool: toolUse.name, input: toolUse.input });

      let resultContent;
      let success = true;

      // ── Short-circuit: tool name not in the registry ─────────────────
      const isKnownTool = !!getToolByName(toolUse.name);
      if (!isKnownTool) {
        const errorPayload = {
          success: false,
          error: `Tool "${toolUse.name}" does not exist. Do not retry. Tell the user in plain text that you can't perform that action and suggest the closest alternative from your available tools.`,
        };
        resultContent = JSON.stringify(errorPayload);
        toolSummaries.push({ tool: toolUse.name, success: false, error: 'unknown_tool' });
        if (onProgress) onProgress({ type: 'tool_error', tool: toolUse.name, error: 'unknown_tool' });
        await _safeLogAction(logAction, { eventType: 'tool_unknown', toolName: toolUse.name, input: toolUse.input, status: 'failure' });
        return { type: 'tool_result', tool_use_id: toolUse.id, content: resultContent, is_error: true };
      }

      // ── Stagnation: same (tool, input) failing repeatedly ────────────
      const fp = _toolFingerprint(toolUse.name, toolUse.input);
      if ((failureFingerprintCounts.get(fp) || 0) >= REPEAT_FAILURE_LIMIT) {
        const errorPayload = {
          success: false,
          error: `You have already tried "${toolUse.name}" with these exact inputs ${REPEAT_FAILURE_LIMIT} times and it failed each time. STOP trying this tool. Respond to the user in plain text — explain what you tried and why you can't proceed.`,
        };
        resultContent = JSON.stringify(errorPayload);
        toolSummaries.push({ tool: toolUse.name, success: false, error: 'stagnation' });
        if (onProgress) onProgress({ type: 'tool_error', tool: toolUse.name, error: 'stagnation' });
        return { type: 'tool_result', tool_use_id: toolUse.id, content: resultContent, is_error: true };
      }

      // Gate: optional pre-execution hook that can short-circuit with its own result.
      let gateDecision = null;
      if (gateToolExecution) {
        try {
          gateDecision = await gateToolExecution({ tool: toolUse.name, input: toolUse.input, decision, toolUseId: toolUse.id });
        } catch (err) {
          gateDecision = { action: 'deny', reason: err.message };
        }
      }

      if (gateDecision?.action === 'deny') {
        resultContent = gateDecision.message || `User cancelled ${toolUse.name}.`;
        toolSummaries.push({ tool: toolUse.name, success: false, cancelled: true, reason: gateDecision.reason || 'cancelled' });
        if (onProgress) onProgress({ type: 'tool_error', tool: toolUse.name, error: resultContent });
        await _safeLogAction(logAction, { eventType: 'tool_cancelled', toolName: toolUse.name, input: toolUse.input, reason: gateDecision.reason });
        return { type: 'tool_result', tool_use_id: toolUse.id, content: resultContent };
      }

      const effectiveInput = (gateDecision?.overrides && Object.keys(gateDecision.overrides).length)
        ? { ...toolUse.input, ...gateDecision.overrides }
        : toolUse.input;

      if (gateDecision?.alreadyExecuted) {
        const real = gateDecision.result;
        const payload = real && typeof real === 'object'
          ? { ...real, already_executed: true }
          : { success: true, already_executed: true, tool: toolUse.name };
        resultContent = JSON.stringify(payload);
        const ok = payload.success !== false;
        toolSummaries.push({ tool: toolUse.name, success: ok, result: payload });
        if (onProgress) onProgress({ type: 'tool_complete', tool: toolUse.name, result: payload });
        await _safeLogAction(logAction, { eventType: 'tool_executed_elsewhere', toolName: toolUse.name, input: effectiveInput, output: payload, status: ok ? 'success' : 'failure' });
        return { type: 'tool_result', tool_use_id: toolUse.id, content: resultContent };
      }

      try {
        const result = await executeTool(toolUse.name, effectiveInput, userId);
        resultContent = typeof result === 'string' ? result : JSON.stringify(result);
        if (result?.success === false) success = false;
        toolSummaries.push({ tool: toolUse.name, success: result?.success !== false, result });
        if (onProgress) onProgress({ type: 'tool_complete', tool: toolUse.name, result });
        await _safeLogAction(logAction, { eventType: 'tool_executed', toolName: toolUse.name, input: effectiveInput, output: result, status: result?.success === false ? 'failure' : 'success' });
        if (result?.success === false) {
          const fp2 = _toolFingerprint(toolUse.name, effectiveInput);
          failureFingerprintCounts.set(fp2, (failureFingerprintCounts.get(fp2) || 0) + 1);
        }
      } catch (err) {
        success = false;
        resultContent = `Error executing ${toolUse.name}: ${err.message}`;
        toolSummaries.push({ tool: toolUse.name, success: false, error: err.message });
        if (onProgress) onProgress({ type: 'tool_error', tool: toolUse.name, error: err.message });
        await _safeLogAction(logAction, { eventType: 'tool_failed', toolName: toolUse.name, input: toolUse.input, errorMsg: err.message, status: 'failure' });
        const fp2 = _toolFingerprint(toolUse.name, effectiveInput);
        failureFingerprintCounts.set(fp2, (failureFingerprintCounts.get(fp2) || 0) + 1);
      }

      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: resultContent,
        ...(success ? {} : { is_error: true }),
      };
    };

    const anyConfirmable = toolUseBlocks.some((t) => getToolByName(t.name)?.requires_confirmation);
    const canParallelize = toolUseBlocks.length > 1 && !anyConfirmable;
    const toolResults = canParallelize
      ? await Promise.all(toolUseBlocks.map(handleToolUse))
      : await (async () => {
          const out = [];
          for (const t of toolUseBlocks) out.push(await handleToolUse(t));
          return out;
        })();

    currentMessages.push({ role: 'user', content: toolResults });
  }

  // Max iterations reached. The text used to be a flat list of
  // tool successes/failures — fine when tools mostly worked, but for
  // the unknown-tool-loop case (now rare thanks to short-circuit
  // above) it read like a system error. Surface a more conversational
  // message that matches what Aria would say if she knew she'd run
  // out of steps.
  const successes = toolSummaries.filter((s) => s.success);
  const failures  = toolSummaries.filter((s) => !s.success);
  const text = (() => {
    if (successes.length && !failures.length) {
      return `I got partway through that — finished ${successes.length} step${successes.length === 1 ? '' : 's'} but hit my limit before wrapping up. Want me to keep going?`;
    }
    if (failures.length && !successes.length) {
      return `I tried a few approaches but couldn't get there. Could you give me a bit more detail about what you're after?`;
    }
    return `I made some progress (${successes.length} done, ${failures.length} stuck) but hit my step limit. Tell me what's most important to finish first?`;
  })();
  return {
    text,
    toolSummaries,
    maxIterationsReached: true,
  };
}

module.exports = { runAgenticLoop, parseDecision };
