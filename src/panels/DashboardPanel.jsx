import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useToast } from '../contexts/ToastContext';
import buildSystemPrompt from '../utils/systemPrompt';
import { getTodayLocal } from '../utils/helpers.js';

const API_BASE = '';

export default function DashboardPanel({ tasks, currentUser, authToken, apiKeys, notes, onNavigate, onAIPrompt, entities, onAddTask, onQuickNote, onAddEvent, onToggleTask, onOpenNote, backend, onBackendChange, apiFetch, callClaudeChat, chatCalendarEvents, initialBriefData, onReloadTasks, onReloadNotes }) {
  const [digest, setDigest] = useState(null);
  const [digestLoading, setDigestLoading] = useState(true);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  const [timelineSummary, setTimelineSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const toast = useToast();

  const _d = new Date();
  const today = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
  const tasksReady = tasks.length > 0 || tasks._loaded;

  // Clear stale date-keyed caches on mount
  useEffect(() => {
    Object.keys(localStorage).forEach((key) => {
      if ((key.startsWith('aria_brief_') || key.startsWith('timeline_summary_') || key.startsWith('digest_') || key.startsWith('cc_messages_')) && !key.includes(today)) {
        localStorage.removeItem(key);
      }
    });
  }, [today]);

  // Greeting
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = currentUser?.displayName?.split(' ')[0] || currentUser?.username || '';
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

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
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    apiFetch(`${API_BASE}/api/gcal/events?userId=${currentUser.id}&timeZone=${encodeURIComponent(tz)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        // Client-side safety filter: only keep events that overlap with today in user's local timezone
        const todayLocal = getTodayLocal();
        const filtered = data.filter((ev) => {
          if (ev.allDay) {
            // All-day events use date strings (YYYY-MM-DD)
            return ev.start === todayLocal || ev.end === todayLocal || (ev.start <= todayLocal && ev.end > todayLocal);
          }
          // Timed events: check if start date in local time matches today
          const startLocal = new Date(ev.start).toLocaleDateString('en-CA'); // YYYY-MM-DD format
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
  const ccStorageKey = `cc_messages_${getTodayLocal()}`;
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
  const [ccRefreshing, setCcRefreshing] = useState(false);
  const ccScrollRef = useRef(null);
  const lastCheckedRef = useRef(new Date().toISOString());
  const ccAutoRefreshedRef = useRef(false);

  // Auto-scroll to bottom
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (ccScrollRef.current) ccScrollRef.current.scrollTop = ccScrollRef.current.scrollHeight;
    });
  }, []);

  useEffect(() => { scrollToBottom(); }, [ccMessages.length, scrollToBottom]);

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
      const fullContext = buildSystemPrompt(tasks, entities, notes, chatCalendarEvents || calendarEvents);
      const sysPrompt = `You are ${aName}, ${firstName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything asked: advice, research, cooking, ideas, business, personal, anything. You also have action tools available to create tasks, notes, and calendar events. Use your tools when the user is asking you to take an action. For everything else, just respond naturally and conversationally. Be warm, direct, and concise. No sign-off.\n\n${fullContext}`;

      // Stream Aria's narration
      const streamRes = await apiFetch('/api/chat/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          systemPrompt: sysPrompt,
          messages: [{ role: 'user', content: ariaPrompt }],
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
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

      // Step 3: no messages — generate brief first
      const h = new Date().getHours();
      const tod = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
      const aName = currentUser?.assistantName || 'Aria';
      const briefRes = await apiFetch('/api/dashboard/aria-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          apiKey: apiKeys?.claude || '',
          assistantName: aName,
          persona: 'executive_assistant',
          userName: firstName,
          timeOfDay: tod,
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
  const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

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
      const h = new Date().getHours();
      const tod = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
      const aName = currentUser?.assistantName || 'Aria';
      const briefRes = await apiFetch('/api/dashboard/aria-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          apiKey: apiKeys?.claude || '',
          assistantName: aName,
          persona: 'executive_assistant',
          userName: firstName,
          timeOfDay: tod,
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
      if (brief) {
        const now = new Date().toISOString();
        await apiFetch(`/api/conversations/${ccConvId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ role: 'assistant', content: brief, model: 'claude' }),
        });
        setCcMessages((prev) => [...prev, { role: 'assistant', content: brief, createdAt: now, ts: Date.now() }]);
      }
    } catch (err) {
      console.error('[CommandCenter] fresh update failed:', err);
    } finally {
      setCcRefreshing(false);
    }
  }, [ccConvId, ccRefreshing, currentUser, firstName, apiKeys, authToken, apiFetch, overdueTasks, highPriorityTasks, todayTasks, calendarEvents, notes, entities]);

  // Auto-refresh on visibility change (returning to tab after 15min)
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
  const handleCcSend = useCallback(async () => {
    const text = ccInput.trim();
    if (!text || ccSending || !ccConvId) return;
    setCcInput('');
    setCcSending(true);

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

    // Build context: last 10 messages + full Aria system prompt with live data
    const recentMsgs = [...ccMessages.slice(-9), userMsg].map((m) => ({ role: m.role, content: m.content }));
    const aName = currentUser?.assistantName || 'Aria';
    const fullContext = buildSystemPrompt(tasks, entities, notes, chatCalendarEvents || calendarEvents);
    const sysPrompt = `You are ${aName}, ${firstName}'s personal AI assistant. You are a full general assistant — answer any question, discuss any topic, help with anything asked: advice, research, cooking, ideas, business, personal, anything. You also have action tools available to create tasks, notes, and calendar events. Use your tools when the user is asking you to take an action. For everything else, just respond naturally and conversationally. Be warm, direct, and concise. No sign-off.\n\n${fullContext}`;

    // Stream response
    let fullResponse = '';
    const placeholderIdx = ccMessages.length + 1;
    setCcMessages((prev) => [...prev, { role: 'assistant', content: '', createdAt: new Date().toISOString(), ts: Date.now() }]);

    try {
      const res = await apiFetch('/api/chat/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          systemPrompt: sysPrompt,
          messages: recentMsgs,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
        }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
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
              } else if (currentEvent === 'done') {
                // finalize — stream complete
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

      // Save assistant response
      if (fullResponse) {
        await apiFetch(`/api/conversations/${ccConvId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ role: 'assistant', content: fullResponse }),
        });
      }
    } catch (err) {
      setCcMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { ...updated[updated.length - 1], content: `Error: ${err.message}` };
        return updated;
      });
    } finally {
      setCcSending(false);
    }
  }, [ccInput, ccSending, ccConvId, ccMessages, currentUser, firstName, apiKeys, authToken, apiFetch, tasks, entities, notes, calendarEvents, chatCalendarEvents]);

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

  // Entity badge for tasks
  const entityBadge = (tags) => {
    if (!tags || tags.length === 0) return null;
    const tag = tags[0];
    const pillarLower = tag.toLowerCase();
    if (['hustle', 'home', 'move', 'grow'].includes(pillarLower)) return pillarBadge(pillarLower);
    return <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600">{tag.length > 12 ? tag.slice(0, 12) + '…' : tag}</span>;
  };

  // Performance stats (30 day window)
  const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0,10);
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
        <div className="flex items-center justify-between px-5 py-3 border-b border-primary/5">
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
        {/* Messages */}
        <div ref={ccScrollRef} className="flex-1 overflow-y-auto px-5 py-3 space-y-3" style={{ minHeight: '405px', fontFamily: 'Manrope, sans-serif' }}>
          {ccLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '32px', color: '#4f4dcf' }}>
              <span className="material-symbols-outlined" style={{ animation: 'spin 1s linear infinite', fontSize: '24px' }}>auto_awesome</span>
              <span style={{ fontFamily: 'Manrope, sans-serif', fontSize: '15px', color: '#6b7280' }}>Aria is thinking...</span>
            </div>
          ) : ccMessages.length === 0 ? (
            <p style={{ fontFamily: 'Manrope, sans-serif', fontSize: '15px', lineHeight: '1.6', color: '#6b7280' }}>No messages yet.</p>
          ) : (
            <>
              {ccMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] ${msg.role === 'user' ? 'text-white' : ''}`}
                    style={msg.role === 'user'
                      ? { backgroundColor: '#4f4dcf', fontFamily: 'Manrope, sans-serif', fontSize: '15px', lineHeight: '1.6', borderRadius: '12px', padding: '12px 16px' }
                      : { backgroundColor: '#f5f2fa', fontFamily: 'Manrope, sans-serif', fontSize: '15px', lineHeight: '1.6', borderRadius: '12px', padding: '12px 16px' }
                    }
                  >
                    {msg.content || <span className="animate-pulse">...</span>}
                  </div>
                </div>
              ))}
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
          <button
            onClick={handleCcSend}
            disabled={!ccInput.trim() || ccSending}
            className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all disabled:opacity-30"
            style={{ backgroundColor: ccInput.trim() ? '#4f4dcf' : 'transparent' }}
          >
            <span className={`material-symbols-outlined text-base ${ccInput.trim() ? 'text-white' : 'text-slate-400'}`}>
              {ccSending ? 'hourglass_empty' : 'send'}
            </span>
          </button>
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
