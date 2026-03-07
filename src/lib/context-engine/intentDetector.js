const INTENT_KEYWORDS = {
  FINANCIAL: ['transaction', 'spend', 'money', 'cost', 'budget', 'revenue', 'profit', 'invoice', 'expense', 'payment'],
  TASK: ['task', 'todo', 'do', 'complete', 'project', 'deadline', 'priority', 'backlog', 'assign'],
  CALENDAR: ['meeting', 'schedule', 'event', 'calendar', 'appointment', 'today', 'tomorrow', 'week'],
  FAMILY: ['liz', 'kids', 'family', 'home', 'dinner', 'school', 'house'],
  HEALTH: ['workout', 'run', 'gym', 'sleep', 'weight', 'steps', 'health', 'exercise', 'calories'],
  JOURNAL: ['feel', 'think', 'reflect', 'mood', 'journal', 'grateful', 'stress', 'anxiety', 'happy'],
  ENTITY: ['contact', 'person', 'company', 'relationship', 'client', 'partner', 'vendor'],
};

/**
 * Detect the user's intent from a chat message.
 * Returns one of: FINANCIAL | TASK | CALENDAR | FAMILY | HEALTH | JOURNAL | ENTITY | GENERAL
 */
export function detectIntent(message) {
  const lower = message.toLowerCase();
  const words = lower.split(/\s+/);

  let bestIntent = 'GENERAL';
  let bestScore = 0;

  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (words.includes(keyword)) {
        score += 2;
      } else if (lower.includes(keyword)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  return bestIntent;
}
