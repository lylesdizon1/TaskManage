export function selectContext(intent, appData) {
  const { transactions = [], tasks = [], notes = [], events = [], entities = [] } = appData;

  // --- Slim helpers: only send what the AI actually needs ---
  const slimTask = (t) => ({
    id: t.id,
    title: t.title,
    completed: t.completed,
    priority: t.priority,
    dueDate: t.dueDate || null,
    tags: t.tags || [],
    assignee: t.assignee || null,
  });

  const slimNote = (n) => ({
    id: n.id,
    title: n.title,
    tags: n.tags || [],
    content: (n.content || '').replace(/<[^>]+>/g, '').slice(0, 200),
    updatedAt: n.updatedAt || null,
  });

  const slimTransaction = (t) => ({
    id: t.id,
    amount: t.amount,
    category: t.category,
    date: t.date,
    description: (t.description || '').slice(0, 80),
  });

  const slimEvent = (e) => ({
    id: e.id,
    title: e.title || e.summary,
    start: e.start,
    end: e.end,
  });

  // --- Derived sets ---
  const openTasks = tasks.filter(t => !t.completed);
  const now = new Date();
  const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const in14days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const upcomingEvents = (days) => events
    .filter(e => new Date(e.start) >= now && new Date(e.start) <= days)
    .slice(0, 20)
    .map(slimEvent);

  switch (intent) {
    case 'FINANCIAL':
      return {
        transactions: transactions.slice(-30).map(slimTransaction),
        tasks: openTasks.filter(t => t.tags?.includes('finance')).slice(0, 5).map(slimTask),
        notes: notes.filter(n => n.tags?.includes('finance')).slice(-3).map(slimNote),
        events: [],
        entities: [],
      };
    case 'TASK':
      return {
        transactions: [],
        tasks: openTasks.slice(0, 20).map(slimTask),
        notes: notes.slice(-5).map(slimNote),
        events: upcomingEvents(in7days).slice(0, 3),
        entities: [],
      };
    case 'CALENDAR':
      return {
        transactions: [],
        tasks: openTasks.filter(t => t.dueDate && new Date(t.dueDate) <= in7days).map(slimTask),
        notes: [],
        events: upcomingEvents(in14days),
        entities: [],
      };
    case 'FAMILY':
      return {
        transactions: transactions.slice(-5).map(slimTransaction),
        tasks: openTasks.filter(t => t.assignee?.includes('liz') || t.tags?.includes('family')).map(slimTask),
        notes: notes.filter(n => n.tags?.includes('family')).slice(-5).map(slimNote),
        events: upcomingEvents(in7days),
        entities: [],
      };
    case 'HEALTH':
      return {
        transactions: [],
        tasks: openTasks.filter(t => t.tags?.includes('health')).slice(0, 5).map(slimTask),
        notes: notes.filter(n => n.tags?.includes('health')).slice(-5).map(slimNote),
        events: [],
        entities: [],
      };
    case 'JOURNAL':
      return {
        transactions: [],
        tasks: openTasks.slice(0, 3).map(slimTask),
        notes: notes.slice(-5).map(slimNote),
        events: [],
        entities: [],
      };
    case 'ENTITY':
      return {
        transactions: [],
        tasks: [],
        notes: notes.slice(-3).map(slimNote),
        events: [],
        entities: entities.slice(0, 20),
      };
    default:
      return {
        transactions: transactions.slice(-10).map(slimTransaction),
        tasks: openTasks.slice(0, 10).map(slimTask),
        notes: notes.slice(-5).map(slimNote),
        events: upcomingEvents(in7days).slice(0, 3),
        entities: [],
      };
  }
}
