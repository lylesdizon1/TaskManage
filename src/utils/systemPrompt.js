/**
 * src/utils/systemPrompt.js — Builds Aria's system prompt for web chat.
 *
 * Assembles a single system prompt string containing the user's live
 * context: active tasks, calendar events, entities, and recent notes.
 * This prompt is sent as the "system" parameter to the Anthropic API
 * so Aria has full situational awareness when responding.
 *
 * Responsibility:
 *   - Format tasks, calendar, entities, and notes into a structured
 *     prompt string that fits within the model's context window
 *   - Compute derived data (today's tasks, overdue tasks, week map)
 *     so the model never has to calculate relative dates
 *
 * Inputs:
 *   - tasks: full task array from the frontend store
 *   - entities: user's entity list (businesses, projects, personal)
 *   - notes: user's notes (private, unarchived)
 *   - calendarEvents: GCal events for the next 7 days
 *   - userTZ: IANA timezone string
 *
 * Dependencies:
 *   - None — pure function, no imports. Uses only Intl.DateTimeFormat
 *     for timezone-aware formatting.
 *
 * @note This is the frontend system prompt builder used by the legacy
 * ChatPanel. The server-side chat routes (ai.cjs, whatsapp.cjs) build
 * their own system prompts independently — they share the same structure
 * but include additional server-only context (agent memory, profile data).
 *
 * @note This prompt is assembled from client-side state and is
 * therefore convenience context, not a security boundary or
 * source of truth. Server-side routes build their own prompts
 * independently.
 *
 * @note userTZ should always be passed explicitly. The fallback
 * to America/Los_Angeles exists only as a defensive compatibility
 * path for legacy callers and should not be relied upon.
 *
 * @note Token budget is managed implicitly: tasks are sent as slim JSON
 * (title/priority/tags/dueDate only), notes are capped at 50 entries
 * with content truncated to 200 chars, and calendar events are limited
 * to the next 7 days. These limits keep the prompt under ~4K tokens
 * for typical usage without explicit counting.
 *
 * @note Context included: active tasks (all), overdue tasks, today's
 * tasks, completed-today tasks, entities with hierarchy, recent notes
 * (50, newest first, content truncated), calendar events (7 days).
 * Context excluded: completed tasks (except today's), archived notes,
 * financial data, inbox items, agent memory (server-only).
 */

/**
 * Build the full system prompt string for Aria's web chat.
 *
 * @param {Array<Object>} tasks - All tasks (active + completed).
 * @param {Array<Object>} entities - User's entities with type and hierarchy.
 * @param {Array<Object>} notes - User's notes (unarchived preferred).
 * @param {Array<Object>} calendarEvents - GCal events with start/summary.
 * @param {string} [userTZ='America/Los_Angeles'] - IANA timezone string.
 * @returns {string} Assembled system prompt ready for the Anthropic API.
 *
 * Assumes callers pass serializable data and a valid IANA
 * timezone string.
 */
export default function buildSystemPrompt(tasks, entities, notes, calendarEvents, userTZ) {
  const today = new Date();
  if (!userTZ) userTZ = 'America/Los_Angeles';
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: userTZ,
  });
  const timeStr = today.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: userTZ,
  });
  // Compute todayISO in PST so date boundaries are correct
  const pstParts = new Intl.DateTimeFormat('en-CA', { timeZone: userTZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(today);
  const todayISO = pstParts;
  // Build explicit weekday→date map so the model never has to compute relative dates
  const weekMap = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dayAbbr = new Intl.DateTimeFormat('en-US', { timeZone: userTZ, weekday: 'short' }).format(d);
    const monthDay = new Intl.DateTimeFormat('en-US', { timeZone: userTZ, month: 'short', day: 'numeric' }).format(d);
    weekMap.push(`${dayAbbr}=${monthDay}`);
  }
  const weekMapStr = `This week: ${weekMap.join(', ')}.`;
  const activeTasks = tasks.filter((t) => !t.completed);
  const taskSummary = activeTasks.map((t) => ({ title: t.title, priority: t.priority, tags: t.tags, dueDate: t.dueDate || null, dueTime: t.dueTime || null }));
  const todayTasks = activeTasks.filter((t) => t.dueDate && t.dueDate.startsWith(todayISO));
  const overdueTasks = activeTasks.filter((t) => t.dueDate && t.dueDate < todayISO);
  const completedToday = tasks.filter((t) => t.completed && t.dueDate && t.dueDate.startsWith(todayISO));
  const allEntities = entities || [];
  const businesses = allEntities.filter((e) => e.type === 'business' || (!e.type && e.type !== 'personal' && e.type !== 'project'));
  const projects = allEntities.filter((e) => e.type === 'project');
  const personals = allEntities.filter((e) => e.type === 'personal');
  const sharedEnts = allEntities.filter((e) => e.shared);
  let entityContext = '\n\nENTITIES & STRUCTURE:';
  if (businesses.length > 0) entityContext += `\nBusinesses: ${businesses.map((e) => e.name).join(', ')}`;
  if (projects.length > 0) {
    entityContext += '\nProjects:';
    businesses.forEach((b) => { const ch = projects.filter((p) => p.parentId === b.id); if (ch.length > 0) entityContext += `\n  ${b.name} \u2192 ${ch.map((p) => p.name).join(', ')}`; });
    const orphans = projects.filter((p) => !p.parentId || !businesses.find((b) => b.id === p.parentId));
    if (orphans.length > 0) entityContext += `\n  (unassigned) \u2192 ${orphans.map((p) => p.name).join(', ')}`;
  }
  if (personals.length > 0) entityContext += `\nPersonal: ${personals.map((e) => e.name).join(', ')}`;
  if (sharedEnts.length > 0) entityContext += `\nShared (household): ${sharedEnts.map((e) => e.name).join(', ')}`;
  let notesContext = '';
  if (notes && notes.length > 0) {
    const recentNotes = notes
      .filter((n) => !n.archived && n.content)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 50)
      .map((n) => `[${n.createdAt || ''}] [${n.pillar || 'untagged'}/${n.category || 'uncategorized'}] Title: ${n.title || 'Untitled'}\n${(n.content || '').slice(0, 200)}`);
    if (recentNotes.length > 0) {
      notesContext = `\n\nRECENT NOTES (last ${recentNotes.length}, newest first):\n${recentNotes.join('\n---\n')}`;
    }
  }
  let todayContext = '';
  function formatTaskTime(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  if (todayTasks.length > 0) todayContext += `\nTasks due today: ${todayTasks.map((t) => { const time = formatTaskTime(t.dueTime); return time ? `${time} - ${t.title} (${t.priority || 'medium'})` : t.title; }).join(', ')}`;
  if (overdueTasks.length > 0) todayContext += `\nOverdue tasks: ${overdueTasks.map((t) => { const time = formatTaskTime(t.dueTime); return `${time ? time + ' - ' : ''}${t.title} (due ${t.dueDate})`; }).join(', ')}`;
  if (completedToday.length > 0) todayContext += `\nCompleted today: ${completedToday.map((t) => `${t.title} ✓`).join(', ')}`;
  // Calendar events for the next 7 days
  // Parse event start date, handling all-day events (date-only strings) as local dates
  // to avoid UTC timezone shift (e.g. "2026-03-08" parsed as UTC midnight = Mar 7 in PST)
  function parseEventDate(ev) {
    if (ev.allDay || ev.start?.date) {
      const [y, m, d] = (ev.start?.date || ev.start || '').split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    const dt = ev.start?.dateTime || ev.start;
    if (typeof dt === 'string' && !dt.includes('Z') && !/[+-]\d{2}:\d{2}$/.test(dt) && dt.includes('T')) {
      const [datePart, timePart] = dt.split('T');
      const [y, m, d] = datePart.split('-').map(Number);
      const [h, min, s] = timePart.split(':').map(Number);
      return new Date(y, m - 1, d, h, min, s || 0);
    }
    return new Date(dt);
  }
  const weekOut = new Date(today);
  weekOut.setDate(weekOut.getDate() + 7);
  weekOut.setHours(23, 59, 59, 999);
  const todayStart = new Date(today);
  todayStart.setHours(0, 0, 0, 0);
  const upcomingEvents = (calendarEvents || [])
    .filter((ev) => {
      const startStr = ev.start?.dateTime || ev.start?.date || ev.start;
      if (!startStr) return false;
      const eventDate = parseEventDate(ev);
      return eventDate >= todayStart && eventDate <= weekOut;
    })
    .sort((a, b) => parseEventDate(a) - parseEventDate(b));
  let calendarContext = `\n\nUPCOMING CALENDAR (next 7 days):\n`;
  if (upcomingEvents.length === 0) {
    calendarContext += 'No events this week';
  } else {
    calendarContext += upcomingEvents.map((e) => {
      const d = parseEventDate(e);
      const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: userTZ });
      const time = (e.allDay || e.start?.date) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: userTZ });
      return `- ${dayLabel}: ${time ? time + ' ' : ''}${e.summary || e.title || 'Untitled'}`;
    }).join('\n');
  }
  return `You are a business productivity assistant. Today is ${dateStr}. Current time: ${timeStr} (${userTZ}).\n${weekMapStr}\nThe user manages multiple ventures. Active (incomplete) tasks: ${JSON.stringify(taskSummary)}. Help prioritize and plan.` + todayContext + calendarContext + entityContext + notesContext;
}
