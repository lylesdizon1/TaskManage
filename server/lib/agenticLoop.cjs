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
const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const MAX_ITERATIONS = 5;

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

async function runAgenticLoop({ messages, system, tools, userId, executeTool, onProgress, model, gateToolExecution, logAction }) {
  let currentMessages = [...messages];
  const toolSummaries = [];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await Promise.race([
      client.messages.create({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        system,
        tools: tools ?? [],
        messages: currentMessages,
      }),
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
      try { await logAction?.({ eventType: 'decision_created', decision }); } catch {}
    }

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      if (onProgress) onProgress({ type: 'tool_start', tool: toolUse.name, input: toolUse.input });

      let resultContent;
      let success = true;

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
        try { await logAction?.({ eventType: 'tool_cancelled', toolName: toolUse.name, input: toolUse.input, reason: gateDecision.reason }); } catch {}
        // Cancellation is a terminal but non-error result — without is_error,
        // Aria treats the cancelled tool as complete and produces a normal
        // follow-up acknowledgment instead of retrying.
        toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: resultContent });
        continue;
      }

      // Merge any overrides the confirmation gate attached (e.g. the user
      // picking a different From account on an email draft).
      const effectiveInput = (gateDecision?.overrides && Object.keys(gateDecision.overrides).length)
        ? { ...toolUse.input, ...gateDecision.overrides }
        : toolUse.input;

      try {
        const result = await executeTool(toolUse.name, effectiveInput, userId);
        resultContent = typeof result === 'string' ? result : JSON.stringify(result);
        toolSummaries.push({ tool: toolUse.name, success: true, result });
        if (onProgress) onProgress({ type: 'tool_complete', tool: toolUse.name, result });
        try { await logAction?.({ eventType: 'tool_executed', toolName: toolUse.name, input: effectiveInput, output: result, status: result?.success === false ? 'failure' : 'success' }); } catch {}
      } catch (err) {
        success = false;
        resultContent = `Error executing ${toolUse.name}: ${err.message}`;
        toolSummaries.push({ tool: toolUse.name, success: false, error: err.message });
        if (onProgress) onProgress({ type: 'tool_error', tool: toolUse.name, error: err.message });
        try { await logAction?.({ eventType: 'tool_failed', toolName: toolUse.name, input: toolUse.input, errorMsg: err.message, status: 'failure' }); } catch {}
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: resultContent,
        ...(success ? {} : { is_error: true }),
      });
    }

    currentMessages.push({ role: 'user', content: toolResults });
  }

  return {
    text: `I completed ${toolSummaries.length} action(s) but hit the step limit. Here's what I finished:\n` +
      toolSummaries.map(s => `• ${s.tool}: ${s.success ? 'done' : `failed — ${s.error || s.reason || ''}`}`).join('\n'),
    toolSummaries,
    maxIterationsReached: true,
  };
}

module.exports = { runAgenticLoop, parseDecision };
