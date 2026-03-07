// src/lib/context-engine/contextBuilder.js

const DEFAULT_SYSTEM_PROMPT = `You are Aria, the AI core of Dizon.ai — a Life OS for high performers.`;

export function buildContextPayload(slices, intent, personaSystemPrompt) {
  const parts = [];

  const systemPrompt = personaSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  parts.push(systemPrompt);
  parts.push(`Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.`);
  parts.push(`User intent detected: ${intent}.`);

  if (slices.tasks?.length) {
    parts.push(`\n## Tasks (${slices.tasks.length})\n${JSON.stringify(slices.tasks, null, 2)}`);
  }
  if (slices.financials?.length) {
    parts.push(`\n## Financial Transactions (${slices.financials.length})\n${JSON.stringify(slices.financials, null, 2)}`);
  }
  if (slices.notes?.length) {
    parts.push(`\n## Notes (${slices.notes.length})\n${JSON.stringify(slices.notes, null, 2)}`);
  }
  if (slices.calendarEvents?.length) {
    parts.push(`\n## Calendar Events (${slices.calendarEvents.length})\n${JSON.stringify(slices.calendarEvents, null, 2)}`);
  }

  return parts.join('\n');
}
