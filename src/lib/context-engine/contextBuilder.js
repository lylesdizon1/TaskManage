/**
 * src/lib/context-engine/contextBuilder.js — Assembles Aria's context payload
 * from pre-selected data slices.
 *
 * This is the final assembly step in the context engine pipeline:
 *   intentDetector → contextSelector → tokenBudget → **contextBuilder**
 *
 * Takes the filtered, budget-trimmed data slices and combines them with
 * the persona system prompt and detected intent into a single string
 * suitable for the Anthropic API's system parameter.
 *
 * Responsibility:
 *   - Combine persona prompt, date context, intent label, and data slices
 *     into a structured system prompt string
 *
 * Inputs:
 *   - slices: pre-selected data (tasks, transactions, notes, events)
 *     already filtered and trimmed by contextSelector + tokenBudget
 *   - intent: detected user intent string from intentDetector
 *   - personaSystemPrompt: persona-specific system prompt from personaRouter
 *   - userTZ: IANA timezone for date formatting
 *
 * Dependencies:
 *   - None — pure function. Upstream pipeline modules (contextSelector,
 *     tokenBudget, personaRouter) are called by buildContext.js, which
 *     orchestrates the full pipeline and passes results here.
 *
 * @note Data slices are JSON.stringify'd with indentation for readability
 * in the prompt. Structured, labeled JSON improves model comprehension at
 * the cost of some token efficiency — this is an intentional tradeoff.
 *
 * @note Token budget management happens upstream in tokenBudget.js, not
 * here. This function trusts that slices are already within budget and
 * does not perform any truncation or counting.
 *
 * @note The slim helpers pattern: contextSelector produces minimal data
 * objects (e.g. task title + priority + dueDate only, not full DB rows)
 * to keep token usage low. By the time data reaches this function, it
 * is already slim.
 */

/** @type {string} Fallback system prompt if no persona prompt is provided. */
const DEFAULT_SYSTEM_PROMPT = `You are Aria, the AI core of Dizon.ai — a Life OS for high performers.`;

/**
 * Assemble the final context payload string from data slices.
 *
 * Concatenates the persona system prompt, today's date, the detected
 * intent, and each non-empty data slice into a single prompt string.
 *
 * @param {Object} slices - Pre-selected data slices from contextSelector.
 * @param {Array<Object>} [slices.tasks] - Filtered task objects.
 * @param {Array<Object>} [slices.transactions] - Filtered financial transactions.
 * @param {Array<Object>} [slices.notes] - Filtered note objects.
 * @param {Array<Object>} [slices.events] - Filtered calendar events.
 * @param {string} intent - Detected user intent (e.g. 'task_management', 'scheduling').
 * @param {string|null} personaSystemPrompt - Persona-specific system prompt, or null for default.
 * @param {string} [userTZ] - IANA timezone string for date formatting.
 * @returns {string} Assembled system prompt string ready for the Anthropic API.
 *
 * Assumes callers pass serializable data and a valid IANA
 * timezone string.
 *
 * @note Only non-empty slices are included in the assembled
 * payload — absent data sections are silently omitted rather
 * than included as empty arrays.
 */
export function buildContextPayload(slices, intent, personaSystemPrompt, userTZ) {
  const parts = [];

  const systemPrompt = personaSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  parts.push(systemPrompt);
  const dateOpts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  if (userTZ) dateOpts.timeZone = userTZ;
  parts.push(`Today is ${new Date().toLocaleDateString('en-US', dateOpts)}.`);
  parts.push(`User intent detected: ${intent}.`);

  if (slices.tasks?.length) {
    parts.push(`\n## Tasks (${slices.tasks.length})\n${JSON.stringify(slices.tasks, null, 2)}`);
  }
  if (slices.transactions?.length) {
    parts.push(`\n## Financial Transactions (${slices.transactions.length})\n${JSON.stringify(slices.transactions, null, 2)}`);
  }
  if (slices.notes?.length) {
    parts.push(`\n## Notes (${slices.notes.length})\n${JSON.stringify(slices.notes, null, 2)}`);
  }
  if (slices.events?.length) {
    parts.push(`\n## Calendar Events (${slices.events.length})\n${JSON.stringify(slices.events, null, 2)}`);
  }

  return parts.join('\n');
}
