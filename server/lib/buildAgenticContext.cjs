'use strict';

/**
 * server/lib/buildAgenticContext.cjs — single context builder for both
 * the SSE chat route (ai.cjs) and the WhatsApp handler (whatsapp.cjs).
 *
 * Parallel-loads user profile, tasks, private notes, recent agent
 * memories, calendar notes, and Google Calendar events. Returns both
 * the raw data and a pre-assembled system prompt that includes Aria's
 * <decision> contract + live-data context block.
 */

const { getTodayLocal } = require('../utils/date.cjs');
const { rediGet, rediSet } = require('./redis.cjs');

const DECISION_INSTRUCTIONS = `\n\n## Decision contract\nBefore calling any tool, output a decision block wrapped in <decision> tags:\n<decision>\n{\n  "intent": "short label — e.g. create_task, schedule_meeting, send_email",\n  "confidence": 0.0,\n  "risk": "low" | "medium" | "high",\n  "requires_confirmation": false\n}\n</decision>\n\nServer enforces: send_email, reply_email, delete_task, delete_event always require confirmation regardless of what you output.\n\nIMPORTANT: Before calling send_email, verify the 'to' field contains a complete, valid email address with @ and a domain (e.g. name@domain.com). If the user provides only a name, nickname, or partial address, ask for the full email address in one short question before proceeding. Never call send_email with an incomplete address.\n\nYou have full access to the user's projects, tasks, checklist items, and notes within their entities. This data is provided to you in the ACTIVE PROJECTS context block above. When asked about projects, summarize from that context. Never say you don't have access to projects.

You have access to the user's contacts and relationship memory in the PEOPLE & RELATIONSHIPS block above. When asked about a person by name, use this context. When asked "who is X", "prep me for my meeting with X", or "what do I know about X", use contact facts and notes to answer. When the SHARED ACCESS block shows granted access, you can reference data from connected users when relevant. Never say you don't have access to contact or relationship information.

For project creation: when the user asks to "create a project", "set up a project", "make a project", etc., a separate intent classifier renders an inline draft tile in the Command Center for them to confirm — you do not need to call a tool. Just acknowledge the request. If the user has not specified an entity and there is no obvious match in their entity list, ask one short clarifying question: "Which entity should this project belong to?". Never invent an entity.`;

// Cross-surface GCal cache — now Redis-backed for durability across
// multi-instance deploys and server restarts. Falls back to no-cache
// behavior when REDIS_URL is unset (see server/lib/redis.cjs).
const CALENDAR_CACHE_TTL_SEC = 5 * 60; // 5 minutes

/**
 * Return a Date corresponding to the start of the user's local day
 * (00:00 in `tz`) plus an optional offset in days. The returned Date
 * is the exact UTC instant — safe to pass to Postgres TIMESTAMPTZ
 * comparisons regardless of the server's local timezone.
 *
 * Uses the noon-UTC trick (same approach as the fetchCalendarWindow
 * window math) to stay DST-safe.
 */
function localMidnightUtc(tz, offsetDays = 0) {
  const userTz = tz || 'America/Los_Angeles';
  const todayLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: userTz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const noonUtc = new Date(`${todayLocal}T12:00:00Z`);
  const noonLocal = new Date(noonUtc.toLocaleString('en-US', { timeZone: userTz }));
  const offsetMs = noonUtc.getTime() - noonLocal.getTime();
  return new Date(noonUtc.getTime() - 12 * 3600000 + offsetMs + offsetDays * 86400000);
}

/**
 * Fetch upcoming GCal events for the given window, spanning all connected
 * accounts. Returns an array sorted by start time. Results are cached for
 * 5 minutes per (userId, tz, days).
 *
 * @param {number} [opts.days=7]  Window length in days starting at local
 *                                midnight today. Pass 1 for today-only.
 */
async function fetchCalendarWindow({ userId, tz, days, loadAllGcalAccounts, loadGcalTokens, saveGcalTokens, makeOAuth2Client, google, logger, requestId }) {
  const userTz = tz || 'America/Los_Angeles';
  const windowDays = Number.isFinite(days) && days > 0 ? days : 7;

  const cacheKey = `gcal:${userId}:${userTz}:${windowDays}`;
  const cached = await rediGet(cacheKey);
  if (cached) return cached;

  try {
    let allAccounts = [];
    if (loadAllGcalAccounts) {
      allAccounts = await loadAllGcalAccounts(userId);
    } else if (loadGcalTokens) {
      const tokens = await loadGcalTokens(userId);
      if (tokens) allAccounts = [{ googleEmail: null, tokens }];
    }
    if (!allAccounts.length || !makeOAuth2Client || !google) return [];

    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: userTz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const noonUtc = new Date(`${todayLocal}T12:00:00Z`);
    const noonLocal = new Date(noonUtc.toLocaleString('en-US', { timeZone: userTz }));
    const offsetMs = noonUtc.getTime() - noonLocal.getTime();
    const timeMin = new Date(noonUtc.getTime() - 12 * 3600000 + offsetMs).toISOString();
    const timeMax = new Date(noonUtc.getTime() - 12 * 3600000 + offsetMs + windowDays * 86400000).toISOString();

    const results = await Promise.allSettled(allAccounts.map(async (acct) => {
      const oauth2 = makeOAuth2Client();
      if (!oauth2) return [];
      oauth2.setCredentials(acct.tokens);
      if (saveGcalTokens && loadGcalTokens && acct.googleEmail) {
        oauth2.on('tokens', async (newTokens) => {
          try {
            const existing = await loadGcalTokens(userId, acct.googleEmail);
            await saveGcalTokens(userId, { ...existing, ...newTokens }, acct.googleEmail);
          } catch (e) { logger?.error?.('context.tokenRefresh.failed', { userId, googleEmail: acct.googleEmail, error: e.message }); }
        });
      }
      const calendar = google.calendar({ version: 'v3', auth: oauth2 });
      const { data } = await calendar.events.list({
        calendarId: 'primary', timeMin, timeMax, timeZone: userTz,
        singleEvents: true, orderBy: 'startTime', maxResults: 20,
      });
      return (data.items || []).map(ev => ({
        title: (ev.summary || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
        start: ev.start?.dateTime || ev.start?.date || '',
        end:   ev.end?.dateTime   || ev.end?.date   || '',
      }));
    }));

    const allEvents = [];
    const seen = new Set();
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const ev of r.value) {
          const key = `${ev.title}::${ev.start}`;
          if (!seen.has(key)) { seen.add(key); allEvents.push(ev); }
        }
      }
    }
    const sorted = allEvents.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    await rediSet(cacheKey, sorted, CALENDAR_CACHE_TTL_SEC);
    return sorted;
  } catch (err) {
    logger?.error?.('context.calendarFetch.failed', { requestId, userId, error: err.message });
    return [];
  }
}

/**
 * Build Aria's context for either surface.
 *
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {string[]} [opts.entityIds]
 * @param {Object} opts.db
 * @param {string} [opts.tz]
 * @param {Function} [opts.loadAllGcalAccounts] - multi-account loader (web)
 * @param {Function} [opts.loadGcalTokens] - single-account loader (fallback)
 * @param {Function} [opts.saveGcalTokens]
 * @param {Function} [opts.makeOAuth2Client]
 * @param {Object} [opts.google] - googleapis module
 * @param {Object} [opts.logger]
 * @param {string} [opts.requestId]
 * @returns {Promise<{ user, tasks, activeTasks, recentCompleted, notes, recentMemories, calendarNotes, calendarEvents, tz, todayStr, todayDate, currentTime, weekMapStr, profileContext, contextBlock, decisionInstructions, systemPrompt }>}
 */
async function buildAgenticContext(opts) {
  const { userId, db, contextHint } = opts;
  const tz = opts.tz || 'America/Los_Angeles';

  // Inbox mode pulls a wider net so Aria can answer open-ended
  // questions about the user's mail.
  const inboxMode = contextHint === 'inbox';
  const emailContextMinRank   = inboxMode ? 1  : 3;
  const recentClassifiedLimit = inboxMode ? 50 : 20;
  const importantUnreadLimit  = inboxMode ? 20 : 10;

  // Calendar events: read from the synced calendar_events cache first
  // (populated by the 15-min sync cron). Fall back to live fetchCalendarWindow
  // if the cache is empty (e.g. user just connected GCal, sync hasn't run).
  const calendarEventsPromise = (async () => {
    if (db.getCalendarEventsForUser) {
      try {
        const startUtc = localMidnightUtc(tz, 0);
        const endUtc   = localMidnightUtc(tz, 7);
        const cached = await db.getCalendarEventsForUser(userId, startUtc, endUtc);
        if (cached && cached.length > 0) {
          return cached
            .map((ev) => ({
              title: (ev.title || '(No title)').replace(/^\[TaskManage\]\s*/i, ''),
              start: ev.startTime ? new Date(ev.startTime).toISOString() : '',
            }))
            .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
        }
      } catch { /* silent — fall through to live fetch */ }
    }
    return fetchCalendarWindow(opts);
  })();

  const [user, tasks, notes, recentMemories, calendarNotes, calendarEvents, learnings, importantUnread, recentClassified, recentOutcomes, memoryFacts, projectsCtx, contactsData, sharedAccessData] = await Promise.all([
    db.getUserById(userId),
    db.getTasksForUser(userId, []),
    db.getPrivateNotesForAI(userId),
    db.getRecentMemories(userId, 20).catch(() => []),
    db.getCalendarNotesForAI(userId).catch(() => []),
    calendarEventsPromise,
    db.getUserLearnings ? db.getUserLearnings(userId).catch(() => []) : Promise.resolve([]),
    db.getImportantUnread ? db.getImportantUnread(userId, emailContextMinRank).catch(() => []) : Promise.resolve([]),
    db.getRecentClassifications ? db.getRecentClassifications(userId, recentClassifiedLimit).catch(() => []) : Promise.resolve([]),
    db.getRecentOutcomeContext ? db.getRecentOutcomeContext(userId, 5).catch(() => []) : Promise.resolve([]),
    db.getMemoryFactsForUser ? db.getMemoryFactsForUser(userId, 10).catch(() => []) : Promise.resolve([]),
    db.getProjectContextForUser ? db.getProjectContextForUser(userId, 5).catch(() => []) : Promise.resolve([]),
    db.getRelevantContacts ? db.getRelevantContacts(userId, 10).catch(() => []) : Promise.resolve([]),
    db.getSharedAccessSummary ? db.getSharedAccessSummary(userId).catch(() => ({ grantsGiven: 0, grantsReceived: 0, scopes: [] })) : Promise.resolve({ grantsGiven: 0, grantsReceived: 0, scopes: [] }),
  ]);

  const todayStr = getTodayLocal(tz);
  const todayDate = todayStr.split(', ')[1];
  const currentTime = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date());

  const weekMapParts = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const dayAbbr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d);
    const monthDay = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d);
    weekMapParts.push(`${dayAbbr}=${monthDay}`);
  }
  const weekMapStr = `This week: ${weekMapParts.join(', ')}.`;

  const activeTasks = (tasks || []).filter(t => !t.completed);
  const recentCompleted = (tasks || []).filter(t => t.completed && t.completionNote);

  const contextBlock = `\n\nCurrent time: ${currentTime} (${tz}). When setting due times, use the user's local timezone — NOT UTC.\n\n## Live Data\nActive tasks (${activeTasks.length}): ${
    activeTasks.slice(0, 30).map(t =>
      `[${t.id}] ${t.title} (${t.priority}${t.dueDate ? ', due ' + t.dueDate : ''}${t.dueDate && t.dueDate < todayDate ? ', OVERDUE' : ''})`
    ).join('; ') || 'none'
  }${recentCompleted.length ? `\nRecently completed with notes: ${recentCompleted.slice(0, 10).map(t => `${t.title} — completed.${t.description ? ` Note at creation: ${t.description}.` : ''} Outcome note: ${t.completionNote}`).join('; ')}` : ''
  }\nRecent notes: ${(notes || []).slice(0, 10).map(n => n.title).join(', ') || 'none'
  }${calendarNotes.length ? `\nCalendar meeting notes (recent): ${calendarNotes.slice(0, 15).map(cn => `"${cn.eventTitle}" (${cn.eventStart ? new Date(cn.eventStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '?'})${cn.preNote ? ' Agenda: ' + cn.preNote.slice(0, 100) : ''}${cn.postNote ? ' Outcomes: ' + cn.postNote.slice(0, 100) : ''}`).join('; ')}` : ''
  }\nCalendar next 7 days: ${(calendarEvents || []).map(ev => `${ev.start} — ${ev.title}`).join('; ') || 'none'
  }\nRecent Aria actions (last 10): ${
    recentMemories.length
      ? recentMemories.slice(0, 10).map(m =>
          `[${new Date(m.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}] ${m.content}`
        ).join('; ')
      : 'none yet'
  }`;

  const profileParts = [];
  if (user?.profileName)       profileParts.push(`You are helping ${user.profileName}.`);
  if (user?.profileBusinesses) profileParts.push(`Businesses: ${user.profileBusinesses}.`);
  if (user?.profileHousehold)  profileParts.push(`Household context: ${user.profileHousehold}.`);
  if (user?.profileLocation)   profileParts.push(`Based in: ${user.profileLocation}.`);
  if (user?.profileNotes)      profileParts.push(`Additional context: ${user.profileNotes}.`);
  const profileContext = profileParts.length ? profileParts.join(' ') + '\n\n' : '';

  const assistantName = user?.assistantName || 'Aria';
  const userName = user?.profileName || user?.displayName || 'the user';
  const basePrompt = `You are ${assistantName}, ${userName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything. You have tools to create, update, search, and delete tasks/notes/events, and to send, reply to, or archive emails. Use tools when taking action. For everything else, respond naturally. Be warm and concise. Today is ${todayStr}. Current time: ${currentTime} (${tz}). The user's timezone is ${tz}.\n${weekMapStr}

For inbox questions: answer from CURRENT INBOX STATE first. Use search_inbox for specific lookups.

When search_inbox returns fewer than 3 results OR has_more is true OR the user seems to expect more: always follow up by asking: "I found [N] emails from [date_range.label]. Would you like me to search further back? I can check the last week, month, 3 months, year, or all time."

When the user specifies a time range in their query (e.g. "last month", "this year", "since January"): map it to the appropriate date_from value and call search_inbox directly without asking.

When the user asks for "all", "complete history", or "retrieve all": call search_inbox with limit: 50. If has_more is still true after limit 50, tell the user: "I found [N] emails — this is the maximum I can retrieve at once. Would you like to narrow by date range or restaurant to find specific orders?"

To page through results: use the oldest result's date as date_to in a follow-up search_inbox call with an earlier date_from.`;

  // Learnings: inject rules (cap 15) + patterns (cap 10); never one-offs.
  const rulesList = (learnings || []).filter(l => l.confidence === 'rule').slice(0, 15);
  const patternsList = (learnings || []).filter(l => l.confidence === 'pattern').slice(0, 10);
  const learningsBlock = buildLearningsBlock(rulesList, patternsList);

  // Email inbox context (optional; built with a char cap for safety).
  const emailBlock = buildEmailContextBlock({
    importantUnread, recentClassified,
    importantUnreadLimit, recentClassifiedLimit,
  });

  // Recent outcome narratives — feed back what actually happened on prior
  // tasks/events so Aria can reference outcomes in future responses.
  const outcomesBlock = buildOutcomesBlock(recentOutcomes, tz);

  // Memory facts — durable patterns extracted by the enrichment worker.
  // Only facts with strength_score >= 0.5 make it in.
  const factsBlock = buildFactsBlock(memoryFacts);

  // Active projects across every entity the user can access.
  const projectsBlock = buildProjectsBlock(projectsCtx);

  // People + relationship memory + shared-access summary.
  const peopleBlock = await buildPeopleBlock(contactsData, db, userId);
  const sharedAccessBlock = buildSharedAccessBlock(sharedAccessData);

  const systemPrompt = profileContext + basePrompt + DECISION_INSTRUCTIONS + learningsBlock + emailBlock + outcomesBlock + factsBlock + projectsBlock + peopleBlock + sharedAccessBlock + contextBlock;
  console.log('[buildAgenticContext] prompt chars:', systemPrompt.length);

  return {
    user, tasks, activeTasks, recentCompleted, notes, recentMemories, calendarNotes, calendarEvents, learnings,
    importantUnread, recentClassified, recentOutcomes, memoryFacts, projects: projectsCtx,
    contacts: contactsData, sharedAccess: sharedAccessData,
    tz, todayStr, todayDate, currentTime, weekMapStr,
    profileContext, contextBlock, learningsBlock, emailBlock, outcomesBlock, factsBlock, projectsBlock,
    peopleBlock, sharedAccessBlock,
    decisionInstructions: DECISION_INSTRUCTIONS,
    systemPrompt,
  };
}

/**
 * Build ACTIVE PROJECTS block. Includes top open task titles + recent note
 * snippet so Aria can answer "what's left", "what's blocking", "are we
 * ready" without an additional tool call. Empty string when no projects.
 */
function buildProjectsBlock(projects) {
  if (!Array.isArray(projects) || projects.length === 0) {
    // Surface the section even when empty so Aria knows projects exist as
    // a concept and doesn't claim "no access" when asked.
    return `\n\nACTIVE PROJECTS\nNo active projects.`;
  }
  const lines = projects.map((p) => {
    const head = `- ${p.entityName || 'Entity'} / ${p.title}: ${p.openTasks || 0} open, ${p.completedTasks || 0} done`;
    const tasks = (p.openTaskTitles && p.openTaskTitles.length)
      ? ` (${p.openTaskTitles.join(', ')})`
      : '';
    const note = p.recentNote ? ` · Note: "${p.recentNote}"` : '';
    return `${head}${tasks}${note}`;
  });
  return `\n\nACTIVE PROJECTS\n${lines.join('\n')}`;
}

/**
 * Build PEOPLE & RELATIONSHIPS block. Fetches top facts per contact
 * inline (small N) and truncates at PEOPLE_BLOCK_CHAR_CAP so we never
 * starve the token budget in the rare case a user has 50+ contacts
 * with rich facts.
 *
 * Contract: returns '' when the contact set is empty so callers can
 * concatenate blindly.
 */
const PEOPLE_BLOCK_CHAR_CAP = 400;

async function buildPeopleBlock(contacts, db, userId) {
  if (!Array.isArray(contacts) || contacts.length === 0) return '';
  const getFacts = db.getTopContactFacts
    ? (cid) => db.getTopContactFacts(cid, userId, 3).catch(() => [])
    : async () => [];
  const lines = [];
  let out = '\n\nPEOPLE & RELATIONSHIPS';
  for (const c of contacts) {
    const factTexts = await getFacts(c.id);
    const parenBits = [c.role || c.relationship || 'contact'];
    if (c.company) parenBits.push(c.company);
    const head = `\n- ${c.displayName || 'Unknown'} (${parenBits.filter(Boolean).join(', ')})`;
    const facts = factTexts.length ? `\n  Facts: ${factTexts.join('; ')}` : '';
    const candidate = out + head + facts;
    if (candidate.length > PEOPLE_BLOCK_CHAR_CAP) break;
    out = candidate;
    lines.push(head);
  }
  return out;
}

/**
 * Build SHARED ACCESS block describing grants RECEIVED (data you can
 * see from others). Silent on grants given — the grantor can see those
 * in the dedicated panel; Aria doesn't need to repeat them.
 */
function buildSharedAccessBlock(summary) {
  if (!summary || !summary.grantsReceived) return '';
  const scopes = (summary.scopes || []).slice(0, 6).join(', ');
  const block = `\n\nSHARED ACCESS\nYou have been granted access to data from ${summary.grantsReceived} connection(s): ${scopes}`;
  return block.length > 150 ? block.slice(0, 147) + '...' : block;
}

/**
 * Build a LEARNED PATTERNS block from memory_facts. Filters to facts at
 * or above 0.5 strength_score (fresh facts start at 0.5 so first-time
 * facts qualify; casual observations never boosted above 0.5 drop out).
 */
function buildFactsBlock(facts) {
  if (!Array.isArray(facts) || facts.length === 0) return '';
  const strong = facts.filter((f) => Number(f.strength_score) >= 0.5);
  if (strong.length === 0) return '';
  return `\n\nLEARNED PATTERNS\n${strong.map((f) => `- ${f.fact_text}`).join('\n')}`;
}

/**
 * Build the RECENT OUTCOMES block from outcome_records rows. Empty string
 * when no outcomes exist so callers can concatenate blindly.
 */
function buildOutcomesBlock(outcomes, tz) {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return '';
  const lines = outcomes.map((o) => {
    let date = '';
    try {
      date = new Date(o.completed_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', timeZone: tz,
      });
    } catch {}
    const status = o.outcome_status ? ` (${o.outcome_status})` : '';
    const followUp = o.follow_up_needed ? ' · follow-up needed' : '';
    return `- ${o.title_snapshot || 'Untitled'}${status}, ${date}: ${o.raw_note}${followUp}`;
  });
  return `\n\nRECENT OUTCOMES\n${lines.join('\n')}`;
}

// Email inbox context. Truncates recentClassified first, then
// importantUnread, to stay under EMAIL_BLOCK_CHAR_CAP.
const EMAIL_BLOCK_CHAR_CAP = 12_000;

function buildEmailContextBlock({ importantUnread, recentClassified, importantUnreadLimit, recentClassifiedLimit }) {
  const unread = Array.isArray(importantUnread) ? importantUnread.slice(0, importantUnreadLimit) : [];
  let recent   = Array.isArray(recentClassified) ? recentClassified.slice(0, recentClassifiedLimit) : [];
  if (!unread.length && !recent.length) return '';

  const fmtDate = (iso) => {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
    catch { return ''; }
  };
  const fmtUnread = (r) =>
    `- From/Vendor: ${r.vendor || 'Unknown'} | Summary: ${r.summary || ''}\n  Category: ${r.category} | Importance: ${r.importance}\n  Entity: ${r.entityName || 'None'} | Date: ${fmtDate(r.classifiedAt)}`;
  const fmtRecent = (r) =>
    `- ${r.importance} | ${r.vendor || 'Unknown'} | ${r.summary || ''} | ${fmtDate(r.classifiedAt)}`;

  const build = (u, r) => {
    let out = '\n\nCURRENT INBOX STATE (available to you):\nThis is your current view of the inbox. Answer inbox questions directly from this data.';
    if (u.length) out += `\n\nEMAILS NEEDING ATTENTION:\n${u.map(fmtUnread).join('\n')}`;
    if (r.length) out += `\n\nRECENT INBOX:\n${r.map(fmtRecent).join('\n')}`;
    out += '\n\nAnswer inbox questions from the data above first. Use search_inbox only when you need to find something more specific than what is shown here.';
    return out;
  };

  let block = build(unread, recent);
  // Truncate recent first, then unread, until we're under cap.
  while (block.length > EMAIL_BLOCK_CHAR_CAP && recent.length > 0) {
    recent = recent.slice(0, Math.max(0, recent.length - Math.ceil(recent.length / 4)));
    block = build(unread, recent);
  }
  while (block.length > EMAIL_BLOCK_CHAR_CAP && unread.length > 0) {
    unread.pop();
    block = build(unread, recent);
  }
  return block;
}

function buildLearningsBlock(rules, patterns) {
  if (!rules.length && !patterns.length) return '';
  const fmt = (l) => `• ${l.ruleText}${l.scope && l.scope !== 'global' ? ` (${l.scope}${l.scopeValue ? `: ${l.scopeValue}` : ''})` : ''}`;
  let out = '';
  if (rules.length) {
    out += `\n\nUSER RULES (hard enforce — confirmation/boundary/routing types must always be followed; style/timing/preference = apply by default):\n${rules.map(fmt).join('\n')}`;
  }
  if (patterns.length) {
    out += `\n\nUSER PATTERNS (apply by default, user may override in context):\n${patterns.map(fmt).join('\n')}`;
  }
  return out;
}

module.exports = { buildAgenticContext, fetchCalendarWindow, localMidnightUtc, DECISION_INSTRUCTIONS };
