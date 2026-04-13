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

const DECISION_INSTRUCTIONS = `\n\n## Decision contract\nBefore calling any tool, output a decision block wrapped in <decision> tags:\n<decision>\n{\n  "intent": "short label — e.g. create_task, schedule_meeting, send_email",\n  "confidence": 0.0,\n  "risk": "low" | "medium" | "high",\n  "requires_confirmation": false\n}\n</decision>\n\nServer enforces: send_email, reply_email, delete_task, delete_event always require confirmation regardless of what you output.`;

/**
 * Fetch upcoming GCal events for the next 7 days, spanning all
 * connected accounts. Returns an array sorted by start time.
 */
async function fetchCalendarWindow({ userId, tz, loadAllGcalAccounts, loadGcalTokens, saveGcalTokens, makeOAuth2Client, google, logger, requestId }) {
  const userTz = tz || 'America/Los_Angeles';

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
    const timeMax = new Date(noonUtc.getTime() - 12 * 3600000 + offsetMs + 7 * 86400000).toISOString();

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
    return allEvents.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
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

  const [user, tasks, notes, recentMemories, calendarNotes, calendarEvents, learnings, importantUnread, recentClassified] = await Promise.all([
    db.getUserById(userId),
    db.getTasksForUser(userId, []),
    db.getPrivateNotesForAI(userId),
    db.getRecentMemories(userId, 20).catch(() => []),
    db.getCalendarNotesForAI(userId).catch(() => []),
    fetchCalendarWindow(opts),
    db.getUserLearnings ? db.getUserLearnings(userId).catch(() => []) : Promise.resolve([]),
    db.getImportantUnread ? db.getImportantUnread(userId, emailContextMinRank).catch(() => []) : Promise.resolve([]),
    db.getRecentClassifications ? db.getRecentClassifications(userId, recentClassifiedLimit).catch(() => []) : Promise.resolve([]),
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
  const basePrompt = `You are ${assistantName}, ${userName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything. You have tools to create, update, search, and delete tasks/notes/events, and to send, reply to, or archive emails. Use tools when taking action. For everything else, respond naturally. Be warm and concise. Today is ${todayStr}. Current time: ${currentTime} (${tz}). The user's timezone is ${tz}.\n${weekMapStr}`;

  // Learnings: inject rules (cap 15) + patterns (cap 10); never one-offs.
  const rulesList = (learnings || []).filter(l => l.confidence === 'rule').slice(0, 15);
  const patternsList = (learnings || []).filter(l => l.confidence === 'pattern').slice(0, 10);
  const learningsBlock = buildLearningsBlock(rulesList, patternsList);

  // Email inbox context (optional; built with a char cap for safety).
  const emailBlock = buildEmailContextBlock({
    importantUnread, recentClassified,
    importantUnreadLimit, recentClassifiedLimit,
  });

  const systemPrompt = profileContext + basePrompt + DECISION_INSTRUCTIONS + learningsBlock + emailBlock + contextBlock;

  return {
    user, tasks, activeTasks, recentCompleted, notes, recentMemories, calendarNotes, calendarEvents, learnings,
    importantUnread, recentClassified,
    tz, todayStr, todayDate, currentTime, weekMapStr,
    profileContext, contextBlock, learningsBlock, emailBlock, decisionInstructions: DECISION_INSTRUCTIONS,
    systemPrompt,
  };
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
    let out = '\n\nEMAIL INBOX CONTEXT:\nYou have access to the user\'s classified email data. Use this to answer questions about their inbox.';
    if (u.length) out += `\n\nEMAILS NEEDING ATTENTION:\n${u.map(fmtUnread).join('\n')}`;
    if (r.length) out += `\n\nRECENT INBOX:\n${r.map(fmtRecent).join('\n')}`;
    out += '\n\nIf the user asks about emails, senders, confirmations, invoices, receipts, unread items, or anything inbox-related, answer from this context. Use search_inbox for specific lookups.';
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

module.exports = { buildAgenticContext, DECISION_INSTRUCTIONS };
