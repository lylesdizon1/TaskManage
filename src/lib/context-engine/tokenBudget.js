const BUDGETS = {
  'claude-sonnet': 160000,
  'claude-sonnet-4-5': 160000,
  'gpt-4o': 80000,
};

function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

export function trimToTokenBudget(slices, modelName = 'claude-sonnet') {
  const budget = BUDGETS[modelName] ?? 80000;
  let total = estimateTokens(slices);

  if (total <= budget) return slices;

  const trimmed = { ...slices };

  // Trim order: notes first, then transactions, then tasks, keep events
  if (total > budget && trimmed.notes?.length) {
    trimmed.notes = trimmed.notes.slice(-3);
    total = estimateTokens(trimmed);
  }
  if (total > budget && trimmed.transactions?.length) {
    trimmed.transactions = trimmed.transactions.slice(-10);
    total = estimateTokens(trimmed);
  }
  if (total > budget && trimmed.tasks?.length) {
    trimmed.tasks = trimmed.tasks.slice(0, 10);
    total = estimateTokens(trimmed);
  }

  return trimmed;
}
