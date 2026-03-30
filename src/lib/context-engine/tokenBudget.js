// Focused prompt budget — not the full context window
const BUDGETS = {
  'claude-sonnet': 8000,
  'claude-sonnet-4-5': 8000,
  'gpt-4o': 6000,
};

function estimateTokens(obj) {
  return Math.ceil(JSON.stringify(obj).length / 4);
}

// Slim task to only fields the AI needs
function slimTask(t) {
  return {
    title: t.title,
    priority: t.priority,
    dueDate: t.dueDate || null,
    status: t.status,
    tags: t.tags?.slice(0, 3) || [],
  };
}

// Slim note to title + first 200 chars of content
function slimNote(n) {
  return {
    title: n.title || '(untitled)',
    pillar: n.pillar,
    content: (n.content || '').replace(/<[^>]*>/g, '').slice(0, 200),
  };
}

// Slim transaction to essentials
function slimTransaction(t) {
  return {
    amount: t.amount,
    description: t.description,
    date: t.date,
    type: t.type,
  };
}

export function trimToTokenBudget(slices, modelName = 'claude-sonnet') {
  const budget = BUDGETS[modelName] ?? 6000;

  // Slim all objects first
  const trimmed = {
    ...slices,
    tasks: (slices.tasks || []).map(slimTask),
    notes: (slices.notes || []).map(slimNote),
    transactions: (slices.transactions || []).map(slimTransaction),
  };

  let total = estimateTokens(trimmed);
  if (total <= budget) return trimmed;

  // Trim order: notes first, then transactions, then tasks, keep events
  if (total > budget && trimmed.notes?.length) {
    trimmed.notes = trimmed.notes.slice(-3);
    total = estimateTokens(trimmed);
  }
  if (total > budget && trimmed.transactions?.length) {
    trimmed.transactions = trimmed.transactions.slice(-5);
    total = estimateTokens(trimmed);
  }
  if (total > budget && trimmed.tasks?.length) {
    trimmed.tasks = trimmed.tasks.slice(0, 8);
    total = estimateTokens(trimmed);
  }

  return trimmed;
}
