/**
 * Select relevant context slices based on detected intent.
 *
 * @param {string} intent - One of FINANCIAL | TASK | CALENDAR | FAMILY | HEALTH | JOURNAL | ENTITY | GENERAL
 * @param {Object} appData - { transactions[], tasks[], notes[], events[], entities[] }
 * @returns {Object} Trimmed slices: { transactions[], tasks[], notes[], events[], entities[] }
 */
export function selectContext(intent, appData) {
  const {
    transactions = [],
    tasks = [],
    notes = [],
    events = [],
    entities = [],
  } = appData;

  const openTasks = tasks.filter(t => !t.completed);
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  const tasksDueWithin7 = openTasks.filter(t => {
    if (!t.dueDate) return false;
    const due = new Date(t.dueDate);
    return due >= now && due <= in7Days;
  });

  const nextEvents = (count, cutoff) => {
    const upcoming = events
      .filter(e => new Date(e.start || e.date) >= now && (!cutoff || new Date(e.start || e.date) <= cutoff))
      .sort((a, b) => new Date(a.start || a.date) - new Date(b.start || b.date));
    return count ? upcoming.slice(0, count) : upcoming;
  };

  const taggedTasks = (tag, limit) => {
    const matched = openTasks.filter(t =>
      (t.tags && t.tags.some(tg => tg.toLowerCase().includes(tag))) ||
      (t.tag && t.tag.toLowerCase().includes(tag))
    );
    return limit ? matched.slice(0, limit) : matched;
  };

  const taggedNotes = (tag, limit) => {
    const matched = notes.filter(n =>
      (n.tags && n.tags.some(tg => tg.toLowerCase().includes(tag))) ||
      (n.tag && n.tag.toLowerCase().includes(tag))
    );
    return limit ? matched.slice(-limit) : matched;
  };

  const lizTasks = openTasks.filter(t =>
    t.assignee === 'liz' || t.assignee === 'wife' || t.owner === 'wife' || t.owner === 'shared'
  );

  switch (intent) {
    case 'FINANCIAL':
      return {
        transactions: transactions.slice(-30),
        tasks: taggedTasks('finance', 5),
        notes: notes.slice(-3),
        events: [],
        entities: [],
      };

    case 'TASK':
      return {
        transactions: [],
        tasks: openTasks,
        notes: notes.slice(-5),
        events: nextEvents(3),
        entities: [],
      };

    case 'CALENDAR':
      return {
        transactions: [],
        tasks: tasksDueWithin7,
        notes: [],
        events: nextEvents(14, in14Days),
        entities: [],
      };

    case 'FAMILY':
      return {
        transactions: transactions.slice(-5),
        tasks: lizTasks,
        notes: taggedNotes('family', 5),
        events: nextEvents(7),
        entities: [],
      };

    case 'HEALTH':
      return {
        transactions: [],
        tasks: taggedTasks('health', 5),
        notes: taggedNotes('health', 5),
        events: [],
        entities: [],
      };

    case 'JOURNAL':
      return {
        transactions: [],
        tasks: openTasks.slice(-3),
        notes: notes.slice(-5),
        events: [],
        entities: [],
      };

    case 'ENTITY':
      return {
        transactions: [],
        tasks: [],
        notes: [],
        events: [],
        entities: entities,
      };

    case 'GENERAL':
    default:
      return {
        transactions: transactions.slice(-10),
        tasks: openTasks.slice(0, 10),
        notes: notes.slice(-5),
        events: nextEvents(3),
        entities: [],
      };
  }
}
