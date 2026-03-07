import { detectIntent }          from './intentDetector.js';
import { selectContext }         from './contextSelector.js';
import { applyBudget }           from './tokenBudget.js';
import { buildContextPayload }   from './contextBuilder.js';

export function buildContext({ message, tasks, entities, financials, notes, calendarEvents }) {
  const intent   = detectIntent(message);
  const raw      = selectContext({ intent, tasks, entities, financials, notes, calendarEvents });
  const budgeted = applyBudget(raw);
  return buildContextPayload(budgeted, intent);
}
