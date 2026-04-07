'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const MAX_ITERATIONS = 5;

async function runAgenticLoop({ messages, system, tools, userId, executeTool, onProgress }) {
  let currentMessages = [...messages];
  const toolSummaries = [];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system,
      tools: tools ?? [],
      messages: currentMessages,
    });

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
