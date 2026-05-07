import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useToast } from '../contexts/ToastContext';
import buildSystemPrompt from '../utils/systemPrompt';
import { getTodayLocal } from '../utils/helpers.js';
import { parseActionDraft } from '../utils/parseActionDraft.js';
import ActiveZoneOrchestrator from '../components/dashboard/ActiveZoneOrchestrator.jsx';
import ActiveZoneVoice from '../components/dashboard/ActiveZoneVoice.jsx';
import TaskDraftTile from '../components/command-center/TaskDraftTile.jsx';
import EventDraftTile from '../components/command-center/EventDraftTile.jsx';
import ProjectDraftTile from '../components/command-center/ProjectDraftTile.jsx';
import ProjectTaskDraftTile from '../components/command-center/ProjectTaskDraftTile.jsx';
import ChecklistDraftTile from '../components/command-center/ChecklistDraftTile.jsx';
import DailyWrapTile from '../components/command-center/DailyWrapTile.jsx';

// Inline-styled markdown components so assistant bubbles keep the
// current typography (Manrope 15px / 1.6 line-height) and don't
// introduce backgrounds, borders, or default margin pollution.
const MD_COMPONENTS = {
  p: ({ node, ...p }) => <p style={{ margin: '0 0 0.5em 0' }} {...p} />,
  ul: ({ node, ordered, ...p }) => <ul style={{ margin: '0.25em 0 0.5em 1.25em', padding: 0, listStyleType: 'disc' }} {...p} />,
  ol: ({ node, ordered, ...p }) => <ol style={{ margin: '0.25em 0 0.5em 1.5em', padding: 0, listStyleType: 'decimal' }} {...p} />,
  li: ({ node, ordered, ...p }) => <li style={{ margin: '0.15em 0' }} {...p} />,
  strong: ({ node, ...p }) => <strong style={{ fontWeight: 700 }} {...p} />,
  em: ({ node, ...p }) => <em style={{ fontStyle: 'italic' }} {...p} />,
  a: ({ node, ...p }) => <a style={{ color: '#4f4dcf', textDecoration: 'underline' }} target="_blank" rel="noreferrer" {...p} />,
  code: ({ node, inline, ...p }) =>
    inline
      ? <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px', background: 'rgba(79,77,207,0.06)', padding: '0 4px', borderRadius: '4px' }} {...p} />
      : <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px', whiteSpace: 'pre-wrap' }} {...p} />,
  h1: ({ node, ...p }) => <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '16px', margin: '0.25em 0 0.4em 0' }} {...p} />,
  h2: ({ node, ...p }) => <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '15px', margin: '0.25em 0 0.35em 0' }} {...p} />,
  h3: ({ node, ...p }) => <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '14px', margin: '0.25em 0 0.3em 0' }} {...p} />,
};

const API_BASE = '';

/** Convert "HH:MM" (24h) to "h:MM AM/PM" for display in draft tiles. */
function to24hTo12h(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return '';
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Proactive narration discipline (paths 1+2+3 unified):
// Path 1 (init) — excluded by design: no prior chat to dedup against.
// Path 2 (freshUpdate) — has 9896fd7's inputHash dedup AND now this
//   recency suppression layer.
// Path 3 (pollUpdatesRef) — has 72ad9ce's in-flight gate AND now this
//   recency suppression PLUS chat-history context in the LLM prompt.
// Future trigger paths must route through this same machinery.
const SUPPRESSION_RECENCY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Returns { overlap, matchedTokens, recentMsgTs } indicating whether a
 * planned narration repeats topics the user just discussed with Aria.
 * Heuristic: 6+ char alphabetic tokens, ≥2 distinct hits within the
 * recency window. The ≥2 floor avoids stop-word brushes ("today",
 * "tomorrow", "important") triggering false positives.
 */
function topicOverlapsRecentChat(narrationText, ccMessages, windowMs) {
  const cutoff = Date.now() - windowMs;
  const recentMsgs = (ccMessages || []).filter((m) => {
    const ts = m?.ts || (m?.createdAt ? new Date(m.createdAt).getTime() : 0);
    return ts >= cutoff;
  });
  if (!recentMsgs.length) return { overlap: false, matchedTokens: [], recentMsgTs: null };
  const recentText = recentMsgs.map((m) => String(m?.content || '').toLowerCase()).join(' ');
  const tokens = Array.from(new Set(String(narrationText || '').toLowerCase().match(/[a-z]{6,}/g) || []));
  const matched = [];
  for (const tok of tokens) {
    if (recentText.includes(tok)) matched.push(tok);
    if (matched.length >= 5) break; // cap log noise
  }
  const lastTs = recentMsgs[recentMsgs.length - 1]?.ts
    || (recentMsgs[recentMsgs.length - 1]?.createdAt ? new Date(recentMsgs[recentMsgs.length - 1].createdAt).getTime() : null);
  return { overlap: matched.length >= 2, matchedTokens: matched, recentMsgTs: lastTs };
}

export default function DashboardPanel({ tasks, currentUser, authToken, apiKeys, notes, onNavigate, onAIPrompt, entities, onAddTask, onQuickNote, onAddEvent, onToggleTask, onOpenNote, backend, onBackendChange, apiFetch, callClaudeChat, chatCalendarEvents, initialBriefData, onReloadTasks, onReloadNotes, onReloadCalendar }) {
  const [digest, setDigest] = useState(null);
  const [digestLoading, setDigestLoading] = useState(true);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  const [timelineSummary, setTimelineSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [gmailAccounts, setGmailAccounts] = useState([]);
  const [briefContext, setBriefContext] = useState(null);
  // Context cards are summoned, not ambient — default to collapsed.
  // Promoted to 'context' only on: first-load-with-no-chat, time-state
  // transition, 30+ min return, or an explicit intent ("what's going on").
  const [activeZoneState, setActiveZoneState] = useState('empty');
  const [activeTile, setActiveTile] = useState(null);
  // Active Zone orchestration surface (the new top-of-dashboard tile area).
  // azRefreshKey bumps to force a re-fetch from the orchestrator after
  // significant state changes (task complete, meeting end, loop close).
  // Wired to AZ7 hooks below.
  const [azRefreshKey, setAzRefreshKey] = useState(0);
  const [azIsEmpty, setAzIsEmpty] = useState(true);
  const bumpAzRefresh = useCallback(() => setAzRefreshKey((k) => k + 1), []);
  // AZ7 — listen for the global 'aria:zone-refresh' event dispatched by
  // App.jsx after task mutations + by close-loop save below. The
  // orchestrator already debounces 2s, so a burst coalesces into one
  // detector run.
  useEffect(() => {
    const handler = () => setAzRefreshKey((k) => k + 1);
    window.addEventListener('aria:zone-refresh', handler);
    return () => window.removeEventListener('aria:zone-refresh', handler);
  }, []);
  const draftFromRef = useRef({});
  const draftToRef = useRef({});
  const draftBodyRef = useRef({});
  // ts of the email draft currently showing in the active zone — confirm
  // cards still live in ccMessages and use this to locate the paired
  // draft refs (from/to/body).
  const activeEmailDraftTsRef = useRef(null);
  // Tracking for summon logic.
  const lastTimeStateRef = useRef(null);
  const lastActivityRef = useRef(Date.now());
  const firstBriefFetchRef = useRef(true);
  // Once-per-session guard so the Daily Wrap proactive CC message fires
  // exactly once. The server-side claim in checkAndLockDailyWrapWeb
  // already enforces once-per-day system-wide; this ref covers the
  // session-local case (e.g. repeated polls in the same window).
  const wrapPromptFiredRef = useRef(false);
  // Once-per-session guard for close-loop proactive tiles — prevents the
  // same close-loop item from re-surfacing after the user submits (since
  // resolveCloseLoopSilent is fire-and-forget and may not have landed by
  // the next fetchBriefContext poll).
  const closeLoopPromptedIdsRef = useRef(new Set());
  // "Acted-on" guard: once the user submits a daily_wrap or close_loop
  // tile, lock that tile type for the session so fetchBriefContext can't
  // re-promote it during the success→empty transition window.
  const dailyWrapActedOnRef = useRef(false);
  // Last project task created via chat — enables "yes" / "add subtasks"
  // follow-ups to resolve to the right task without asking again. Stale
  // after 60 seconds.
  const lastCreatedProjectTaskRef = useRef(null);
  const toast = useToast();

  useEffect(() => {
    if (!authToken) return;
    apiFetch('/api/gmail/accounts', {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((accounts) => setGmailAccounts(Array.isArray(accounts) ? accounts.filter((a) => a.account_email) : []))
      .catch(() => {});
  }, [authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch structured brief context. Summon rules (not ambient):
  //   • first fetch AND user hasn't chatted yet → show
  //   • time-state transition (morning → midday, etc) → show
  //   • otherwise → just refresh data, leave zone state alone
  // Never forces a 'context' state if a tile/email/notes flow is active.
  const fetchBriefContext = useCallback(async () => {
    if (!authToken) return;
    try {
      const r = await apiFetch('/api/brief/context', { headers: { Authorization: `Bearer ${authToken}` } });
      if (!r.ok) return;
      const data = await r.json();
      setBriefContext(data);

      firstBriefFetchRef.current = false;
      if (data.timeState) lastTimeStateRef.current = data.timeState;

      // AZ5 — orchestration moved out of fetchBriefContext. The new
      // ActiveZoneOrchestrator (top of dashboard) owns the
      // "should we surface a daily_wrap / close_loop tile" decision via
      // the candidate detector + tile composer. activeZoneState /
      // activeTile remain for the DOWNSTREAM composition surfaces
      // (daily wrap form, close-loop note input, email draft tile, etc.)
      // which are invoked by the user clicking a tile's primary action.
      // The ambient proactive CC message for daily_wrap is preserved
      // below so users still get a chat nudge — fires only once per day
      // via wrapReminderReady's DB-side claim.
      if (!ccSendingRef.current && data.activeZoneSuggestion === 'daily_wrap' && data.wrapReminderReady && !wrapPromptFiredRef.current) {
        wrapPromptFiredRef.current = true;
        const done = data.stats?.tasksCompletedToday || 0;
        const highOpen = (data.tasks?.overdue?.filter((t) => t.priority === 'high') || []).length
          + (data.tasks?.dueToday?.filter((t) => t.priority === 'high' && !t.completed) || []).length;
        const parts = [];
        if (done > 0) parts.push(`${done} task${done === 1 ? '' : 's'} done`);
        if (highOpen > 0) parts.push(`${highOpen} high-priority still open`);
        const summary = parts.length ? ` Today: ${parts.join(', ')}.` : '';
        const now = new Date().toISOString();
        setCcMessages((prev) => {
          if (prev.some(m => m.update_type === 'daily_wrap')) return prev;
          return [
            ...prev,
            {
              role: 'assistant',
              content: `Ready to wrap your day?${summary} Want to capture how it went?`,
              update_type: 'daily_wrap',
              createdAt: now,
              ts: Date.now(),
            },
          ];
        });
      }
    } catch { /* silent */ }
  }, [apiFetch, authToken]);

  useEffect(() => {
    if (!authToken) return;
    fetchBriefContext();
    const interval = setInterval(fetchBriefContext, 5 * 60 * 1000);
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const idleMs = Date.now() - lastActivityRef.current;
      fetchBriefContext();
      // 30+ min idle: ask Aria for a fresh catch-up. The active zone
      // stays action-only now — context surfaces in Aria's chat reply,
      // not a static card block.
      if (idleMs > 30 * 60 * 1000) {
        lastActivityRef.current = Date.now();
        setTimeout(() => ccSendRef.current?.('Catch me up on my day'), 400);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVis); };
  }, [authToken, fetchBriefContext]);

  const userTZ = currentUser?.timezone || 'America/Los_Angeles';
  const today = getTodayLocal(userTZ);
  const tasksReady = tasks.length > 0 || tasks._loaded;

  // Clear stale date-keyed caches on mount
  useEffect(() => {
    Object.keys(localStorage).forEach((key) => {
      if ((key.startsWith('timeline_summary_') || key.startsWith('digest_') || key.startsWith('cc_messages_')) && !key.includes(today)) {
        localStorage.removeItem(key);
      }
    });
  }, [today]);

  // Greeting — use profile timezone
  const hour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: userTZ, hour: 'numeric', hour12: false }).format(new Date()), 10);
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = currentUser?.displayName?.split(' ')[0] || currentUser?.username || '';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: userTZ });

  // Task computations
  const activeTasks = useMemo(() => tasks.filter((t) => !t.completed), [tasks]);
  const overdueTasks = useMemo(() => activeTasks.filter((t) => t.dueDate && t.dueDate < today), [activeTasks, today]);
  const highPriorityTasks = useMemo(() => activeTasks.filter((t) => t.priority === 'high'), [activeTasks]);
  const todayTasks = useMemo(() => activeTasks.filter((t) => t.dueDate === today), [activeTasks, today]);
  const highNoDue = useMemo(() => activeTasks.filter((t) => t.priority === 'high' && !t.dueDate), [activeTasks]);
  const inboxCount = overdueTasks.length + highNoDue.length;

  // Upcoming tasks (due after today, within 14 days)
  const upcomingTasks = useMemo(() => {
    const _d14 = new Date();
    _d14.setDate(_d14.getDate() + 14);
    const maxDate = `${_d14.getFullYear()}-${String(_d14.getMonth()+1).padStart(2,'0')}-${String(_d14.getDate()).padStart(2,'0')}`;
    return activeTasks
      .filter((t) => t.dueDate && t.dueDate > today && t.dueDate <= maxDate)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 7);
  }, [activeTasks, today]);

  // Floating tasks (no due date, not completed)
  const floatingTasks = useMemo(() => activeTasks.filter((t) => !t.dueDate).slice(0, 7), [activeTasks]);

  // Notes: this week count + latest note
  const notesThisWeek = useMemo(() => {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString();
    return notes.filter((n) => n.type !== 'digest' && n.createdAt && n.createdAt >= weekAgoStr).length;
  }, [notes]);

  const latestNote = useMemo(() => {
    return notes.find((n) => n.type !== 'digest') || null;
  }, [notes]);

  // Fetch calendar events for today. Re-runs on user OR timezone change
  // (the latter was missing from deps, so a TZ flip didn't refresh the
  // filter window). AbortController-aware so unmount mid-fetch doesn't
  // setState on a dead component.
  useEffect(() => {
    if (!currentUser?.id) return;
    const ctrl = new AbortController();
    apiFetch(`${API_BASE}/api/gcal/events?timeZone=${encodeURIComponent(userTZ)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: ctrl.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        if (ctrl.signal.aborted || !Array.isArray(data)) return;
        const todayLocal = getTodayLocal(userTZ);
        const filtered = data.filter((ev) => {
          if (ev.allDay) {
            return ev.start === todayLocal || ev.end === todayLocal || (ev.start <= todayLocal && ev.end > todayLocal);
          }
          const startLocal = new Intl.DateTimeFormat('en-CA', { timeZone: userTZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ev.start));
          return startLocal === todayLocal;
        });
        setCalendarEvents(filtered);
      })
      .catch((err) => { if (err?.name !== 'AbortError') { /* swallow — UI fallback handles missing events */ } })
      .finally(() => { if (!ctrl.signal.aborted) setCalendarLoaded(true); });
    return () => ctrl.abort();
  }, [currentUser?.id, userTZ, authToken]);

  // Timeline items: merge calendar events + tasks, sorted chronologically
  const timelineItems = useMemo(() => {
    const items = [];

    // Overdue tasks first
    overdueTasks.forEach((t) => {
      items.push({ type: 'overdue', time: null, sortKey: -1, title: t.title, priority: t.priority, tags: t.tags, id: t.id });
    });

    // Calendar events
    calendarEvents.forEach((ev) => {
      let timeStr = 'All day';
      let sortKey = 0;
      if (ev.start && !ev.allDay) {
        const d = new Date(ev.start);
        sortKey = d.getHours() * 60 + d.getMinutes();
        timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
      }
      items.push({ type: 'calendar', time: timeStr, sortKey, title: ev.title, id: ev.id });
    });

    // Today's tasks + high priority tasks — slot by time if available
    const taskSet = new Set();
    overdueTasks.forEach((t) => taskSet.add(t.id));
    [...todayTasks, ...highPriorityTasks.filter((t) => !t.dueDate || t.dueDate === today)].forEach((t) => {
      if (taskSet.has(t.id)) return;
      taskSet.add(t.id);
      let timeStr = 'EOD';
      let sortKey = 9999;
      if (t.dueTime) {
        const [h, m] = t.dueTime.split(':').map(Number);
        sortKey = h * 60 + m;
        const ampm = h >= 12 ? 'pm' : 'am';
        const h12 = h % 12 || 12;
        timeStr = `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
      }
      items.push({ type: t.priority === 'high' ? 'high' : 'task', time: timeStr, sortKey, title: t.title, priority: t.priority, tags: t.tags, id: t.id });
    });

    // Sort: overdue first (sortKey -1), then by time
    items.sort((a, b) => a.sortKey - b.sortKey);
    return items;
  }, [calendarEvents, overdueTasks, todayTasks, highPriorityTasks, today]);

  // All data sources loaded — gate AI generation on this
  const allDataReady = tasksReady && calendarLoaded;

  // Timeline AI summary (once per day, cached)
  useEffect(() => {
    const cacheKey = `timeline_summary_${today}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) { setTimelineSummary(cached); setSummaryLoading(false); return; }

    // Wait for all data sources before generating
    if (!allDataReady) return;

    const eventsData = calendarEvents.map((e) => ({ time: e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), title: e.title }));
    const tasksData = [...overdueTasks.map((t) => ({ title: t.title, priority: t.priority, overdue: true })), ...todayTasks.map((t) => ({ title: t.title, priority: t.priority, overdue: false })), ...highPriorityTasks.filter((t) => !t.dueDate || t.dueDate === today).map((t) => ({ title: t.title, priority: t.priority, overdue: false }))];

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };
    apiFetch('/api/dashboard/timeline-summary', {
      method: 'POST', headers,
      body: JSON.stringify({ apiKey: apiKeys?.claude || '', events: eventsData, tasks: tasksData }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.summary) {
          setTimelineSummary(data.summary);
          localStorage.setItem(cacheKey, data.summary);
        }
      })
      .catch(() => {})
      .finally(() => setSummaryLoading(false));
  }, [today, allDataReady, calendarEvents.length, overdueTasks.length, todayTasks.length, highPriorityTasks.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Command Center state ──────────────────────────────────────────────────
  const ccStorageKey = `cc_messages_${getTodayLocal(userTZ)}`;
  // Read cached messages once; share between ccMessages and ccLoading init
  // so we don't double-parse localStorage.
  const [ccCacheInit] = useState(() => {
    try {
      const raw = localStorage.getItem(`cc_messages_${getTodayLocal(userTZ)}`);
      if (raw) {
        const msgs = JSON.parse(raw);
        if (Array.isArray(msgs) && msgs.length > 0) return msgs;
      }
    } catch {}
    return null;
  });
  const [ccMessages, setCcMessages] = useState(ccCacheInit || []);
  const [ccConvId, setCcConvId] = useState(null);
  // Skip the loading spinner when localStorage already has today's messages —
  // show cached messages immediately and let initCommandCenter sync silently.
  const [ccLoading, setCcLoading] = useState(!ccCacheInit);
  const [ccInput, setCcInput] = useState('');
  const [ccSending, setCcSending] = useState(false);
  const ccAbortRef   = useRef(null);   // active AbortController for chat stream
  const ccStoppedRef = useRef(false);  // set true on user Stop so late events are ignored
  const ccSendRef    = useRef(null);   // holds latest handleCcSend for cross-surface triggers
  const ccMessagesRef = useRef(ccCacheInit || []);    // mirror of ccMessages for stable reads inside callbacks
  const ccSendingRef = useRef(false);  // mirror of ccSending for reads inside fetchBriefContext
  const activeZoneStateRef = useRef('empty'); // mirror of activeZoneState for reads inside fetchBriefContext

  // Inline-note capture: exactly one row's textarea is open at a time.
  // Key format: `task:<id>` or `event:<id>` so we can share one state across
  // both task and event rows without clashing ids.
  const [inlineNoteRowKey, setInlineNoteRowKey] = useState(null);
  const [inlineNoteDraft, setInlineNoteDraft] = useState('');

  const openInlineNote = useCallback((key, initial = '') => {
    setInlineNoteRowKey(key);
    setInlineNoteDraft(initial || '');
  }, []);
  const closeInlineNote = useCallback(() => {
    setInlineNoteRowKey(null);
    setInlineNoteDraft('');
  }, []);

  // Fire-and-forget close-loop resolve — silent on any failure; never
  // surfaced to the user. The endpoint is idempotent server-side.
  const resolveCloseLoopSilent = useCallback((sourceType, sourceId) => {
    if (!sourceType || !sourceId) return;
    apiFetch('/api/close-loop/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ source_type: sourceType, source_id: String(sourceId) }),
    }).catch(() => {});
  }, [apiFetch, authToken]);

  const saveTaskInlineNote = useCallback(async (taskId) => {
    const note = inlineNoteDraft.trim();
    if (!note) { closeInlineNote(); return; }
    closeInlineNote();
    try {
      await apiFetch(`/api/tasks/${taskId}/completion-note`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ completion_note: note }),
      });
      resolveCloseLoopSilent('task', taskId);
      onReloadTasks?.();
    } catch (err) {
      console.error('[inlineNote] task save failed:', err.message);
    }
  }, [inlineNoteDraft, apiFetch, authToken, onReloadTasks, closeInlineNote, resolveCloseLoopSilent]);

  const saveEventInlineNote = useCallback(async (ev) => {
    const note = inlineNoteDraft.trim();
    if (!note) { closeInlineNote(); return; }
    closeInlineNote();
    try {
      await apiFetch('/api/calendar-notes/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          eventId: ev.id,
          eventTitle: ev.title || null,
          eventStart: ev.start || null,
          eventEnd: ev.end || null,
          accountEmail: ev.account || null,
          postNote: note,
        }),
      });
      resolveCloseLoopSilent('event', ev.id);
    } catch (err) {
      console.error('[inlineNote] event save failed:', err.message);
    }
  }, [inlineNoteDraft, apiFetch, authToken, closeInlineNote, resolveCloseLoopSilent]);

  // Task delete — fires window.confirm, DELETEs, then reloads the task
  // list. Backend cascades owner check at the route layer; UI does not
  // assume success on failure.
  const deleteTaskRow = useCallback(async (t) => {
    if (!window.confirm(`Delete "${t.title}"?`)) return;
    try {
      const r = await apiFetch(`/api/tasks/${t.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (r.ok) {
        resolveCloseLoopSilent('task', t.id); // vacate any pending close-loop
        onReloadTasks?.();
      }
    } catch (err) {
      console.error('[deleteTask] failed:', err.message);
    }
  }, [apiFetch, authToken, onReloadTasks, resolveCloseLoopSilent]);

  // Render helper — "Note" hover button for a task row. Keeps the
  // existing row JSX otherwise untouched so every entrypoint (Today's /
  // Upcoming / Floating) shares the same action wiring.
  const renderTaskNoteAction = (t) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        const key = `task:${t.id}`;
        if (inlineNoteRowKey === key) closeInlineNote();
        else openInlineNote(key, t.completionNote || '');
      }}
      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-[10px] font-bold text-primary hover:underline"
      title="Add note"
    >
      Note
    </button>
  );

  const renderTaskDeleteAction = (t) => (
    <button
      onClick={(e) => { e.stopPropagation(); deleteTaskRow(t); }}
      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-on-surface-variant hover:text-error"
      title="Delete task"
    >
      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>delete</span>
    </button>
  );

  // Inline textarea row rendered directly under a task when its note is
  // open. Enter submits, Escape closes. Empty submit silently closes.
  const renderInlineTaskTextarea = (t) => (
    inlineNoteRowKey === `task:${t.id}` ? (
      <div className="px-3 pb-3 pl-10" onClick={(e) => e.stopPropagation()}>
        <textarea
          autoFocus
          value={inlineNoteDraft}
          onChange={(e) => setInlineNoteDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeInlineNote(); }
            else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveTaskInlineNote(t.id); }
          }}
          placeholder="Quick note — outcome, follow-up, color…"
          className="w-full text-[12px] p-2 rounded-md border border-surface-container-high bg-surface-container-lowest outline-none focus:border-primary resize-y min-h-[50px]"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        />
        <div className="flex gap-1.5 mt-1.5 justify-end">
          <button onClick={closeInlineNote} className="text-[10px] font-bold text-on-surface-variant hover:underline">Cancel</button>
          <button
            onClick={() => saveTaskInlineNote(t.id)}
            disabled={!inlineNoteDraft.trim()}
            className="text-[10px] font-bold text-primary hover:underline disabled:opacity-40"
          >Save</button>
        </div>
      </div>
    ) : null
  );

  // Timeline row — same pattern, past-only guard lives at the caller
  // because "past" depends on the event's start/end vs. now.
  const renderEventNoteAction = (ev) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        const key = `event:${ev.id}`;
        if (inlineNoteRowKey === key) closeInlineNote();
        else openInlineNote(key, '');
      }}
      className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-[10px] font-bold text-primary hover:underline"
      title="Add meeting notes"
    >
      Notes
    </button>
  );

  const renderInlineEventTextarea = (ev) => (
    inlineNoteRowKey === `event:${ev.id}` ? (
      <div className="mt-2 pl-10" onClick={(e) => e.stopPropagation()}>
        <textarea
          autoFocus
          value={inlineNoteDraft}
          onChange={(e) => setInlineNoteDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); closeInlineNote(); }
            else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEventInlineNote(ev); }
          }}
          placeholder="Meeting outcomes, decisions, follow-ups…"
          className="w-full text-[12px] p-2 rounded-md border border-surface-container-high bg-surface-container-lowest outline-none focus:border-primary resize-y min-h-[50px]"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        />
        <div className="flex gap-1.5 mt-1.5 justify-end">
          <button onClick={closeInlineNote} className="text-[10px] font-bold text-on-surface-variant hover:underline">Cancel</button>
          <button
            onClick={() => saveEventInlineNote(ev)}
            disabled={!inlineNoteDraft.trim()}
            className="text-[10px] font-bold text-primary hover:underline disabled:opacity-40"
          >Save</button>
        </div>
      </div>
    ) : null
  );

  // Past-event guard for timeline hover action. All-day events show the
  // hover action only after midnight (their "end" has passed).
  const isEventPast = (ev) => {
    try {
      if (ev.allDay) return ev.end && ev.end <= new Date().toISOString().slice(0, 10);
      return new Date(ev.start).getTime() < Date.now();
    } catch { return false; }
  };
  const [ccRefreshing, setCcRefreshing] = useState(false);
  const ccScrollRef = useRef(null);
  const lastCheckedRef = useRef(new Date().toISOString());
  const ccAutoRefreshedRef = useRef(false);

  // Rotating thinking messages — intent-aware. Each set is a small
  // sequence rotated every 1.8s while loading. Intent is set in
  // handleCcSend from a quick keyword check on the user message.
  const THINKING_MESSAGES = {
    email:   ['Thinking...', 'Accessing your Gmail...', 'Checking contacts...', 'Almost there...'],
    task:    ['Thinking...', 'Checking your tasks...', 'Almost there...'],
    event:   ['Thinking...', 'Checking your calendar...', 'Almost there...'],
    default: ['Thinking...', 'Working on it...', 'Almost there...'],
  };
  const [thinkingIdx, setThinkingIdx] = useState(0);
  const [thinkingIntent, setThinkingIntent] = useState('default');
  const thinkingMessagesForIntent = THINKING_MESSAGES[thinkingIntent] || THINKING_MESSAGES.default;
  useEffect(() => {
    if (!ccLoading && !ccSending) {
      // Reset for the next turn so the placeholder doesn't carry stale intent.
      setThinkingIntent('default');
      return;
    }
    const set = THINKING_MESSAGES[thinkingIntent] || THINKING_MESSAGES.default;
    setThinkingIdx(0);
    const timer = setInterval(() => setThinkingIdx((i) => (i + 1) % set.length), 1800);
    return () => clearInterval(timer);
  }, [ccLoading, ccSending, thinkingIntent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom — but only when the user is already at (or
  // near) the bottom. If they've scrolled up to read history, leave
  // them there. ≥100px from bottom = "reading mode."
  const SCROLL_AT_BOTTOM_THRESHOLD_PX = 100;
  const userScrolledAwayRef = useRef(false);
  const handleCcScroll = useCallback(() => {
    const el = ccScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledAwayRef.current = distanceFromBottom > SCROLL_AT_BOTTOM_THRESHOLD_PX;
  }, []);
  const scrollToBottom = useCallback(() => {
    if (userScrolledAwayRef.current) return;
    requestAnimationFrame(() => {
      if (ccScrollRef.current) ccScrollRef.current.scrollTop = ccScrollRef.current.scrollHeight;
    });
  }, []);

  useEffect(() => { scrollToBottom(); }, [ccMessages.length, scrollToBottom]);

  // Mirror ccMessages into a ref so callbacks (handleCcSend) can read the
  // latest committed state without depending on ccMessages in their deps.
  useEffect(() => { ccMessagesRef.current = ccMessages; }, [ccMessages]);
  useEffect(() => { ccSendingRef.current = ccSending; }, [ccSending]);
  // 60s safety-net: if ccSending stays true for a full minute, force-
  // reset it. This covers edge cases where the SSE stream silently dies
  // (network change, server restart) and the finally block never fires.
  useEffect(() => {
    if (!ccSending) return;
    const timer = setTimeout(() => {
      console.warn('[CC] 60s input-lock timeout — force-resetting ccSending');
      ccStoppedRef.current = false;
      ccAbortRef.current = null;
      setCcSending(false);
    }, 60_000);
    return () => clearTimeout(timer);
  }, [ccSending]);
  useEffect(() => { activeZoneStateRef.current = activeZoneState; }, [activeZoneState]);

  // Persist CC messages to localStorage on every change
  useEffect(() => {
    if (ccMessages.length > 0) {
      try { localStorage.setItem(ccStorageKey, JSON.stringify(ccMessages)); } catch {}
    }
  }, [ccMessages, ccStorageKey]);

  // Poll for command center updates — Aria narrates updates via /api/chat/stream
  const pollUpdatesRef = useRef(null);
  pollUpdatesRef.current = async (convId) => {
    // Bug 2 guard — never narrate background updates while a user turn
    // is in flight. The narration call hits /api/chat/execute (the
    // SAME endpoint as the user turn) and pushes an assistant bubble
    // alongside the user's still-streaming placeholder, racing the
    // primary response. Skip this cycle; the next 60s poll picks it up
    // (cursor doesn't advance, so updates aren't lost).
    if (ccSendingRef.current) {
      return;
    }
    try {
      const res = await apiFetch(`/api/dashboard/command-center/updates?since=${encodeURIComponent(lastCheckedRef.current)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      // Advance the cursor ONLY after we know we got a usable response.
      // Prior code moved it immediately after the fetch — if the request
      // errored or the JSON parse failed, the cursor still moved and the
      // next poll skipped the missed window forever.
      if (!res.ok) return;
      const { updates } = await res.json();
      if (!updates || updates.length === 0) {
        // Empty page — safe to advance cursor.
        lastCheckedRef.current = new Date().toISOString();
        return;
      }

      // Second-chance gate — user may have started typing during the
      // updates fetch above. Re-check before launching the narration
      // turn (which holds the SSE channel for up to 30s).
      // Cursor is intentionally NOT advanced here — the next poll will
      // pick up these same updates and try again, so we don't drop them.
      if (ccSendingRef.current) return;
      // Cursor advance moved to AFTER successful narration save below
      // so an interrupted narration doesn't lose its updates either.

      // Build a natural prompt for Aria from the raw updates
      const updateSummary = updates.map((u) => u.content).join('\n');

      // Recency suppression — if the update content overlaps with topics
      // the user just discussed with Aria, stay silent. Path 3's failure
      // mode (pre-fix): server-emitted "task overdue" updates fired on
      // tasks the user literally just created with Aria one turn earlier.
      // Cursor advances on suppress: the update was seen and consciously
      // dropped. Refusing to advance creates a guaranteed-suppress hot
      // loop until the chat goes quiet.
      const overlap = topicOverlapsRecentChat(updateSummary, ccMessagesRef.current, SUPPRESSION_RECENCY_WINDOW_MS);
      if (overlap.overlap) {
        if (typeof window !== 'undefined') {
          console.log('[CC.poll] suppressed', {
            reason: 'topic_overlap',
            matched_tokens: overlap.matchedTokens,
            recent_msg_ts: overlap.recentMsgTs,
            update_id: updates[0]?.id || null,
            cursor: lastCheckedRef.current,
          });
        }
        lastCheckedRef.current = new Date().toISOString();
        return;
      }

      // Build full context system prompt
      const aName = currentUser?.assistantName || 'Aria';
      const fullContext = buildSystemPrompt(tasks, entities, notes, chatCalendarEvents || calendarEvents, currentUser?.timezone);
      const sysPrompt = `You are ${aName}, ${firstName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything asked: advice, research, cooking, ideas, business, personal, anything. You also have action tools available to create tasks, notes, and calendar events. Use your tools when the user is asking you to take an action. For everything else, just respond naturally and conversationally. Be warm, direct, and concise. No sign-off.\n\nThe user is in active conversation with you in this command center. Recent messages between you and the user are included below as context. Do NOT restate things you and the user just discussed — only narrate genuinely new context. If the new events are things the user already addressed with you, stay silent rather than echo.\n\n${fullContext}`;

      // Last 10 turns as conversation history so the LLM sees what was
      // just discussed even when the token-overlap heuristic missed it
      // (paraphrasing, pronouns). Belt-and-suspenders with the gate above.
      const recentMsgs = (ccMessagesRef.current || [])
        .slice(-10)
        .map((m) => ({ role: m.role, content: String(m.content || '') }))
        .filter((m) => m.role && m.content);

      const ariaPrompt = `The following new events just occurred in the background. Narrate them to the user naturally and concisely in your voice as Aria — do not just repeat the raw text. Be brief, warm, and actionable:\n\n${updateSummary}`;

      // Stream Aria's narration
      const streamRes = await apiFetch('/api/chat/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          systemPrompt: sysPrompt,
          messages: [...recentMsgs, { role: 'user', content: ariaPrompt }],
          timeZone: userTZ,
        }),
      });

      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let ariaResponse = '';
      let currentEvent = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const rawLine of lines) {
          const eventMatch = rawLine.match(/^event: (.+)/);
          const dataMatch  = rawLine.match(/^data: (.+)/);

          if (eventMatch) {
            currentEvent = eventMatch[1].trim();
          }

          if (dataMatch && currentEvent) {
            try {
              const parsed = JSON.parse(dataMatch[1]);

              if (currentEvent === 'text') {
                ariaResponse = parsed.content || '';
              } else if (currentEvent === 'tools_executed') {
                const tools = parsed.tools || [];
                if (tools.some(t => ['create_task', 'complete_task', 'update_task', 'delete_task'].includes(t))) {
                  onReloadTasks?.();
                }
                if (tools.some(t => ['create_note', 'update_note', 'delete_note'].includes(t))) {
                  onReloadNotes?.();
                }
              } else if (currentEvent === 'error') {
                console.error('[SSE] error:', parsed.message);
              }
            } catch (e) {
              // malformed data line, skip
            }
            currentEvent = null;
          }
        }
      }

      if (!ariaResponse) return;

      // Final gate before commit — if the user typed while we were
      // streaming, suppress the narration to keep the chat focused on
      // the user's question. Cursor stays unadvanced so next poll
      // re-narrates these updates when the channel is free.
      if (ccSendingRef.current) return;

      // Save and append as Aria message
      await apiFetch(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ role: 'assistant', content: ariaResponse, model: 'claude' }),
      });

      setCcMessages((prev) => [...prev, { role: 'assistant', content: ariaResponse, createdAt: new Date().toISOString(), ts: Date.now() }]);
      // Advance cursor only after we successfully committed the narration.
      lastCheckedRef.current = new Date().toISOString();
    } catch (err) {
      console.error('[CommandCenter] poll failed:', err);
    }
  };

  // Init: load or create command center session — extracted to ref for trigger flexibility
  const ccInitRunningRef = useRef(false);
  const ccPollIntervalRef = useRef(null);

  // Cross-trigger brief-composition guard. Multiple callsites
  // (initCommandCenter + handleFreshUpdate) both hit /api/dashboard/aria-brief;
  // without coordination, a hard refresh could fire two LLM composes back-to-
  // back when the visibility-change fresh-update path races init's fallback.
  // `composeBriefOnce` serializes the two sites:
  //   - in-flight: any concurrent caller awaits the same promise
  //   - fresh: if the last compose resolved <10s ago, reuse its result
  const briefInFlightRef = useRef(null);        // Promise|null
  const briefLastResultRef = useRef(null);      // { brief: string, ts: number } | null
  const BRIEF_FRESH_MS = 10_000;
  const composeBriefOnce = useCallback(async (payloadFn) => {
    // Fresh cache — skip LLM entirely.
    const cached = briefLastResultRef.current;
    if (cached && Date.now() - cached.ts < BRIEF_FRESH_MS) {
      return { brief: cached.brief, source: 'fresh_cache' };
    }
    // In-flight coalesce — second caller piggybacks on the first's Promise.
    if (briefInFlightRef.current) {
      return briefInFlightRef.current.then((brief) => ({ brief, source: 'in_flight_join' }));
    }
    const p = (async () => {
      const briefRes = await apiFetch('/api/dashboard/aria-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(payloadFn()),
      });
      const { brief } = await briefRes.json();
      briefLastResultRef.current = { brief, ts: Date.now() };
      return brief;
    })();
    briefInFlightRef.current = p;
    try {
      const brief = await p;
      return { brief, source: 'llm' };
    } finally {
      briefInFlightRef.current = null;
    }
  }, [apiFetch, authToken]);

  const initCommandCenterRef = useRef(null);
  initCommandCenterRef.current = async () => {
    if (!currentUser?.id || ccInitRunningRef.current) return;
    ccInitRunningRef.current = true;
    // Only show spinner if we have NO cached messages — otherwise the
    // cached messages are already visible and we sync silently.
    const hasCachedMessages = ccMessagesRef.current.length > 0;
    if (!hasCachedMessages) setCcLoading(true);
    // Guard against duplicate intervals on re-init (e.g. user-id change).
    // Prior code only set ccInitRunningRef = false on the error path, so
    // a successful init would lock the ref true forever AND each accepted
    // re-entry could leak a fresh setInterval.
    if (ccPollIntervalRef.current) {
      clearInterval(ccPollIntervalRef.current);
      ccPollIntervalRef.current = null;
    }
    try {
      // Step 1: get or create today's session
      const sessionRes = await apiFetch('/api/dashboard/command-center/session', {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const { conversation, messages } = await sessionRes.json();
      setCcConvId(conversation.id);

      // Step 2: if messages exist, load and done
      if (messages && messages.length > 0) {
        setCcMessages(messages.map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt, ts: m.createdAt ? new Date(m.createdAt).getTime() : Date.now() })));
        setCcLoading(false);
        ccPollIntervalRef.current = setInterval(() => pollUpdatesRef.current(conversation.id), 60000);
        return;
      }

      // Step 3: no messages — generate brief first. Server derives time
      // state from req.user.timezone so no timeOfDay needed here.
      // Routes through composeBriefOnce so handleFreshUpdate firing
      // moments later doesn't double-compose.
      const aName = currentUser?.assistantName || 'Aria';
      const { brief, source: briefSource } = await composeBriefOnce(() => ({
        apiKey: apiKeys?.claude || '',
        assistantName: aName,
        persona: 'executive_assistant',
        userName: firstName,
        data: {
          overdue: initialBriefData?.overdue || overdueTasks.map((t) => t.title).join(', ') || 'None',
          highPriority: initialBriefData?.highPriority || highPriorityTasks.map((t) => t.title).join(', ') || 'None',
          todayTasks: initialBriefData?.todayTasks || todayTasks.map((t) => t.title).join(', ') || 'None',
          events: calendarEvents.map((e) => e.title).join(', ') || 'None',
          notesCount: notes?.length || 0,
          entities: (entities || []).map((e) => e.name).join(', ') || 'None',
        },
      }));
      if (typeof window !== 'undefined') {
        console.log('[CC.init] brief composed', { source: briefSource });
      }

      // Step 4: save brief as message 1
      if (brief) {
        await apiFetch(`/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ role: 'assistant', content: brief, model: 'claude' }),
        });

        setCcMessages([{ role: 'assistant', content: brief, createdAt: new Date().toISOString(), ts: Date.now() }]);
      }

      setCcLoading(false);
      ccPollIntervalRef.current = setInterval(() => pollUpdatesRef.current(conversation.id), 60000);
    } catch (err) {
      console.error('[CommandCenter] init failed:', err);
      setCcLoading(false);
    } finally {
      // Always release the ref so a future user-change or remount can
      // re-init. Prior code only released on error → success locked
      // it forever.
      ccInitRunningRef.current = false;
    }
  };

  // Trigger init when initialBriefData arrives (computed in App.jsx right after tasks load)
  useEffect(() => {
    if (!currentUser?.id) return;
    if (!initialBriefData) return;
    if (ccConvId || ccInitRunningRef.current) return;
    initCommandCenterRef.current();
  }, [initialBriefData, currentUser?.id, ccConvId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fallback: if user genuinely has zero tasks, fire after 5s regardless
  useEffect(() => {
    if (!currentUser?.id) return;
    const fallback = setTimeout(() => {
      if (!ccConvId && !ccInitRunningRef.current) initCommandCenterRef.current();
    }, 5000);
    return () => clearTimeout(fallback);
  }, [currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (ccPollIntervalRef.current) clearInterval(ccPollIntervalRef.current);
    };
  }, []);

  // ── Fresh update logic ──────────────────────────────────────────────────────
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  function getLastMessageTimestamp(msgs) {
    if (!msgs || msgs.length === 0) return 0;
    const last = msgs[msgs.length - 1];
    if (last.ts) return last.ts;
    if (last.createdAt) return new Date(last.createdAt).getTime();
    return Date.now() - REFRESH_INTERVAL_MS - 60_000; // default: stale
  }

  const needsRefresh = useMemo(() => {
    if (ccLoading || ccRefreshing || ccSending || ccMessages.length === 0) return false;
    const lastTs = getLastMessageTimestamp(ccMessages);
    return (Date.now() - lastTs) > REFRESH_INTERVAL_MS;
  }, [ccMessages, ccLoading, ccRefreshing, ccSending]);

  const handleFreshUpdate = useCallback(async () => {
    if (!ccConvId || ccRefreshing) return;
    setCcRefreshing(true);
    try {
      // Server derives time state from req.user.timezone.
      // Routes through composeBriefOnce so a race with initCommandCenter's
      // fallback brief call doesn't double-compose.
      const aName = currentUser?.assistantName || 'Aria';
      const briefData = {
        overdue: overdueTasks.map((t) => t.title).join(', ') || 'None',
        highPriority: highPriorityTasks.map((t) => t.title).join(', ') || 'None',
        todayTasks: todayTasks.map((t) => t.title).join(', ') || 'None',
        events: calendarEvents.map((e) => e.title).join(', ') || 'None',
        notesCount: notes?.length || 0,
        entities: (entities || []).map((e) => e.name).join(', ') || 'None',
      };
      // Semantic dedup: hash the composer INPUTS (not the LLM output).
      // Identical inputs → identical meaning regardless of wording. djb2
      // is plenty for short deterministic strings on a single session;
      // collision risk is negligible for this vocabulary.
      const inputHash = (() => {
        const s = JSON.stringify(briefData);
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
        return (h >>> 0).toString(16);
      })();
      // Recency suppression — orthogonal to inputHash. inputHash catches
      // identical-payload duplicates; this catches "different payload, but
      // every meaningful topic is something the user just discussed with
      // me". Cheaper to skip pre-compose than to LLM-render-and-discard.
      const briefTopicSummary = [briefData.overdue, briefData.highPriority, briefData.todayTasks, briefData.events].join(' ');
      const overlap = topicOverlapsRecentChat(briefTopicSummary, ccMessagesRef.current, SUPPRESSION_RECENCY_WINDOW_MS);
      if (overlap.overlap) {
        if (typeof window !== 'undefined') {
          console.log('[CC.freshUpdate] suppressed', {
            reason: 'topic_overlap',
            matched_tokens: overlap.matchedTokens,
            recent_msg_ts: overlap.recentMsgTs,
            input_hash: inputHash,
          });
        }
        return;
      }
      const { brief, source: briefSource } = await composeBriefOnce(() => ({
        apiKey: apiKeys?.claude || '',
        assistantName: aName,
        persona: 'executive_assistant',
        userName: firstName,
        data: briefData,
      }));
      if (typeof window !== 'undefined') {
        console.log('[CC.freshUpdate] brief composed', { source: briefSource, inputHash });
      }
      // If init just composed and we're inside the fresh window, we'd be
      // echoing its brief into the conversation as a new message. Skip
      // the append entirely when the source is cache/in_flight — init
      // already rendered it.
      if (briefSource === 'fresh_cache' || briefSource === 'in_flight_join') {
        return;
      }
      const content = brief || 'Nothing new to report — you\'re all caught up!';
      const now = new Date().toISOString();

      // Result handling — three paths driven by semantic dedup on inputHash.
      // NOTE: proactive narrations are CLIENT-ONLY ephemeral. They used to
      // POST to /api/conversations/:id/messages, which persisted a growing
      // stack across reloads. Now they only update ccMessages; init's
      // brief remains the sole server-persisted entry for the day.
      setCcMessages((prev) => {
        // Find the most recent prior proactive narration.
        let prevProactiveIdx = -1;
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i]?.update_type === 'proactive_brief') { prevProactiveIdx = i; break; }
        }
        // Path 1 — same inputs as the prior proactive. Skip entirely.
        if (prevProactiveIdx >= 0 && prev[prevProactiveIdx]?.input_hash === inputHash) {
          if (typeof window !== 'undefined') console.log('[CC.freshUpdate] skipped', { reason: 'semantic_dedup', inputHash });
          return prev;
        }
        const newMsg = {
          role: 'assistant',
          update_type: 'proactive_brief',
          input_hash: inputHash,
          content,
          createdAt: now,
          ts: Date.now(),
        };
        // Path 2 — different inputs and a prior proactive exists. Replace in place.
        if (prevProactiveIdx >= 0) {
          if (typeof window !== 'undefined') console.log('[CC.freshUpdate] replaced', { inputHash });
          const updated = [...prev];
          updated[prevProactiveIdx] = newMsg;
          return updated;
        }
        // Path 3 — no prior proactive (first one this session). Append.
        if (typeof window !== 'undefined') console.log('[CC.freshUpdate] appended', { inputHash });
        return [...prev, newMsg];
      });
    } catch (err) {
      console.error('[CommandCenter] fresh update failed:', err);
      setCcMessages((prev) => [...prev, { role: 'assistant', content: 'Couldn\'t fetch an update right now — try again in a moment.', createdAt: new Date().toISOString(), ts: Date.now() }]);
    } finally {
      setCcRefreshing(false);
    }
  }, [ccConvId, ccRefreshing, currentUser, firstName, apiKeys, authToken, apiFetch, overdueTasks, highPriorityTasks, todayTasks, calendarEvents, notes, entities, composeBriefOnce]);

  // Auto-refresh on visibility change (returning to tab after 5min)
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== 'visible') return;
      if (!ccConvId || ccLoading || ccRefreshing || ccSending) return;
      if (ccMessages.length === 0) return;
      const elapsed = Date.now() - getLastMessageTimestamp(ccMessages);
      if (elapsed > REFRESH_INTERVAL_MS && !ccAutoRefreshedRef.current) {
        ccAutoRefreshedRef.current = true;
        handleFreshUpdate().finally(() => { ccAutoRefreshedRef.current = false; });
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [ccConvId, ccLoading, ccRefreshing, ccSending, ccMessages, handleFreshUpdate]);

  // Send user message + stream Aria response
  const handleCcSend = useCallback(async (textOverride) => {
    const text = (typeof textOverride === 'string' ? textOverride : ccInput).trim();
    if (!text || ccSending || !ccConvId) return;
    setCcInput('');
    setCcSending(true);
    ccStoppedRef.current = false;
    const controller = new AbortController();
    ccAbortRef.current = controller;

    // Mark activity so the 30-min idle summon doesn't fire immediately.
    lastActivityRef.current = Date.now();

    // Lightweight intent detection — drives the rotating placeholder copy
    // and decides whether to inject the user's connected Gmail accounts.
    const lower = text.toLowerCase();
    const emailIntent = /email|send|reply|message|gmail/.test(lower);
    const taskIntent  = /task|remind|todo|follow.?up/.test(lower);
    const eventIntent = /schedul|meeting|calendar|event|block/.test(lower);
    if (emailIntent)      setThinkingIntent('email');
    else if (taskIntent)  setThinkingIntent('task');
    else if (eventIntent) setThinkingIntent('event');
    else                  setThinkingIntent('default');

    // Active zone is action-only. Context/summary intents now flow through
    // Aria's chat reply — we no longer render the static card block here.
    // Tile/email/notes/outcome/close_loop/success have their own lifecycles
    // and are preserved by not clearing the zone when one is active.
    const contextIntent = /what('s| is) (going on|happening|on my|my day)|catch me up|what do i have|good morning/i;
    const wantsContext = contextIntent.test(text);
    setActiveZoneState((s) => {
      if (s === 'tile' || s === 'email' || s === 'notes' || s === 'outcome' || s === 'close_loop' || s === 'success') return s;
      return 'empty';
    });
    if (wantsContext) fetchBriefContext();

    const userMsg = { role: 'user', content: text, createdAt: new Date().toISOString(), ts: Date.now() };
    setCcMessages((prev) => [...prev, userMsg]);

    // Save user message
    try {
      await apiFetch(`/api/conversations/${ccConvId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ role: 'user', content: text }),
      });
    } catch {}

    // Auto-name CC conversation from first user message
    const userMsgCount = ccMessages.filter((m) => m.role === 'user').length;
    if (userMsgCount === 0) {
      const autoTitle = text.length > 50 ? text.slice(0, 50).trim() + '...' : text.trim();
      try {
        await apiFetch(`/api/conversations/${ccConvId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ title: autoTitle }),
        });
      } catch {}
    }

    // ── Dynamic tile intercept: parse task/event intent first ──
    // If the message is a task/event ask, render an inline editable
    // draft tile instead of running the agentic loop. default_chat
    // falls through to the normal flow below.
    // Skip the intercept entirely when the user is mid-wrap — Aria
    // is conversing about reflection and short replies like "good
    // day" shouldn't get re-classified as a task.
    if (activeZoneStateRef.current === 'daily_wrap') {
      // fall through to normal chat streaming below
    } else try {
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: userTZ, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      // Freshness gate on lastCreatedProjectTaskRef (stale after 60s).
      const lpt = lastCreatedProjectTaskRef.current;
      const freshLastTask = lpt && (Date.now() - lpt.ts < 60000) ? lpt : null;
      const draft = await parseActionDraft({
        apiFetch, authToken, message: text, timezone: userTZ, today,
        entities, projects: briefContext?.projects,
        lastProjectTask: freshLastTask,
      });
      // Daily Wrap: open the conversational flow. No tile, no tool call —
      // Aria continues in chat using the DAILY WRAP context block + the
      // journal/close-loop tools. Zone flips to 'daily_wrap' so the
      // user's next "what went well" reply stays in-context and doesn't
      // get caught by the tile intercept again.
      if (draft && draft.type === 'daily_wrap_chat') {
        const now = new Date().toISOString();
        setCcMessages((prev) => [
          ...prev,
          { role: 'assistant', content: "Ready to wrap your day? Let's start — what went well today?", createdAt: now, ts: Date.now() },
        ]);
        setActiveZoneState('daily_wrap');
        ccAbortRef.current = null;
        setCcSending(false);
        return;
      }
      // Clarify: ambiguous task/project — ask and bail, no tile.
      if (draft && draft.type === 'clarify') {
        const now = new Date().toISOString();
        setCcMessages((prev) => [
          ...prev,
          { role: 'assistant', content: draft.question || 'Should I add this to a project or as a standalone task?', createdAt: now, ts: Date.now() },
        ]);
        ccAbortRef.current = null;
        setCcSending(false);
        return;
      }
      if (draft && (draft.type === 'task' || draft.type === 'event' || draft.type === 'project' || draft.type === 'project_task' || draft.type === 'checklist')) {
        // Project with no resolved entity → ask for clarification, no tile.
        if (draft.type === 'project' && !draft.entity_id) {
          const now = new Date().toISOString();
          setCcMessages((prev) => [
            ...prev,
            { role: 'assistant', content: 'Which entity should this project belong to?', createdAt: now, ts: Date.now() },
          ]);
          ccAbortRef.current = null;
          setCcSending(false);
          return;
        }
        // Checklist with no resolved task → ask which task, no tile.
        if (draft.type === 'checklist' && !draft.project_task_id) {
          const now = new Date().toISOString();
          setCcMessages((prev) => [
            ...prev,
            { role: 'assistant', content: 'Which task should I add these to?', createdAt: now, ts: Date.now() },
          ]);
          ccAbortRef.current = null;
          setCcSending(false);
          return;
        }
        // Project task with no resolved project → ask for clarification, no tile.
        if (draft.type === 'project_task' && !draft.project_id) {
          const now = new Date().toISOString();
          setCcMessages((prev) => [
            ...prev,
            { role: 'assistant', content: 'Which project should I add this task to?', createdAt: now, ts: Date.now() },
          ]);
          ccAbortRef.current = null;
          setCcSending(false);
          return;
        }
        let ack;
        if (draft.type === 'task') ack = draft.confidence === 'high' ? "Got it — here's the task" : "Here's a task draft";
        else if (draft.type === 'event') ack = draft.confidence === 'high' ? "Got it — here's the event" : "Here's the event draft";
        else if (draft.type === 'project_task') ack = `I drafted a task for ${draft.project_name}: ${draft.title}. Confirm to create it.`;
        else if (draft.type === 'checklist') ack = draft.items?.length
          ? `Here are ${draft.items.length} item${draft.items.length === 1 ? '' : 's'} for ${draft.task_title}. Confirm to add.`
          : `Add checklist items to ${draft.task_title} below.`;
        else ack = `I drafted a new project for ${draft.entity_name}: ${draft.title}. Confirm to create it.`;
        const tileId = `tile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        let payload;
        let role;
        if (draft.type === 'task') {
          role = 'task_draft';
          payload = { title: draft.title, due_date: draft.due_date || '', due_time: to24hTo12h(draft.due_time), priority: draft.priority || 'medium' };
        } else if (draft.type === 'event') {
          role = 'event_draft';
          payload = { title: draft.title, start_time: draft.start_time, duration_minutes: draft.duration_minutes || 60 };
        } else if (draft.type === 'project_task') {
          role = 'project_task_draft';
          payload = {
            title: draft.title,
            project_id: draft.project_id,
            project_name: draft.project_name,
            entity_id: draft.entity_id,
            entity_name: draft.entity_name,
            description: draft.description || '',
          };
        } else if (draft.type === 'checklist') {
          role = 'checklist_draft';
          const seedItems = Array.isArray(draft.items) && draft.items.length ? draft.items : [''];
          payload = {
            project_task_id: draft.project_task_id,
            task_title: draft.task_title,
            project_name: draft.project_name,
            entity_id: draft.entity_id,
            items: seedItems,
          };
        } else {
          role = 'project_draft';
          payload = { title: draft.title, entity_id: draft.entity_id, entity_name: draft.entity_name, description: draft.description || '' };
        }
        const now = new Date().toISOString();
        setCcMessages((prev) => [
          ...prev,
          { role: 'assistant', content: ack, createdAt: now, ts: Date.now() },
        ]);
        setActiveTile({
          role,
          id: tileId,
          type: draft.type,
          status: 'draft',
          confidence: draft.confidence || 'medium',
          payload,
          createdAt: now,
          ts: Date.now(),
        });
        setActiveZoneState('tile');
        ccAbortRef.current = null;
        setCcSending(false);
        return;
      }
    } catch { /* parser failure → fall through to normal chat */ }

    // Build context: last 10 messages + full Aria system prompt with live data.
    // Read from ref so we always see the latest committed state.
    const recentMsgs = [...ccMessagesRef.current.slice(-9), userMsg].map((m) => ({ role: m.role, content: m.content }));

    // Email-intent: inject the list of connected Gmail accounts inline so
    // Aria doesn't ask "which account?". Best-effort — silent fall-through
    // on failure so non-email turns and offline cases proceed normally.
    if (emailIntent) {
      const gmailCtrl = new AbortController();
      const gmailTimer = setTimeout(() => gmailCtrl.abort(), 2000);
      try {
        const accountsRes = await apiFetch('/api/gmail/accounts', {
          headers: { Authorization: `Bearer ${authToken}` },
          signal: gmailCtrl.signal,
        });
        if (accountsRes.ok) {
          const accounts = await accountsRes.json();
          if (Array.isArray(accounts) && accounts.length > 0) {
            const accountList = accounts.map(a => a.account_email).filter(Boolean).join(', ');
            if (accountList) {
              const last = recentMsgs[recentMsgs.length - 1];
              if (last && last.role === 'user' && typeof last.content === 'string') {
                last.content = `${last.content}\n\n[User's connected Gmail accounts: ${accountList}. Use the most appropriate one or the first if unclear. Do not ask the user which account to use.]`;
              }
            }
          }
        }
      } catch {} finally {
        clearTimeout(gmailTimer);
      }
    }

    const aName = currentUser?.assistantName || 'Aria';
    const fullContext = buildSystemPrompt(tasks, entities, notes, chatCalendarEvents || calendarEvents);
    const sysPrompt = `You are ${aName}, ${firstName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything asked: advice, research, cooking, ideas, business, personal, anything. You also have action tools available to create tasks, notes, and calendar events. Use your tools when the user is asking you to take an action. For everything else, just respond naturally and conversationally. Be warm, direct, and concise. No sign-off.\n\n${fullContext}`;

    // Stream response
    let fullResponse = '';
    setCcMessages((prev) => [...prev, { role: 'assistant', content: '', createdAt: new Date().toISOString(), ts: Date.now() }]);

    try {
      const res = await apiFetch('/api/chat/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          systemPrompt: sysPrompt,
          messages: recentMsgs,
          timeZone: userTZ,
        }),
        signal: controller.signal,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let currentEvent = null;

      while (true) {
        if (ccStoppedRef.current) { try { await reader.cancel(); } catch {} break; }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const rawLine of lines) {
          if (ccStoppedRef.current) break;
          const eventMatch = rawLine.match(/^event: (.+)/);
          const dataMatch  = rawLine.match(/^data: (.+)/);

          if (eventMatch) {
            currentEvent = eventMatch[1].trim();
          }

          if (dataMatch && currentEvent) {
            try {
              const parsed = JSON.parse(dataMatch[1]);

              if (currentEvent === 'text') {
                if (ccStoppedRef.current) { currentEvent = null; continue; }
                fullResponse = parsed.content || '';
                setCcMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { ...updated[updated.length - 1], content: fullResponse };
                  return updated;
                });
              } else if (currentEvent === 'tools_executed') {
                const tools = parsed.tools || [];
                if (tools.some(t => ['create_task', 'complete_task', 'update_task', 'delete_task'].includes(t))) {
                  onReloadTasks?.();
                }
                if (tools.some(t => ['create_note', 'update_note', 'delete_note'].includes(t))) {
                  onReloadNotes?.();
                }
              } else if (currentEvent === 'skills_loaded') {
                // M2.6 — attach loaded-skill metadata to the assistant
                // message so it can render the inline indicator.
                const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
                if (skills.length) {
                  setCcMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.role === 'assistant') {
                      updated[updated.length - 1] = { ...last, loadedSkills: skills };
                    }
                    return updated;
                  });
                }
              } else if (currentEvent === 'email_draft') {
                // Full draft preview — rendered in the active zone now.
                const draftTs = Date.now();
                activeEmailDraftTsRef.current = draftTs;
                setActiveTile({
                  role: 'email_draft',
                  draft: parsed.draft || {},
                  createdAt: new Date().toISOString(),
                  ts: draftTs,
                });
                setActiveZoneState('email');
              } else if (currentEvent === 'tool_confirm') {
                // Inject an inline confirmation card BEFORE the (empty) assistant placeholder
                setCcMessages((prev) => {
                  const updated = [...prev];
                  const placeholder = updated.pop();
                  updated.push({
                    role: 'confirm',
                    confirmId: parsed.confirm_id,
                    tool: parsed.tool,
                    params: parsed.params || {},
                    risk: parsed.risk || 'high',
                    status: 'pending',
                    createdAt: new Date().toISOString(),
                    ts: Date.now(),
                  });
                  if (placeholder) updated.push(placeholder);
                  return updated;
                });
              } else if (currentEvent === 'done') {
                // Terminal state: if the trailing placeholder never received
                // real text, drop it so the rotating "Thinking…" / "Almost
                // there…" status can't linger on screen.
                if (!fullResponse) {
                  setCcMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last && last.role === 'assistant' && !last.content) updated.pop();
                    return updated;
                  });
                }
              } else if (currentEvent === 'error') {
                console.error('[SSE] error:', parsed.message);
                setCcMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last && last.role === 'assistant' && !last.content) updated.pop();
                  return updated;
                });
              }
            } catch (e) {
              // malformed data line, skip
            }
            currentEvent = null;
          }
        }
      }

      // Post-stream cleanup: if the placeholder never received text (e.g.
      // the backend emitted `done` with empty text, or the stream closed
      // without a `done` event), drop the empty bubble so the rotating
      // thinking status can't linger.
      if (!fullResponse) {
        setCcMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant' && !last.content) updated.pop();
          return updated;
        });
      }

      // Save assistant response (skip if user stopped mid-stream)
      if (fullResponse && !ccStoppedRef.current) {
        await apiFetch(`/api/conversations/${ccConvId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ role: 'assistant', content: fullResponse }),
        });
      }
    } catch (err) {
      const aborted = err?.name === 'AbortError' || ccStoppedRef.current;
      if (aborted) {
        // Leave any partial text already in the placeholder alone. If the
        // placeholder is still empty, drop it so the thread isn't littered
        // with a blank bubble. A system row is added below.
        setCcMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === 'assistant' && !last.content) updated.pop();
          return updated;
        });
      } else {
        setCcMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { ...updated[updated.length - 1], content: `Error: ${err.message}` };
          return updated;
        });
      }
    } finally {
      if (ccStoppedRef.current) {
        setCcMessages((prev) => [...prev, { role: 'system', content: 'Generation stopped', createdAt: new Date().toISOString(), ts: Date.now() }]);
      }
      ccAbortRef.current = null;
      setCcSending(false);
    }
  }, [ccInput, ccSending, ccConvId, ccMessages, currentUser, firstName, apiKeys, authToken, apiFetch, tasks, entities, notes, calendarEvents, chatCalendarEvents, fetchBriefContext]);

  // Keep a live ref to the latest send handler so window-event listeners
  // can trigger a send without re-binding on every render.
  useEffect(() => { ccSendRef.current = handleCcSend; }, [handleCcSend]);

  // Cross-panel triggers: Inbox compose auto-submits here, Draft with Aria
  // just prefills the input. Both are one-shot window events.
  useEffect(() => {
    const onAutosend = (e) => {
      const msg = e?.detail?.message;
      if (!msg) return;
      setCcInput('');
      // Pass the message directly into the send handler; no race with
      // the state update cycle.
      ccSendRef.current?.(msg);
    };
    const onPrefill = (e) => {
      const msg = e?.detail?.message;
      if (!msg) return;
      setCcInput(msg);
    };
    window.addEventListener('aria-autosend', onAutosend);
    window.addEventListener('aria-prefill', onPrefill);
    return () => {
      window.removeEventListener('aria-autosend', onAutosend);
      window.removeEventListener('aria-prefill', onPrefill);
    };
  }, []);

  // ── Dynamic tile helpers ──────────────────────────────────────────────
  const updateTile = useCallback((tileId, patch) => {
    setCcMessages((prev) => prev.map((m) => {
      if (m.id !== tileId) return m;
      const nextPayload = patch && patch.payload !== undefined ? patch.payload : { ...(m.payload || {}), ...patch };
      const nextTop = patch?.payload !== undefined ? { ...m, payload: nextPayload } : { ...m, payload: nextPayload };
      return nextTop;
    }));
  }, []);

  const setTileMeta = useCallback((tileId, patch) => {
    setCcMessages((prev) => prev.map((m) => (m.id === tileId ? { ...m, ...patch } : m)));
  }, []);

  const dismissTile = useCallback((tileId) => {
    setCcMessages((prev) => prev.filter((m) => m.id !== tileId));
  }, []);

  // Track auto-dismiss timers so we can cancel them on unmount.
  const dismissTimers = useRef({});
  useEffect(() => () => {
    Object.values(dismissTimers.current).forEach(clearTimeout);
    dismissTimers.current = {};
  }, []);

  // ── Active-zone tile helpers (Phase 2) ────────────────────────────────
  const updateActiveTile = useCallback((patch) => {
    setActiveTile((prev) => {
      if (!prev) return prev;
      const nextPayload = patch && patch.payload !== undefined ? patch.payload : { ...(prev.payload || {}), ...patch };
      return { ...prev, payload: nextPayload };
    });
  }, []);

  const cancelActiveTile = useCallback(() => {
    // Close-loop tiles: fire a dismiss POST so pending_close_loop stops
    // resurfacing until tomorrow. Fire-and-forget; UI clears immediately.
    const tile = activeTile;
    if (tile?.role === 'close_loop') {
      const { source_type: sourceType, source_id: sourceId } = tile.payload || {};
      if (sourceType && sourceId) {
        apiFetch('/api/close-loop/dismiss', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ source_type: sourceType, source_id: String(sourceId) }),
        }).catch(() => {});
      }
    }
    // Reset blocking refs so the next handleCcSend isn't gated by stale state.
    ccStoppedRef.current = false;
    ccAbortRef.current = null;
    setActiveTile(null);
    setActiveZoneState('empty');
  }, [activeTile, apiFetch, authToken]);

  const executeActiveTile = useCallback(async (extra) => {
    setActiveTile((prev) => (prev ? { ...prev, status: 'executing', error: null } : prev));
    const tile = activeTile;
    if (!tile) return;
    const p = tile.payload || {};

    // Daily Wrap save: persists the four-field form + completed=true to
    // /api/journal-entries. Stamps completed_at so hasCompletedWrap
    // returns true and neither the cron push nor the web nudge fires
    // again today. Form arrives via `extra` (DailyWrapTile calls
    // onConfirm(formData)) to avoid the setState+execute tick race.
    if (tile.role === 'daily_wrap') {
      // Accept object form (Phase 9 multi-field) OR string (V1 fallback).
      let body;
      if (extra && typeof extra === 'object') {
        body = {
          wins: extra.wins || '',
          frustrations: extra.frustrations || '',
          tomorrow_focus: extra.tomorrow_focus || '',
          raw_freeform: extra.raw_freeform || '',
          completed: true,
        };
        const anyContent = !!(body.wins.trim() || body.frustrations.trim() || body.tomorrow_focus.trim() || body.raw_freeform.trim());
        if (!anyContent) { setActiveTile(null); setActiveZoneState('empty'); return; }
      } else if (typeof extra === 'string' && extra.trim()) {
        body = { raw_freeform: extra.trim(), completed: true };
      } else {
        setActiveTile(null); setActiveZoneState('empty'); return;
      }
      try {
        const r = await apiFetch('/api/journal-entries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: data.error || `HTTP ${r.status}` } : prev));
          return;
        }
        dailyWrapActedOnRef.current = true;
        setCcMessages((prev) => {
          // Dedup: skip if a wrap_saved message already exists this session
          if (prev.some(m => m.update_type === 'wrap_saved')) return prev;
          return [
            ...prev,
            { role: 'system', content: 'Wrap saved — nice close.', update_type: 'wrap_saved', createdAt: new Date().toISOString(), ts: Date.now() },
          ];
        });
        // Reset blocking refs so the next handleCcSend isn't gated by stale
        // state from a previous stopped stream or abort controller.
        ccStoppedRef.current = false;
        ccAbortRef.current = null;
        // Expire any unresolved pending confirmations in the chat.
        setCcMessages((prev) => prev.map((m) =>
          m.role === 'confirm' && m.status === 'pending'
            ? { ...m, status: 'expired' }
            : m
        ));
        setActiveZoneState('success');
        setTimeout(() => { setActiveTile(null); setActiveZoneState('empty'); }, 1500);
        bumpAzRefresh(); // AZ7 — daily_wrap_due tile should now drop
      } catch (err) {
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: err.message || 'Network error' } : prev));
      }
      return;
    }

    // Close-loop save: persist the note to the appropriate endpoint,
    // then resolve the pending_close_loop row (fire-and-forget) and
    // clear the tile. Note text arrives via the `extra` arg from
    // CloseLoopTile since payload mutation + re-invoke race on tick.
    if (tile.role === 'close_loop') {
      const sourceType = p.source_type;
      const sourceId = p.source_id;
      const note = typeof extra === 'string' ? extra.trim() : (p.note || '').trim();
      if (!note) { setActiveTile(null); setActiveZoneState('empty'); return; }
      if (!sourceType || !sourceId) {
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: 'Missing source for close-loop save' } : prev));
        return;
      }
      try {
        let r;
        if (sourceType === 'event') {
          r = await apiFetch('/api/calendar-notes/post', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({ eventId: sourceId, eventTitle: p.event_title || null, postNote: note }),
          });
        } else if (sourceType === 'task') {
          r = await apiFetch(`/api/tasks/${sourceId}/completion-note`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({ completion_note: note }),
          });
        } else {
          setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: `Unsupported source_type: ${sourceType}` } : prev));
          return;
        }
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: data.error || `HTTP ${r.status}` } : prev));
          return;
        }
        // Resolve pending_close_loop silently — do not block on failure.
        resolveCloseLoopSilent(sourceType, sourceId);
        if (sourceType === 'task') onReloadTasks?.();
        // Match daily_wrap UX: confirm with a system message + success flash
        // then decay. Without this the tile just vanishes and users report
        // "it didn't dismiss" even though state was cleared.
        setCcMessages((prev) => [
          ...prev,
          { role: 'system', content: 'Note saved.', update_type: `close_loop_saved:${sourceType}:${sourceId}`, createdAt: new Date().toISOString(), ts: Date.now() },
        ]);
        // Reset blocking refs so the next handleCcSend isn't gated by stale
        // state from a previous stopped stream or abort controller.
        ccStoppedRef.current = false;
        ccAbortRef.current = null;
        // Expire any unresolved pending confirmations in the chat so
        // they don't block future agentic turns.
        setCcMessages((prev) => prev.map((m) =>
          m.role === 'confirm' && m.status === 'pending'
            ? { ...m, status: 'expired' }
            : m
        ));
        setActiveZoneState('success');
        setTimeout(() => {
          setActiveTile(null);
          setActiveZoneState('empty');
        }, 1200);
        bumpAzRefresh(); // AZ7 — close-loop completed; tile should drop
      } catch (err) {
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: err.message || 'Network error' } : prev));
      }
      return;
    }

    // Checklist tiles batch-POST to /api/task-checklist-items.
    if (tile.type === 'checklist') {
      if (!p.project_task_id || !p.entity_id) {
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: 'No task selected' } : prev));
        return;
      }
      const cleaned = (Array.isArray(p.items) ? p.items : [])
        .map((s) => (s || '').trim())
        .filter((s) => s.length > 0);
      if (cleaned.length === 0) {
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: 'Add at least one item' } : prev));
        return;
      }
      try {
        const results = await Promise.all(cleaned.map((text) =>
          apiFetch('/api/task-checklist-items', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({ task_id: p.project_task_id, entity_id: p.entity_id, text }),
          }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})), status: r.status }))
        ));
        const failed = results.filter((r) => !r.ok || !r.data?.item);
        if (failed.length) {
          const firstErr = failed[0].data?.error || `HTTP ${failed[0].status}`;
          setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: `${failed.length}/${cleaned.length} failed: ${firstErr}` } : prev));
          return;
        }
        const now = new Date().toISOString();
        setCcMessages((prev) => [
          ...prev,
          { role: 'system', content: `${cleaned.length} checklist item${cleaned.length === 1 ? '' : 's'} added to ${p.task_title || 'task'}`, createdAt: now, ts: Date.now() },
        ]);
        setActiveZoneState('success');
        setTimeout(() => {
          setActiveTile(null);
          setActiveZoneState('empty');
          fetchBriefContext();
        }, 2000);
      } catch (err) {
        const msg = err?.message || 'Network error';
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: msg } : prev));
      }
      return;
    }

    // Project-task tiles bypass /api/tile/execute and POST /api/project-tasks directly.
    if (tile.type === 'project_task') {
      if (!p.project_id || !p.entity_id) {
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: 'No project selected' } : prev));
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await apiFetch('/api/project-tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ project_id: p.project_id, entity_id: p.entity_id, title: p.title, description: p.description || '' }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.task) {
          setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: data.error || `HTTP ${res.status}` } : prev));
          return;
        }
        // Stash for checklist follow-up ("yes" / "add subtasks: …"). Stale
        // after 60s so old context doesn't leak into later conversations.
        const createdTask = data.task || {};
        lastCreatedProjectTaskRef.current = {
          id: createdTask.id,
          title: createdTask.title || p.title,
          projectName: p.project_name || null,
          entityId: p.entity_id,
          ts: Date.now(),
        };
        setTimeout(() => {
          if (lastCreatedProjectTaskRef.current && Date.now() - lastCreatedProjectTaskRef.current.ts >= 60000) {
            lastCreatedProjectTaskRef.current = null;
          }
        }, 60000);
        const now = new Date().toISOString();
        setCcMessages((prev) => [
          ...prev,
          { role: 'system', content: `Task created — ${p.title || 'untitled'}${p.project_name ? ` · ${p.project_name}` : ''}`, createdAt: now, ts: Date.now() },
          { role: 'assistant', content: 'Task created. Want to add checklist items?', createdAt: now, ts: Date.now() },
        ]);
        setActiveZoneState('success');
        setTimeout(() => {
          setActiveTile(null);
          setActiveZoneState('empty');
          fetchBriefContext();
        }, 2000);
      } catch (err) {
        const msg = err?.name === 'AbortError' ? 'Request timed out — tap Retry.' : (err.message || 'Network error');
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: msg } : prev));
      } finally {
        clearTimeout(timeout);
      }
      return;
    }

    // Project tiles bypass /api/tile/execute and POST /api/projects directly.
    if (tile.type === 'project') {
      if (!p.entity_id) {
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: 'No entity selected' } : prev));
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await apiFetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ entity_id: p.entity_id, title: p.title, description: p.description || '' }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.project) {
          setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: data.error || `HTTP ${res.status}` } : prev));
          return;
        }
        const now = new Date().toISOString();
        setCcMessages((prev) => [
          ...prev,
          { role: 'system', content: `Project created — ${p.title || 'untitled'}${p.entity_name ? ` · ${p.entity_name}` : ''}`, createdAt: now, ts: Date.now() },
          { role: 'assistant', content: 'Want me to add tasks?', createdAt: now, ts: Date.now() },
        ]);
        setActiveZoneState('success');
        setTimeout(() => {
          setActiveTile(null);
          setActiveZoneState('empty');
          // Refresh briefContext so the new project shows up in the
          // Active Projects card and Aria's context.
          fetchBriefContext();
        }, 2000);
      } catch (err) {
        const msg = err?.name === 'AbortError' ? 'Request timed out — tap Retry.' : (err.message || 'Network error');
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: msg } : prev));
      } finally {
        clearTimeout(timeout);
      }
      return;
    }

    let body;
    if (tile.type === 'task') {
      body = {
        type: 'task',
        payload: {
          title: p.title || '',
          due_date: p.due_date || null,
          priority: p.priority || 'medium',
          ...(p.due_time ? { due_time: p.due_time } : {}),
          ...(p.entity_name ? { entity_name: p.entity_name } : {}),
        },
      };
    } else {
      const start = p.start_time;
      const mins = Number(p.duration_minutes) || 60;
      let endIso = null;
      try {
        const s = new Date(start);
        if (!isNaN(s.getTime())) {
          const e = new Date(s.getTime() + mins * 60000);
          const pad = (n) => String(n).padStart(2, '0');
          endIso = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}T${pad(e.getHours())}:${pad(e.getMinutes())}:${pad(e.getSeconds())}`;
        }
      } catch {}
      body = {
        type: 'event',
        payload: {
          title: p.title || '',
          start_datetime: start,
          end_datetime: endIso,
          ...(p.calendarId ? { calendarId: p.calendarId } : {}),
        },
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await apiFetch('/api/tile/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: data.error || `HTTP ${res.status}` } : prev));
        return;
      }
      // Success: append summary to chat feed, flip zone to success, then
      // either decay to empty (events) or prompt for outcome capture (tasks).
      const summary = tile.type === 'task'
        ? `Task created — ${p.title || 'untitled'}${p.due_date ? ` · due ${p.due_date}` : ''}${p.entity_name ? ` · ${p.entity_name}` : ''}`
        : `Event created — ${p.title || 'untitled'}${p.start_time ? ` · ${p.start_time}` : ''}`;
      setCcMessages((prev) => [...prev, { role: 'system', content: summary, createdAt: new Date().toISOString(), ts: Date.now() }]);
      if (tile.type === 'task') onReloadTasks?.();
      else if (tile.type === 'event') onReloadCalendar?.();
      setActiveZoneState('success');

      if (tile.type === 'task') {
        // After a brief success flash, transition into outcome capture.
        const taskId = data.result?.task_id || tile.id;
        const taskTitle = data.result?.title || p.title || '';
        setTimeout(() => {
          setActiveTile({ type: 'outcome', taskId, taskTitle, ts: Date.now() });
          setActiveZoneState('outcome');
        }, 800);
      } else {
        setTimeout(() => {
          setActiveTile(null);
          setActiveZoneState('empty');
          fetchBriefContext();
        }, 2000);
      }
    } catch (err) {
      const msg = err?.name === 'AbortError' ? 'Request timed out — tap Retry.' : (err.message || 'Network error');
      setActiveTile((prev) => (prev ? { ...prev, status: 'error', error: msg } : prev));
    } finally {
      clearTimeout(timeout);
    }
  }, [activeTile, apiFetch, authToken, onReloadTasks, onReloadCalendar, fetchBriefContext]);

  const executeTile = useCallback(async (tile) => {
    const p = tile.payload || {};
    let body;
    if (tile.type === 'task') {
      body = {
        type: 'task',
        payload: {
          title: p.title || '',
          due_date: p.due_date || null,
          priority: p.priority || 'medium',
          ...(p.due_time ? { due_time: p.due_time } : {}),
          ...(p.entity_name ? { entity_name: p.entity_name } : {}),
        },
      };
    } else {
      const start = p.start_time;
      const mins = Number(p.duration_minutes) || 60;
      let endIso = null;
      try {
        const s = new Date(start);
        if (!isNaN(s.getTime())) {
          const e = new Date(s.getTime() + mins * 60000);
          const pad = (n) => String(n).padStart(2, '0');
          endIso = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}T${pad(e.getHours())}:${pad(e.getMinutes())}:${pad(e.getSeconds())}`;
        }
      } catch {}
      body = {
        type: 'event',
        payload: {
          title: p.title || '',
          start_datetime: start,
          end_datetime: endIso,
          ...(p.calendarId ? { calendarId: p.calendarId } : {}),
        },
      };
    }

    setTileMeta(tile.id, { status: 'executing', error: null });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await apiFetch('/api/tile/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setTileMeta(tile.id, { status: 'error', error: data.error || `HTTP ${res.status}` });
        return;
      }
      setTileMeta(tile.id, { status: 'success', error: null });
      if (tile.type === 'task') onReloadTasks?.();
      else if (tile.type === 'event') onReloadCalendar?.();
      dismissTimers.current[tile.id] = setTimeout(() => {
        dismissTile(tile.id);
        delete dismissTimers.current[tile.id];
      }, 2000);
    } catch (err) {
      if (err?.name === 'AbortError') {
        setTileMeta(tile.id, { status: 'error', error: 'Request timed out — tap Retry.' });
      } else {
        setTileMeta(tile.id, { status: 'error', error: err.message || 'Network error' });
      }
    } finally {
      clearTimeout(timeout);
    }
  }, [apiFetch, authToken, dismissTile, onReloadTasks, onReloadCalendar, setTileMeta]);

  const handleCcStop = useCallback(() => {
    ccStoppedRef.current = true;
    try { ccAbortRef.current?.abort(); } catch {}
    setCcSending(false);
  }, []);

  const fetchDigest = (force = false) => {
    const cacheKey = `digest_${today}`;
    if (!force) {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        try {
          setDigest(JSON.parse(cached));
          setDigestLoading(false);
          return;
        } catch { /* invalid cache, refetch */ }
      }
      const existingDigest = notes.find((n) => n.type === 'digest' && n.createdAt && n.createdAt.slice(0, 10) === today);
      if (existingDigest) {
        setDigest(existingDigest);
        localStorage.setItem(cacheKey, JSON.stringify(existingDigest));
        setDigestLoading(false);
        return;
      }
    } else {
      localStorage.removeItem(cacheKey);
      setDigest(null);
      setDigestLoading(true);
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };
    apiFetch('/api/notes/daily-digest', {
      method: 'POST', headers,
      body: JSON.stringify({ apiKey: apiKeys?.claude || '', force }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.content) {
          setDigest(data);
          localStorage.setItem(cacheKey, JSON.stringify(data));
        }
      })
      .catch(() => {})
      .finally(() => setDigestLoading(false));
  };

  // Digest: load from localStorage cache or fetch
  useEffect(() => {
    fetchDigest(false);
  }, [today]); // eslint-disable-line react-hooks/exhaustive-deps

  // Done today count
  const doneToday = useMemo(() => tasks.filter((t) => t.completed && t.completedAt && t.completedAt.slice(0, 10) === today).length, [tasks, today]);

  const assistantName = currentUser?.assistantName || 'Aria';

  const pillarBadge = (pillar) => {
    if (!pillar) return null;
    const cfg = { hustle: { bg: 'bg-blue-100', text: 'text-blue-700', label: 'Hustle' }, home: { bg: 'bg-green-100', text: 'text-green-700', label: 'Home' }, move: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Move' }, grow: { bg: 'bg-purple-100', text: 'text-purple-700', label: 'Grow' } }[pillar];
    if (!cfg) return null;
    return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${cfg.bg} ${cfg.text}`}>{cfg.label}</span>;
  };

  // Entity color map: entity name → hex color
  const ENTITY_COLORS = ['#4f4dcf','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6'];
  const entityColorMap = useMemo(() => {
    const map = {};
    (entities || []).forEach((e, i) => {
      map[e.name.toLowerCase()] = (e.color && e.color.startsWith('#')) ? e.color : ENTITY_COLORS[i % ENTITY_COLORS.length];
    });
    return map;
  }, [entities]);

  // Entity badge for tasks
  const entityBadge = (tags) => {
    if (!tags || tags.length === 0) return null;
    const tag = tags[0];
    const pillarLower = tag.toLowerCase();
    if (['hustle', 'home', 'move', 'grow'].includes(pillarLower)) return pillarBadge(pillarLower);
    const color = entityColorMap[pillarLower];
    if (color) {
      return <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium text-white" style={{ backgroundColor: color }}>{tag.length > 12 ? tag.slice(0, 12) + '…' : tag}</span>;
    }
    return <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600">{tag.length > 12 ? tag.slice(0, 12) + '…' : tag}</span>;
  };

  // Performance stats (30 day window)
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = new Intl.DateTimeFormat('en-CA', { timeZone: userTZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(thirtyDaysAgo);
  const recentTasks = tasks.filter((t) => !t.dueDate || t.dueDate >= thirtyDaysAgoStr);
  const completedOnTime = recentTasks.filter((t) => t.completed && t.completedAt && t.dueDate && t.completedAt.slice(0,10) <= t.dueDate).length;
  const completedLate = recentTasks.filter((t) => t.completed && t.completedAt && t.dueDate && t.completedAt.slice(0,10) > t.dueDate).length;
  const completedEarly = recentTasks.filter((t) => t.completed && t.completedAt && t.dueDate && t.completedAt.slice(0,10) < t.dueDate).length;
  const missedTasks = recentTasks.filter((t) => !t.completed && t.dueDate && t.dueDate < today).length;
  const totalPerf = completedOnTime + completedLate + completedEarly + missedTasks || 1;
  const onTimePct = Math.round(completedOnTime/totalPerf*100);
  const earlyPct = Math.round(completedEarly/totalPerf*100);
  const latePct = Math.round(completedLate/totalPerf*100);
  const missedPct = Math.round(missedTasks/totalPerf*100);

  return (
    <div className="flex-1 overflow-y-auto px-0 md:px-8 py-0 md:py-4 space-y-4 md:space-y-6 w-full" style={{ minHeight: 0 }}>

      {/* ROW 1: Greeting — hidden on mobile so the CC box starts
          immediately below the top bar. */}
      <div className="hidden md:block" style={{ marginBottom: '16px' }}>
        <h1 style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '32px', fontWeight: 700, color: '#31323a', lineHeight: 1.1 }}>
          {greeting}, {firstName}.
        </h1>
        <p style={{ fontFamily: 'Manrope, sans-serif', fontSize: '13px', color: '#9ca3af', marginTop: '4px' }}>
          {dateStr}
        </p>
      </div>

      {/* ROW 1.5: Active Zone — Aria's orchestration surface (AZ5/6).
          Renders up to 3 tiles ranked by priority, or the empty-state
          Aria voice panel when there's nothing to surface. Refresh-
          debounced via azRefreshKey wired by AZ7. */}
      <section className="px-1 md:px-0 mb-3 hidden md:block" aria-label="Active Zone">
        <div className="flex items-center gap-2 mb-2 px-1">
          <span className="material-symbols-outlined text-primary" style={{ fontSize: '14px' }}>auto_awesome</span>
          <h2 className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-primary">Active Zone</h2>
        </div>
        <div className="space-y-2">
          {azIsEmpty && (
            <ActiveZoneVoice apiFetch={apiFetch} authToken={authToken} refreshKey={azRefreshKey} />
          )}
          <ActiveZoneOrchestrator
          apiFetch={apiFetch}
          authToken={authToken}
          refreshKey={azRefreshKey}
          onEmptyChange={setAzIsEmpty}
          onAction={(action, tile) => {
            // Route the tile's primary action into the existing
            // composition surfaces. Keeping activeZoneState/activeTile
            // as the downstream composer so we don't break drafting.
            switch (action.action) {
              case 'open_daily_wrap':
                setActiveTile({
                  role: 'daily_wrap', type: 'daily_wrap',
                  id: `dw-${Date.now()}`, status: 'draft',
                  payload: { title: 'Ready to wrap your day?' },
                  ts: Date.now(),
                });
                setActiveZoneState('daily_wrap');
                break;
              case 'add_event_outcome': {
                const ev = (tile.itemsPreview || tile.items_preview || [])[0]?.event;
                if (!ev) break;
                setActiveTile({
                  role: 'close_loop', type: 'event',
                  id: `close-${ev.id}`, status: 'draft',
                  payload: { title: `How did "${ev.title || 'your meeting'}" go?`, source_type: 'event', source_id: ev.id, event_title: ev.title || '' },
                  ts: Date.now(),
                });
                setActiveZoneState('close_loop');
                break;
              }
              case 'open_confirmation':
                // Surface the pending confirmation card via existing chat
                // flow — chat panel watches pending_confirmations.
                ccSendRef.current?.('Show me the pending confirmation');
                break;
              case 'open_flagged_inbox':
                if (typeof window !== 'undefined') window.location.hash = '#inbox?filter=flagged';
                break;
              case 'open_meeting_prep':
              case 'open_task':
              case 'resume_draft':
                // No dedicated UI yet — surface via chat for now.
                ccSendRef.current?.(`Open ${action.action.replace(/_/g, ' ')}: ${action.target || ''}`);
                break;
              default:
                // expand_* actions are handled inline by the orchestrator
                // and never reach this callback.
                break;
            }
          }}
        />
        </div>
      </section>

      {/* ROW 2: Command Center. Mobile: position fixed between the top
          bar (56px / top-14) and the bottom nav (64px / bottom-16) so
          the input stays above the nav regardless of browser-chrome
          animations. Desktop: static flex-col card with max-height cap. */}
      <div className="bg-gradient-to-br from-surface-container-lowest to-surface-container-low rounded-none md:rounded-xl shadow-none md:shadow-[0px_10px_30px_rgba(79,77,207,0.05)] overflow-hidden border-0 md:border md:border-primary/5 flex flex-col fixed md:static top-14 md:top-auto bottom-16 md:bottom-auto left-0 right-0 md:max-h-[calc(100vh-300px)] z-30 md:z-auto" style={{ width: '100%' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-primary/5" style={{ flexShrink: 0 }}>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-lg" style={{ color: '#4f4dcf' }}>auto_awesome</span>
            <h3 style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '15px', fontWeight: 600, color: '#4f4dcf' }}>Command Center</h3>
          </div>
          <select
            value={backend}
            onChange={(e) => onBackendChange(e.target.value)}
            className="bg-transparent border-none focus:ring-0 cursor-pointer outline-none px-1 py-0.5 rounded-full"
            style={{ fontFamily: 'Manrope, sans-serif', fontSize: '13px', fontWeight: 600, color: '#4f4dcf' }}
          >
            <option value="claude">Claude</option>
            <option value="chatgpt">ChatGPT</option>
          </select>
        </div>
        {/* Active zone — structured context, tiles, email drafts, success */}
        <ActiveZone
          state={activeZoneState}
          briefContext={briefContext}
          activeTile={activeTile}
          entityColorMap={entityColorMap}
          gmailAccounts={gmailAccounts}
          entities={entities}
          onTileChange={(patch) => updateActiveTile(patch)}
          onTileConfirm={executeActiveTile}
          onTileCancel={cancelActiveTile}
          onTileRetry={executeActiveTile}
          draftFromRef={draftFromRef}
          draftToRef={draftToRef}
          draftBodyRef={draftBodyRef}
          sendPrompt={(msg) => ccSendRef.current?.(msg)}
          onCompleteTask={async (taskId, taskTitle) => {
            try {
              await apiFetch(`/api/tasks/${taskId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({ completed: true, completedAt: new Date().toISOString() }),
              });
              onReloadTasks?.();
              // Flip active zone into outcome capture for this task.
              setActiveTile({ type: 'outcome', taskId, taskTitle: taskTitle || '', ts: Date.now() });
              setActiveZoneState('outcome');
            } catch {}
          }}
          onSaveOutcome={async ({ sourceId, titleSnapshot, outcomeStatus, rawNote }) => {
            try {
              const res = await apiFetch('/api/outcomes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({
                  sourceType: 'task',
                  sourceId,
                  titleSnapshot,
                  outcomeStatus: outcomeStatus || null,
                  rawNote: rawNote || null,
                  followUpNeeded: false,
                  enteredBy: 'user',
                }),
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setActiveTile((prev) => prev ? { ...prev, error: data.error || `HTTP ${res.status}` } : prev);
                return;
              }
              setCcMessages((prev) => [...prev, { role: 'system', content: 'Got it — logged.', createdAt: new Date().toISOString(), ts: Date.now() }]);
              setActiveTile(null);
              setActiveZoneState('empty');
              fetchBriefContext();
            } catch {
              setActiveTile((prev) => prev ? { ...prev, error: 'Network error' } : prev);
            }
          }}
          onSkipOutcome={() => {
            setActiveTile(null);
            setActiveZoneState('empty');
          }}
          onOpenMeetingNotes={(event) => {
            setActiveTile({ type: 'meeting_notes', event, ts: Date.now() });
            setActiveZoneState('notes');
          }}
          onSaveMeetingNotes={async (event, body) => {
            if (!body || !body.trim()) return;
            // Upstream event objects come from different sources (briefContext
            // events.completed has no id, meetingsNeedingNotes has id). Try a
            // few common field names, then guard before the network call.
            const resolvedEventId = event?.id || event?.eventId || event?.event_id || null;
            if (!resolvedEventId) {
              setActiveTile((prev) => prev ? { ...prev, error: 'Could not identify this meeting — reload and try again.' } : prev);
              return;
            }
            try {
              const res = await apiFetch('/api/calendar-notes/post', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({
                  eventId: resolvedEventId,
                  eventTitle: event.title,
                  eventStart: event.startTime || event.start,
                  eventEnd:   event.endTime   || event.end,
                  accountEmail: event.accountEmail || '',
                  postNote: body,
                }),
              });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setActiveTile((prev) => prev ? { ...prev, error: data.error || `HTTP ${res.status}` } : prev);
                return;
              }
              onReloadNotes?.();
              setActiveZoneState('success');
              setTimeout(() => {
                setActiveTile(null);
                setActiveZoneState('empty');
                fetchBriefContext();
              }, 2000);
            } catch {
              setActiveTile((prev) => prev ? { ...prev, error: 'Network error' } : prev);
            }
          }}
          onSkipMeetingNotes={(event) => {
            setActiveTile(null);
            setActiveZoneState('empty');
            ccSendRef.current?.(`Remind me to add notes for ${event.title || 'the meeting'} in 30 minutes`);
          }}
        />
        {/* Messages — content stacks from the top and scrolls naturally
            as it grows. The CC container is fixed on mobile with a
            static input bar below, so no bottom padding is needed. */}
        <div ref={ccScrollRef} onScroll={handleCcScroll} className="flex-1 min-h-0 overflow-y-auto" style={{ fontFamily: 'Manrope, sans-serif', scrollBehavior: 'smooth' }}>
         <div className="px-5 py-3 space-y-3">
          {ccLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '32px', color: '#4f4dcf' }}>
              <span className="material-symbols-outlined" style={{ animation: 'spin 1s linear infinite', fontSize: '24px' }}>auto_awesome</span>
              <span style={{ fontFamily: 'Manrope, sans-serif', fontSize: '15px', color: '#6b7280', transition: 'opacity 0.3s' }}>{thinkingMessagesForIntent[thinkingIdx % thinkingMessagesForIntent.length]}</span>
            </div>
          ) : ccMessages.length === 0 ? (
            <p style={{ fontFamily: 'Manrope, sans-serif', fontSize: '15px', lineHeight: '1.6', color: '#6b7280' }}>No messages yet.</p>
          ) : (
            <>
              {ccMessages.map((msg, i) => {
                if (msg.role === 'task_draft' || msg.role === 'event_draft') {
                  const Tile = msg.role === 'task_draft' ? TaskDraftTile : EventDraftTile;
                  return (
                    <div key={msg.id || i} className="flex justify-start">
                      <div className="max-w-[92%] w-full">
                        <Tile
                          payload={msg.payload}
                          status={msg.status || 'draft'}
                          error={msg.error}
                          onChange={(patch) => updateTile(msg.id, patch)}
                          onConfirm={() => executeTile(msg)}
                          onCancel={() => dismissTile(msg.id)}
                          onRetry={() => executeTile(msg)}
                          gmailAccounts={gmailAccounts}
                          entities={entities}
                        />
                      </div>
                    </div>
                  );
                }
                if (msg.role === 'email_draft') {
                  const d = msg.draft || {};
                  const matched = gmailAccounts.find((a) => a.account_email === d.from);
                  const currentFrom = draftFromRef.current[msg.ts]
                    || (matched ? matched.account_email : (gmailAccounts[0]?.account_email || d.from || ''));
                  if (!draftFromRef.current[msg.ts] && currentFrom) draftFromRef.current[msg.ts] = currentFrom;
                  const multiAccount = gmailAccounts.length > 1;
                  return (
                    <div key={msg.ts || i} className="flex justify-start">
                      <div
                        className="max-w-[92%] w-full bg-white border border-gray-200 rounded-xl shadow-sm"
                        style={{ fontFamily: 'Manrope, sans-serif' }}
                      >
                        <div style={{ padding: '12px 14px', fontSize: '13px', color: '#374151' }}>
                          <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: '11px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
                            Email draft
                          </div>
                          <div className="grid grid-cols-[56px_1fr] gap-y-1 gap-x-2">
                            <div className="text-gray-400">From</div>
                            {multiAccount ? (
                              <select
                                defaultValue={currentFrom}
                                onChange={(e) => { draftFromRef.current[msg.ts] = e.target.value; }}
                                style={{
                                  fontFamily: 'Manrope, sans-serif',
                                  fontSize: '13px',
                                  color: '#1f2937',
                                  background: 'transparent',
                                  border: 'none',
                                  padding: 0,
                                  margin: 0,
                                  outline: 'none',
                                  cursor: 'pointer',
                                  appearance: 'none',
                                  WebkitAppearance: 'none',
                                }}
                              >
                                {gmailAccounts.map((a) => (
                                  <option key={a.account_email} value={a.account_email}>{a.account_email}</option>
                                ))}
                              </select>
                            ) : (
                              <div className="text-gray-800 truncate">{currentFrom || '—'}</div>
                            )}
                            <div className="text-gray-400">To</div>
                            <input
                              type="text"
                              defaultValue={d.to || ''}
                              onChange={(e) => { draftToRef.current[msg.ts] = e.target.value; }}
                              placeholder="recipient@email.com"
                              style={{
                                fontFamily: 'Manrope, sans-serif',
                                fontSize: '13px',
                                color: '#1f2937',
                                background: 'transparent',
                                border: 'none',
                                borderBottom: '1px solid transparent',
                                padding: '1px 0',
                                margin: 0,
                                outline: 'none',
                                width: '100%',
                              }}
                              onFocus={(e) => { e.target.style.borderBottom = '1px solid rgba(79,77,207,0.4)'; }}
                              onBlur={(e) => { e.target.style.borderBottom = '1px solid transparent'; }}
                            />
                            <div className="text-gray-400">Subject</div><div className="text-gray-800" style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{d.subject || '—'}</div>
                          </div>
                        </div>
                        <div style={{ borderTop: '1px solid #e5e7eb' }} />
                        <textarea
                          defaultValue={d.body || ''}
                          onChange={(e) => { draftBodyRef.current[msg.ts] = e.target.value; }}
                          placeholder="Email body"
                          style={{
                            display: 'block',
                            width: '100%',
                            padding: '12px 14px',
                            fontFamily: 'Manrope, sans-serif',
                            fontSize: '13px',
                            lineHeight: '1.55',
                            color: '#1f2937',
                            background: 'transparent',
                            border: 'none',
                            borderTop: '1px solid transparent',
                            borderRadius: 0,
                            outline: 'none',
                            resize: 'vertical',
                            minHeight: '80px',
                            maxHeight: '320px',
                            boxSizing: 'border-box',
                          }}
                          onFocus={(e) => { e.target.style.borderTop = '1px solid rgba(79,77,207,0.4)'; }}
                          onBlur={(e) => { e.target.style.borderTop = '1px solid transparent'; }}
                        />
                      </div>
                    </div>
                  );
                }
                if (msg.role === 'confirm') {
                  const p = msg.params || {};
                  const bodyStr = p.body ? String(p.body) : '';
                  const preview = bodyStr
                    ? (bodyStr.length > 300 ? bodyStr.slice(0, 300) + '…' : bodyStr)
                    : (p.subject || '');
                  // For send_email, the paired email_draft now lives in the
                  // active zone; use activeEmailDraftTsRef + activeTile to
                  // locate the user's edits.
                  let accountOverride = null;
                  let toOverride = null;
                  let bodyOverride = null;
                  if (msg.tool === 'send_email') {
                    const draftTs = activeEmailDraftTsRef.current;
                    const activeDraft = (activeTile?.role === 'email_draft') ? (activeTile.draft || {}) : {};
                    if (draftTs) {
                      accountOverride = draftFromRef.current[draftTs] || null;
                      const editedTo = draftToRef.current[draftTs];
                      const originalTo = activeDraft.to || '';
                      if (typeof editedTo === 'string' && editedTo.trim() && editedTo.trim() !== originalTo) {
                        toOverride = editedTo.trim();
                      }
                      const editedBody = draftBodyRef.current[draftTs];
                      const originalBody = activeDraft.body || '';
                      if (typeof editedBody === 'string' && editedBody !== originalBody) {
                        bodyOverride = editedBody;
                      }
                    }
                  }
                  const handleConfirm = async (approved) => {
                    try {
                      await apiFetch('/api/chat/confirm', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                        body: JSON.stringify({
                          confirm_id: msg.confirmId,
                          approved,
                          ...(approved && accountOverride ? { account_email: accountOverride } : {}),
                          ...(approved && toOverride ? { to_override: toOverride } : {}),
                          ...(approved && bodyOverride !== null ? { body_override: bodyOverride } : {}),
                        }),
                      });
                      // Lookup by stable msg.ts — index `i` is captured in
                      // closure and could point at a different row by the
                      // time this resolves (if user dismissed an earlier
                      // tile). msg.ts is stamped at message creation.
                      setCcMessages((prev) => prev.map((m) => m.ts === msg.ts ? { ...m, status: approved ? 'approved' : 'rejected' } : m));
                      onReloadTasks?.(); onReloadNotes?.();
                    } catch (err) {
                      setCcMessages((prev) => prev.map((m) => m.ts === msg.ts ? { ...m, status: 'error' } : m));
                    }
                  };
                  return (
                    <div key={msg.ts || i} className="flex justify-start">
                      <div
                        className="max-w-[85%] border"
                        style={{ backgroundColor: '#fbf8fe', borderColor: 'rgba(79,77,207,0.2)', fontFamily: 'Manrope, sans-serif', fontSize: '14px', lineHeight: '1.5', borderRadius: '12px', padding: '12px 14px' }}
                      >
                        <div style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontWeight: 700, fontSize: '13px', color: '#4f4dcf', marginBottom: '6px' }}>
                          <span className="material-symbols-outlined" style={{ fontSize: '16px', verticalAlign: 'text-bottom', marginRight: '4px' }}>priority_high</span>
                          Approval required
                        </div>
                        <div style={{ color: '#1f2937', marginBottom: '4px' }}>
                          {msg.tool === 'send_email' && <>Send email to <b>{p.to}</b>?</>}
                          {msg.tool === 'reply_email' && <>Reply on thread <b>{p.thread_id}</b>?</>}
                          {msg.tool === 'delete_task' && <>Delete task <b>{p.task_id}</b>?</>}
                          {msg.tool === 'delete_event' && <>Delete event <b>{p.event_id}</b>?</>}
                          {!['send_email','reply_email','delete_task','delete_event'].includes(msg.tool) && <>Confirm {msg.tool}?</>}
                        </div>
                        {p.subject && (
                          <div style={{ fontSize: '13px', color: '#374151', marginBottom: '2px', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                            Subject: {p.subject}
                          </div>
                        )}
                        {preview && (
                          <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: '8px', whiteSpace: 'pre-wrap' }}>
                            {preview}
                          </div>
                        )}
                        {msg.status === 'pending' && (
                          <div className="flex gap-2 mt-2">
                            <button onClick={() => handleConfirm(true)}
                              style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '12px', fontWeight: 600, background: '#4f4dcf', color: '#fff', border: 'none', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer' }}>
                              ✓ Send
                            </button>
                            <button onClick={() => handleConfirm(false)}
                              style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '12px', fontWeight: 600, background: 'transparent', color: '#4f4dcf', border: '1px solid rgba(79,77,207,0.3)', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer' }}>
                              ✗ Cancel
                            </button>
                          </div>
                        )}
                        {msg.status === 'approved' && <div style={{ fontSize: '12px', color: '#059669', fontWeight: 600 }}>Sent ✓</div>}
                        {msg.status === 'rejected' && <div style={{ fontSize: '12px', color: '#6b7280' }}>Cancelled</div>}
                        {msg.status === 'expired' && <div style={{ fontSize: '12px', color: '#6b7280' }}>Expired</div>}
                        {msg.status === 'error' && <div style={{ fontSize: '12px', color: '#dc2626' }}>Confirmation failed</div>}
                      </div>
                    </div>
                  );
                }
                if (msg.role === 'system') {
                  return (
                    <div key={msg.ts || i} className="flex justify-center my-1">
                      <span
                        className="inline-flex items-center gap-1.5 text-[11px] text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-3 py-1"
                        style={{ fontFamily: 'Manrope, sans-serif' }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>info</span>
                        {msg.content}
                      </span>
                    </div>
                  );
                }
                const isUser = msg.role === 'user';
                return (
                  <div key={msg.ts || i} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                    <div
                      className={`max-w-[85%] ${isUser ? 'text-white' : ''}`}
                      style={isUser
                        ? { backgroundColor: '#4f4dcf', fontFamily: 'Manrope, sans-serif', fontSize: '15px', lineHeight: '1.6', borderRadius: '12px', padding: '12px 16px' }
                        : { backgroundColor: '#f5f2fa', fontFamily: 'Manrope, sans-serif', fontSize: '15px', lineHeight: '1.6', borderRadius: '12px', padding: '12px 16px' }
                      }
                    >
                      {msg.content
                        ? (isUser
                            ? msg.content
                            : <ReactMarkdown components={MD_COMPONENTS}>{msg.content}</ReactMarkdown>)
                        : <span className="animate-pulse" style={{ color: '#6b7280' }}>{thinkingMessagesForIntent[thinkingIdx % thinkingMessagesForIntent.length]}</span>}
                    </div>
                    {!isUser && Array.isArray(msg.loadedSkills) && msg.loadedSkills.length > 0 && (
                      <div style={{ marginTop: 4, marginLeft: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {msg.loadedSkills.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => { window.dispatchEvent(new CustomEvent('navigate-app', { detail: { view: 'agents' } })); }}
                            title={s.reason ? `Loaded because: ${s.reason}` : 'Loaded skill'}
                            style={{
                              fontSize: 11, color: '#6b7280', background: 'transparent',
                              border: 'none', padding: '0 4px', cursor: 'pointer',
                              fontFamily: 'Manrope, sans-serif',
                            }}
                          >
                            📚 {s.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {ccRefreshing && (
                <div className="flex justify-start">
                  <div style={{ backgroundColor: '#f5f2fa', fontFamily: 'Manrope, sans-serif', fontSize: '15px', lineHeight: '1.6', borderRadius: '12px', padding: '12px 16px' }}>
                    <span className="animate-pulse">Updating...</span>
                  </div>
                </div>
              )}
              {needsRefresh && !ccRefreshing && (
                <div className="flex justify-start pt-1">
                  <button
                    onClick={handleFreshUpdate}
                    style={{ fontFamily: 'Manrope, sans-serif', fontSize: '12px', fontWeight: 600, color: '#4f4dcf', background: 'none', border: '1px solid rgba(79,77,207,0.2)', borderRadius: '16px', padding: '4px 12px', cursor: 'pointer' }}
                    className="hover:bg-primary/5 transition-colors"
                  >
                    ✦ Get update
                  </button>
                </div>
              )}
            </>
          )}
         </div>
        </div>
        {/* Input — static in the flex-col flow. CC container is
            fixed-sized on mobile (top-14 to bottom-16), so the input
            naturally sits above the bottom nav. Hidden until brief loads. */}
        {!ccLoading && <div className="flex-shrink-0 px-4 py-3 border-t border-primary/5 flex items-center gap-2 bg-white">
          <input
            type="text"
            value={ccInput}
            onChange={(e) => setCcInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCcSend(); } }}
            placeholder={`Ask ${assistantName} anything...`}
            className="flex-1 bg-transparent focus:ring-0 placeholder:text-[#555] outline-none"
            style={{ fontFamily: 'Manrope, sans-serif', fontSize: '15px', border: '1px solid #4f4dcf', borderRadius: '8px', padding: '8px 12px' }}
            disabled={ccSending}
          />
          {ccSending ? (
            <button
              onClick={handleCcStop}
              aria-label="Stop generating"
              title="Stop generating"
              className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all hover:brightness-110"
              style={{ backgroundColor: '#fee2e2', border: '1px solid #fecaca' }}
            >
              <span className="material-symbols-outlined text-base" style={{ color: '#dc2626' }}>stop_circle</span>
            </button>
          ) : (
            <button
              onClick={handleCcSend}
              disabled={!ccInput.trim()}
              aria-label="Send message"
              className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all disabled:opacity-30"
              style={{ backgroundColor: ccInput.trim() ? '#4f4dcf' : 'transparent' }}
            >
              <span className={`material-symbols-outlined text-base ${ccInput.trim() ? 'text-white' : 'text-slate-400'}`}>send</span>
            </button>
          )}
        </div>}
      </div>

      {/* ROW 4: Timeline + Tasks + Upcoming — desktop-only; mobile
          surfaces these via the dedicated Calendar / Tasks tabs. */}
      <div className="hidden md:grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
        <div className="space-y-4">
          <div className="flex justify-between items-end px-1">
            <h3 className="text-lg font-extrabold font-headline">Today&apos;s Timeline</h3>
            <button onClick={() => onNavigate('calendar')} className="text-primary font-bold text-[10px] hover:underline">View Calendar</button>
          </div>
          {calendarEvents.length === 0 ? (
            <div className="space-y-3 relative">
              <div className="relative pl-10 group">
                <div className="absolute left-0 top-1 w-7 h-7 rounded-full bg-surface-container-high flex items-center justify-center z-10 ring-4 ring-background">
                  <span className="material-symbols-outlined text-on-surface-variant text-base">calendar_today</span>
                </div>
                <div className="bg-surface-container-low p-3 rounded-xl shadow-sm">
                  <span className="text-[8px] font-bold text-slate-400 uppercase tracking-widest">Today</span>
                  <h4 className="text-sm font-bold mt-1 text-on-surface-variant">No events scheduled</h4>
                  <button onClick={() => onNavigate('calendar')} className="text-primary text-[10px] font-bold mt-1 hover:underline">Open Calendar</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3 relative before:absolute before:left-[13px] before:top-4 before:bottom-4 before:w-0.5 before:bg-surface-container-high">
              {calendarEvents.slice(0,4).map((ev, i) => {
                const timeStr = ev.allDay ? 'All day' : new Date(ev.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                const bgMap = ['bg-primary', 'bg-secondary-container', 'bg-surface-container-high', 'bg-surface-container-high'];
                const iconMap = ['schedule', 'groups', 'restaurant', 'event'];
                const textMap = ['text-on-primary', 'text-primary', 'text-on-surface-variant', 'text-on-surface-variant'];
                return (
                  <div key={ev.id || i} className="relative pl-10 group">
                    <div className={`absolute left-0 top-1 w-7 h-7 rounded-full ${bgMap[i]||'bg-surface-container-high'} flex items-center justify-center z-10 ring-4 ring-background group-hover:scale-110 transition-transform`}>
                      <span className={`material-symbols-outlined ${textMap[i]||'text-on-surface-variant'} text-base`}>{iconMap[i]||'event'}</span>
                    </div>
                    <div className={`${i===1?'border-l-4 border-primary ':''} ${i===2?'bg-surface-container-low':'bg-surface-container-lowest'} p-3 rounded-xl shadow-sm hover:shadow-md transition-shadow flex items-start gap-2`}>
                      <div className="flex-1 min-w-0">
                        <span className={`text-[8px] font-bold uppercase tracking-widest ${i===0?'text-primary':'text-slate-400'}`}>{timeStr}</span>
                        <h4 className="text-sm font-bold mt-1">{ev.title}</h4>
                      </div>
                      {isEventPast(ev) && renderEventNoteAction(ev)}
                    </div>
                    {isEventPast(ev) && renderInlineEventTextarea(ev)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="space-y-4">
          <div className="flex justify-between items-end px-1">
            <h3 className="text-lg font-extrabold font-headline">Today&apos;s Tasks</h3>
            <button onClick={() => onNavigate('daily')} className="text-primary font-bold text-[10px] hover:underline">Manage All</button>
          </div>
          <div className="bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden border border-surface-container-low">
            <div className="divide-y divide-surface-container-low">
              {overdueTasks.length === 0 && todayTasks.length === 0 ? (
                <div className="p-3"><h5 className="text-xs font-bold text-on-surface-variant">All clear 🎉</h5></div>
              ) : (
                <>
                  {overdueTasks.slice(0,2).map((t) => (
                    <div key={t.id}>
                      <div className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                        <button onClick={() => onToggleTask(t.id)} className="mt-0.5 h-4 w-4 rounded-full border-2 border-error flex items-center justify-center flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <h5 className="text-xs font-bold leading-tight text-error truncate">{t.title}</h5>
                          <div className="flex gap-2 mt-1.5">
                            <span className="flex items-center gap-1 text-[8px] font-bold text-error bg-error/5 px-1.5 py-0.5 rounded-full">
                              <span className="material-symbols-outlined text-[10px]">timer</span> overdue
                            </span>
                          </div>
                        </div>
                        {renderTaskNoteAction(t)}
                        {renderTaskDeleteAction(t)}
                      </div>
                      {renderInlineTaskTextarea(t)}
                    </div>
                  ))}
                  {todayTasks.slice(0,4).map((t) => (
                    <div key={t.id}>
                      <div className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                        <button onClick={() => onToggleTask(t.id)} className="mt-0.5 h-4 w-4 rounded-full border-2 border-outline-variant flex items-center justify-center hover:border-primary transition-colors flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <h5 className="text-xs font-bold leading-tight truncate">{t.title}</h5>
                          <div className="flex gap-2 mt-1.5">
                            <span className="flex items-center gap-1 text-[8px] font-bold text-primary bg-primary/5 px-1.5 py-0.5 rounded-full">Due today</span>
                          </div>
                        </div>
                        {renderTaskNoteAction(t)}
                        {renderTaskDeleteAction(t)}
                      </div>
                      {renderInlineTaskTextarea(t)}
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <div className="flex justify-between items-end px-1">
            <h3 className="text-lg font-extrabold font-headline">Upcoming Tasks</h3>
            <button onClick={() => onNavigate('daily')} className="text-primary font-bold text-[10px] hover:underline">View All</button>
          </div>
          <div className="bg-surface-container-lowest rounded-xl shadow-sm overflow-hidden border border-surface-container-low">
            <div className="divide-y divide-surface-container-low">
              {upcomingTasks.length === 0 && floatingTasks.length === 0 ? (
                <div className="p-3"><h5 className="text-xs font-bold text-on-surface-variant">Nothing upcoming</h5></div>
              ) : (
                <>
                  {upcomingTasks.map((t) => (
                    <div key={t.id}>
                      <div className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                        <button onClick={() => onToggleTask(t.id)} className="mt-0.5 h-4 w-4 rounded-full border-2 border-outline-variant flex items-center justify-center hover:border-primary transition-colors flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <h5 className="text-xs font-bold leading-tight truncate">{t.title}</h5>
                          <div className="flex gap-2 mt-1.5">
                            <span className="flex items-center gap-1 text-[8px] font-bold text-on-surface-variant bg-surface-container px-1.5 py-0.5 rounded-full">
                              {(() => { const [y, m, d] = t.dueDate.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); })()}
                            </span>
                          </div>
                        </div>
                        {renderTaskNoteAction(t)}
                        {renderTaskDeleteAction(t)}
                      </div>
                      {renderInlineTaskTextarea(t)}
                    </div>
                  ))}
                  {floatingTasks.length > 0 && (
                    <>
                      <div className="px-3 pt-2 pb-1">
                        <span className="text-[8px] font-bold text-on-surface-variant uppercase tracking-widest">No date</span>
                      </div>
                      {floatingTasks.map((t) => (
                        <div key={t.id}>
                          <div className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                            <button onClick={() => onToggleTask(t.id)} className="mt-0.5 h-4 w-4 rounded-full border-2 border-outline-variant flex items-center justify-center hover:border-primary transition-colors flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <h5 className="text-xs font-bold leading-tight truncate">{t.title}</h5>
                            </div>
                            {renderTaskNoteAction(t)}
                            {renderTaskDeleteAction(t)}
                          </div>
                          {renderInlineTaskTextarea(t)}
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ROW 5: Active Notes — desktop-only. */}
      <div className="hidden md:block space-y-4">
        <div className="flex justify-between items-end px-1">
          <h3 className="text-lg font-extrabold font-headline">Active Notes</h3>
          <button onClick={() => onNavigate('notes')} className="text-primary font-bold text-[10px] hover:underline">See All Notes</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {notes.filter((n) => n.type !== 'digest').slice(0,3).map((note, i) => {
            const borders = ['border-[#4f4dcf]', 'border-tertiary', 'border-error'];
            const hovers = ['group-hover:text-primary', 'group-hover:text-tertiary', 'group-hover:text-error'];
            const timeAgo = note.updatedAt ? (() => { const diff = Date.now() - new Date(note.updatedAt).getTime(); const h = Math.floor(diff/3600000); if(h<1) return 'Just now'; if(h<24) return 'Modified '+h+'h ago'; if(h<48) return 'Modified Yesterday'; return 'Modified '+Math.floor(h/24)+'d ago'; })() : '';
            return (
              <button key={note.id} onClick={() => onOpenNote(note)} className={'bg-surface-container-lowest p-5 rounded-xl shadow-sm border-t-4 '+borders[i%3]+' group hover:scale-[1.01] transition-transform cursor-pointer border-x border-b border-x-surface-container-low border-b-surface-container-low text-left w-full'}>
                <span className="text-[8px] font-bold uppercase text-slate-400 tracking-widest">{timeAgo}</span>
                <h4 className={'text-sm font-bold mt-2 '+hovers[i%3]+' transition-colors'}>{note.title || 'Untitled'}</h4>
                <p className="text-on-surface-variant text-[11px] mt-2.5 line-clamp-3 leading-relaxed">{(note.content||'').replace(/<[^>]+>/g,'').slice(0,120)}</p>
              </button>
            );
          })}
          {notes.filter((n) => n.type !== 'digest').length === 0 && (
            <div className="col-span-3 bg-surface-container-lowest p-5 rounded-xl shadow-sm border border-surface-container-low text-center">
              <p className="text-[11px] text-on-surface-variant">No notes yet</p>
              <button onClick={onQuickNote} className="text-primary text-[10px] font-bold mt-2 hover:underline">Create your first note</button>
            </div>
          )}
        </div>
      </div>

      {/* ROW 6: Task Performance — desktop-only. */}
      <div className="hidden md:block space-y-4">
        <div className="flex justify-between items-end px-1">
          <h3 className="text-lg font-extrabold font-headline">Task Performance</h3>
          <span className="text-on-surface-variant text-[10px] font-bold uppercase tracking-wider">Last 30 days</span>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-surface-container-low group hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center">
                <span className="material-symbols-outlined text-emerald-500 text-lg">task_alt</span>
              </div>
              <span className="text-[8px] font-bold uppercase tracking-wider text-emerald-500 bg-emerald-50 px-2 py-0.5 rounded-full">On Time</span>
            </div>
            <p className="text-3xl font-extrabold font-headline text-on-background leading-none">{String(completedOnTime).padStart(2,'0')}</p>
            <p className="text-[10px] text-on-surface-variant font-medium mt-1">tasks completed on time</p>
            <div className="mt-3 h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div className="h-full bg-emerald-400 rounded-full" style={{width:onTimePct+'%'}} />
            </div>
            <p className="text-[8px] text-on-surface-variant mt-1">{onTimePct}% of total</p>
          </div>
          <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-surface-container-low group hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-primary text-lg">bolt</span>
              </div>
              <span className="text-[8px] font-bold uppercase tracking-wider text-primary bg-primary/10 px-2 py-0.5 rounded-full">Early</span>
            </div>
            <p className="text-3xl font-extrabold font-headline text-on-background leading-none">{String(completedEarly).padStart(2,'0')}</p>
            <p className="text-[10px] text-on-surface-variant font-medium mt-1">tasks completed early</p>
            <div className="mt-3 h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full" style={{width:earlyPct+'%'}} />
            </div>
            <p className="text-[8px] text-on-surface-variant mt-1">{earlyPct}% of total</p>
          </div>
          <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-surface-container-low group hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="w-8 h-8 rounded-full bg-amber-50 flex items-center justify-center">
                <span className="material-symbols-outlined text-amber-500 text-lg">schedule</span>
              </div>
              <span className="text-[8px] font-bold uppercase tracking-wider text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">Late</span>
            </div>
            <p className="text-3xl font-extrabold font-headline text-on-background leading-none">{String(completedLate).padStart(2,'0')}</p>
            <p className="text-[10px] text-on-surface-variant font-medium mt-1">tasks completed late</p>
            <div className="mt-3 h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div className="h-full bg-amber-400 rounded-full" style={{width:latePct+'%'}} />
            </div>
            <p className="text-[8px] text-on-surface-variant mt-1">{latePct}% of total</p>
          </div>
          <div className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-surface-container-low group hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="w-8 h-8 rounded-full bg-error/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-error text-lg">cancel</span>
              </div>
              <span className="text-[8px] font-bold uppercase tracking-wider text-error bg-error/10 px-2 py-0.5 rounded-full">Missed</span>
            </div>
            <p className="text-3xl font-extrabold font-headline text-on-background leading-none">{String(missedTasks).padStart(2,'0')}</p>
            <p className="text-[10px] text-on-surface-variant font-medium mt-1">tasks missed / abandoned</p>
            <div className="mt-3 h-1 bg-surface-container-high rounded-full overflow-hidden">
              <div className="h-full bg-error rounded-full" style={{width:missedPct+'%'}} />
            </div>
            <p className="text-[8px] text-on-surface-variant mt-1">{missedPct}% of total</p>
          </div>
        </div>
        <div className="bg-primary/5 border border-primary/10 rounded-xl px-4 py-3 flex items-center gap-3">
          <span className="material-symbols-outlined text-primary text-lg flex-shrink-0">auto_awesome</span>
          <p className="text-[11px] text-on-surface-variant leading-relaxed">
            <span className="font-bold text-on-background">{assistantName}&apos;s read: </span>
            {(completedOnTime + completedEarly + completedLate + missedTasks) === 0 ? 'No completed tasks in the last 30 days yet. Complete tasks to start tracking performance.' : missedTasks > completedOnTime ? 'Missing more than completing on time. Focus on adding due dates to high-priority items.' : completedEarly > completedOnTime ? 'You tend to finish early — consider tightening your deadlines to build momentum.' : `On-time rate is ${onTimePct}% over the last 30 days.${onTimePct === 100 ? ' Perfect streak.' : ' Add due dates to tasks to improve tracking.'}`}
          </p>
        </div>
      </div>

      <div className="h-8" />

    </div>
  );
}

// ── ActiveZone ───────────────────────────────────────────────────────────
// Structured surface above the chat feed. Renders one of:
//   context → 3 mini-cards (still open / done today / up next)
//   tile    → TaskDraftTile or EventDraftTile
//   email   → inline editable email draft card
//   notes   → post-meeting notes capture
//   success → green confirmation
//   empty   → collapsed (height 0)
const ROW_BTN_STYLE = {
  fontFamily: "'Plus Jakarta Sans', sans-serif",
  fontSize: '11px',
  padding: '2px 8px',
  border: '0.5px solid #d1d5db',
  borderRadius: '8px',
  background: 'transparent',
  color: '#4b5563',
  cursor: 'pointer',
  transition: 'background 120ms',
};

function RowButton({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={ROW_BTN_STYLE}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#f3f4f6'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

function ActiveZone({
  state, briefContext, activeTile,
  entityColorMap, gmailAccounts, entities,
  onTileChange, onTileConfirm, onTileCancel, onTileRetry,
  draftFromRef, draftToRef, draftBodyRef,
  sendPrompt, onCompleteTask, onOpenMeetingNotes,
  onSaveMeetingNotes, onSkipMeetingNotes,
  onSaveOutcome, onSkipOutcome,
}) {
  const isVisible =
    state === 'tile' || state === 'email' || state === 'notes' ||
    state === 'outcome' || state === 'success' || state === 'close_loop' ||
    state === 'daily_wrap';

  if (!isVisible) {
    return <div style={{ height: 0, overflow: 'hidden', flexShrink: 0 }} />;
  }

  const wrapperStyle = {
    flexShrink: 0,
    padding: '14px 16px',
    borderBottom: '0.5px solid rgba(79,77,207,0.08)',
    background: '#fcfbff',
  };


  if (state === 'tile' && activeTile) {
    const Tile = activeTile.role === 'task_draft' ? TaskDraftTile
      : activeTile.role === 'project_draft' ? ProjectDraftTile
      : activeTile.role === 'project_task_draft' ? ProjectTaskDraftTile
      : activeTile.role === 'checklist_draft' ? ChecklistDraftTile
      : EventDraftTile;
    return (
      <div className="max-h-[40vh] md:max-h-none overflow-y-auto md:overflow-visible" style={wrapperStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#4f4dcf', animation: 'pulse 1.5s infinite' }} />
          <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 10, color: '#4f4dcf', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {activeTile.type === 'task' ? 'Task draft' : activeTile.type === 'project' ? 'Project draft' : activeTile.type === 'project_task' ? 'Project task draft' : activeTile.type === 'checklist' ? 'Checklist draft' : 'Event draft'}
          </span>
        </div>
        <Tile
          payload={activeTile.payload}
          status={activeTile.status || 'draft'}
          error={activeTile.error}
          onChange={onTileChange}
          onConfirm={onTileConfirm}
          onCancel={onTileCancel}
          onRetry={onTileRetry}
          gmailAccounts={gmailAccounts}
          entities={entities}
        />
      </div>
    );
  }

  if (state === 'email' && activeTile?.role === 'email_draft') {
    const d = activeTile.draft || {};
    const matched = gmailAccounts.find((a) => a.account_email === d.from);
    const currentFrom = draftFromRef.current[activeTile.ts]
      || (matched ? matched.account_email : (gmailAccounts[0]?.account_email || d.from || ''));
    if (!draftFromRef.current[activeTile.ts] && currentFrom) draftFromRef.current[activeTile.ts] = currentFrom;
    const multiAccount = gmailAccounts.length > 1;

    return (
      <div className="max-h-[40vh] md:max-h-none overflow-y-auto md:overflow-visible" style={wrapperStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#4f4dcf', animation: 'pulse 1.5s infinite' }} />
          <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 10, color: '#4f4dcf', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Email draft</span>
        </div>
        <div className="bg-white border border-gray-200 rounded-xl shadow-sm" style={{ fontFamily: 'Manrope, sans-serif' }}>
          <div style={{ padding: '12px 14px', fontSize: '13px', color: '#374151' }}>
            <div className="grid grid-cols-[56px_1fr] gap-y-1 gap-x-2">
              <div className="text-gray-400">From</div>
              {multiAccount ? (
                <select
                  defaultValue={currentFrom}
                  onChange={(e) => { draftFromRef.current[activeTile.ts] = e.target.value; }}
                  style={{ fontFamily: 'Manrope, sans-serif', fontSize: '13px', color: '#1f2937', background: 'transparent', border: 'none', padding: 0, outline: 'none', cursor: 'pointer' }}
                >
                  {gmailAccounts.map((a) => (
                    <option key={a.account_email} value={a.account_email}>{a.account_email}</option>
                  ))}
                </select>
              ) : (
                <div className="text-gray-800 truncate">{currentFrom || '—'}</div>
              )}
              <div className="text-gray-400">To</div>
              <input
                type="text"
                defaultValue={d.to || ''}
                onChange={(e) => { draftToRef.current[activeTile.ts] = e.target.value; }}
                placeholder="recipient@email.com"
                style={{ fontFamily: 'Manrope, sans-serif', fontSize: '13px', color: '#1f2937', background: 'transparent', border: 'none', borderBottom: '1px solid transparent', padding: '1px 0', outline: 'none', width: '100%' }}
                onFocus={(e) => { e.target.style.borderBottom = '1px solid rgba(79,77,207,0.4)'; }}
                onBlur={(e) => { e.target.style.borderBottom = '1px solid transparent'; }}
              />
              <div className="text-gray-400">Subject</div>
              <div className="text-gray-800" style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>{d.subject || '—'}</div>
            </div>
          </div>
          <div style={{ borderTop: '1px solid #e5e7eb' }} />
          <textarea
            defaultValue={d.body || ''}
            onChange={(e) => { draftBodyRef.current[activeTile.ts] = e.target.value; }}
            placeholder="Email body"
            style={{ display: 'block', width: '100%', padding: '12px 14px', fontFamily: 'Manrope, sans-serif', fontSize: '13px', lineHeight: '1.55', color: '#1f2937', background: 'transparent', border: 'none', borderTop: '1px solid transparent', outline: 'none', resize: 'vertical', minHeight: '80px', maxHeight: '320px', boxSizing: 'border-box' }}
            onFocus={(e) => { e.target.style.borderTop = '1px solid rgba(79,77,207,0.4)'; }}
            onBlur={(e) => { e.target.style.borderTop = '1px solid transparent'; }}
          />
        </div>
      </div>
    );
  }

  if (state === 'notes' && activeTile?.type === 'meeting_notes') {
    const event = activeTile.event || {};
    return (
      <div className="max-h-[40vh] md:max-h-none overflow-y-auto md:overflow-visible" style={wrapperStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#4f4dcf', animation: 'pulse 1.5s infinite' }} />
          <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 13, color: '#1f2937' }}>
            {event.title || 'Meeting'} just ended
          </span>
        </div>
        <div style={{ fontFamily: 'Manrope, sans-serif', fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
          Any notes? I&apos;ll save them.
        </div>
        <textarea
          ref={(el) => { if (el) el.dataset.notesInput = '1'; }}
          id={`meeting-notes-${activeTile.ts}`}
          rows={3}
          placeholder="What came out of it? Decisions, follow-ups, anything worth remembering..."
          style={{
            display: 'block', width: '100%', padding: '10px 12px',
            fontFamily: 'Manrope, sans-serif', fontSize: 13, lineHeight: 1.55, color: '#1f2937',
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
            outline: 'none', resize: 'vertical', minHeight: 60, boxSizing: 'border-box',
          }}
        />
        {activeTile.error && (
          <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{activeTile.error}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={() => onSkipMeetingNotes?.(event)}
            style={{ ...ROW_BTN_STYLE, fontSize: 12, padding: '4px 10px' }}
          >
            Skip
          </button>
          <button
            onClick={() => {
              const el = document.getElementById(`meeting-notes-${activeTile.ts}`);
              const body = el ? el.value : '';
              onSaveMeetingNotes?.(event, body);
            }}
            style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 12, fontWeight: 600, padding: '4px 12px', background: '#4f4dcf', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
          >
            Save notes
          </button>
        </div>
      </div>
    );
  }

  if (state === 'outcome' && activeTile?.type === 'outcome') {
    return <OutcomePrompt tile={activeTile} onSave={onSaveOutcome} onSkip={onSkipOutcome} />;
  }

  if (state === 'success') {
    return (
      <div className="max-h-[40vh] md:max-h-none overflow-y-auto md:overflow-visible" style={wrapperStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#059669' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>check_circle</span>
          <span style={{ fontFamily: 'Manrope, sans-serif', fontSize: '13px', fontWeight: 600 }}>Done</span>
        </div>
      </div>
    );
  }

  if (state === 'daily_wrap' && activeTile?.role === 'daily_wrap') {
    return (
      <div className="max-h-[40vh] md:max-h-none overflow-y-auto md:overflow-visible" style={wrapperStyle}>
        <DailyWrapTile
          payload={activeTile.payload || {}}
          status={activeTile.status || 'draft'}
          error={activeTile.error}
          onDismiss={onTileCancel}
          onConfirm={onTileConfirm}
        />
      </div>
    );
  }

  if (state === 'close_loop' && activeTile?.role === 'close_loop') {
    return (
      <div className="max-h-[40vh] md:max-h-none overflow-y-auto md:overflow-visible" style={wrapperStyle}>
        <CloseLoopTile
          tile={activeTile}
          onChange={onTileChange}
          onDismiss={onTileCancel}
          onConfirm={onTileConfirm}
        />
      </div>
    );
  }

  return <div style={{ height: 0, overflow: 'hidden', flexShrink: 0 }} />;
}

/**
 * CloseLoopTile — placeholder for ambient capture follow-ups (meeting
 * ended without notes, task completed without color, etc.). V1 renders
 * a title + textarea + dismiss/confirm. Full note-persistence wires in
 * with Daily Wrap build.
 */
function CloseLoopTile({ tile, onChange, onDismiss, onConfirm }) {
  const [text, setText] = useState(tile?.payload?.note || '');
  const payload = tile?.payload || {};
  const status = tile?.status || 'draft';
  const executing = status === 'executing';
  const error = tile?.error;

  const handleSave = () => {
    const note = text.trim();
    if (!note) return;
    // Pass note directly — payload setState + confirm in same tick
    // would race, so the parent's executeActiveTile reads from `extra`.
    onConfirm?.(note);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', animation: 'pulse 1.5s infinite' }} />
        <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 10, color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          Close the loop
        </span>
      </div>
      <div style={{ fontFamily: 'Manrope, sans-serif', fontSize: 14, color: '#1f2937', fontWeight: 500, marginBottom: 8 }}>
        {payload.title || 'Anything to capture?'}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave(); }
          else if (e.key === 'Escape') { e.preventDefault(); onDismiss?.(); }
        }}
        disabled={executing}
        placeholder="A quick note — outcomes, decisions, follow-ups…"
        style={{
          width: '100%', minHeight: 60, fontSize: 13, padding: '8px 10px',
          border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none',
          resize: 'vertical', fontFamily: 'Manrope, sans-serif',
        }}
      />
      {error && (
        <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{error}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}>
        <button
          onClick={() => onDismiss?.()}
          disabled={executing}
          style={{ fontSize: 12, color: '#6b7280', background: 'transparent', border: 'none', cursor: executing ? 'default' : 'pointer' }}
        >
          Not now
        </button>
        <button
          onClick={handleSave}
          disabled={!text.trim() || executing}
          style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: '#4f4dcf', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', opacity: (!text.trim() || executing) ? 0.4 : 1 }}
        >
          {executing ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </div>
  );
}


// ── OutcomePrompt ───────────────────────────────────────────────────────
// "How did it go?" capture UI shown after a task completes. Status chip +
// optional narrative; either writes to outcome_records or dismisses.
const OUTCOME_STATUS_CONFIG = [
  { key: 'success',   label: '✓ Success',   fg: '#3b6d11', bg: '#eaf3de' },
  { key: 'mixed',     label: '~ Mixed',     fg: '#534ab7', bg: '#eeedfe' },
  { key: 'neutral',   label: '— Neutral',   fg: '#534ab7', bg: '#eeedfe' },
  { key: 'failed',    label: '✗ Failed',    fg: '#a32d2d', bg: '#fcebeb' },
  { key: 'cancelled', label: '⊘ Cancelled', fg: '#5f5e5a', bg: '#f1efe8' },
];

function OutcomePrompt({ tile, onSave, onSkip }) {
  const [selectedStatus, setSelectedStatus] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const wrapperStyle = {
    flexShrink: 0,
    padding: '14px 16px',
    borderBottom: '0.5px solid rgba(79,77,207,0.08)',
    background: '#fcfbff',
  };

  const chipBase = {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: 11,
    fontWeight: 600,
    padding: '4px 10px',
    borderRadius: 10,
    border: '0.5px solid #d1d5db',
    background: 'transparent',
    color: '#4b5563',
    cursor: 'pointer',
    transition: 'background 120ms, color 120ms, border-color 120ms',
  };

  const handleSave = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave?.({
        sourceId: tile.taskId,
        titleSnapshot: tile.taskTitle,
        outcomeStatus: selectedStatus,
        rawNote: note.trim() || null,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-h-[40vh] md:max-h-none overflow-y-auto md:overflow-visible" style={wrapperStyle}>
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 13, color: '#1f2937' }}>
        {tile.taskTitle || 'Task completed'}
      </div>
      <div style={{ fontFamily: 'Manrope, sans-serif', fontSize: 12, color: '#6b7280', marginTop: 2, marginBottom: 8 }}>
        How did it go?
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {OUTCOME_STATUS_CONFIG.map((s) => {
          const active = selectedStatus === s.key;
          const style = active
            ? { ...chipBase, background: s.bg, color: s.fg, borderColor: s.bg }
            : chipBase;
          return (
            <button
              key={s.key}
              onClick={() => setSelectedStatus(active ? null : s.key)}
              style={style}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Any notes? Decisions, follow-ups, what actually happened..."
        style={{
          display: 'block', width: '100%', padding: '10px 12px',
          fontFamily: 'Manrope, sans-serif', fontSize: 13, lineHeight: 1.55, color: '#1f2937',
          background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8,
          outline: 'none', resize: 'vertical', minHeight: 60, boxSizing: 'border-box',
        }}
      />
      {tile.error && (
        <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6 }}>{tile.error}</div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
        <button
          onClick={onSkip}
          disabled={busy}
          style={{ ...chipBase, fontSize: 12, padding: '4px 12px' }}
        >
          Skip
        </button>
        <button
          onClick={handleSave}
          disabled={busy}
          style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 12, fontWeight: 600, padding: '4px 14px', background: '#4f4dcf', color: '#fff', border: 'none', borderRadius: 8, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.7 : 1 }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
