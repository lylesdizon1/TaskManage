export function selectContext(intent, appData) {
  const { transactions = [], tasks = [], notes = [], events = [], entities = [] } = appData;

  const openTasks = tasks.filter(t => !t.completed);
  const now = new Date();
  const in7days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const in14days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const upcomingEvents = (days) => events
    .filter(e => new Date(e.start) >= now && new Date(e.start) <= days)
    .slice(0, 20);

  switch (intent) {
    case 'FINANCIAL':
      return {
        transactions: transactions.slice(-30),
        tasks: openTasks.filter(t => t.tags?.includes('finance')).slice(0, 5),
        notes: notes.filter(n => n.tags?.includes('finance')).slice(-3),
        events: [],
        entities: [],
      };
    case 'TASK':
      return {
        transactions: [],
        tasks: openTasks,
        notes: notes.slice(-5),
        events: upcomingEvents(in7days).slice(0, 3),
        entities: [],
      };
    case 'CALENDAR':
      return {
        transactions: [],
        tasks: openTasks.filter(t => t.dueDate && new Date(t.dueDate) <= in7days),
        notes: [],
        events: upcomingEvents(in14days),
        entities: [],
      };
    case 'FAMILY':
      return {
        transactions: transactions.slice(-5),
        tasks: openTasks.filter(t => t.assignee?.includes('liz') || t.tags?.includes('family')),
        notes: notes.filter(n => n.tags?.includes('family')).slice(-5),
        events: upcomingEvents(in7days),
        entities: [],
      };
    case 'HEALTH':
      return {
        transactions: [],
        tasks: openTasks.filter(t => t.tags?.includes('health')).slice(0, 5),
        notes: notes.filter(n => n.tags?.includes('health')).slice(-5),
        events: [],
        entities: [],
      };
    case 'JOURNAL':
      return {
        transactions: [],
        tasks: openTasks.slice(0, 3),
        notes: notes.slice(-5),
        events: [],
        entities: [],
      };
    case 'ENTITY':
      return {
        transactions: [],
        tasks: [],
        notes: notes.slice(-3),
        events: [],
        entities: entities.slice(0, 20),
      };
    default:
      return {
        transactions: transactions.slice(-10),
        tasks: openTasks.slice(0, 10),
        notes: notes.slice(-5),
        events: upcomingEvents(in7days).slice(0, 3),
        entities: [],
      };
  }
}
