import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay, startOfMonth, endOfMonth, addMonths, subMonths, addDays, subDays } from 'date-fns';
import enUS from 'date-fns/locale/en-US';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { SpinnerIcon, CalendarIcon } from '../components/icons/Icons.jsx';

const API_BASE = '';

const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

const ENTITY_COLORS = [
  '#4f4dcf', '#0ea5e9', '#10b981', '#f59e0b',
  '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6',
];
const NEUTRAL_COLOR = '#94a3b8';

export default function CalendarPanel({ currentUser, authToken, addToast, apiFetch }) {
  const [gcalStatus, setGcalStatus] = useState({ connected: false, email: null, accounts: [] });
  const [outlookAccounts, setOutlookAccounts] = useState([]); // [{ id, account_email, provider, created_at }]
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(false); // Connected Accounts collapse
  const swipeStartX = useRef(null); // Day-view swipe gesture x0
  const [loading, setLoading]       = useState(true);
  const [events, setEvents]         = useState([]);
  const [entities, setEntities]     = useState([]);
  const [view, setView]             = useState('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ top: 0, left: 0 });
  const popoverRef = useRef(null);
  const [eventNotes, setEventNotes] = useState({ preNote: '', postNote: '' });
  const [editingPre, setEditingPre] = useState('');
  const [editingPost, setEditingPost] = useState('');
  const [noteSaved, setNoteSaved] = useState(false);
  const [notesLoading, setNotesLoading] = useState(false);
  const [historyNotes, setHistoryNotes] = useState([]);
  const [historySearch, setHistorySearch] = useState('');
  const [historyRange, setHistoryRange] = useState('month');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ title: '', date: '', startTime: '', endTime: '', googleEmail: '', entityTag: '', notes: '' });
  const [createSaving, setCreateSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const userTZ = currentUser?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Refresh BOTH provider account lists. Used on mount and after either
  // OAuth redirect so neither provider's display can be stale after the
  // other reconnects. Individual failures inside each fetch preserve
  // prior state rather than wiping it (see each fn's catch).
  async function refreshAllAccounts() {
    await Promise.all([checkStatus(), loadOutlookAccounts()]);
  }

  // ── Status check ──────────────────────────────────────────────
  useEffect(() => {
    refreshAllAccounts();
    const params = new URLSearchParams(window.location.search);
    const fromGcal = params.get('gcal') === 'connected';
    const fromOutlook = params.get('outlook') === 'connected';
    if (fromGcal || fromOutlook) {
      window.history.replaceState({}, '', window.location.pathname);
      // Always reload BOTH lists — an OAuth redirect on one provider
      // shouldn't leave the other provider's UI display out of sync.
      refreshAllAccounts();
      if (fromGcal) addToast({ type: 'success', message: 'Google Calendar connected!' });
      if (fromOutlook) addToast({ type: 'success', message: 'Outlook connected!' });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadOutlookAccounts() {
    try {
      const res = await apiFetch(`${API_BASE}/api/outlook/accounts`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      // Resilience: do NOT wipe prior state on transient fetch failures.
      // A 5xx blip from the server or a cross-tab redirect-race must not
      // clear accounts the user already had visible.
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setOutlookAccounts(data);
    } catch { /* preserve prior state */ }
  }

  async function handleConnectOutlook() {
    setAddMenuOpen(false);
    try {
      const res = await apiFetch(`${API_BASE}/api/outlook/auth-url`, { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (data.error || !data.url) { addToast({ type: 'error', message: data.error || 'Outlook OAuth not configured' }); return; }
      window.location.href = data.url;
    } catch { addToast({ type: 'error', message: 'Failed to start Outlook sign-in' }); }
  }

  async function handleDisconnectOutlook(id, email) {
    try {
      await apiFetch(`${API_BASE}/api/outlook/accounts/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      addToast({ type: 'success', message: email ? `Disconnected ${email}` : 'Outlook disconnected' });
      loadOutlookAccounts();
    } catch { addToast({ type: 'error', message: 'Failed to disconnect' }); }
  }

  async function checkStatus() {
    setLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/gcal/status`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!res.ok) return; // preserve prior state on transient failure
      const data = await res.json();
      // Only overwrite state when we actually have an accounts array — a
      // partial or malformed response must not clobber a good prior one.
      if (data && Array.isArray(data.accounts)) setGcalStatus(data);
    } catch {
      // preserve prior state — a transient network blip should not wipe
      // the user's connected accounts from the UI.
    } finally {
      setLoading(false);
    }
  }

  // ── Fetch entities for color mapping ──────────────────────────
  useEffect(() => {
    if (!gcalStatus.connected) return;
    apiFetch(`${API_BASE}/api/entities`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setEntities(data); })
      .catch(() => {});
  }, [gcalStatus.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Entity color map ──────────────────────────────────────────
  const entityColorMap = useMemo(() => {
    const map = {};
    entities.forEach((e, i) => {
      map[e.name.toLowerCase()] = (e.color && e.color.startsWith('#')) ? e.color : ENTITY_COLORS[i % ENTITY_COLORS.length];
    });
    return map;
  }, [entities]);

  // Map calendarId → entity color for GCal calendar matching
  const calendarEntityColorMap = useMemo(() => {
    const map = {};
    entities.forEach((e, i) => {
      if (e.calendarId) {
        map[e.calendarId] = (e.color && e.color.startsWith('#')) ? e.color : ENTITY_COLORS[i % ENTITY_COLORS.length];
      }
    });
    return map;
  }, [entities]);

  function getEventColor(event) {
    // Explicit entity tag takes priority — user chose this deliberately
    if (event.entityName) {
      const c = entityColorMap[event.entityName.toLowerCase()];
      if (c) return c;
    }
    // Fall back to calendarId → entity mapping
    if (event.calendarId && calendarEntityColorMap[event.calendarId]) {
      return calendarEntityColorMap[event.calendarId];
    }
    // Scan title for entity name mentions
    const titleLower = (event.title || '').toLowerCase();
    for (const [name, color] of Object.entries(entityColorMap)) {
      if (titleLower.includes(name)) return color;
    }
    return NEUTRAL_COLOR;
  }

  // ── Fetch events ──────────────────────────────────────────────
  const fetchEvents = useCallback(async () => {
    if (!gcalStatus.connected) return;
    try {
      // Fetch from start of current view month to cover past + future days
      const monthStart = startOfMonth(currentDate);
      const monthEnd = endOfMonth(currentDate);
      const days = Math.ceil((monthEnd - monthStart) / 86400000) + 7; // extra week buffer
      const startDate = format(monthStart, 'yyyy-MM-dd');
      const res = await apiFetch(
        `${API_BASE}/api/gcal/events?timeZone=${encodeURIComponent(userTZ)}&days=${days}&startDate=${startDate}`,
        { headers: { Authorization: `Bearer ${authToken}` } },
      );
      const data = await res.json();
      if (!Array.isArray(data)) return;
      const mapped = data.map(ev => ({
        id: ev.id,
        title: ev.title || '(No title)',
        start: ev.allDay ? new Date(ev.start + 'T00:00:00') : new Date(ev.start),
        end: ev.allDay ? new Date((ev.end || ev.start) + 'T00:00:00') : new Date(ev.end || ev.start),
        allDay: ev.allDay || false,
        account: ev.account || '',
        calendarId: ev.calendarId || '',
        entityName: ev.entityName || '',
      }));
      setEvents(mapped);
    } catch {
      // silent
    }
  }, [gcalStatus.connected, authToken, userTZ, currentDate.getMonth(), currentDate.getFullYear()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  // ── Fetch notes when event selected ──────────────────────────
  useEffect(() => {
    if (!selectedEvent) return;
    setNotesLoading(true);
    const rawId = selectedEvent.id;
    // strip account prefix (email::eventId → eventId)
    const eventId = rawId.includes('::') ? rawId.split('::').slice(1).join('::') : rawId;
    apiFetch(`${API_BASE}/api/calendar-notes?eventId=${encodeURIComponent(eventId)}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })
      .then(r => r.json())
      .then(data => {
        const pre = data.preNote || data.pre_note || '';
        const post = data.postNote || data.post_note || '';
        setEventNotes({ preNote: pre, postNote: post });
        setEditingPre(pre);
        setEditingPost(post);
      })
      .catch(() => {
        setEventNotes({ preNote: '', postNote: '' });
        setEditingPre('');
        setEditingPost('');
      })
      .finally(() => setNotesLoading(false));
  }, [selectedEvent?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveNote(field, value) {
    if (!selectedEvent) return;
    const rawId = selectedEvent.id;
    const eventId = rawId.includes('::') ? rawId.split('::').slice(1).join('::') : rawId;
    try {
      await apiFetch(`${API_BASE}/api/calendar-notes/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          [field]: value,
          event_title: selectedEvent.title,
          event_start: selectedEvent.start?.toISOString(),
          event_end: selectedEvent.end?.toISOString(),
          source_account: selectedEvent.account || null,
        }),
      });
      setEventNotes(prev => ({ ...prev, [field === 'pre_note' ? 'preNote' : 'postNote']: value }));
      setNoteSaved(true);
      setTimeout(() => setNoteSaved(false), 1500);
    } catch {
      addToast({ type: 'error', message: 'Failed to save note' });
    }
  }

  // ── Fetch history notes ──────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (view !== 'history') return;
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ dateRange: historyRange, limit: '50' });
      if (historySearch) params.set('search', historySearch);
      const res = await apiFetch(`${API_BASE}/api/calendar-notes/history?${params}`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      setHistoryNotes(Array.isArray(data) ? data : []);
    } catch {
      setHistoryNotes([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [view, historyRange, historySearch, authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // ── Close popover on outside click ────────────────────────────
  useEffect(() => {
    if (!selectedEvent) return;
    function handleClick(e) {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setSelectedEvent(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [selectedEvent]);

  // ── Handlers ──────────────────────────────────────────────────
  async function handleConnect() {
    try {
      const res = await apiFetch(`${API_BASE}/api/gcal/auth-url`, { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (data.error) { addToast({ type: 'error', message: data.error }); return; }
      window.location.href = data.url;
    } catch { addToast({ type: 'error', message: 'Failed to start Google sign-in' }); }
  }

  async function handleDisconnect(email) {
    try {
      await apiFetch(`${API_BASE}/api/gcal/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ email }),
      });
      addToast({ type: 'success', message: email ? `Disconnected ${email}` : 'Google Calendar disconnected' });
      checkStatus();
    } catch { addToast({ type: 'error', message: 'Failed to disconnect' }); }
  }

  async function handleSetPrimary(email) {
    try {
      await apiFetch(`${API_BASE}/api/gcal/set-primary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ email }),
      });
      addToast({ type: 'success', message: `${email} set as primary` });
      checkStatus();
    } catch { addToast({ type: 'error', message: 'Failed to set primary' }); }
  }

  function handleSelectEvent(event, e) {
    const rect = e?.target?.getBoundingClientRect?.() || e?.currentTarget?.getBoundingClientRect?.();
    if (rect) {
      setPopoverPos({ top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 300) });
    }
    setSelectedEvent(event);
    setConfirmDelete(false);
  }

  function handleNavigate(newDate) { setCurrentDate(newDate); }

  function openCreateModal(slotInfo) {
    const accounts = gcalStatus.accounts || [];
    const primary = accounts.find(a => a.isPrimary) || accounts[0];
    const dateStr = slotInfo?.start ? format(slotInfo.start, 'yyyy-MM-dd') : format(new Date(), 'yyyy-MM-dd');
    const hasTime = slotInfo?.start && slotInfo.start.getHours() !== 0;
    setCreateForm({
      title: '',
      date: dateStr,
      startTime: hasTime ? format(slotInfo.start, 'HH:mm') : '',
      endTime: hasTime && slotInfo.end ? format(slotInfo.end, 'HH:mm') : '',
      googleEmail: primary?.email || '',
      entityTag: '',
      notes: '',
    });
    setShowCreateModal(true);
  }

  async function handleCreateEvent() {
    if (!createForm.title.trim()) { addToast({ type: 'error', message: 'Title is required' }); return; }
    setCreateSaving(true);
    try {
      const tz = userTZ;
      const startPayload = {};
      const endPayload = {};

      if (createForm.startTime) {
        startPayload.dateTime = `${createForm.date}T${createForm.startTime}:00`;
        startPayload.timeZone = tz;
        const endTime = createForm.endTime || (() => {
          const [h, m] = createForm.startTime.split(':').map(Number);
          return `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        })();
        endPayload.dateTime = `${createForm.date}T${endTime}:00`;
        endPayload.timeZone = tz;
      } else {
        startPayload.date = createForm.date;
        endPayload.date = createForm.date;
      }

      const res = await apiFetch(`${API_BASE}/api/gcal/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          title: createForm.title.trim(),
          start: startPayload,
          end: endPayload,
          googleEmail: createForm.googleEmail,
          description: createForm.notes || undefined,
          entityTag: createForm.entityTag || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { addToast({ type: 'error', message: data.error || 'Failed to create event' }); return; }

      // Save pre_note if notes provided
      if (createForm.notes && data.eventId) {
        try {
          await apiFetch(`${API_BASE}/api/calendar-notes/${encodeURIComponent(data.eventId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({
              pre_note: createForm.notes,
              event_title: createForm.title.trim(),
              event_start: startPayload.dateTime ? new Date(startPayload.dateTime).toISOString() : new Date(createForm.date).toISOString(),
              source_account: createForm.googleEmail,
            }),
          });
        } catch { /* best effort */ }
      }

      addToast({ type: 'success', message: 'Event created' });
      setShowCreateModal(false);
      fetchEvents();
    } catch {
      addToast({ type: 'error', message: 'Failed to create event' });
    } finally {
      setCreateSaving(false);
    }
  }

  async function handleDeleteEvent() {
    if (!selectedEvent) return;
    setDeleting(true);
    const rawId = selectedEvent.id;
    const account = selectedEvent.account;
    const eventId = rawId.includes('::') ? rawId.split('::').slice(1).join('::') : rawId;
    try {
      const res = await apiFetch(`${API_BASE}/api/gcal/events/${encodeURIComponent(eventId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ googleEmail: account }),
      });
      const data = await res.json();
      if (!res.ok) { addToast({ type: 'error', message: data.error || 'Failed to delete' }); return; }
      addToast({ type: 'success', message: 'Event deleted' });
      setSelectedEvent(null);
      setConfirmDelete(false);
      fetchEvents();
    } catch {
      addToast({ type: 'error', message: 'Failed to delete event' });
    } finally {
      setDeleting(false);
    }
  }

  // ── Event styling ─────────────────────────────────────────────
  const eventPropGetter = useCallback((event) => {
    const bg = getEventColor(event);
    return {
      style: {
        backgroundColor: bg,
        color: '#fff',
        border: 'none',
        borderRadius: '4px',
        fontSize: '12px',
        fontFamily: "'Manrope', sans-serif",
        padding: '1px 4px',
      },
    };
  }, [entityColorMap, calendarEntityColorMap]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Loading state ─────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <SpinnerIcon className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  // ── Not connected ─────────────────────────────────────────────
  if (!gcalStatus.connected) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center mb-4">
          <CalendarIcon className="w-8 h-8 text-indigo-600" />
        </div>
        <h3 className="text-lg font-bold text-gray-900 mb-2">Connect Google Calendar</h3>
        <p className="text-sm text-gray-500 mb-6 max-w-xs">
          Sign in with Google to view your calendar and sync tasks with due dates as calendar events.
        </p>
        <button
          onClick={handleConnect}
          className="flex items-center gap-3 px-5 py-3 bg-white border border-gray-300 rounded-xl shadow-sm hover:bg-gray-50 transition-colors text-sm font-medium text-gray-700"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          Sign in with Google
        </button>
      </div>
    );
  }

  // ── Connected — render native calendar ────────────────────────
  const accounts = gcalStatus.accounts || [];

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ backgroundColor: '#fbf8fe' }}>
      {/* Accounts bar. Collapsed by default to reclaim vertical space
          on mobile; header row shows count + chevron, tap to expand. */}
      <div className="px-4 py-2 bg-green-50 border-b border-green-100 flex-shrink-0">
        <div className="flex items-center justify-between mb-1 relative">
          <button
            onClick={() => setAccountsExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-green-700 hover:text-green-800"
            aria-expanded={accountsExpanded}
          >
            <span>Connected Accounts ({accounts.length + outlookAccounts.length})</span>
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
              {accountsExpanded ? 'expand_more' : 'chevron_right'}
            </span>
          </button>
          <div className="relative">
            <button
              onClick={() => setAddMenuOpen((v) => !v)}
              className="text-xs text-indigo-600 hover:text-indigo-800 font-medium transition-colors"
            >
              + Add Account
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[160px]">
                <button
                  onClick={() => { setAddMenuOpen(false); handleConnect(); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  Connect Google
                </button>
                <button
                  onClick={handleConnectOutlook}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50"
                >
                  Connect Outlook
                </button>
              </div>
            )}
          </div>
        </div>
        {accountsExpanded && <div className="flex flex-col gap-1">
          {accounts.map((acct) => (
            <div key={`g:${acct.email}`} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-green-700">
                <span className="w-2 h-2 bg-green-500 rounded-full" />
                <span>{acct.email}</span>
                <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px] font-medium">Google</span>
                {/* Primary badge is driven by gcal_tokens.is_primary on the
                    server. Never inferred from array position here. */}
                {acct.isPrimary === true && (
                  <span className="px-1.5 py-0.5 bg-indigo-100 text-indigo-600 rounded text-[10px] font-medium">
                    Primary
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {!acct.isPrimary && accounts.length > 1 && (
                  <button
                    onClick={() => handleSetPrimary(acct.email)}
                    className="text-gray-400 hover:text-indigo-600 transition-colors font-medium"
                  >
                    Set Primary
                  </button>
                )}
                <button
                  onClick={() => handleDisconnect(acct.email)}
                  className="text-gray-400 hover:text-red-500 transition-colors font-medium"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ))}
          {outlookAccounts.map((acct) => (
            <div key={`o:${acct.id}`} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 text-green-700">
                <span className="w-2 h-2 bg-green-500 rounded-full" />
                <span>{acct.account_email || '(unknown — reconnect)'}</span>
                <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px] font-medium">Outlook</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDisconnectOutlook(acct.id, acct.account_email)}
                  className="text-gray-400 hover:text-red-500 transition-colors font-medium"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ))}
        </div>}
      </div>

      {/* View toggle + calendar header. overflow-x-auto on mobile so
          the Month/Week/Day/History pills don't get clipped on narrow
          screens; desktop keeps the usual justify-between row. */}
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-100 flex-shrink-0 overflow-x-auto md:overflow-visible" style={{ scrollbarWidth: 'none' }}>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setCurrentDate(new Date()); if (view !== 'day') setView('day'); }}
            className="px-3 py-1 text-xs font-medium bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Today
          </button>
          <button
            onClick={() => setCurrentDate(d => (
              view === 'month' ? subMonths(d, 1)
              : view === 'day' ? subDays(d, 1)
              : new Date(d.getTime() - 7 * 86400000)
            ))}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-500"
          >
            <span className="material-symbols-outlined text-[18px]">chevron_left</span>
          </button>
          <button
            onClick={() => setCurrentDate(d => (
              view === 'month' ? addMonths(d, 1)
              : view === 'day' ? addDays(d, 1)
              : new Date(d.getTime() + 7 * 86400000)
            ))}
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 transition-colors text-gray-500"
          >
            <span className="material-symbols-outlined text-[18px]">chevron_right</span>
          </button>
          <h2 className="text-sm font-semibold text-gray-900 ml-1" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            {view === 'day'
              ? format(currentDate, 'EEEE, MMMM d yyyy')
              : view === 'week'
                ? `Week of ${format(currentDate, 'MMM d, yyyy')}`
                : format(currentDate, 'MMMM yyyy')}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openCreateModal(null)}
            className="px-3 py-1 text-xs font-medium text-white rounded-lg transition-colors"
            style={{ backgroundColor: '#4f4dcf' }}
          >
            + New Event
          </button>
          <div className="flex bg-gray-100 rounded-lg p-0.5 flex-shrink-0">
          {['month', 'week', 'day', 'history'].map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors capitalize ${
                view === v ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {v}
            </button>
          ))}
          </div>
        </div>
      </div>

      {/* Calendar or History */}
      {view === 'history' ? (
        <div className="flex-1 overflow-auto px-4 py-3">
          {/* Search + filter */}
          <div className="flex items-center gap-2 mb-3">
            <input
              type="text"
              value={historySearch}
              onChange={e => setHistorySearch(e.target.value)}
              placeholder="Search meetings…"
              className="flex-1 text-xs bg-white border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              style={{ fontFamily: "'Manrope', sans-serif" }}
            />
            <select
              value={historyRange}
              onChange={e => setHistoryRange(e.target.value)}
              className="text-xs bg-white border border-gray-200 rounded-lg px-2 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300"
              style={{ fontFamily: "'Manrope', sans-serif" }}
            >
              <option value="week">Past Week</option>
              <option value="month">Past Month</option>
              <option value="3months">Past 3 Months</option>
              <option value="all">All Time</option>
            </select>
          </div>

          {historyLoading ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <SpinnerIcon className="w-5 h-5 animate-spin" />
            </div>
          ) : historyNotes.length === 0 ? (
            <div className="text-center py-8 text-gray-400 text-sm">
              {historySearch ? 'No matching meeting notes found' : 'No meeting notes yet. Click any past event to add notes.'}
            </div>
          ) : (
            <div className="space-y-3">
              {historyNotes.map(note => (
                <div key={note.id || note.eventId} className="bg-white rounded-lg border border-gray-200 p-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h4 className="text-sm font-semibold text-gray-900">{note.eventTitle || note.event_title || '(Untitled)'}</h4>
                    <span className="text-[10px] text-gray-400 flex-shrink-0">
                      {note.eventStart || note.event_start
                        ? format(new Date(note.eventStart || note.event_start), 'MMM d, yyyy · h:mm a')
                        : ''}
                    </span>
                  </div>
                  {note.sourceAccount || note.source_account ? (
                    <div className="text-[10px] text-gray-400 mb-2">{note.sourceAccount || note.source_account}</div>
                  ) : null}
                  {(note.preNote || note.pre_note) && (
                    <div className="mb-2">
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Agenda</span>
                      <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">{note.preNote || note.pre_note}</p>
                    </div>
                  )}
                  {(note.postNote || note.post_note) && (
                    <div>
                      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Outcomes</span>
                      <p className="text-xs text-gray-600 mt-0.5 whitespace-pre-wrap">{note.postNote || note.post_note}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div
          className="flex-1 overflow-auto px-2 py-1 dizon-calendar"
          onTouchStart={(e) => {
            if (view !== 'day') return;
            swipeStartX.current = e.touches[0]?.clientX ?? null;
          }}
          onTouchEnd={(e) => {
            if (view !== 'day' || swipeStartX.current == null) return;
            const endX = e.changedTouches[0]?.clientX;
            const delta = (endX ?? 0) - swipeStartX.current;
            swipeStartX.current = null;
            if (delta < -50) setCurrentDate((d) => addDays(d, 1));
            else if (delta > 50) setCurrentDate((d) => subDays(d, 1));
          }}
        >
          <Calendar
            localizer={localizer}
            events={events}
            view={view}
            onView={v => { if (v !== 'history') setView(v); }}
            views={['month', 'week', 'day']}
            date={currentDate}
            onNavigate={handleNavigate}
            onSelectEvent={handleSelectEvent}
            onSelectSlot={openCreateModal}
            selectable
            eventPropGetter={eventPropGetter}
            toolbar={false}
            popup
            scrollToTime={(() => {
              // Open day/week views anchored one hour before the current
              // hour so the current time sits near the top of the visible
              // range rather than pinned at the very top.
              const s = new Date();
              s.setMinutes(0, 0, 0);
              s.setHours(Math.max(0, s.getHours() - 1));
              return s;
            })()}
            style={{ height: '100%', minHeight: 500 }}
          />
        </div>
      )}

      {/* Event popover */}
      {selectedEvent && (() => {
        const eventEnded = selectedEvent.end && new Date(selectedEvent.end) < new Date();
        return (
          <div
            ref={popoverRef}
            className="fixed z-50 bg-white rounded-xl shadow-lg border border-gray-200 p-4 w-80 max-h-[80vh] overflow-y-auto"
            style={{ top: Math.min(popoverPos.top, window.innerHeight - 300), left: popoverPos.left }}
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: getEventColor(selectedEvent) }}
                />
                <h4 className="text-sm font-semibold text-gray-900 leading-tight">{selectedEvent.title}</h4>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {noteSaved && (
                  <span className="text-[10px] text-green-600 font-medium animate-pulse">Saved</span>
                )}
                <button
                  onClick={() => setSelectedEvent(null)}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>
            </div>

            {/* Date/Time + Account */}
            <div className="text-xs text-gray-500 space-y-1 mb-3">
              <div className="flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[14px]">schedule</span>
                {selectedEvent.allDay
                  ? format(selectedEvent.start, 'EEE, MMM d, yyyy')
                  : `${format(selectedEvent.start, 'EEE, MMM d · h:mm a')}${selectedEvent.end ? ` – ${format(selectedEvent.end, 'h:mm a')}` : ''}`
                }
              </div>
              {selectedEvent.account && (
                <div className="flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[14px]">account_circle</span>
                  {selectedEvent.account}
                </div>
              )}
            </div>

            {notesLoading ? (
              <div className="flex items-center justify-center py-3 text-gray-400">
                <SpinnerIcon className="w-4 h-4 animate-spin" />
              </div>
            ) : (
              <>
                {/* Pre-meeting note */}
                <div className="mb-3">
                  <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
                    Agenda / Prep
                  </label>
                  <textarea
                    value={editingPre}
                    onChange={e => setEditingPre(e.target.value)}
                    onBlur={() => {
                      if (editingPre !== eventNotes.preNote) saveNote('pre_note', editingPre);
                    }}
                    placeholder="Meeting agenda, prep notes…"
                    rows={3}
                    className="w-full text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300 placeholder-gray-300"
                    style={{ fontFamily: "'Manrope', sans-serif" }}
                  />
                </div>

                {/* Post-meeting note — only if event has ended */}
                {eventEnded && (
                  <div>
                    <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
                      Outcomes / Decisions
                    </label>
                    <textarea
                      value={editingPost}
                      onChange={e => setEditingPost(e.target.value)}
                      onBlur={() => {
                        if (editingPost !== eventNotes.postNote) saveNote('post_note', editingPost);
                      }}
                      placeholder="Key outcomes, action items…"
                      rows={3}
                      className="w-full text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300 placeholder-gray-300"
                      style={{ fontFamily: "'Manrope', sans-serif" }}
                    />
                  </div>
                )}

                {/* Delete */}
                <div className="mt-3 pt-2 border-t border-gray-100">
                  {!confirmDelete ? (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="text-[11px] text-red-400 hover:text-red-600 transition-colors font-medium"
                    >
                      Delete Event
                    </button>
                  ) : (
                    <div>
                      <p className="text-[11px] text-gray-500 mb-1.5">Delete this event? This cannot be undone.</p>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleDeleteEvent}
                          disabled={deleting}
                          className="text-[11px] font-medium text-red-600 hover:text-red-700 transition-colors disabled:opacity-50"
                        >
                          {deleting ? 'Deleting…' : 'Yes, delete'}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="text-[11px] font-medium text-gray-400 hover:text-gray-600 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Create event modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowCreateModal(false)}>
          <div className="bg-white rounded-xl shadow-xl border border-gray-200 w-96 max-h-[90vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>New Event</h3>
              <button onClick={() => setShowCreateModal(false)} className="text-gray-400 hover:text-gray-600 transition-colors">
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="space-y-3">
              {/* Title */}
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Title</label>
                <input
                  type="text"
                  value={createForm.title}
                  onChange={e => setCreateForm(f => ({ ...f, title: e.target.value }))}
                  placeholder="Event title"
                  autoFocus
                  className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300"
                  style={{ fontFamily: "'Manrope', sans-serif" }}
                />
              </div>

              {/* Date */}
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Date</label>
                <input
                  type="date"
                  value={createForm.date}
                  onChange={e => setCreateForm(f => ({ ...f, date: e.target.value }))}
                  className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                  style={{ fontFamily: "'Manrope', sans-serif" }}
                />
              </div>

              {/* Start / End time */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Start Time</label>
                  <input
                    type="time"
                    value={createForm.startTime}
                    onChange={e => {
                      const st = e.target.value;
                      setCreateForm(f => {
                        const updated = { ...f, startTime: st };
                        // Auto-set end time to start + 1 hour if no end time yet
                        if (st && !f.endTime) {
                          const [h, m] = st.split(':').map(Number);
                          updated.endTime = `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
                        }
                        return updated;
                      });
                    }}
                    className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                    style={{ fontFamily: "'Manrope', sans-serif" }}
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">End Time</label>
                  <input
                    type="time"
                    value={createForm.endTime}
                    onChange={e => setCreateForm(f => ({ ...f, endTime: e.target.value }))}
                    className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                    style={{ fontFamily: "'Manrope', sans-serif" }}
                  />
                </div>
              </div>

              {/* Calendar account */}
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Calendar</label>
                <select
                  value={createForm.googleEmail}
                  onChange={e => setCreateForm(f => ({ ...f, googleEmail: e.target.value }))}
                  className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                  style={{ fontFamily: "'Manrope', sans-serif" }}
                >
                  {(gcalStatus.accounts || []).map(acct => (
                    <option key={acct.email} value={acct.email}>{acct.email}{acct.isPrimary ? ' (Primary)' : ''}</option>
                  ))}
                </select>
              </div>

              {/* Entity tag */}
              {entities.length > 0 && (
                <div>
                  <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Entity Tag</label>
                  <select
                    value={createForm.entityTag}
                    onChange={e => setCreateForm(f => ({ ...f, entityTag: e.target.value }))}
                    className="w-full text-sm text-gray-900 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-indigo-300"
                    style={{ fontFamily: "'Manrope', sans-serif" }}
                  >
                    <option value="">None</option>
                    {entities.map(ent => (
                      <option key={ent.id} value={ent.name}>{ent.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Notes */}
              <div>
                <label className="block text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Agenda / Notes</label>
                <textarea
                  value={createForm.notes}
                  onChange={e => setCreateForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="Meeting agenda, prep notes…"
                  rows={3}
                  className="w-full text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-indigo-300 placeholder-gray-300"
                  style={{ fontFamily: "'Manrope', sans-serif" }}
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-gray-100">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateEvent}
                disabled={createSaving}
                className="px-4 py-2 text-xs font-medium text-white rounded-lg transition-colors disabled:opacity-50"
                style={{ backgroundColor: '#4f4dcf' }}
              >
                {createSaving ? 'Creating…' : 'Create Event'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Override react-big-calendar styles to match Dizon design system */}
      <style>{`
        .dizon-calendar .rbc-calendar {
          font-family: 'Manrope', sans-serif;
          background: #fbf8fe;
        }
        .dizon-calendar .rbc-header {
          font-family: 'Plus Jakarta Sans', sans-serif;
          font-size: 11px;
          font-weight: 600;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          padding: 8px 4px;
          border-bottom: 1px solid #e5e7eb;
        }
        .dizon-calendar .rbc-month-view,
        .dizon-calendar .rbc-time-view {
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          overflow: hidden;
        }
        .dizon-calendar .rbc-day-bg {
          background: #fff;
        }
        .dizon-calendar .rbc-off-range-bg {
          background: #f9fafb;
        }
        .dizon-calendar .rbc-today {
          background: #f0edff !important;
        }
        .dizon-calendar .rbc-date-cell {
          font-size: 12px;
          padding: 4px 6px;
          color: #374151;
        }
        .dizon-calendar .rbc-date-cell.rbc-now {
          font-weight: 700;
          color: #4f4dcf;
        }
        .dizon-calendar .rbc-event {
          border-radius: 4px !important;
          font-size: 11px !important;
          padding: 1px 4px !important;
          line-height: 1.4;
        }
        .dizon-calendar .rbc-event.rbc-selected {
          box-shadow: 0 0 0 2px #4f4dcf;
        }
        .dizon-calendar .rbc-show-more {
          font-size: 11px;
          color: #4f4dcf;
          font-weight: 500;
        }
        .dizon-calendar .rbc-time-header-cell .rbc-header {
          border-bottom: none;
        }
        .dizon-calendar .rbc-time-slot {
          font-size: 10px;
          color: #9ca3af;
        }
        .dizon-calendar .rbc-current-time-indicator {
          background-color: #4f4dcf;
        }
        .dizon-calendar .rbc-allday-cell {
          min-height: 20px;
        }
      `}</style>
    </div>
  );
}
