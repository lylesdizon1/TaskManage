// src/lib/context-engine/contextBuilder.js

const DEFAULT_SYSTEM_PROMPT = `You are Aria, the AI core of Dizon.ai — a Life OS for high performers.`;

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
