export function getTodayLocal(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function conditionDescription(condition) {
  switch (condition.type) {
    case 'overdue':        return 'Tasks past their due date';
    case 'due-in-hours':   return `Tasks due within ${condition.hours || 24} hours`;
    case 'high-priority':  return 'All incomplete high-priority tasks';
    case 'tag-match':      return `All active "${condition.tag}" tasks`;
    case 'tag-overdue':    return `Overdue "${condition.tag}" tasks`;
    case 'daily-digest':   return 'All active tasks (session summary)';
    case 'morning-brief':  return `Morning brief at ${condition.time || '08:00'}`;
    case 'event-reminder': return `${condition.minutesBefore || 15} min before event`;
    case 'critical-mail':  return 'VIP sender or trigger keyword match';
    default:               return 'Unknown condition';
  }
}

// Returns 'per-task' | 'daily' | 'session'
export function getRuleScope(type) {
  if (type === 'daily-digest')   return 'session';
  if (type === 'high-priority')  return 'daily';
  if (type === 'tag-match')      return 'daily';
  if (type === 'morning-brief')  return 'daily';
  if (type === 'critical-mail')  return 'per-task';
  if (type === 'event-reminder') return 'per-task';
  return 'per-task'; // overdue, due-in-hours, tag-overdue
}

// Build grouped entity list for dropdowns: Business (+ children) > Personal
export function buildGroupedEntities(entities) {
  const businesses = entities.filter((e) => e.type === 'business' || (!e.type && e.type !== 'personal' && e.type !== 'project'));
  const projects = entities.filter((e) => e.type === 'project');
  const personals = entities.filter((e) => e.type === 'personal');
  const result = [];
  businesses.forEach((b) => {
    result.push({ ...b, _indent: 0, _group: 'business' });
    projects.filter((p) => p.parentId === b.id).forEach((p) => result.push({ ...p, _indent: 1, _group: 'business' }));
  });
  projects.filter((p) => !p.parentId || !businesses.find((b) => b.id === p.parentId)).forEach((p) => result.push({ ...p, _indent: 0, _group: 'business' }));
  personals.forEach((p) => result.push({ ...p, _indent: 0, _group: 'personal' }));
  return result;
}
