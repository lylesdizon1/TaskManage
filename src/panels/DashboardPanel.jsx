import { useState, useEffect, useMemo } from 'react';
import { useToast } from '../contexts/ToastContext';

const API_BASE = '';

export default function DashboardPanel({ tasks, currentUser, authToken, apiKeys, notes, onNavigate, onAIPrompt, entities, onAddTask, onQuickNote, onAddEvent, backend, onBackendChange, apiFetch, callClaudeChat }) {
  const [digest, setDigest] = useState(null);
  const [digestLoading, setDigestLoading] = useState(true);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  const [timelineSummary, setTimelineSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [ariaBrief, setAriaBrief] = useState(null);
  const [ariaBriefLoading, setAriaBriefLoading] = useState(true);
  const [briefSending, setBriefSending] = useState(false);
  const toast = useToast();

  async function sendMorningBrief() {
    setBriefSending(true);
    try {
      const res = await apiFetch('/api/alerts/morning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (res.ok) toast.success(data.message || 'Morning brief sent!');
      else toast.error(data.error || 'Failed to send morning brief');
    } catch {
      toast.error('Failed to send morning brief');
    } finally {
      setBriefSending(false);
    }
  }

  const _d = new Date();
  const today = `${_d.getFullYear()}-${String(_d.getMonth()+1).padStart(2,'0')}-${String(_d.getDate()).padStart(2,'0')}`;
  const tasksReady = tasks.length > 0 || tasks._loaded;

  // Clear stale date-keyed caches on mount
  useEffect(() => {
    Object.keys(localStorage).forEach((key) => {
      if ((key.startsWith('aria_brief_') || key.startsWith('timeline_summary_') || key.startsWith('digest_')) && !key.includes(today)) {
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
        const todayLocal = new Date().toISOString().slice(0, 10);
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

  // Aria brief (persona-aware, once per day, cached)
  useEffect(() => {
    const _h = new Date().getHours();
    const _tod = _h < 12 ? 'morning' : _h < 17 ? 'afternoon' : 'evening';
    const cacheKey = `aria_brief_${today}_${_tod}_${currentUser?.id || ''}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) { setAriaBrief(cached); setAriaBriefLoading(false); return; }

    // Don't generate until all data sources have loaded
    if (!allDataReady) return;

    const hour2 = new Date().getHours();
    const tod = hour2 < 12 ? 'morning' : hour2 < 17 ? 'afternoon' : 'evening';
    const aName = currentUser?.assistantName || 'Aria';
    const overdueStr = overdueTasks.length > 0 ? overdueTasks.map((t) => t.title).slice(0, 5).join(', ') : 'None';
    const dueTodayStr = todayTasks.length > 0 ? todayTasks.map((t) => t.title).slice(0, 5).join(', ') : 'None';
    const highTodayOnly = highPriorityTasks.filter((t) => !t.dueDate || t.dueDate <= today);
    const highStr = highTodayOnly.length > 0 ? highTodayOnly.map((t) => t.title).slice(0, 5).join(', ') : 'None';
    const eventsStr = calendarEvents.length > 0 ? calendarEvents.map((e) => e.title).slice(0, 5).join(', ') : 'None';
    const entStr = (entities || []).filter((e) => e.type === 'business').map((e) => e.name).join(', ') || 'None';


    const sysPrompt = `You are ${aName}, an Executive Assistant. Write a warm, professional ${tod} brief for ${firstName} in 2-3 sentences. Focus ONLY on what needs attention today: overdue tasks, tasks due today, high priority items, and calendar events. Do not mention finances, businesses, or anything not directly actionable today. If everything is clear, say so briefly. Write naturally. No bullet points. No sign-off.`;
    const userMsg = `Write my ${tod} brief.\n\nTODAY'S DATA:\n- Calendar events today: ${eventsStr}\n- Overdue tasks: ${overdueStr}\n- Due today: ${dueTodayStr}\n- High priority: ${highStr}`;

    callClaudeChat([{ role: 'user', content: userMsg }], sysPrompt, apiKeys?.claude || '', authToken)
      .then((text) => {
        if (text && text !== '(no response)') {
          // Strip any trailing signature like "— Aria" or "- Aria" to avoid duplicate
          const cleaned = text.replace(/\s*[—–-]\s*\w+\s*$/, '').trim();
          setAriaBrief(cleaned);
          localStorage.setItem(cacheKey, cleaned);
        }
      })
      .catch((err) => { console.error('[aria-brief] generation failed:', err.message); })
      .finally(() => setAriaBriefLoading(false));
  }, [today, allDataReady, calendarEvents.length, overdueTasks.length, todayTasks.length, highPriorityTasks.length, notesThisWeek]); // eslint-disable-line react-hooks/exhaustive-deps

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

      {/* ROW 1: Greeting + Search + Weather */}
      <div className="flex items-center justify-between gap-6">
        <div className="flex-shrink-0">
          <h2 className="text-2xl font-extrabold tracking-tight text-on-background font-headline">{greeting}, {firstName}.</h2>
          <p className="text-on-surface-variant text-[11px] font-medium">{dateStr}</p>
        </div>
        <div className="flex-1 flex justify-center">
          <div className="flex items-center gap-3 bg-surface-container-lowest px-4 py-3 rounded-xl w-full shadow-sm border border-primary/10 transition-all hover:shadow-md focus-within:ring-2 focus-within:ring-primary/20">
            <span className="material-symbols-outlined text-primary text-lg">search</span>
            <input
              className="bg-transparent border-none focus:ring-0 text-[11px] w-full placeholder:text-slate-400 font-medium outline-none"
              placeholder="Ask Aria anything..."
              onKeyDown={(e) => { if (e.key === 'Enter' && e.target.value.trim()) { onAIPrompt(e.target.value.trim()); e.target.value = ''; } }}
            />
            <select
              value={backend}
              onChange={(e) => onBackendChange(e.target.value)}
              className="flex-shrink-0 bg-transparent border-none text-[10px] font-bold text-primary focus:ring-0 cursor-pointer outline-none px-1 py-0.5 rounded-full"
            >
              <option value="claude">Claude</option>
              <option value="chatgpt">ChatGPT</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-surface-container-low px-3 py-1.5 rounded-full border border-primary/5 flex-shrink-0">
          <span className="material-symbols-outlined text-amber-500 text-lg">sunny</span>
          <span className="text-[11px] font-bold text-on-surface">Danville</span>
        </div>
      </div>

      {/* ROW 2: Aria Daily Brief */}
      <div className="bg-gradient-to-br from-surface-container-lowest to-surface-container-low p-5 rounded-xl shadow-[0px_10px_30px_rgba(79,77,207,0.05)] relative overflow-hidden group border border-primary/5">
        <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity pointer-events-none">
          <span className="material-symbols-outlined text-[60px] overflow-hidden inline-block w-[60px] h-[60px]" aria-hidden="true">auto_awesome</span>
        </div>
        <div className="relative z-10 flex flex-col md:flex-row gap-4 items-start">
          <div className="flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-lg">auto_awesome</span>
              <h3 className="text-base font-bold font-headline text-primary">{assistantName}&apos;s Daily Brief</h3>
            </div>
            {ariaBriefLoading ? (
              <p className="text-on-surface-variant leading-relaxed text-xs max-w-4xl animate-pulse">Preparing your brief...</p>
            ) : ariaBrief ? (
              <p className="text-on-surface-variant leading-relaxed text-xs max-w-4xl">{ariaBrief}</p>
            ) : (
              <p className="text-on-surface-variant leading-relaxed text-xs max-w-4xl">No brief yet — check back in a moment.</p>
            )}
            <div className="flex gap-2">
              {overdueTasks.length > 0 && (
                <span className="bg-error/10 text-error px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider">{overdueTasks.length} Overdue</span>
              )}
              {calendarEvents.length > 0 ? (
                <span className="bg-surface-container-highest text-on-surface-variant px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider">{calendarEvents.length} Events Today</span>
              ) : (
                <span className="bg-surface-container-highest text-on-surface-variant px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-wider">Clear Morning</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ROW 3: Quick Actions + Stat Tiles — Stitch comp layout */}
      {/* Mobile: two 3-col grids stacked. Desktop: single 6-col row matching comp */}
      <div className="space-y-3 md:space-y-0">
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          {/* Quick Action Buttons */}
          <button onClick={onAddTask} className="bg-primary/5 hover:bg-primary hover:text-on-primary transition-all rounded-xl flex items-center justify-center p-3 gap-2 group shadow-sm border border-primary/10">
            <span className="material-symbols-outlined text-primary group-hover:text-on-primary transition-colors text-lg">add_task</span>
            <span className="text-[10px] font-bold uppercase">Add Task</span>
          </button>
          <button onClick={onQuickNote} className="bg-primary/5 hover:bg-primary hover:text-on-primary transition-all rounded-xl flex items-center justify-center p-3 gap-2 group shadow-sm border border-primary/10">
            <span className="material-symbols-outlined text-primary group-hover:text-on-primary transition-colors text-lg">edit_note</span>
            <span className="text-[10px] font-bold uppercase">Quick Note</span>
          </button>
          <button onClick={sendMorningBrief} disabled={briefSending} className="bg-primary/5 hover:bg-primary hover:text-on-primary transition-all rounded-xl flex items-center justify-center p-3 gap-2 group shadow-sm border border-primary/10 disabled:opacity-50">
            <span className="material-symbols-outlined text-primary group-hover:text-on-primary transition-colors text-lg">{briefSending ? 'hourglass_empty' : 'wb_twilight'}</span>
            <span className="text-[10px] font-bold uppercase">{briefSending ? 'Sending...' : 'Morning Brief'}</span>
          </button>
          {/* Stat Tiles — centered text on mobile, icon+number on desktop (Stitch comp) */}
          <button onClick={() => onNavigate('inbox')} className="bg-surface-container-lowest p-3 rounded-xl shadow-[0px_10px_20px_rgba(79,77,207,0.04)] text-center md:text-left md:flex md:items-center md:gap-3 hover:bg-surface-container-low transition-colors group shadow-sm relative">
            <div className="hidden md:block bg-error/10 p-2 rounded-full group-hover:scale-110 transition-transform">
              <span className="material-symbols-outlined text-error text-lg">inbox</span>
            </div>
            <div>
              <p className="text-lg font-extrabold text-on-background font-headline leading-none">{String(inboxCount).padStart(2,'0')}</p>
              <p className="text-[8px] text-on-surface-variant font-bold uppercase mt-0.5">Inbox</p>
            </div>
            {inboxCount > 0 && <div className="absolute top-2 right-2 w-2 h-2 rounded-full bg-error animate-pulse" />}
          </button>
          <button onClick={() => onNavigate('daily', 'overdue')} className="bg-surface-container-lowest p-3 rounded-xl shadow-[0px_10px_20px_rgba(79,77,207,0.04)] text-center md:text-left md:flex md:items-center md:gap-3 hover:bg-surface-container-low transition-colors group shadow-sm">
            <div className="hidden md:block bg-error-container/20 p-2 rounded-full group-hover:scale-110 transition-transform">
              <span className="material-symbols-outlined text-error text-lg">event_busy</span>
            </div>
            <div>
              <p className="text-lg font-extrabold text-on-background font-headline leading-none">{String(overdueTasks.length).padStart(2,'0')}</p>
              <p className="text-[8px] text-on-surface-variant font-bold uppercase mt-0.5">Overdue</p>
            </div>
          </button>
          <button onClick={() => onNavigate('daily', 'high')} className="bg-surface-container-lowest p-3 rounded-xl shadow-[0px_10px_20px_rgba(79,77,207,0.04)] text-center md:text-left md:flex md:items-center md:gap-3 hover:bg-surface-container-low transition-colors group shadow-sm">
            <div className="hidden md:block bg-primary/10 p-2 rounded-full group-hover:scale-110 transition-transform">
              <span className="material-symbols-outlined text-primary text-lg">priority_high</span>
            </div>
            <div>
              <p className="text-lg font-extrabold text-on-background font-headline leading-none">{String(highPriorityTasks.length).padStart(2,'0')}</p>
              <p className="text-[8px] text-on-surface-variant font-bold uppercase mt-0.5">Priority</p>
            </div>
          </button>
        </div>
      </div>

      {/* ROW 4: Timeline + Tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
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
                      <button className="mt-0.5 h-4 w-4 rounded-full border-2 border-error flex items-center justify-center flex-shrink-0" />
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
                      <button className="mt-0.5 h-4 w-4 rounded-full border-2 border-outline-variant flex items-center justify-center hover:border-primary transition-colors flex-shrink-0" />
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
      </div>

      {/* ROW 5: Task Performance */}
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

      {/* ROW 6: Active Notes */}
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
              <button key={note.id} onClick={() => onNavigate('notes')} className={'bg-surface-container-lowest p-5 rounded-xl shadow-sm border-t-4 '+borders[i%3]+' group hover:scale-[1.01] transition-transform cursor-pointer border-x border-b border-x-surface-container-low border-b-surface-container-low text-left w-full'}>
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

      <div className="h-8" />

    </div>
  );
}
