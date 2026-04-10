'use strict';

/**
 * server/lib/agenticLoop.cjs — Aria's multi-turn tool-use execution loop.
 *
 * Implements the agentic pattern for the Anthropic Messages API: send a
 * prompt, check if the model wants to use a tool, execute it, feed the
 * result back, and repeat until the model emits a final text response
 * or the safety cap is reached.
 *
 * Inputs:
 *   - messages: conversation history (user/assistant turns)
 *   - system: Aria system prompt (built by context engine)
 *   - tools: ARIA_TOOLS schema array (from server/tools.cjs)
 *   - executeTool: bound tool executor scoped to the authenticated user
 *   - onProgress: optional callback for real-time progress events
 *
 * Dependencies:
 *   - @anthropic-ai/sdk for the Messages API
 *   - server/tools.cjs for tool definitions and execution (injected)
 *
 * Boundaries:
 *   - This module does NOT handle authentication, streaming, or SSE.
 *     The caller (ai.cjs for SSE chat, whatsapp.cjs for WhatsApp) is
 *     responsible for transport. This module only runs the loop and
 *     returns a structured result.
 *   - Tool execution is injected via executeTool — this module never
 *     imports db.cjs or tools.cjs directly.
 *
 * @note The onProgress callback serves different purposes depending on
 * the caller. In the SSE chat route (ai.cjs), it pushes Server-Sent
 * Events to the browser for live tool status updates. In the WhatsApp
 * route, it is typically null — WhatsApp replies are sent after the
 * loop completes, not during.
 *
 * @note MAX_ITERATIONS is a hard safety cap to prevent runaway loops.
 * Without it, a model that repeatedly calls tools without ever emitting
 * a final text response would loop indefinitely and burn API credits.
 * 5 iterations allows multi-step workflows (e.g. create task → create
 * event → summarise) while catching infinite loops.
 */

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

/** Hard cap on tool-use iterations to prevent runaway API spend. */
const MAX_ITERATIONS = 5;

/**
 * Run Aria's agentic tool-use loop until the model produces a final
 * text response or the iteration cap is reached.
 *
 * Each iteration: call the Anthropic API → if the response contains
 * tool_use blocks, execute each tool via executeTool(), append results
 * as a user message, and loop. If the response is end_turn with no
 * tool_use blocks, return the text.
 *
 * @param {Object} options
 * @param {Array<Object>} options.messages - Conversation history.
 * @param {string} options.system - System prompt for Aria.
 * @param {Array<Object>} [options.tools] - Tool schemas (ARIA_TOOLS).
 * @param {string} options.userId - Authenticated user ID for scoping tool execution.
 * @param {Function} options.executeTool - Async tool executor injected by the
 *   caller. Signature from this module's perspective: (toolName, toolInput, userId) => result.
 *   The caller is responsible for binding any additional context such as db,
 *   entityIds, and timezone.
 * @param {Function} [options.onProgress] - Optional callback for real-time
 *   progress events. Called with { type: 'tool_start'|'tool_complete'|'tool_error', ... }.
 * @param {string} [options.model='claude-sonnet-4-20250514'] - Anthropic model ID.
 * @returns {Promise<Object>} Result object:
 *   - text {string} — Final assistant response text.
 *   - toolSummaries {Array<Object>} — Log of each tool call and its outcome.
 *   - maxIterationsReached {boolean} — True if the loop hit the safety cap
 *     before the model produced a final response.
 *
 * @note The tool_use loop follows the Anthropic API contract: assistant
 * messages containing tool_use blocks must be followed by a user message
 * with corresponding tool_result blocks (matched by tool_use_id). Breaking
 * this contract causes a 400 error from the API.
 *
 * @note A single model response may contain multiple tool_use blocks.
 * Each is executed in order and summarized for the caller. Tool failures
 * are reported through tool summaries so the caller can surface errors
 * without losing execution context.
 */
async function runAgenticLoop({ messages, system, tools, userId, executeTool, onProgress, model }) {
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

    // Push full assistant message — text + tool_use together (API requirement)
    currentMessages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || toolUseBlocks.length === 0) {
      return {
        text: textBlocks.map(b => b.text).join('\n').trim(),
        toolSummaries,
        maxIterationsReached: false,
      };
    }

    const toolResults = [];

    for (const toolUse of toolUseBlocks) {
      if (onProgress) onProgress({ type: 'tool_start', tool: toolUse.name, input: toolUse.input });

      let resultContent;
      let success = true;

      try {
        const result = await executeTool(toolUse.name, toolUse.input, userId);
        resultContent = typeof result === 'string' ? result : JSON.stringify(result);
        toolSummaries.push({ tool: toolUse.name, success: true, result });
        if (onProgress) onProgress({ type: 'tool_complete', tool: toolUse.name, result });
      } catch (err) {
        success = false;
        resultContent = `Error executing ${toolUse.name}: ${err.message}`;
        toolSummaries.push({ tool: toolUse.name, success: false, error: err.message });
        if (onProgress) onProgress({ type: 'tool_error', tool: toolUse.name, error: err.message });
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
      toolSummaries.map(s => `• ${s.tool}: ${s.success ? 'done' : `failed — ${s.error}`}`).join('\n'),
    toolSummaries,
    maxIterationsReached: true,
  };
}

module.exports = { runAgenticLoop };
