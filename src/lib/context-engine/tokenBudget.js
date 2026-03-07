const TOKEN_BUDGETS = {
  'claude-sonnet': 160000,
  'gpt-4o': 80000,
};

const DEFAULT_BUDGET = 80000;
const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from a string or object.
 */
function estimateTokens(data) {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  return Math.ceil(str.length / CHARS_PER_TOKEN);
}

/**
 * Trim context slices to fit within the model's token budget.
 * Trim order: notes → transactions → tasks. Events are kept last.
 *
 * @param {Object} slices - { transactions[], tasks[], notes[], events[], entities[] }
 * @param {string} modelName - e.g. 'claude-sonnet' or 'gpt-4o'
 * @returns {Object} Trimmed slices
 */
export function trimToTokenBudget(slices, modelName) {
  const budget = TOKEN_BUDGETS[modelName] || DEFAULT_BUDGET;
  const trimmed = { ...slices };

  if (estimateTokens(trimmed) <= budget) {
    return trimmed;
  }

  // Trim notes first
  while (trimmed.notes && trimmed.notes.length > 0 && estimateTokens(trimmed) > budget) {
    trimmed.notes = trimmed.notes.slice(1);
  }

  // Trim transactions second
  while (trimmed.transactions && trimmed.transactions.length > 0 && estimateTokens(trimmed) > budget) {
    trimmed.transactions = trimmed.transactions.slice(1);
  }

  // Trim tasks third
  while (trimmed.tasks && trimmed.tasks.length > 0 && estimateTokens(trimmed) > budget) {
    trimmed.tasks = trimmed.tasks.slice(1);
  }

  // Trim entities fourth
  while (trimmed.entities && trimmed.entities.length > 0 && estimateTokens(trimmed) > budget) {
    trimmed.entities = trimmed.entities.slice(1);
  }

  // Events trimmed last
  while (trimmed.events && trimmed.events.length > 0 && estimateTokens(trimmed) > budget) {
    trimmed.events = trimmed.events.slice(1);
  }

  return trimmed;
}
