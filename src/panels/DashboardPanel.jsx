import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import { useToast } from '../contexts/ToastContext';
import buildSystemPrompt from '../utils/systemPrompt';
import { getTodayLocal } from '../utils/helpers.js';
import { parseActionDraft } from '../utils/parseActionDraft.js';
import TaskDraftTile from '../components/command-center/TaskDraftTile.jsx';
import EventDraftTile from '../components/command-center/EventDraftTile.jsx';

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

      const noUserMessages = !ccMessagesRef.current.some((m) => m.role === 'user');
      const prevTimeState = lastTimeStateRef.current;
      const transitioned = prevTimeState && data.timeState && data.timeState !== prevTimeState;

      if ((firstBriefFetchRef.current && noUserMessages) || transitioned) {
        setActiveZoneState((s) =>
          (s === 'tile' || s === 'email' || s === 'notes' || s === 'success') ? s : 'context'
        );
      }
      firstBriefFetchRef.current = false;
      if (data.timeState) lastTimeStateRef.current = data.timeState;
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
      // 30+ min idle: summon cards + ask Aria for a fresh catch-up.
      if (idleMs > 30 * 60 * 1000) {
        lastActivityRef.current = Date.now();
        setActiveZoneState((s) =>
          (s === 'tile' || s === 'email' || s === 'notes' || s === 'success') ? s : 'context'
        );
        // Small delay so fetch result lands before Aria's response streams in.
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

  // Fetch calendar events for today
  useEffect(() => {
    if (!currentUser?.id) return;
    apiFetch(`${API_BASE}/api/gcal/events?timeZone=${encodeURIComponent(userTZ)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        // Client-side safety filter: only keep events that overlap with today in user's local timezone
        const todayLocal = getTodayLocal(userTZ);
        const filtered = data.filter((ev) => {
          if (ev.allDay) {
            // All-day events use date strings (YYYY-MM-DD)
            return ev.start === todayLocal || ev.end === todayLocal || (ev.start <= todayLocal && ev.end > todayLocal);
          }
          // Timed events: check if start date in local time matches today
          const startLocal = new Intl.DateTimeFormat('en-CA', { timeZone: userTZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ev.start));
          return startLocal === todayLocal;
        });
        setCalendarEvents(filtered);
      })
      .catch(() => {})
      .finally(() => setCalendarLoaded(true));
  }, [currentUser?.id]);

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
  const [ccMessages, setCcMessages] = useState(() => {
    try {
      const cached = localStorage.getItem(ccStorageKey);
      if (cached) return JSON.parse(cached);
    } catch {}
    return [];
  });
  const [ccConvId, setCcConvId] = useState(null);
  const [ccLoading, setCcLoading] = useState(true);
  const [ccInput, setCcInput] = useState('');
  const [ccSending, setCcSending] = useState(false);
  const ccAbortRef   = useRef(null);   // active AbortController for chat stream
  const ccStoppedRef = useRef(false);  // set true on user Stop so late events are ignored
  const ccSendRef    = useRef(null);   // holds latest handleCcSend for cross-surface triggers
  const ccMessagesRef = useRef([]);    // mirror of ccMessages for stable reads inside callbacks
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

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (ccScrollRef.current) ccScrollRef.current.scrollTop = ccScrollRef.current.scrollHeight;
    });
  }, []);

  useEffect(() => { scrollToBottom(); }, [ccMessages.length, scrollToBottom]);

  // Mirror ccMessages into a ref so callbacks (handleCcSend) can read the
  // latest committed state without depending on ccMessages in their deps.
  useEffect(() => { ccMessagesRef.current = ccMessages; }, [ccMessages]);

  // Persist CC messages to localStorage on every change
  useEffect(() => {
    if (ccMessages.length > 0) {
      try { localStorage.setItem(ccStorageKey, JSON.stringify(ccMessages)); } catch {}
    }
  }, [ccMessages, ccStorageKey]);

  // Poll for command center updates — Aria narrates updates via /api/chat/stream
  const pollUpdatesRef = useRef(null);
  pollUpdatesRef.current = async (convId) => {
    try {
      const res = await apiFetch(`/api/dashboard/command-center/updates?since=${encodeURIComponent(lastCheckedRef.current)}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      lastCheckedRef.current = new Date().toISOString();
      const { updates } = await res.json();
      if (!updates || updates.length === 0) return;

      // Build a natural prompt for Aria from the raw updates
      const updateSummary = updates.map((u) => u.content).join('\n');
      const ariaPrompt = `The following new events just occurred in the background. Narrate them to the user naturally and concisely in your voice as Aria — do not just repeat the raw text. Be brief, warm, and actionable:\n\n${updateSummary}`;

      // Build full context system prompt
      const aName = currentUser?.assistantName || 'Aria';
      const fullContext = buildSystemPrompt(tasks, entities, notes, chatCalendarEvents || calendarEvents, currentUser?.timezone);
      const sysPrompt = `You are ${aName}, ${firstName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything asked: advice, research, cooking, ideas, business, personal, anything. You also have action tools available to create tasks, notes, and calendar events. Use your tools when the user is asking you to take an action. For everything else, just respond naturally and conversationally. Be warm, direct, and concise. No sign-off.\n\n${fullContext}`;

      // Stream Aria's narration
      const streamRes = await apiFetch('/api/chat/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          systemPrompt: sysPrompt,
          messages: [{ role: 'user', content: ariaPrompt }],
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

      // Save and append as Aria message
      await apiFetch(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ role: 'assistant', content: ariaResponse, model: 'claude' }),
      });

      setCcMessages((prev) => [...prev, { role: 'assistant', content: ariaResponse, createdAt: new Date().toISOString(), ts: Date.now() }]);
    } catch (err) {
      console.error('[CommandCenter] poll failed:', err);
    }
  };

  // Init: load or create command center session — extracted to ref for trigger flexibility
  const ccInitRunningRef = useRef(false);
  const ccPollIntervalRef = useRef(null);

  const initCommandCenterRef = useRef(null);
  initCommandCenterRef.current = async () => {
    if (!currentUser?.id || ccInitRunningRef.current) return;
    ccInitRunningRef.current = true;
    setCcLoading(true);
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
      const aName = currentUser?.assistantName || 'Aria';
      const briefRes = await apiFetch('/api/dashboard/aria-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
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
        }),
      });
      const { brief } = await briefRes.json();

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
      const aName = currentUser?.assistantName || 'Aria';
      const briefRes = await apiFetch('/api/dashboard/aria-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          apiKey: apiKeys?.claude || '',
          assistantName: aName,
          persona: 'executive_assistant',
          userName: firstName,
          data: {
            overdue: overdueTasks.map((t) => t.title).join(', ') || 'None',
            highPriority: highPriorityTasks.map((t) => t.title).join(', ') || 'None',
            todayTasks: todayTasks.map((t) => t.title).join(', ') || 'None',
            events: calendarEvents.map((e) => e.title).join(', ') || 'None',
            notesCount: notes?.length || 0,
            entities: (entities || []).map((e) => e.name).join(', ') || 'None',
          },
        }),
      });
      const { brief } = await briefRes.json();
      const content = brief || 'Nothing new to report — you\'re all caught up!';
      const now = new Date().toISOString();
      await apiFetch(`/api/conversations/${ccConvId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ role: 'assistant', content, model: 'claude' }),
      });
      setCcMessages((prev) => [...prev, { role: 'assistant', content, createdAt: now, ts: Date.now() }]);
    } catch (err) {
      console.error('[CommandCenter] fresh update failed:', err);
      setCcMessages((prev) => [...prev, { role: 'assistant', content: 'Couldn\'t fetch an update right now — try again in a moment.', createdAt: new Date().toISOString(), ts: Date.now() }]);
    } finally {
      setCcRefreshing(false);
    }
  }, [ccConvId, ccRefreshing, currentUser, firstName, apiKeys, authToken, apiFetch, overdueTasks, highPriorityTasks, todayTasks, calendarEvents, notes, entities]);

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

    // "Summon context" intent — show cards alongside Aria's prose. Every
    // other message collapses the zone to give the chat full height.
    // Preserve tile/email/notes/success — those have their own lifecycle.
    const contextIntent = /what('s| is) (going on|happening|on my|my day)|catch me up|what do i have|good morning/i;
    const wantsContext = contextIntent.test(text);
    setActiveZoneState((s) => {
      if (s === 'tile' || s === 'email' || s === 'notes' || s === 'success') return s;
      return wantsContext ? 'context' : 'empty';
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
    try {
      const today = new Intl.DateTimeFormat('en-CA', {
        timeZone: userTZ, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const draft = await parseActionDraft({ apiFetch, authToken, message: text, timezone: userTZ, today });
      if (draft && (draft.type === 'task' || draft.type === 'event')) {
        const ack = draft.type === 'task'
          ? (draft.confidence === 'high' ? "Got it — here's the task" : "Here's a task draft")
          : (draft.confidence === 'high' ? "Got it — here's the event" : "Here's the event draft");
        const tileId = `tile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        const payload = draft.type === 'task'
          ? { title: draft.title, due_date: draft.due_date || '', due_time: to24hTo12h(draft.due_time), priority: draft.priority || 'medium' }
          : { title: draft.title, start_time: draft.start_time, duration_minutes: draft.duration_minutes || 60 };
        const now = new Date().toISOString();
        // Ack goes to chat feed; tile goes to the active zone.
        setCcMessages((prev) => [
          ...prev,
          { role: 'assistant', content: ack, createdAt: now, ts: Date.now() },
        ]);
        setActiveTile({
          role: draft.type === 'task' ? 'task_draft' : 'event_draft',
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
    setActiveTile(null);
    setActiveZoneState('empty');
  }, []);

  const executeActiveTile = useCallback(async () => {
    setActiveTile((prev) => (prev ? { ...prev, status: 'executing', error: null } : prev));
    const tile = activeTile;
    if (!tile) return;
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
      // Success: append summary to chat feed, flip zone to success, decay to empty.
      const summary = tile.type === 'task'
        ? `Task created — ${p.title || 'untitled'}${p.due_date ? ` · due ${p.due_date}` : ''}${p.entity_name ? ` · ${p.entity_name}` : ''}`
        : `Event created — ${p.title || 'untitled'}${p.start_time ? ` · ${p.start_time}` : ''}`;
      setCcMessages((prev) => [...prev, { role: 'system', content: summary, createdAt: new Date().toISOString(), ts: Date.now() }]);
      if (tile.type === 'task') onReloadTasks?.();
      else if (tile.type === 'event') onReloadCalendar?.();
      setActiveZoneState('success');
      setTimeout(() => {
        setActiveTile(null);
        setActiveZoneState('empty');
        // Refresh briefContext so the context cards repopulate with the new task/event.
        fetchBriefContext();
      }, 2000);
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
    <div className="flex-1 overflow-y-auto px-8 py-4 space-y-6 w-full" style={{ minHeight: 0 }}>

      {/* ROW 1: Greeting */}
      <div style={{ marginBottom: '16px' }}>
        <h1 style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '32px', fontWeight: 700, color: '#31323a', lineHeight: 1.1 }}>
          {greeting}, {firstName}.
        </h1>
        <p style={{ fontFamily: 'Manrope, sans-serif', fontSize: '13px', color: '#9ca3af', marginTop: '4px' }}>
          {dateStr}
        </p>
      </div>

      {/* ROW 2: Command Center */}
      <div className="bg-gradient-to-br from-surface-container-lowest to-surface-container-low rounded-xl shadow-[0px_10px_30px_rgba(79,77,207,0.05)] overflow-hidden border border-primary/5 flex flex-col" style={{ maxHeight: '1485px', width: '100%' }}>
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
          onCompleteTask={async (taskId) => {
            try {
              await apiFetch(`/api/tasks/${taskId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({ completed: true, completedAt: new Date().toISOString() }),
              });
              onReloadTasks?.();
              fetchBriefContext();
            } catch {}
          }}
          onOpenMeetingNotes={(event) => {
            setActiveTile({ type: 'meeting_notes', event, ts: Date.now() });
            setActiveZoneState('notes');
          }}
          onSaveMeetingNotes={async (event, body) => {
            if (!body || !body.trim()) return;
            try {
              const res = await apiFetch('/api/tile/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body: JSON.stringify({
                  type: 'note',
                  payload: {
                    title: `${event.title || 'Meeting'} — notes`,
                    body,
                    entity_name: event.entityName || null,
                  },
                }),
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.success) {
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
        {/* Messages */}
        <div ref={ccScrollRef} className="flex-1 overflow-y-auto px-5 py-3 space-y-3" style={{ minHeight: '405px', fontFamily: 'Manrope, sans-serif' }}>
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
                    <div key={i} className="flex justify-start">
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
                      setCcMessages((prev) => prev.map((m, j) => j === i ? { ...m, status: approved ? 'approved' : 'rejected' } : m));
                      onReloadTasks?.(); onReloadNotes?.();
                    } catch (err) {
                      setCcMessages((prev) => prev.map((m, j) => j === i ? { ...m, status: 'error' } : m));
                    }
                  };
                  return (
                    <div key={i} className="flex justify-start">
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
                        {msg.status === 'error' && <div style={{ fontSize: '12px', color: '#dc2626' }}>Confirmation failed</div>}
                      </div>
                    </div>
                  );
                }
                if (msg.role === 'system') {
                  return (
                    <div key={i} className="flex justify-center my-1">
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
                  <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
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
        {/* Input — hidden until brief is loaded */}
        {!ccLoading && <div className="px-4 py-3 border-t border-primary/5 flex items-center gap-2">
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

      {/* ROW 4: Timeline + Tasks + Upcoming */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">
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
                    <div className={`${i===1?'border-l-4 border-primary ':''} ${i===2?'bg-surface-container-low':'bg-surface-container-lowest'} p-3 rounded-xl shadow-sm hover:shadow-md transition-shadow`}>
                      <span className={`text-[8px] font-bold uppercase tracking-widest ${i===0?'text-primary':'text-slate-400'}`}>{timeStr}</span>
                      <h4 className="text-sm font-bold mt-1">{ev.title}</h4>
                    </div>
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
                    <div key={t.id} className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                      <button onClick={() => onToggleTask(t.id)} className="mt-0.5 h-4 w-4 rounded-full border-2 border-error flex items-center justify-center flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <h5 className="text-xs font-bold leading-tight text-error truncate">{t.title}</h5>
                        <div className="flex gap-2 mt-1.5">
                          <span className="flex items-center gap-1 text-[8px] font-bold text-error bg-error/5 px-1.5 py-0.5 rounded-full">
                            <span className="material-symbols-outlined text-[10px]">timer</span> overdue
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {todayTasks.slice(0,4).map((t) => (
                    <div key={t.id} className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                      <button onClick={() => onToggleTask(t.id)} className="mt-0.5 h-4 w-4 rounded-full border-2 border-outline-variant flex items-center justify-center hover:border-primary transition-colors flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <h5 className="text-xs font-bold leading-tight truncate">{t.title}</h5>
                        <div className="flex gap-2 mt-1.5">
                          <span className="flex items-center gap-1 text-[8px] font-bold text-primary bg-primary/5 px-1.5 py-0.5 rounded-full">Due today</span>
                        </div>
                      </div>
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
                    <div key={t.id} className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                      <button onClick={() => onToggleTask(t.id)} className="mt-0.5 h-4 w-4 rounded-full border-2 border-outline-variant flex items-center justify-center hover:border-primary transition-colors flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <h5 className="text-xs font-bold leading-tight truncate">{t.title}</h5>
                        <div className="flex gap-2 mt-1.5">
                          <span className="flex items-center gap-1 text-[8px] font-bold text-on-surface-variant bg-surface-container px-1.5 py-0.5 rounded-full">
                            {(() => { const [y, m, d] = t.dueDate.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); })()}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {floatingTasks.length > 0 && (
                    <>
                      <div className="px-3 pt-2 pb-1">
                        <span className="text-[8px] font-bold text-on-surface-variant uppercase tracking-widest">No date</span>
                      </div>
                      {floatingTasks.map((t) => (
                        <div key={t.id} className="p-3 flex items-start gap-3 hover:bg-surface-container-low transition-colors group">
                          <button onClick={() => onToggleTask(t.id)} className="mt-0.5 h-4 w-4 rounded-full border-2 border-outline-variant flex items-center justify-center hover:border-primary transition-colors flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <h5 className="text-xs font-bold leading-tight truncate">{t.title}</h5>
                          </div>
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

      {/* ROW 5: Active Notes */}
      <div className="space-y-4">
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

      {/* ROW 6: Task Performance */}
      <div className="space-y-4">
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
}) {
  const isContext = state === 'context' && briefContext;
  const isVisible = isContext || state === 'tile' || state === 'email' || state === 'notes' || state === 'success';

  if (!isVisible) {
    return <div style={{ height: 0, overflow: 'hidden', flexShrink: 0 }} />;
  }

  const wrapperStyle = {
    flexShrink: 0,
    padding: '14px 16px',
    borderBottom: '0.5px solid rgba(79,77,207,0.08)',
    background: '#fcfbff',
  };

  if (isContext) {
    const bc = briefContext;
    const entityDot = (t) => {
      const tag = (t.tags && t.tags[0]) || null;
      return tag ? (entityColorMap[tag.toLowerCase()] || '#9ca3af') : '#9ca3af';
    };
    const formatTime = (iso) => {
      try {
        if (!iso) return '';
        const d = new Date(iso);
        return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
      } catch { return ''; }
    };

    const Row = ({ dotColor, label, chip, chipColor, chipBg, actions }) => (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, fontSize: 12, color: '#374151' }}
        className="group"
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor || '#9ca3af', flexShrink: 0 }} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {chip && (
          <span style={{ fontSize: 10, color: chipColor || '#6b7280', background: chipBg || 'rgba(156,163,175,0.15)', padding: '1px 6px', borderRadius: 8, flexShrink: 0 }}>{chip}</span>
        )}
        {actions && actions.length > 0 && (
          <span
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ display: 'flex', gap: 4, flexShrink: 0 }}
          >
            {actions.map((a, i) => (
              <RowButton key={i} onClick={a.onClick}>{a.label}</RowButton>
            ))}
          </span>
        )}
      </div>
    );

    const Card = ({ title, children }) => (
      <div style={{ flex: 1, minWidth: 140, background: '#f5f2fa', borderRadius: 10, padding: '10px 12px' }}>
        <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 10, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>{title}</div>
        {children}
      </div>
    );

    // STILL OPEN — overdue first, then dueToday (cap 4 rows)
    const stillOpen = [
      ...(bc.tasks?.overdue || []).slice(0, 2).map((t) => ({ t, chip: 'overdue', chipColor: '#b91c1c', chipBg: 'rgba(239,68,68,0.15)' })),
      ...(bc.tasks?.dueToday || []).slice(0, 2).map((t) => ({ t, chip: 'today', chipColor: '#4f4dcf', chipBg: 'rgba(79,77,207,0.12)' })),
    ].slice(0, 4);

    const stillOpenRows = stillOpen.length === 0
      ? <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>—</div>
      : stillOpen.map(({ t, chip, chipColor, chipBg }, i) => (
          <Row
            key={`still-${i}`}
            dotColor={entityDot(t)}
            label={t.title}
            chip={chip} chipColor={chipColor} chipBg={chipBg}
            actions={[
              { label: 'Done', onClick: () => onCompleteTask?.(t.id) },
              { label: 'Reschedule', onClick: () => sendPrompt?.(`Reschedule ${t.title} to tomorrow`) },
            ]}
          />
        ));

    // DONE TODAY — completed tasks + completed events (cap 4)
    const completedTasks = (bc.tasks?.completedToday || []).slice(0, 2);
    const completedEvents = (bc.events?.completed || []).slice(0, 2);
    const doneRows = (completedTasks.length + completedEvents.length) === 0
      ? <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>—</div>
      : [
          ...completedTasks.map((t, i) => (
            <Row
              key={`dt-t-${i}`}
              dotColor={entityDot(t)}
              label={t.title}
              chip="✓" chipColor="#059669" chipBg="rgba(5,150,105,0.12)"
            />
          )),
          ...completedEvents.map((ev, i) => (
            <Row
              key={`dt-e-${i}`}
              dotColor="#10b981"
              label={ev.title}
              chip={formatTime(ev.start)} chipColor="#065f46" chipBg="rgba(5,150,105,0.08)"
              actions={[
                { label: 'Notes', onClick: () => onOpenMeetingNotes?.(ev) },
              ]}
            />
          )),
        ];

    // UP NEXT — upcoming events + first important unread email (cap 3)
    const upcomingEvents = (bc.events?.upcoming || []).slice(0, 2);
    const topEmail = (bc.emails?.needsAttention || [])[0];
    const upNextRows = (upcomingEvents.length === 0 && !topEmail)
      ? <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>—</div>
      : [
          ...upcomingEvents.map((ev, i) => (
            <Row
              key={`un-e-${i}`}
              dotColor="#4f4dcf"
              label={ev.title}
              chip={formatTime(ev.start)} chipColor="#4f4dcf" chipBg="rgba(79,77,207,0.1)"
              actions={[
                { label: 'Prep me', onClick: () => sendPrompt?.(`Prep me for ${ev.title}`) },
              ]}
            />
          )),
          ...(topEmail ? [(
            <Row
              key="un-m"
              dotColor="#f59e0b"
              label={(() => {
                const raw = topEmail.summary || topEmail.vendor || 'Email';
                return raw.length > 30 ? raw.slice(0, 30) + '…' : raw;
              })()}
              chip="action" chipColor="#92400e" chipBg="rgba(245,158,11,0.12)"
              actions={[
                { label: 'Reply', onClick: () => sendPrompt?.(`Help me reply to ${topEmail.summary || 'this email'} from ${topEmail.vendor || 'the sender'}`) },
              ]}
            />
          )] : []),
        ];

    return (
      <div style={wrapperStyle}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <Card title="Still open">{stillOpenRows}</Card>
          <Card title="Done today">{doneRows}</Card>
          <Card title="Up next">{upNextRows}</Card>
        </div>
      </div>
    );
  }

  if (state === 'tile' && activeTile) {
    const Tile = activeTile.role === 'task_draft' ? TaskDraftTile : EventDraftTile;
    return (
      <div style={wrapperStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#4f4dcf', animation: 'pulse 1.5s infinite' }} />
          <span style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 700, fontSize: 10, color: '#4f4dcf', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {activeTile.type === 'task' ? 'Task draft' : 'Event draft'}
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
      <div style={wrapperStyle}>
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
      <div style={wrapperStyle}>
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

  if (state === 'success') {
    return (
      <div style={wrapperStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#059669' }}>
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>check_circle</span>
          <span style={{ fontFamily: 'Manrope, sans-serif', fontSize: '13px', fontWeight: 600 }}>Done</span>
        </div>
      </div>
    );
  }

  return <div style={{ height: 0, overflow: 'hidden', flexShrink: 0 }} />;
}
