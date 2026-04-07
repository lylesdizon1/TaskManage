import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { useToast } from './contexts/ToastContext';
import { useAuthLogout } from './hooks/useAuthLogout';
import { buildContext } from './lib/context-engine/buildContext';
import { detectIntent } from './lib/context-engine/intentDetector';
import { routePersona } from './lib/context-engine/personaRouter';
import { usePersona } from './contexts/PersonaContext';
import SkeletonBlock from './components/ui/SkeletonBlock.jsx';
const SettingsModal = lazy(() => import('./components/settings/SettingsModal'));

// ─────────────────────────────────────────────────────────────────────────────
// API BASE (works in dev via Vite proxy and in prod when served from same origin)
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = '';

// ─────────────────────────────────────────────────────────────────────────────
// JWT TOKEN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

import { decodeJwtPayload, tokenExpiresSoon } from './utils/auth.js';

/** Singleton refresh promise so concurrent 403s don't fire multiple refreshes. */
let _refreshPromise = null;

/**
 * Attempt to refresh the JWT token via POST /api/auth/refresh.
 * On success: saves new token to localStorage, returns new token.
 * On failure: clears auth, returns null.
 */
async function refreshToken() {
  const currentToken = localStorage.getItem('tm_token');
  if (!currentToken) return null;

  if (_refreshPromise) return _refreshPromise;
  _refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      localStorage.setItem('tm_token', data.token);
      localStorage.setItem('tm_user', JSON.stringify(data.user));
      return data.token;
    } catch { return null; }
    finally { _refreshPromise = null; }
  })();
  return _refreshPromise;
}

/**
 * Drop-in replacement for fetch() that auto-refreshes on 403.
 * - If a request returns 403, attempts a silent token refresh and retries once.
 * - If refresh fails, fires a 'session-expired' CustomEvent so the UI can react.
 * - Accepts the same arguments as fetch(). If `options.headers.Authorization` is
 *   present, it will be updated with the refreshed token on retry.
 */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status !== 403) return res;

  // 403 — attempt silent refresh
  const newToken = await refreshToken();
  if (newToken) {
    // Retry original request with new token
    const retryOpts = { ...options, headers: { ...options.headers, Authorization: `Bearer ${newToken}` } };
    return fetch(url, retryOpts);
  }

  // Refresh failed — session truly expired
  localStorage.removeItem('tm_token');
  localStorage.removeItem('tm_user');
  window.dispatchEvent(new CustomEvent('session-expired'));
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

import { COLOR_PRESETS, AVAILABLE_COLORS, getEntityStyle, getTagStyle, PRIORITY_BORDER, PRIORITY_BADGE } from './constants/colors.js';
import { buildGroupedEntities } from './utils/helpers.js';
import FilterBar from './components/tasks/FilterBar.jsx';
import { ChatMessageThread, SlidingChatPanel, ChatTabPanel, UniversalPromptBar } from './components/chat/ChatComponents.jsx';
import buildSystemPrompt from './utils/systemPrompt.js';
import { GearIcon, XIcon, SendIcon, ChatIcon, SpinnerIcon, MailIcon, ChecklistIcon, LogoutIcon, CalendarIcon, NotesIcon, UploadIcon, SyncIcon, PencilIcon } from './components/icons/Icons.jsx';
const CalendarPanel = lazy(() => import('./panels/CalendarPanel.jsx'));
const InboxPanel = lazy(() => import('./panels/InboxPanel.jsx'));
const NotesPanel = lazy(() => import('./panels/NotesPanel.jsx'));
const AddTaskForm = lazy(() => import('./components/tasks/AddTaskForm.jsx'));
const DashboardPanel = lazy(() => import('./panels/DashboardPanel.jsx'));
const AdminPanel = lazy(() => import('./panels/AdminPanel.jsx'));
import { CreateEventModal, QuickCaptureModal, QuickCaptureFAB } from './components/modals/QuickCaptureModal.jsx';

// Render grouped entity <option> elements for <select> dropdowns
function EntitySelectOptions({ entities }) {
  const grouped = buildGroupedEntities(entities);
  let lastGroup = '';
  const items = [];
  grouped.forEach((ent, i) => {
    if (ent._group === 'personal' && lastGroup !== 'personal') {
      items.push(<option key="__sep" disabled>{'─────────────'}</option>);
    }
    lastGroup = ent._group;
    const prefix = ent._indent ? '\u00A0\u00A0\u00A0\u2514\u2500 ' : '';
    const shared = ent.shared ? ' \u{1F517}' : '';
    items.push(<option key={ent.id} value={ent.name}>{prefix}{ent.name}{shared}</option>);
  });
  return items;
}

import { uid, escapeHtml, conditionDescription, getRuleScope, getTodayLocal } from './utils/helpers.js';
import {
  DEFAULT_ALERT_RULES,
  CONDITION_META,
  EMPTY_NEW_RULE,
  evaluateRule,
  buildPlainTextAlert,
  buildEmailHtml,
  sendAlertEmail,
  persistFiredAlerts,
  runAlertRules,
} from './components/alerts/alertUtils.js';

// ─────────────────────────────────────────────────────────────────────────────
// AI UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

// fetchSuggestedTags moved to src/utils/aiHelpers.js

async function callClaudeChat(messages, systemPrompt, apiKey, authToken) {
  const res = await apiFetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({
      apiKey,
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || '(no response)';
}

async function callOpenAIChat(messages, systemPrompt, apiKey, authToken) {
  const res = await apiFetch('/api/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({
      apiKey,
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '(no response)';
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────

import LoginScreen from './screens/LoginScreen.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// TAG PILL
// ─────────────────────────────────────────────────────────────────────────────

import TagPill from './components/ui/TagPill.jsx';

import ToastContainer from './components/ui/ToastContainer.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS MODAL  (tabbed: API Keys | Email & Alerts)

export default function App() {
  // ── Auth state ──────────────────────────────────────────────────────────────
  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tm_user')); } catch { return null; }
  });
  const [authToken, setAuthToken] = useState(() => localStorage.getItem('tm_token') || null);
  const [sessionExpired, setSessionExpired] = useState(false);

  function handleLogin(user, token) {
    // Clear all Aria/digest/timeline caches so fresh login always generates fresh brief
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith('aria_brief_') || key.startsWith('timeline_summary_') || key.startsWith('digest_')) {
        localStorage.removeItem(key);
      }
    });
    setCurrentUser(user);
    setAuthToken(token);
    setSessionExpired(false);
  }

  function handleLogout() {
    // Clear all user-specific state before unmounting
    setCurrentUser(null);
    setAuthToken(null);
    setSessionExpired(false);
    // Clear localStorage
    localStorage.removeItem('tm_token');
    localStorage.removeItem('tm_user');
    localStorage.removeItem('tm_chat_draft');
    // Force full page reload to guarantee clean state
    window.location.href = '/';
  }

  // Listen for session-expired events from apiFetch
  useEffect(() => {
    function onSessionExpired() {
      setSessionExpired(true);
    }
    window.addEventListener('session-expired', onSessionExpired);
    return () => window.removeEventListener('session-expired', onSessionExpired);
  }, []);

  // Proactive token refresh on user activity — throttled to once per hour
  useEffect(() => {
    if (!authToken) return;
    let lastRefreshCheck = 0;
    function doProactiveRefresh() {
      const now = Date.now();
      if (now - lastRefreshCheck < 3600000) return; // max once per hour
      lastRefreshCheck = now;
      if (tokenExpiresSoon(authToken)) {
        refreshToken().then((newToken) => {
          if (newToken) {
            setAuthToken(newToken);
            try {
              const user = JSON.parse(localStorage.getItem('tm_user'));
              if (user) setCurrentUser(user);
            } catch {}
          }
        });
      }
    }
    // Check immediately on mount / token change
    doProactiveRefresh();
    // Check on user activity
    window.addEventListener('click', doProactiveRefresh);
    window.addEventListener('keydown', doProactiveRefresh);
    return () => {
      window.removeEventListener('click', doProactiveRefresh);
      window.removeEventListener('keydown', doProactiveRefresh);
    };
  }, [authToken]);

  // Session expired modal
  if (sessionExpired) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-sm w-full text-center">
          <div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">Session Expired</h2>
          <p className="text-sm text-gray-500 mb-4">Your session has expired. Please log in again to continue.</p>
          {localStorage.getItem('tm_chat_draft') && (
            <p className="text-xs text-gray-400 mb-4">Your unsent message has been saved and will be restored after login.</p>
          )}
          <button
            onClick={handleLogout}
            className="w-full py-2.5 px-4 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
          >
            Log In Again
          </button>
        </div>
      </div>
    );
  }

  // If not logged in, show login screen
  if (!currentUser || !authToken) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  // ── App state ───────────────────────────────────────────────────────────────
  return <AuthenticatedApp currentUser={currentUser} authToken={authToken} onLogout={handleLogout} />;
}

function AuthenticatedApp({ currentUser: initialUser, authToken, onLogout }) {
  const [currentUser, setCurrentUser]           = useState(initialUser);
  const [tasks, setTasks]                       = useState([]);
  const tasksLoadedRef                           = useRef(false);
  const [activeView, setActiveView]             = useState(() => {
    return new URLSearchParams(window.location.search).get('view') || 'dashboard';
  });
  const [activeTagFilters, setActiveTagFilters] = useState([]);
  const [statusFilter, setStatusFilter]         = useState('all');
  const [taskFilter, setTaskFilter]             = useState('');
  const [showSettings, setShowSettings]         = useState(false);
  const [showCreateEvent, setShowCreateEvent]   = useState(false);
  const [showTaskModal, setShowTaskModal]       = useState(false);
  const [editingTask, setEditingTask]           = useState(null);
  const [apiKeys, setApiKeys]                   = useState({ claude: '', openai: '' });
  const [emailSettings, setEmailSettings]       = useState({
    gmailUser: '',
    gmailAppPassword: '',
    recipientEmail: '',
  });
  const [alertRules, setAlertRules]             = useState(DEFAULT_ALERT_RULES);

  const [gcalConnected, setGcalConnected]       = useState(false);
  const [envConfigured, setEnvConfigured]       = useState({});
  const [mobileView, setMobileView]            = useState('tasks'); // 'tasks' | 'chat' | 'calendar' | 'notes'
  const [mobileChatOpen, setMobileChatOpen]    = useState(false); // list vs chat view inside mobile Aria
  const [entities, setEntities]                 = useState([]);
  const firedAlertsRef                          = useRef((() => {
    const todayStr = getTodayLocal();
    const saved = JSON.parse(localStorage.getItem('dizon_fired_alerts') || '[]');
    const filtered = saved.filter(k => !k.match(/\d{4}-\d{2}-\d{2}/) || k.includes(todayStr));
    return new Set(filtered);
  })());

  // Quick Capture FAB state
  const [noteCategories, setNoteCategories]     = useState([]);
  const [allNotes, setAllNotes]                 = useState([]);
  const [notesEditorOpen, setNotesEditorOpen]   = useState(false);
  const openNoteRef                              = useRef(null);
  const [quickCapturedNote, setQuickCapturedNote] = useState(null);

  // Dashboard state
  const [dashboardNotes, setDashboardNotes]     = useState([]);
  const [chatInitialMsg, setChatInitialMsg]     = useState('');

  // ── Universal Chat state ──
  const [conversations, setConversations]       = useState([]);
  const [activeConvId, setActiveConvId]         = useState(null);
  const [chatMessages, setChatMessages]         = useState([]);
  const [chatInput, setChatInput]               = useState(() => localStorage.getItem('tm_chat_draft') || '');
  const chatInputRef                            = useRef('');
  const [chatBackend, setChatBackend]           = useState('claude');
  const { activePersona } = usePersona();
  const [chatLoading, setChatLoading]           = useState(false);
  const [lastAutoPersona, setLastAutoPersona]     = useState(null);
  const [chatPanelOpen, setChatPanelOpen]       = useState(false);

  // ── Calendar events for chat context ──
  const [chatCalendarEvents, setChatCalendarEvents] = useState([]);
  const [initialBriefData, setInitialBriefData]  = useState(null);

  // Sync activeView → browser URL
  useEffect(() => {
    const current = new URLSearchParams(window.location.search).get('view');
    if (current !== activeView) {
      window.history.pushState({ view: activeView }, '', `?view=${activeView}`);
    }
  }, [activeView]);

  // Browser back/forward → update activeView
  useEffect(() => {
    const handlePop = (e) => {
      const view = e.state?.view || 'dashboard';
      setActiveView(view);
    };
    window.addEventListener('popstate', handlePop);
    return () => window.removeEventListener('popstate', handlePop);
  }, []);

  // Keep chatInput ref in sync for session-expired handler
  useEffect(() => { chatInputRef.current = chatInput; }, [chatInput]);

  // Save unsent chat message on session-expired so it survives re-login
  useEffect(() => {
    function onSessionExpired() {
      if (chatInputRef.current) {
        localStorage.setItem('tm_chat_draft', chatInputRef.current);
      }
    }
    window.addEventListener('session-expired', onSessionExpired);
    return () => window.removeEventListener('session-expired', onSessionExpired);
  }, []);

  // Load entities + refresh current user on mount
  useEffect(() => {
    apiFetch('/api/entities', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setEntities(data); })
      .catch(() => {});
    // Load notes for dashboard
    apiFetch('/api/notes', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setDashboardNotes(data.filter((n) => n.type !== 'digest')); })
      .catch(() => {});
    // Refresh user data (role, entityIds) from server
    apiFetch('/api/auth/me', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => {
        if (data.user) {
          setCurrentUser(data.user);
          localStorage.setItem('tm_user', JSON.stringify(data.user));
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync dashboardNotes when NotesPanel updates allNotes (deletes, creates, edits)
  useEffect(() => { if (allNotes.length) setDashboardNotes(allNotes); }, [allNotes]);

  function reloadEntities() {
    apiFetch('/api/entities', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setEntities(data); })
      .catch((err) => console.error('[entities] reload failed:', err.message));
  }

  // ── Chat helpers ──
  async function loadConversations() {
    try {
      const r = await apiFetch('/api/conversations', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await r.json();
      if (Array.isArray(data)) setConversations(data);
    } catch {}
  }

  async function loadConversationMessages(convId) {
    try {
      const r = await apiFetch(`/api/conversations/${convId}/messages`, { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await r.json();
      if (Array.isArray(data)) setChatMessages(data.map((m) => ({ role: m.role, content: m.content })));
    } catch {}
  }

  async function selectConversation(convId) {
    setActiveConvId(convId);
    if (convId) {
      const conv = conversations.find((c) => c.id === convId);
      if (conv?.model) setChatBackend(conv.model);
      await loadConversationMessages(convId);
    } else {
      setChatMessages([]);
    }
  }

  async function createNewChat() {
    try {
      const r = await apiFetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ model: chatBackend }),
      });
      const conv = await r.json();
      if (conv.id) {
        setActiveConvId(conv.id);
        setChatMessages([]);
        await loadConversations();
        return conv.id;
      }
    } catch {}
    return null;
  }

  async function deleteConversation(convId) {
    try {
      await apiFetch(`/api/conversations/${convId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
      if (activeConvId === convId) { setActiveConvId(null); setChatMessages([]); }
      await loadConversations();
    } catch {}
  }

  async function renameConversation(convId, title) {
    try {
      await apiFetch(`/api/conversations/${convId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ title }),
      });
      await loadConversations();
    } catch {}
  }

  async function handleChatSend(overrideText) {
    const text = (overrideText || chatInput).trim();
    if (!text || chatLoading) return;

    let convId = activeConvId;
    // Auto-create conversation if none active
    if (!convId) {
      convId = await createNewChat();
      if (!convId) return;
    }

    const userMsg = { role: 'user', content: text };
    const updatedMessages = [...chatMessages, userMsg];
    setChatMessages(updatedMessages);
    setChatInput('');
    localStorage.removeItem('tm_chat_draft');
    // Auto-route to best persona for this message
    const detectedIntent = detectIntent(text);
    const routedPersonaId = routePersona(detectedIntent);
    const { getPersonaById: _getPersonaById } = await import('./config/personas');
    const routedPersona = _getPersonaById(routedPersonaId);
    const effectivePersona = routedPersona ?? activePersona;
    setLastAutoPersona(effectivePersona);
    setChatLoading(true);

    // Save user message to DB
    try {
      await apiFetch(`/api/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ role: 'user', content: text }),
      });
    } catch {}

    // Auto-name conversation from first user message
    if (updatedMessages.filter((m) => m.role === 'user').length === 1) {
      const autoTitle = text.length > 50 ? text.slice(0, 50).trim() + '...' : text.trim();
      renameConversation(convId, autoTitle);
    }

    // Build system prompt and call AI
    const sysPrompt = buildContext({ message: text, tasks, entities: userEntities, notes: allNotes, calendarEvents: chatCalendarEvents, personaSystemPrompt: effectivePersona.systemPrompt, autoPersonaEmoji: effectivePersona.emoji, autoPersonaName: effectivePersona.defaultName });
    try {
      let reply;
      if (chatBackend === 'claude') {
        reply = await callClaudeChat(updatedMessages, sysPrompt, apiKeys.claude, authToken);
      } else {
        reply = await callOpenAIChat(updatedMessages, sysPrompt, apiKeys.openai, authToken);
      }
      const assistantMsg = { role: 'assistant', content: reply, persona: { emoji: effectivePersona.emoji, name: effectivePersona.defaultName, id: effectivePersona.id } };
      setChatMessages((prev) => [...prev, assistantMsg]);
      // Save assistant message to DB
      try {
        await apiFetch(`/api/conversations/${convId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ role: 'assistant', content: reply }),
        });
      } catch {}
    } catch (err) {
      setChatMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${err.message}` }]);
    }
    setChatLoading(false);
    await loadConversations(); // refresh titles
    // Open response surface
    if (window.innerWidth >= 768 && activeView !== 'chat') {
      setChatPanelOpen(true);
    } else if (window.innerWidth < 768 && mobileView !== 'chat') {
      setMobileView('chat');
      setMobileChatOpen(true);
    }
  }

  // Load conversations on mount
  useEffect(() => { loadConversations(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle chatInitialMsg from Dashboard — auto-send
  useEffect(() => {
    if (chatInitialMsg) {
      const msg = chatInitialMsg;
      setChatInitialMsg('');
      setChatInput('');
      handleChatSend(msg);
    }
  }, [chatInitialMsg]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleChatPanel() {
    setChatPanelOpen((prev) => {
      const next = !prev;
      return next;
    });
  }

  const userEntities = useMemo(() => {
    const isPrivileged = currentUser?.role === 'admin' || currentUser?.role === 'superadmin';
    if (isPrivileged) return entities;
    return entities; // API already scopes to user's own + shared
  }, [entities, currentUser]);

  // Keep refs current so the 60 s interval always reads fresh values without
  // needing to re-register the effect on every state change.
  const tasksRef          = useRef(tasks);
  const alertRulesRef     = useRef(alertRules);
  const emailSettingsRef  = useRef(emailSettings);
  const apiKeysRef        = useRef(apiKeys);
  const settingsLoadedRef = useRef(false);
  useEffect(() => { tasksRef.current = tasks; },            [tasks]);
  useEffect(() => { alertRulesRef.current = alertRules; },  [alertRules]);
  useEffect(() => { emailSettingsRef.current = emailSettings; }, [emailSettings]);
  useEffect(() => { apiKeysRef.current = apiKeys; },        [apiKeys]);

  // ── Persistent settings (settings.json via proxy) ─────────────────────────

  async function saveSettings(keys, email, rules) {
    try {
      await apiFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKeys: keys, emailSettings: email, alertRules: rules }),
      });
    } catch (err) {
      console.error('[settings] save failed:', err.message);
    }
  }

  // Load settings once on mount
  useEffect(() => {
    apiFetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        if (data.apiKeys)       setApiKeys(data.apiKeys);
        if (data.emailSettings) setEmailSettings(data.emailSettings);
        if (data.alertRules) {
          const merged = data.alertRules.map((r) => {
            const def = DEFAULT_ALERT_RULES.find((d) => d.id === r.id);
            return def ? { ...def, ...r } : r;
          });
          setAlertRules(merged);
        }
        if (data.envConfigured) setEnvConfigured(data.envConfigured);
      })
      .catch(() => {})
      .finally(() => { settingsLoadedRef.current = true; });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Task persistence ──────────────────────────────────────────────────────

  // Load tasks — extracted so it can be called on demand after tool use / task add
  function reloadTasks() {
    apiFetch('/api/tasks', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => {
        const taskData = Array.isArray(data) ? data : [];
        setTasks(taskData);
        // Compute brief data immediately from the raw task array
        const todayISO = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
        setInitialBriefData({
          overdue: taskData.filter(t => !t.completed && t.dueDate && t.dueDate < todayISO).map(t => t.title).join(', ') || 'None',
          highPriority: taskData.filter(t => !t.completed && t.priority === 'high').map(t => t.title).join(', ') || 'None',
          todayTasks: taskData.filter(t => !t.completed && t.dueDate === todayISO).map(t => t.title).join(', ') || 'None',
        });
      })
      .catch(() => setTasks([]))
      .finally(() => { tasksLoadedRef.current = true; });
  }

  // Load notes — extracted so it can be called on demand after tool use
  function reloadNotes() {
    apiFetch('/api/notes', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          const filtered = data.filter((n) => n.type !== 'digest');
          setDashboardNotes(filtered);
          setAllNotes(filtered);
        }
      })
      .catch(() => {});
  }

  // Load tasks on mount
  useEffect(() => {
    reloadTasks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch Google Calendar events for chat context
  useEffect(() => {
    if (!currentUser?.id) return;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    apiFetch(`${API_BASE}/api/gcal/events?userId=${currentUser.id}&timeZone=${encodeURIComponent(tz)}&days=7`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setChatCalendarEvents(data);
      })
      .catch(() => {});
  }, [currentUser?.id]);

  // Auto-scan email inbox on mount + every 15 minutes
  const emailScanInProgressRef = useRef(false);
  useEffect(() => {
    if (!currentUser?.id) return;
    async function scanInbox() {
      if (emailScanInProgressRef.current) return;
      emailScanInProgressRef.current = true;
      try {
        await apiFetch('/api/gmail/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        });
      } catch (err) {
        console.error('[email-scan] failed:', err.message);
      } finally {
        emailScanInProgressRef.current = false;
      }
    }
    scanInbox();
    const scanInterval = setInterval(scanInbox, 15 * 60 * 1000);
    return () => clearInterval(scanInterval);
  }, [currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save tasks whenever they change (skip initial hydration)
  useEffect(() => {
    if (!tasksLoadedRef.current) return;
    apiFetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(tasks),
    }).catch((err) => console.error('[tasks] save failed:', err.message));
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save alert rules whenever they change (skip during initial hydration)
  useEffect(() => {
    if (!settingsLoadedRef.current) return;
    saveSettings(apiKeysRef.current, emailSettingsRef.current, alertRules);
  }, [alertRules]); // eslint-disable-line react-hooks/exhaustive-deps

  const _toast = useToast();
  useAuthLogout(onLogout);
  function addToast(t) {
    const fn = _toast[t.type] ?? _toast.info;
    fn(t.message);
  }

  // Evaluate rules on mount (catches session-scoped digest) + every 60 s
  useEffect(() => {
    runAlertRules(
      tasksRef.current, alertRulesRef.current,
      emailSettingsRef.current, firedAlertsRef, addToast, apiFetch, authToken,
    );
    const id = setInterval(() => {
      runAlertRules(
        tasksRef.current, alertRulesRef.current,
        emailSettingsRef.current, firedAlertsRef, addToast, apiFetch, authToken,
      );
    }, 60_000);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Google Calendar status check ──────────────────────────────────────────
  useEffect(() => {
    apiFetch(`${API_BASE}/api/gcal/status?userId=${currentUser.id}`)
      .then((r) => r.json())
      .then((data) => setGcalConnected(data.connected))
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSyncToCalendar(task) {
    if (!task.dueDate) return;
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await apiFetch(`${API_BASE}/api/gcal/sync-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          userId: currentUser.id,
          title: task.title,
          description: task.description || '',
          dueDate: task.dueDate,
          dueTime: task.dueTime || null,
          timeZone: tz,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      addToast({ type: 'success', message: `Synced "${task.title}" to Google Calendar` });
    } catch (err) {
      addToast({ type: 'error', message: `Calendar sync failed: ${err.message}` });
    }
  }

  function addTask(task) {
    const { syncToCalendar, ...taskData } = task;
    setTasks((prev) => [taskData, ...prev]);
    // Reload from DB after short delay to ensure server write is complete
    setTimeout(() => reloadTasks(), 300);
    // Optionally sync to Google Calendar
    if (syncToCalendar && taskData.dueDate && gcalConnected) {
      handleSyncToCalendar(taskData).then(() => {
        // Refresh calendar events so new event appears immediately
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        apiFetch(`${API_BASE}/api/gcal/events?userId=${currentUser.id}&timeZone=${encodeURIComponent(tz)}&days=7`)
          .then((r) => r.json())
          .then((data) => { if (Array.isArray(data)) setChatCalendarEvents(data); })
          .catch(() => {});
      });
    }
  }

  function toggleTask(id) {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const nowCompleted = !task.completed;
    const completedAt = nowCompleted ? new Date().toISOString() : null;
    setTasks((prev) =>
      prev.map((t) => t.id === id ? { ...t, completed: nowCompleted, completedAt } : t),
    );
    apiFetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ completed: nowCompleted, completedAt }),
    }).catch((err) => console.error('[tasks] toggle failed:', err.message));
  }

  function deleteTask(id) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  function toggleVisibility(id) {
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, visibility: t.visibility === 'private' ? 'shared' : 'private' }
          : t,
      ),
    );
  }

  function editTask(id, fields) {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...fields } : t)),
    );
    // Also persist to server via PUT
    apiFetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(fields),
    }).catch((err) => console.error('[tasks] edit failed:', err.message));
  }

  // Filter tasks: show shared tasks from anyone + private tasks only from current user
  const visibleTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (task.visibility === 'private' && task.owner !== currentUser?.id) return false;
      return true;
    });
  }, [tasks, currentUser]);

  const filteredTasks = useMemo(() => {
    return visibleTasks.filter((task) => {
      if (activeView === 'priority' && task.priority !== 'high') return false;
      if (
        activeTagFilters.length > 0 &&
        !activeTagFilters.some((t) => task.tags.includes(t))
      )
        return false;
      if (statusFilter === 'active' && task.completed) return false;
      if (statusFilter === 'done' && !task.completed) return false;
      return true;
    });
  }, [visibleTasks, activeView, activeTagFilters, statusFilter]);

  const completedCount    = filteredTasks.filter((t) => t.completed).length;

  return (
    <div className="min-h-screen bg-background flex" style={{ fontFamily: "'Manrope', sans-serif" }}>

      {/* ── Sidebar ── */}
      <aside className="hidden md:flex fixed left-0 top-0 h-full flex-col py-6 px-5 bg-slate-50/80 backdrop-blur-xl w-52 shadow-[0px_20px_40px_rgba(79,77,207,0.08)] z-50">
        <div className="mb-8 px-2">
          <h1 className="text-base font-bold tracking-tight text-primary" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Dizon.ai</h1>
          <p className="text-[8px] uppercase tracking-[0.2em] text-slate-400 mt-1 font-bold">Personal OS</p>
        </div>
        <nav className="flex-1 space-y-1">
          {[
            { key: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
            { key: 'inbox', label: 'Inbox', icon: 'inbox' },
            { key: 'daily', label: 'Tasks', icon: 'task' },
            { key: 'calendar', label: 'Calendar', icon: 'calendar_today' },
            { key: 'notes', label: 'Notes', icon: 'sticky_note_2' },
            { key: 'chat', label: 'Aria', icon: 'chat' },
            ...(currentUser?.role === 'superadmin' ? [{ key: 'admin', label: 'Admin', icon: 'admin_panel_settings' }] : []),
          ].map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setActiveView(key)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl transition-all duration-200 text-left ${
                activeView === key
                  ? 'text-primary font-bold border-r-4 border-primary bg-primary/5'
                  : 'text-slate-500 font-medium hover:bg-primary/5'
              }`}
            >
              <span className="material-symbols-outlined text-lg">{icon}</span>
              <span className="text-[11px]">{label}</span>
            </button>
          ))}
        </nav>
        <div className="mt-auto space-y-2 px-2">
          <div className="flex items-center gap-2 pt-3 border-t border-slate-200">
            <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {currentUser.displayName?.[0] || 'L'}
            </div>
            <span className="text-[11px] font-medium text-on-surface-variant truncate">{currentUser.displayName}</span>
            <button onClick={onLogout} className="ml-auto text-slate-400 hover:text-error transition-colors" title="Sign out">
              <LogoutIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main (offset by sidebar) ── */}
      <div className="flex-1 md:ml-52 flex flex-col h-screen overflow-hidden">

        {/* ── Top bar ── */}
        <header className="hidden md:flex items-center justify-end px-8 h-12 bg-background/80 backdrop-blur-xl sticky top-0 z-40 border-b border-surface-container-low flex-shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowSettings(true)} className="p-1.5 text-slate-400 hover:text-primary transition-colors" title="Settings">
              <GearIcon className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Mobile top bar */}
        <header className="md:hidden bg-background border-b border-surface-container-low px-4 py-3 flex items-center justify-between sticky top-0 z-40">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center">
              <span className="text-white text-xs font-bold">D</span>
            </div>
            <h1 className="text-sm font-bold text-primary">Dizon.ai</h1>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowSettings(true)} className="p-2 text-slate-400 hover:text-primary">
              <GearIcon className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Contextual Aria input bar — hidden on dashboard where Command Center has its own input */}
        {((window.innerWidth < 768 && mobileView !== 'tasks' && mobileView !== 'chat') || (window.innerWidth >= 768 && activeView !== 'dashboard' && activeView !== 'chat')) && (
          <div className="flex-shrink-0">
            <UniversalPromptBar
              input={chatInput}
              onInputChange={setChatInput}
              backend={chatBackend}
              onBackendChange={setChatBackend}
              onSend={handleChatSend}
              loading={chatLoading}
              activeTab={window.innerWidth < 768 ? mobileView : activeView}
              personaPill={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}
            />
          </div>
        )}

        {/* ── Content ── */}
        <div className="flex flex-row flex-1 overflow-hidden pb-20 md:pb-0" style={{ minHeight: 0 }}>
        <section
          className={`flex-col overflow-hidden w-full ${(mobileView === 'tasks' || mobileView === 'daily') ? 'flex' : 'hidden md:flex'}`}
          style={{ flex: chatPanelOpen && activeView !== 'chat' ? '0 0 75%' : '1 1 100%', transition: 'flex 0.2s', minHeight: 0 }}
        >

          {/* View routing */}
          <Suspense fallback={<div className="flex-1 p-10"><SkeletonBlock className="h-64" /></div>}>
          {activeView === 'dashboard' ? (
            <DashboardPanel
              tasks={tasks}
              currentUser={currentUser}
              authToken={authToken}
              apiKeys={apiKeys}
              notes={dashboardNotes}
              entities={userEntities}
              chatCalendarEvents={chatCalendarEvents}
              initialBriefData={initialBriefData}
              onNavigate={(view, filter) => {
                setActiveView(view);
                if (window.innerWidth < 768) {
                  if (view === 'calendar') setMobileView('calendar');
                  else if (view === 'notes') setMobileView('notes');
                  else setMobileView('tasks');
                }
                if (view === 'daily' && filter === 'overdue') setStatusFilter('active');
                if (view === 'daily' && filter === 'high') setStatusFilter('active');
                if (view === 'daily' && filter === 'done') setStatusFilter('done');
              }}
              onAIPrompt={(msg) => {
                setChatInitialMsg(msg);
                if (window.innerWidth < 768) setMobileView('chat');
                else setChatPanelOpen(true);
              }}
              onAddTask={() => setShowTaskModal(true)}
              onQuickNote={() => { document.querySelector('[aria-label="Quick Capture"]')?.click(); }}
              onAddEvent={() => setShowCreateEvent(true)}
              onToggleTask={(id) => { toggleTask(id); }}
              onOpenNote={(note) => { setActiveView('notes'); setTimeout(() => openNoteRef.current?.(note), 100); }}
              backend={chatBackend}
              onBackendChange={setChatBackend}
              apiFetch={apiFetch}
              callClaudeChat={callClaudeChat}
              onReloadTasks={reloadTasks}
              onReloadNotes={reloadNotes}
            />
          ) : activeView === 'admin' && currentUser?.role === 'superadmin' ? (
            <AdminPanel authToken={authToken} />
          ) : activeView === 'inbox' ? (
            <InboxPanel tasks={tasks} authToken={authToken} currentUser={currentUser} onToggleTask={(id) => { toggleTask(id); }} onEditTask={(id, fields) => { editTask(id, fields); }} addToast={addToast} apiFetch={apiFetch} />
          ) : activeView === 'calendar' ? (
            <CalendarPanel currentUser={currentUser} addToast={addToast} apiFetch={apiFetch} />
          ) : activeView === 'notes' ? (
            <NotesPanel authToken={authToken} onEditorStateChange={setNotesEditorOpen} onCategoriesLoaded={setNoteCategories} onNotesLoaded={setAllNotes} quickCapturedNote={quickCapturedNote} addToast={addToast} entities={userEntities} apiFetch={apiFetch} onNoteOpenRef={(fn) => { openNoteRef.current = fn; }} />
          ) : activeView === 'chat' ? (
            <div className="flex flex-col flex-1 overflow-hidden">
              <ChatTabPanel
                conversations={conversations}
                activeConvId={activeConvId}
                activeMessages={chatMessages}
                loading={chatLoading}
                backend={chatBackend}
                onSelectConv={selectConversation}
                onNewChat={createNewChat}
                onDeleteConv={deleteConversation}
                onRenameConv={renameConversation}
              />
              <div className="flex-shrink-0 hidden md:block">
                <UniversalPromptBar
                  input={chatInput}
                  onInputChange={setChatInput}
                  backend={chatBackend}
                  onBackendChange={setChatBackend}
                  onSend={handleChatSend}
                  loading={chatLoading}
                  activeTab="chat"
                  personaPill={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}
                />
              </div>
            </div>
          ) : (
          /* Tasks panel — exact comp */
          <div className="flex-1 overflow-y-auto" style={{ minHeight: 0, WebkitOverflowScrolling: 'touch' }}>

            {/* Page header */}
            <div className="px-8 pt-6 pb-4">
              <h1 className="text-2xl font-extrabold font-headline text-on-background tracking-tight">Tasks</h1>
              <p className="text-on-surface-variant text-[11px] font-medium mt-0.5">
                {visibleTasks.filter((t) => !t.completed && t.dueDate && t.dueDate < getTodayLocal()).length} overdue
                {' · '}
                {visibleTasks.filter((t) => !t.completed && t.dueDate === getTodayLocal()).length} due today
                {' · '}
                {visibleTasks.filter((t) => !t.completed && (!t.dueDate || t.dueDate > getTodayLocal())).length} upcoming
              </p>
            </div>



            {/* Filter pills — dynamic from active entities */}
            <div className="px-8 pb-5 flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setActiveTagFilters([])}
                className={`px-4 py-1.5 rounded-full text-[10px] font-bold shadow shadow-primary/20 transition-all ${activeTagFilters.length === 0 ? 'bg-primary text-white' : 'bg-surface-container-lowest border border-surface-container-high text-on-surface-variant hover:border-primary/20'}`}
              >All</button>
              {userEntities.map((entity) => (
                <button
                  key={entity.id}
                  onClick={() => setActiveTagFilters([entity.name])}
                  className={`px-4 py-1.5 rounded-full text-[10px] font-bold transition-all ${activeTagFilters.includes(entity.name) ? 'bg-primary text-white' : 'bg-surface-container-lowest border border-surface-container-high text-on-surface-variant hover:border-primary/20'}`}
                >{entity.name}</button>
              ))}
              <div className="h-4 w-px bg-outline-variant/30 mx-1" />
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50" style={{fontSize:"14px"}}>filter_list</span>
                <input
                  type="text"
                  value={taskFilter}
                  onChange={(e) => setTaskFilter(e.target.value)}
                  placeholder="Filter tasks..."
                  className="text-[10px] bg-surface-container-lowest border border-surface-container-high rounded-full pl-8 pr-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/20 text-on-background w-32"
                />
              </div>
              <button
                onClick={() => setShowTaskModal(true)}
                className="flex items-center gap-1.5 bg-primary text-on-primary px-3 py-1.5 rounded-full text-[10px] font-bold shadow shadow-primary/20 hover:scale-[0.97] transition-transform flex-shrink-0"
              >
                <span className="material-symbols-outlined" style={{fontSize:"14px"}}>add</span>
                New Task
              </button>
            </div>

            {/* Task sections */}
            {(() => {
              const todayStr = getTodayLocal();
              const base = (activeTagFilters.length > 0
                ? visibleTasks.filter((t) => t.tags?.some((tag) => activeTagFilters.includes(tag)))
                : visibleTasks
              ).filter((t) => !taskFilter || t.title?.toLowerCase().includes(taskFilter.toLowerCase()));
              const overdue = base.filter((t) => !t.completed && t.dueDate && t.dueDate < todayStr);
              const todayTasks = base.filter((t) => !t.completed && t.dueDate === todayStr);
              const upcoming = base.filter((t) => !t.completed && (!t.dueDate || t.dueDate > todayStr));
              const completedToday = base.filter((t) => t.completed && t.completedAt && t.completedAt.slice(0,10) === todayStr);

              const taskRow = (t, isOverdue = false) => (
                <div key={t.id} onClick={() => setEditingTask(t)} className={`flex items-center gap-3 p-3 rounded-xl transition-colors group cursor-pointer ${isOverdue ? 'bg-error/5 border border-error/10 hover:bg-error/10' : 'bg-surface-container-lowest border border-surface-container-low hover:bg-surface-container-low'}`}>
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleTask(t.id); }}
                    className={`h-4 w-4 rounded-full border-2 flex-shrink-0 transition-colors ${isOverdue ? 'border-error' : 'border-outline-variant hover:border-primary'}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-bold leading-tight truncate ${isOverdue ? 'text-on-background' : 'text-on-background'}`}>{t.title}</p>
                    {isOverdue && t.dueDate && (
                      <p className="text-[9px] text-error font-bold mt-0.5">
                        {Math.floor((new Date(todayStr) - new Date(t.dueDate)) / 86400000)} day{Math.floor((new Date(todayStr) - new Date(t.dueDate)) / 86400000) !== 1 ? 's' : ''} overdue
                      </p>
                    )}
                    {!isOverdue && t.dueDate === todayStr && (
                      <p className="text-[9px] text-on-surface-variant mt-0.5">Due today{t.priority === 'high' ? ' · High priority' : ''}</p>
                    )}
                  </div>
                  {t.tags?.[0] && (
                    <span className="text-[9px] font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full flex-shrink-0">{t.tags[0]}</span>
                  )}
                  {t.dueDate && t.dueDate !== todayStr && !isOverdue && (
                    <span className="text-[9px] text-on-surface-variant font-bold flex-shrink-0">
                      {(() => { const [y, m, d] = t.dueDate.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); })()}
                    </span>
                  )}
                  <span className="material-symbols-outlined text-on-surface-variant/30 group-hover:text-on-surface-variant text-base transition-colors flex-shrink-0">chevron_right</span>
                </div>
              );

              const priorityDot = {
                high:   'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]',
                medium: 'bg-orange-400 shadow-[0_0_8px_rgba(249,115,22,0.4)]',
                low:    'bg-blue-400 shadow-[0_0_8px_rgba(59,130,246,0.4)]',
              };
              const priorityLabel = { high: 'High Priority', medium: 'Medium Priority', low: 'Low Priority' };

              const taskCard = (t) => (
                <div key={t.id} onClick={() => setEditingTask(t)} className="group bg-surface-container-lowest p-4 rounded-xl shadow-sm hover:shadow-md hover:scale-[1.01] transition-all border border-transparent hover:border-primary/10 cursor-pointer">
                  <div className="flex items-start gap-3">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleTask(t.id); }}
                      className="mt-0.5 w-5 h-5 rounded-lg border-2 border-primary/20 flex-shrink-0 hover:border-primary transition-colors"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${priorityDot[t.priority] || priorityDot.medium}`} />
                        <span className="text-[10px] font-bold uppercase text-on-surface-variant">{priorityLabel[t.priority] || 'Medium Priority'}</span>
                      </div>
                      <h3 className="text-sm font-bold text-on-background truncate group-hover:text-primary transition-colors">{t.title}</h3>
                      <div className="flex items-center gap-2 mt-3">
                        {t.tags?.[0] && (
                          <span className="text-[10px] px-2 py-0.5 bg-secondary-container text-on-secondary-container rounded-full font-bold">{t.tags[0]}</span>
                        )}
                        {t.dueTime && (
                          <div className="flex items-center gap-1 text-[10px] text-on-surface-variant font-medium ml-auto">
                            <span className="material-symbols-outlined" style={{fontSize:"12px"}}>schedule</span>
                            {t.dueTime}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );

              return (
                <div className="px-8 space-y-8 pb-12">

                  {/* OVERDUE */}
                  {overdue.length > 0 && (
                    <section>
                      <div className="flex items-center gap-3 mb-3">
                        <span className="material-symbols-outlined text-error text-base">event_busy</span>
                        <h2 className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-error">Overdue</h2>
                        <div className="h-px flex-1 bg-error/10" />
                        <span className="text-[9px] font-bold text-error bg-error/10 px-2 py-0.5 rounded-full">{overdue.length} task{overdue.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="space-y-2">{overdue.map((t) => taskRow(t, true))}</div>
                    </section>
                  )}

                  {/* TODAY */}
                  {todayTasks.length > 0 && (
                    <section>
                      <div className="flex items-center gap-3 mb-3">
                        <span className="material-symbols-outlined text-primary text-base">today</span>
                        <h2 className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-primary/70">Today</h2>
                        <div className="h-px flex-1 bg-primary/10" />
                        <span className="text-[9px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded-full">{todayTasks.length} task{todayTasks.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{todayTasks.map((t) => taskCard(t))}</div>
                    </section>
                  )}

                  {/* UPCOMING */}
                  {upcoming.length > 0 && (
                    <section>
                      <div className="flex items-center gap-3 mb-3">
                        <span className="material-symbols-outlined text-on-surface-variant text-base">upcoming</span>
                        <h2 className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-on-surface-variant">Upcoming</h2>
                        <div className="h-px flex-1 bg-surface-container-high" />
                        <span className="text-[9px] font-bold text-on-surface-variant bg-surface-container px-2 py-0.5 rounded-full">{upcoming.length} task{upcoming.length !== 1 ? 's' : ''}</span>
                      </div>
                      <div className="space-y-2">{upcoming.map((t) => taskRow(t, false))}</div>
                    </section>
                  )}

                  {/* COMPLETED TODAY */}
                  {completedToday.length > 0 && (
                    <section className="opacity-60 grayscale-[0.5]">
                      <div className="flex items-center gap-3 mb-3">
                        <span className="material-symbols-outlined text-emerald-500 text-base">task_alt</span>
                        <h2 className="text-[10px] font-extrabold uppercase tracking-[0.15em] text-slate-400">Completed Today</h2>
                        <div className="h-px flex-1 bg-surface-container-high" />
                        <button className="text-[9px] font-bold text-on-surface-variant hover:text-primary transition-colors">Show all</button>
                      </div>
                      <div className="space-y-2">
                        {completedToday.map((t) => (
                          <div key={t.id} className="flex items-center gap-3 bg-surface-container-lowest/50 p-3 rounded-xl">
                            <div className="h-4 w-4 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
                              <span className="material-symbols-outlined text-white text-[10px]" style={{fontVariationSettings:"'FILL' 1"}}>check</span>
                            </div>
                            <p className="text-xs font-medium text-on-surface-variant line-through flex-1 truncate">{t.title}</p>
                            <span className="text-[9px] text-on-surface-variant font-medium flex-shrink-0">
                              {t.completedAt ? new Date(t.completedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'Today'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* EMPTY STATE */}
                  {overdue.length === 0 && todayTasks.length === 0 && upcoming.length === 0 && completedToday.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-16">
                      <span className="material-symbols-outlined text-5xl text-on-surface-variant/30 mb-3">task_alt</span>
                      <p className="text-sm font-bold text-on-surface-variant">All clear</p>
                      <p className="text-xs text-on-surface-variant/60 mt-1">No tasks here</p>
                    </div>
                  )}

                </div>
              );
            })()}
          </div>
          )}
          </Suspense>
        </section>

        {/* ── Right: Sliding Chat panel (25% desktop, hidden on chat tab and mobile) ── */}
        {chatPanelOpen && activeView !== 'chat' && (
          <section className="hidden md:flex flex-col overflow-hidden" style={{ flex: '0 0 25%' }}>
            <SlidingChatPanel
              messages={chatMessages}
              loading={chatLoading}
              backend={chatBackend}
              contextBadge={`${tasks.filter((t) => !t.completed).length} tasks${allNotes.filter((n) => !n.archived && n.content).length > 0 ? ` · ${allNotes.filter((n) => !n.archived && n.content).length} note${allNotes.filter((n) => !n.archived && n.content).length !== 1 ? 's' : ''}` : ''}`}
              onHide={toggleChatPanel}
              activePersona={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}
            />
          </section>
        )}



        {/* ── Chat panel (mobile: fixed full-screen overlay; desktop: hidden here) ── */}
        {mobileView === 'chat' && (
          <section
            className="md:hidden flex flex-col overflow-hidden"
            style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 50, backgroundColor: '#fff' }}
          >
            {/* Header — only shows on list view; chat view has its own header with back */}
            {!mobileChatOpen && (
              <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-container-low flex-shrink-0">
                <button
                  onClick={() => setMobileView('tasks')}
                  className="flex items-center justify-center w-8 h-8 rounded-full hover:bg-surface-container-low transition-colors"
                >
                  <span className="material-symbols-outlined text-lg text-on-surface-variant">arrow_back</span>
                </button>
                <h3 style={{ fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '15px', fontWeight: 600, color: '#4f4dcf' }}>Aria</h3>
              </div>
            )}
            <ChatTabPanel
              conversations={conversations}
              activeConvId={activeConvId}
              activeMessages={chatMessages}
              loading={chatLoading}
              backend={chatBackend}
              onSelectConv={selectConversation}
              onNewChat={createNewChat}
              onDeleteConv={deleteConversation}
              onRenameConv={renameConversation}
              mobileChatOpen={mobileChatOpen}
              onMobileChatOpen={() => setMobileChatOpen(true)}
              onMobileChatClose={() => setMobileChatOpen(false)}
            />
          </section>
        )}

        {/* ── Calendar panel (mobile only — on desktop it's in the task section tabs) ── */}
        <section
          className={`flex-col overflow-hidden w-full md:hidden ${
            mobileView === 'calendar' ? 'flex' : 'hidden'
          }`}
        >
          <Suspense fallback={<div className="flex-1 p-10"><SkeletonBlock className="h-64" /></div>}>
            <CalendarPanel currentUser={currentUser} addToast={addToast} apiFetch={apiFetch} />
          </Suspense>
        </section>

        {/* ── Notes panel (mobile only — on desktop it's in the task section tabs) ── */}
        <section
          className={`flex-col overflow-hidden w-full md:hidden ${
            mobileView === 'notes' ? 'flex' : 'hidden'
          }`}
        >
          <Suspense fallback={<div className="flex-1 p-10"><SkeletonBlock className="h-64" /></div>}>
            <NotesPanel authToken={authToken} onEditorStateChange={setNotesEditorOpen} onCategoriesLoaded={setNoteCategories} onNotesLoaded={setAllNotes} quickCapturedNote={quickCapturedNote} addToast={addToast} entities={userEntities} apiFetch={apiFetch} onNoteOpenRef={(fn) => { openNoteRef.current = fn; }} />
          </Suspense>
        </section>
        </div>
      </div>

      {/* ── Mobile bottom navigation ── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur-xl border-t border-outline-variant/10 flex z-40 rounded-t-2xl shadow-[0px_-10px_30px_rgba(79,77,207,0.06)]">
        {[
          { key: 'tasks', label: 'Home', icon: <span className="material-symbols-outlined text-xl">dashboard</span> },
          { key: 'daily', label: 'Tasks', icon: <span className="material-symbols-outlined text-xl">checklist</span> },
          { key: 'calendar', label: 'Calendar', icon: <span className="material-symbols-outlined text-xl">calendar_today</span> },
          { key: 'notes', label: 'Notes', icon: <span className="material-symbols-outlined text-xl">sticky_note_2</span> },
          { key: 'chat', label: 'Aria', icon: <span className="material-symbols-outlined text-xl">chat</span> },
        ].map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => {
              setMobileView(key);
              if (key !== 'chat') setMobileChatOpen(false);
              if (key === 'tasks') setActiveView('dashboard');
              else if (key === 'daily') setActiveView('daily');
            }}
            className={`flex-1 flex flex-col items-center gap-0.5 py-3 text-xs font-bold transition-colors ${
              mobileView === key ? 'text-primary' : 'text-slate-400'
            }`}
          >
            {icon}
            <span className="text-[9px] uppercase tracking-wider">{label}</span>
          </button>
        ))}
      </nav>

      {/* ── Modals ── */}
      {showCreateEvent && (
        <CreateEventModal
          currentUser={currentUser}
          onClose={() => setShowCreateEvent(false)}
          onCreated={() => {
            // Refresh calendar events
            const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
            apiFetch(`${API_BASE}/api/gcal/events?userId=${currentUser.id}&timeZone=${encodeURIComponent(tz)}&days=7`)
              .then((r) => r.json())
              .then((data) => { if (Array.isArray(data)) setChatCalendarEvents(data); })
              .catch(() => {});
          }}
          addToast={addToast}
          apiFetch={apiFetch}
        />
      )}
      {showSettings && (
        <Suspense fallback={null}>
        <SettingsModal
          apiKeys={apiKeys}
          onSave={(keys) => { setApiKeys(keys); saveSettings(keys, emailSettingsRef.current, alertRulesRef.current); }}
          emailSettings={emailSettings}
          onSaveEmail={(email) => { setEmailSettings(email); saveSettings(apiKeysRef.current, email, alertRulesRef.current); }}
          onClose={() => setShowSettings(false)}
          envConfigured={envConfigured}
          authToken={authToken}
          currentUser={currentUser}
          entities={entities}
          onEntitiesChanged={reloadEntities}
          onUserUpdated={(u) => { setCurrentUser(u); localStorage.setItem('tm_user', JSON.stringify(u)); }}
          apiFetch={apiFetch}
          alertRules={alertRules}
          onUpdateAlertRules={setAlertRules}
          tasks={tasks}
          firedAlertsRef={firedAlertsRef}
          envStatus={{
            slack:    !!envConfigured.channelSlack,
            whatsapp: !!envConfigured.channelWhatsapp,
            sms:      !!envConfigured.channelSms,
            email:    !!envConfigured.channelEmail,
          }}
          addToast={addToast}
          EntitySelectOptions={EntitySelectOptions}
        />
        </Suspense>
      )}


      {/* Add Task Modal — global */}
      {showTaskModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setShowTaskModal(false)}
        >
          <div
            className="bg-surface rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <Suspense fallback={null}>
            <AddTaskForm
              onAdd={(task) => { addTask(task); setShowTaskModal(false); }}
              claudeKey={apiKeys.claude}
              currentUser={currentUser}
              entities={userEntities}
              authToken={authToken}
              gcalConnected={gcalConnected}
              forceOpen={true}
              onClose={() => setShowTaskModal(false)}
              apiFetch={apiFetch}
            />
            </Suspense>
          </div>
        </div>
      )}

      {/* Edit Task Modal — global */}
      {editingTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setEditingTask(null)}
        >
          <div
            className="bg-surface rounded-2xl shadow-2xl w-full max-w-lg mx-4 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-extrabold text-on-background font-headline">Edit Task</h2>
              <button onClick={() => setEditingTask(null)} className="text-on-surface-variant hover:text-on-background transition-colors">
                <span className="material-symbols-outlined text-xl">close</span>
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider mb-1.5 block">Title</label>
                <input
                  type="text"
                  value={editingTask.title}
                  onChange={(e) => setEditingTask((t) => ({ ...t, title: e.target.value }))}
                  className="w-full bg-surface-container-lowest rounded-xl px-4 py-2.5 text-sm text-on-background border border-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider mb-1.5 block">Priority</label>
                  <select
                    value={editingTask.priority || 'medium'}
                    onChange={(e) => setEditingTask((t) => ({ ...t, priority: e.target.value }))}
                    className="w-full bg-surface-container-lowest rounded-xl px-4 py-2.5 text-sm text-on-background border border-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider mb-1.5 block">Due Date</label>
                  <input
                    type="date"
                    value={editingTask.dueDate || ''}
                    onChange={(e) => setEditingTask((t) => ({ ...t, dueDate: e.target.value }))}
                    className="w-full bg-surface-container-lowest rounded-xl px-4 py-2.5 text-sm text-on-background border border-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider mb-1.5 block">Entity</label>
                <select
                  value={editingTask.tags?.[0] || ''}
                  onChange={(e) => setEditingTask((t) => ({ ...t, tags: e.target.value ? [e.target.value] : [] }))}
                  className="w-full bg-surface-container-lowest rounded-xl px-4 py-2.5 text-sm text-on-background border border-surface-variant focus:outline-none focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">None</option>
                  {(userEntities || []).map((ent) => (
                    <option key={ent.id} value={ent.name}>{ent.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setEditingTask(null)}
                  className="flex-1 px-4 py-2.5 rounded-xl border border-surface-variant text-sm font-bold text-on-surface-variant hover:bg-surface-container transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { editTask(editingTask.id, { title: editingTask.title, priority: editingTask.priority, dueDate: editingTask.dueDate, tags: editingTask.tags }); setEditingTask(null); }}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-bold shadow-lg shadow-primary/20 hover:scale-[0.98] transition-transform"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick Capture FAB removed — actions live in Command Center */}

      {/* ── Toast notifications handled by ToastProvider in main.jsx ── */}
    </div>
  );
}
