import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useToast } from './contexts/ToastContext';
import { useAuthLogout } from './hooks/useAuthLogout';
import { buildContext } from './lib/context-engine/buildContext';
import { detectIntent } from './lib/context-engine/intentDetector';
import { routePersona } from './lib/context-engine/personaRouter';
import { usePersona } from './contexts/PersonaContext';
import PersonaSettings from './components/settings/PersonaSettings';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TiptapImage from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';

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
import { GearIcon, XIcon, SendIcon, ChatIcon, SpinnerIcon, BellIcon, MailIcon, ChecklistIcon, LogoutIcon, CalendarIcon, NotesIcon, UploadIcon, SyncIcon, PencilIcon } from './components/icons/Icons.jsx';
import CalendarPanel from './panels/CalendarPanel.jsx';
import InboxPanel from './panels/InboxPanel.jsx';

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

import { uid, escapeHtml, conditionDescription, getRuleScope } from './utils/helpers.js';
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

async function fetchSuggestedTags(title, description, claudeKey, entityNames, authToken) {
  if (!claudeKey || !title.trim() || entityNames.length === 0) return [];

  const prompt =
    `Given these categories: ${entityNames.join(', ')}. ` +
    `Based on this task title and description: '${title} - ${description}', ` +
    `suggest which tags apply. Respond ONLY with a JSON array of matching tag names, ` +
    `e.g. ${JSON.stringify(entityNames.slice(0, 2))}. No explanation.`;

  try {
    const res = await apiFetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({
        apiKey: claudeKey,
        model: 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*?\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return parsed.filter((t) => entityNames.includes(t));
  } catch {
    return [];
  }
}

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
// ─────────────────────────────────────────────────────────────────────────────

function EnvBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 rounded-full ml-2">
      <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
      Configured via environment
    </span>
  );
}

function SettingsModal({ apiKeys, onSave, emailSettings, onSaveEmail, onClose, envConfigured = {}, authToken, currentUser, entities, onEntitiesChanged, onUserUpdated }) {
  const isAdmin = currentUser?.role === 'admin';
  const [tab, setTab]               = useState('keys');
  const [draftKeys, setDraftKeys]   = useState({ ...apiKeys });
  const [draftEmail, setDraftEmail] = useState({ ...emailSettings });
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [pwForm, setPwForm]         = useState({ current: '', newPw: '', confirm: '' });
  const [pwStatus, setPwStatus]     = useState(null);
  const [pwSaving, setPwSaving]     = useState(false);

  // Persona state
  const [personaName, setPersonaName] = useState(currentUser?.assistantName || 'Aria');
  const [personaType, setPersonaType] = useState(currentUser?.persona || 'executive_assistant');
  const [personaSaving, setPersonaSaving] = useState(false);
  const [personaStatus, setPersonaStatus] = useState(null);

  // ── Gmail / Email Intelligence state ──
  const [gmailStatus, setGmailStatus] = useState({ connected: false, email: '' });
  const [gmailConfig, setGmailConfig] = useState({ vipSenders: [], triggerKeywords: [], commitmentDetection: true });
  const [gmailLoading, setGmailLoading] = useState(false);
  const [newVip, setNewVip] = useState('');
  const [newKeyword, setNewKeyword] = useState('');
  const [newExclusion, setNewExclusion] = useState('');
  const [configSaving, setConfigSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const settingsToast = useToast();

  // ── Entity management state ──
  const [entityList, setEntityList] = useState([]);
  const [newEntityName, setNewEntityName] = useState('');
  const [newEntityColor, setNewEntityColor] = useState('indigo');
  const [newEntityType, setNewEntityType] = useState('business');
  const [newEntityParent, setNewEntityParent] = useState('');
  const [newEntityShared, setNewEntityShared] = useState(false);
  const [editingEntity, setEditingEntity] = useState(null);

  // ── User management state ──
  const [userList, setUserList] = useState([]);
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', displayName: '', email: '', password: '', role: 'member', entityIds: [] });
  const [editingUser, setEditingUser] = useState(null);

  useEffect(() => {
    if (tab === 'gmail') loadGmailData();
    if (isAdmin && (tab === 'entities' || tab === 'users')) {
      if (tab === 'entities') loadEntities();
      if (tab === 'users') loadUsers();
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadGmailData() {
    try {
      const [statusRes, configRes] = await Promise.all([
        apiFetch(`/api/gmail/status?userId=${currentUser.id}`),
        apiFetch(`/api/gmail/config?userId=${currentUser.id}`),
      ]);
      const statusData = await statusRes.json();
      const configData = await configRes.json();
      setGmailStatus(statusData);
      setGmailConfig({ excludedSenders: [], autoExcludeNoreply: true, ...configData });
    } catch {}
  }

  async function handleGmailConnect() {
    setGmailLoading(true);
    try {
      const res = await apiFetch(`/api/gmail/auth-url?userId=${currentUser.id}`);
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setGmailLoading(false);
    }
  }

  async function handleGmailDisconnect() {
    setGmailLoading(true);
    try {
      await apiFetch(`/api/gmail/disconnect?userId=${currentUser.id}`, { method: 'DELETE' });
      setGmailStatus({ connected: false, email: '' });
    } catch {} finally {
      setGmailLoading(false);
    }
  }

  async function handleSaveGmailConfig() {
    setConfigSaving(true);
    try {
      await apiFetch('/api/gmail/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, config: gmailConfig }),
      });
    } catch {} finally {
      setConfigSaving(false);
    }
  }

  async function handleGmailScan() {
    setScanning(true);
    try {
      const res = await apiFetch('/api/gmail/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (res.ok) {
        if (data.newItems > 0) {
          settingsToast.success(`Found ${data.newItems} new item${data.newItems !== 1 ? 's' : ''} in your Inbox`);
        } else {
          settingsToast.info('Inbox is up to date');
        }
      } else {
        settingsToast.error(data.error || 'Scan failed');
      }
    } catch {
      settingsToast.error('Scan failed');
    } finally {
      setScanning(false);
    }
  }

  async function loadEntities() {
    try {
      const res = await apiFetch('/api/entities', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (Array.isArray(data)) setEntityList(data);
    } catch {}
  }

  async function loadUsers() {
    try {
      const res = await apiFetch('/api/users', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (Array.isArray(data)) setUserList(data);
    } catch {}
  }

  async function handleCreateEntity() {
    if (!newEntityName.trim()) return;
    try {
      const res = await apiFetch('/api/entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          name: newEntityName.trim(),
          color: newEntityColor,
          type: newEntityType,
          parentId: newEntityType === 'project' ? newEntityParent || null : null,
          shared: newEntityShared,
        }),
      });
      if (res.ok) {
        setNewEntityName('');
        setNewEntityColor('indigo');
        setNewEntityType('business');
        setNewEntityParent('');
        setNewEntityShared(false);
        loadEntities();
        onEntitiesChanged?.();
      }
    } catch {}
  }

  async function handleUpdateEntity(id, fields) {
    try {
      await apiFetch(`/api/entities/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(fields),
      });
      setEditingEntity(null);
      loadEntities();
      onEntitiesChanged?.();
    } catch {}
  }

  async function handleDeleteEntity(id) {
    try {
      await apiFetch(`/api/entities/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      loadEntities();
      onEntitiesChanged?.();
    } catch {}
  }

  async function handleCreateUser() {
    if (!newUser.username.trim() || !newUser.password) return;
    try {
      const res = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(newUser),
      });
      if (res.ok) {
        setNewUser({ username: '', displayName: '', email: '', password: '', role: 'member', entityIds: [] });
        setShowAddUser(false);
        loadUsers();
      }
    } catch {}
  }

  async function handleUpdateUser(id, fields) {
    try {
      await apiFetch(`/api/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(fields),
      });
      setEditingUser(null);
      loadUsers();
    } catch {}
  }

  async function handleDeleteUser(id) {
    try {
      await apiFetch(`/api/users/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      loadUsers();
    } catch {}
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') onClose();
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch('/api/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: draftEmail.recipientEmail }),
      });
      const data = await res.json();
      setTestResult(
        res.ok ? { ok: true, msg: 'Test email sent via Resend!' } : { ok: false, msg: data.error || 'Failed' },
      );
    } catch (err) {
      setTestResult({ ok: false, msg: err.message });
    } finally {
      setTesting(false);
    }
  }

  const inputCls =
    'w-full px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition';
  const disabledCls =
    'w-full px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-gray-500 cursor-not-allowed';

  const hasAnyEnv = Object.values(envConfigured).some(Boolean);

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center">
              <GearIcon className="w-4 h-4 text-gray-600" />
            </div>
            <h2 className="text-lg font-bold text-gray-900">Settings</h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg p-1 transition-colors"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-100 mx-6 overflow-x-auto">
          {[
            { key: 'keys',  label: 'API Keys' },
            { key: 'email', label: 'Alerts' },
            { key: 'assistant', label: 'AI Assistant' },
            { key: 'password', label: 'Password' },
            { key: 'gmail', label: 'Email Intelligence' },
            ...(isAdmin ? [
              { key: 'entities', label: 'Entities' },
              { key: 'users', label: 'Users' },
            ] : []),
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px whitespace-nowrap ${
                tab === key
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="px-6 py-5 flex-1 overflow-y-auto">
          {/* API Keys tab */}
          {tab === 'keys' && (
            <div className="space-y-4">
              {hasAnyEnv ? (
                <p className="text-xs text-gray-500 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  Fields marked with a green badge are configured via Railway environment variables and survive redeploys.
                </p>
              ) : (
                <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  Keys are stored in memory only and never persisted beyond this session.
                </p>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Claude API Key
                  {envConfigured.claudeKey && <EnvBadge />}
                </label>
                <input
                  type="password"
                  value={draftKeys.claude}
                  onChange={(e) => setDraftKeys((k) => ({ ...k, claude: e.target.value }))}
                  placeholder="sk-ant-api03-..."
                  autoComplete="off"
                  disabled={envConfigured.claudeKey}
                  className={envConfigured.claudeKey ? disabledCls : inputCls}
                />
                <p className="text-xs text-gray-400 mt-1">AI tag suggestions + Claude chat</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  OpenAI API Key
                  {envConfigured.openaiKey && <EnvBadge />}
                </label>
                <input
                  type="password"
                  value={draftKeys.openai}
                  onChange={(e) => setDraftKeys((k) => ({ ...k, openai: e.target.value }))}
                  placeholder="sk-..."
                  autoComplete="off"
                  disabled={envConfigured.openaiKey}
                  className={envConfigured.openaiKey ? disabledCls : inputCls}
                />
                <p className="text-xs text-gray-400 mt-1">ChatGPT chat</p>
              </div>

              <button
                onClick={() => { onSave(draftKeys); onClose(); }}
                className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm"
              >
                Save API Keys
              </button>
            </div>
          )}

          {/* Email tab */}
          {tab === 'email' && (
            <div className="space-y-4">
              {/* Resend status */}
              <div className={`text-xs px-3 py-2.5 rounded-lg font-medium flex items-center gap-2 ${
                envConfigured.resendApiKey
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : 'bg-amber-50 text-amber-700 border border-amber-100'
              }`}>
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${envConfigured.resendApiKey ? 'bg-green-500' : 'bg-amber-400'}`} />
                {envConfigured.resendApiKey
                  ? 'Resend API key configured via environment variable'
                  : 'Set RESEND_API_KEY in Railway environment variables to enable email'}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Default Alert Recipient
                  {envConfigured.recipientEmail && <EnvBadge />}
                </label>
                <input
                  type="email"
                  value={draftEmail.recipientEmail}
                  onChange={(e) => setDraftEmail((s) => ({ ...s, recipientEmail: e.target.value }))}
                  placeholder="alerts@example.com"
                  autoComplete="off"
                  disabled={envConfigured.recipientEmail}
                  className={envConfigured.recipientEmail ? disabledCls : inputCls}
                />
                <p className="text-xs text-gray-400 mt-1">Alerts are sent to this address by default</p>
              </div>

              {testResult && (
                <div
                  className={`text-xs px-3 py-2 rounded-lg font-medium ${
                    testResult.ok
                      ? 'bg-green-50 text-green-700 border border-green-200'
                      : 'bg-red-50 text-red-700 border border-red-200'
                  }`}
                >
                  {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleTestConnection}
                  disabled={testing || !envConfigured.resendApiKey}
                  className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 hover:bg-gray-50 font-medium text-sm transition-colors disabled:opacity-50"
                >
                  {testing ? 'Sending…' : 'Send Test Email'}
                </button>
                <button
                  onClick={() => { onSaveEmail(draftEmail); onClose(); }}
                  className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm"
                >
                  Save Email Settings
                </button>
              </div>
            </div>
          )}

          {/* AI Assistant tab */}
          {tab === 'assistant' && (
            <div className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Assistant Name</label>
                <input
                  type="text"
                  value={personaName}
                  onChange={(e) => setPersonaName(e.target.value)}
                  placeholder="Aria"
                  maxLength={30}
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
                />
                <p className="text-xs text-gray-400 mt-1">Your AI assistant&rsquo;s name — used in briefs and greetings.</p>
              </div>
              <PersonaSettings />

              {personaStatus && (
                <div className={`text-xs px-3 py-2 rounded-lg font-medium ${
                  personaStatus.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
                }`}>
                  {personaStatus.ok ? '\u2713 ' : '\u2717 '}{personaStatus.msg}
                </div>
              )}

              <button
                disabled={personaSaving}
                onClick={async () => {
                  setPersonaSaving(true);
                  setPersonaStatus(null);
                  try {
                    const res = await apiFetch('/api/users/settings', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                      body: JSON.stringify({ persona: personaType, assistantName: personaName.trim() || 'Aria' }),
                    });
                    const data = await res.json();
                    if (res.ok) {
                      setPersonaStatus({ ok: true, msg: 'Saved!' });
                      if (onUserUpdated) onUserUpdated(data);
                    } else {
                      setPersonaStatus({ ok: false, msg: data.error || 'Failed to save' });
                    }
                  } catch (err) {
                    setPersonaStatus({ ok: false, msg: err.message });
                  } finally {
                    setPersonaSaving(false);
                  }
                }}
                className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
              >
                {personaSaving ? 'Saving\u2026' : 'Save Assistant Settings'}
              </button>
            </div>
          )}

          {/* Password tab */}
          {tab === 'password' && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Current Password</label>
                <input
                  type="password"
                  value={pwForm.current}
                  onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
                  placeholder="Enter current password"
                  autoComplete="current-password"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">New Password</label>
                <input
                  type="password"
                  value={pwForm.newPw}
                  onChange={(e) => setPwForm((f) => ({ ...f, newPw: e.target.value }))}
                  placeholder="Enter new password"
                  autoComplete="new-password"
                  className={inputCls}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirm New Password</label>
                <input
                  type="password"
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  className={inputCls}
                />
              </div>

              {pwStatus && (
                <div className={`text-xs px-3 py-2 rounded-lg font-medium ${
                  pwStatus.ok
                    ? 'bg-green-50 text-green-700 border border-green-200'
                    : 'bg-red-50 text-red-700 border border-red-200'
                }`}>
                  {pwStatus.ok ? '✓ ' : '✗ '}{pwStatus.msg}
                </div>
              )}

              <button
                disabled={pwSaving}
                onClick={async () => {
                  setPwStatus(null);
                  if (!pwForm.current || !pwForm.newPw || !pwForm.confirm) {
                    setPwStatus({ ok: false, msg: 'All fields are required' });
                    return;
                  }
                  if (pwForm.newPw !== pwForm.confirm) {
                    setPwStatus({ ok: false, msg: 'New passwords do not match' });
                    return;
                  }
                  if (pwForm.newPw.length < 4) {
                    setPwStatus({ ok: false, msg: 'New password must be at least 4 characters' });
                    return;
                  }
                  setPwSaving(true);
                  try {
                    const res = await apiFetch('/api/auth/change-password', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${authToken}`,
                      },
                      body: JSON.stringify({ currentPassword: pwForm.current, newPassword: pwForm.newPw }),
                    });
                    const data = await res.json();
                    if (res.ok) {
                      setPwStatus({ ok: true, msg: 'Password changed successfully' });
                      setPwForm({ current: '', newPw: '', confirm: '' });
                    } else {
                      setPwStatus({ ok: false, msg: data.error || 'Failed to change password' });
                    }
                  } catch (err) {
                    setPwStatus({ ok: false, msg: err.message });
                  } finally {
                    setPwSaving(false);
                  }
                }}
                className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
              >
                {pwSaving ? 'Changing…' : 'Change Password'}
              </button>
            </div>
          )}

          {/* Email Intelligence tab */}
          {tab === 'gmail' && (
            <div className="space-y-5">
              {/* Connection status */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-2">Gmail Connection</h3>
                <div className="flex items-center justify-between p-3 rounded-lg border border-gray-100 bg-gray-50/50">
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${gmailStatus.connected ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className="text-sm text-gray-600">
                      {gmailStatus.connected ? `Connected to ${gmailStatus.email}` : 'Not connected'}
                    </span>
                  </div>
                  {gmailStatus.connected ? (
                    <button
                      onClick={handleGmailDisconnect}
                      disabled={gmailLoading}
                      className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                    >
                      {gmailLoading ? 'Disconnecting...' : 'Disconnect'}
                    </button>
                  ) : (
                    <button
                      onClick={handleGmailConnect}
                      disabled={gmailLoading}
                      className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {gmailLoading ? 'Connecting...' : 'Connect Gmail'}
                    </button>
                  )}
                </div>
              </div>

              {/* VIP Senders */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">VIP Senders</h3>
                <p className="text-xs text-gray-400 mb-2">Emails or domains (e.g. boss@company.com, @important.com)</p>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newVip}
                    onChange={(e) => setNewVip(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newVip.trim()) {
                        setGmailConfig((c) => ({ ...c, vipSenders: [...c.vipSenders, newVip.trim()] }));
                        setNewVip('');
                      }
                    }}
                    placeholder="Add email or @domain"
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
                  />
                  <button
                    onClick={() => {
                      if (newVip.trim()) {
                        setGmailConfig((c) => ({ ...c, vipSenders: [...c.vipSenders, newVip.trim()] }));
                        setNewVip('');
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50"
                  >Add</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {gmailConfig.vipSenders.map((s, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                      {s}
                      <button
                        onClick={() => setGmailConfig((c) => ({ ...c, vipSenders: c.vipSenders.filter((_, j) => j !== i) }))}
                        className="text-indigo-400 hover:text-indigo-600 ml-0.5"
                      >&times;</button>
                    </span>
                  ))}
                  {gmailConfig.vipSenders.length === 0 && <span className="text-xs text-gray-300 italic">None added yet</span>}
                </div>
              </div>

              {/* Trigger Keywords */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">Trigger Keywords</h3>
                <p className="text-xs text-gray-400 mb-2">Flag emails containing these words (e.g. urgent, deadline, invoice)</p>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newKeyword}
                    onChange={(e) => setNewKeyword(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newKeyword.trim()) {
                        setGmailConfig((c) => ({ ...c, triggerKeywords: [...c.triggerKeywords, newKeyword.trim()] }));
                        setNewKeyword('');
                      }
                    }}
                    placeholder="Add keyword"
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
                  />
                  <button
                    onClick={() => {
                      if (newKeyword.trim()) {
                        setGmailConfig((c) => ({ ...c, triggerKeywords: [...c.triggerKeywords, newKeyword.trim()] }));
                        setNewKeyword('');
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50"
                  >Add</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {gmailConfig.triggerKeywords.map((k, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                      {k}
                      <button
                        onClick={() => setGmailConfig((c) => ({ ...c, triggerKeywords: c.triggerKeywords.filter((_, j) => j !== i) }))}
                        className="text-amber-400 hover:text-amber-600 ml-0.5"
                      >&times;</button>
                    </span>
                  ))}
                  {gmailConfig.triggerKeywords.length === 0 && <span className="text-xs text-gray-300 italic">None added yet</span>}
                </div>
              </div>

              {/* Excluded Senders */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">Excluded Senders</h3>
                <p className="text-xs text-gray-400 mb-2">Skip emails from these senders during scan</p>
                <label className="inline-flex items-center gap-2 cursor-pointer mb-3">
                  <div
                    className={`relative w-9 h-5 rounded-full transition-colors ${gmailConfig.autoExcludeNoreply ? 'bg-indigo-600' : 'bg-gray-300'}`}
                    onClick={() => setGmailConfig((c) => ({ ...c, autoExcludeNoreply: !c.autoExcludeNoreply }))}
                  >
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${gmailConfig.autoExcludeNoreply ? 'translate-x-4' : ''}`} />
                  </div>
                  <span className="text-sm text-gray-600">Auto-exclude no-reply senders</span>
                </label>
                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={newExclusion}
                    onChange={(e) => setNewExclusion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newExclusion.trim()) {
                        setGmailConfig((c) => ({ ...c, excludedSenders: [...(c.excludedSenders || []), newExclusion.trim()] }));
                        setNewExclusion('');
                      }
                    }}
                    placeholder="Add email or @domain to exclude"
                    className="flex-1 px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-300 focus:ring-1 focus:ring-indigo-200 outline-none"
                  />
                  <button
                    onClick={() => {
                      if (newExclusion.trim()) {
                        setGmailConfig((c) => ({ ...c, excludedSenders: [...(c.excludedSenders || []), newExclusion.trim()] }));
                        setNewExclusion('');
                      }
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50"
                  >Add</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(gmailConfig.excludedSenders || []).map((s, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                      {s}
                      <button
                        onClick={() => setGmailConfig((c) => ({ ...c, excludedSenders: (c.excludedSenders || []).filter((_, j) => j !== i) }))}
                        className="text-gray-400 hover:text-gray-600 ml-0.5"
                      >&times;</button>
                    </span>
                  ))}
                  {(gmailConfig.excludedSenders || []).length === 0 && <span className="text-xs text-gray-300 italic">None added yet</span>}
                </div>
              </div>

              {/* Commitment Detection */}
              <div>
                <h3 className="text-sm font-semibold text-gray-700 mb-1">Commitment Detection</h3>
                <p className="text-xs text-gray-400 mb-2">AI detects promises and commitments in your emails</p>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <div
                    className={`relative w-9 h-5 rounded-full transition-colors ${gmailConfig.commitmentDetection ? 'bg-indigo-600' : 'bg-gray-300'}`}
                    onClick={() => setGmailConfig((c) => ({ ...c, commitmentDetection: !c.commitmentDetection }))}
                  >
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${gmailConfig.commitmentDetection ? 'translate-x-4' : ''}`} />
                  </div>
                  <span className="text-sm text-gray-600">{gmailConfig.commitmentDetection ? 'On' : 'Off'}</span>
                </label>
              </div>

              {/* Save + Scan */}
              <div className="space-y-2">
                <button
                  onClick={handleSaveGmailConfig}
                  disabled={configSaving}
                  className="w-full py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {configSaving ? 'Saving...' : 'Save Configuration'}
                </button>
                <button
                  onClick={handleGmailScan}
                  disabled={!gmailStatus.connected || scanning}
                  className="w-full py-2 text-sm font-medium text-indigo-600 border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {scanning ? (
                    <>
                      <span className="w-4 h-4 border-2 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
                      Scanning...
                    </>
                  ) : 'Scan Now'}
                </button>
                {!gmailStatus.connected && (
                  <p className="text-xs text-gray-400 text-center">Connect Gmail above to enable scanning</p>
                )}
              </div>
            </div>
          )}

          {/* Entities tab (admin only) */}
          {tab === 'entities' && isAdmin && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">Manage entities, projects, and household sharing.</p>

              {/* Existing entities — hierarchical */}
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {(() => {
                  // Build hierarchy: businesses first, then their child projects, then personal
                  const businesses = entityList.filter((e) => e.type === 'business' || (!e.type && e.type !== 'personal' && e.type !== 'project'));
                  const projects = entityList.filter((e) => e.type === 'project');
                  const personals = entityList.filter((e) => e.type === 'personal');
                  const ordered = [];
                  businesses.forEach((b) => {
                    ordered.push({ ...b, _indent: 0 });
                    projects.filter((p) => p.parentId === b.id).forEach((p) => ordered.push({ ...p, _indent: 1 }));
                  });
                  // Orphan projects (no parent or parent not found)
                  projects.filter((p) => !p.parentId || !businesses.find((b) => b.id === p.parentId)).forEach((p) => ordered.push({ ...p, _indent: 0 }));
                  personals.forEach((p) => ordered.push({ ...p, _indent: 0 }));
                  return ordered;
                })().map((ent) => {
                  const style = getEntityStyle(ent.color);
                  const typeIcon = ent.type === 'personal' ? '\u{1F464}' : ent.type === 'project' ? '\u{1F4CB}' : '\u{1F3E2}';
                  const typeLabel = ent.type === 'personal' ? 'Personal' : ent.type === 'project' ? 'Project' : 'Business';
                  const isOwner = ent.isOwner !== false;

                  if (editingEntity === ent.id) {
                    return (
                      <div key={ent.id} className="flex flex-col gap-2 p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <input type="text" defaultValue={ent.name} id={`ent-name-${ent.id}`} className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded" />
                          <select defaultValue={ent.color} id={`ent-color-${ent.id}`} className="px-2 py-1 text-sm border border-gray-200 rounded">
                            {AVAILABLE_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <div className="flex items-center gap-2">
                          <select defaultValue={ent.type || 'business'} id={`ent-type-${ent.id}`} className="px-2 py-1 text-xs border border-gray-200 rounded">
                            <option value="business">Business</option>
                            <option value="project">Project</option>
                            <option value="personal">Personal</option>
                          </select>
                          <select defaultValue={ent.parentId || ''} id={`ent-parent-${ent.id}`} className="px-2 py-1 text-xs border border-gray-200 rounded">
                            <option value="">No parent</option>
                            {entityList.filter((e) => (e.type === 'business' || !e.type) && e.id !== ent.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                          </select>
                          <label className="flex items-center gap-1 text-xs text-gray-600">
                            <input type="checkbox" defaultChecked={ent.shared || false} id={`ent-shared-${ent.id}`} className="rounded" />
                            Shared
                          </label>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              const name = document.getElementById(`ent-name-${ent.id}`).value;
                              const color = document.getElementById(`ent-color-${ent.id}`).value;
                              const type = document.getElementById(`ent-type-${ent.id}`).value;
                              const parentId = document.getElementById(`ent-parent-${ent.id}`).value;
                              const shared = document.getElementById(`ent-shared-${ent.id}`).checked;
                              handleUpdateEntity(ent.id, { name, color, type, parentId: type === 'project' ? parentId : null, shared });
                            }}
                            className="px-2 py-1 text-xs bg-indigo-600 text-white rounded"
                          >Save</button>
                          <button onClick={() => setEditingEntity(null)} className="px-2 py-1 text-xs text-gray-500">Cancel</button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={ent.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-gray-100" style={{ marginLeft: ent._indent ? 20 : 0 }}>
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {ent._indent > 0 && <span className="text-gray-300 text-xs">&lsaquo;&mdash;</span>}
                        <span className={`w-3 h-3 rounded-full flex-shrink-0 ${style.dot}`} />
                        <span className="text-sm font-medium text-gray-800 truncate">{ent.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{typeIcon} {typeLabel}</span>
                        {ent.shared && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">{'\u{1F517}'} Shared</span>}
                        {!isOwner && <span className="text-[10px] text-gray-400">(read-only)</span>}
                      </div>
                      {isOwner && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button onClick={() => setEditingEntity(ent.id)} className="text-xs text-indigo-500 hover:text-indigo-700 px-1">Edit</button>
                          <button onClick={() => handleDeleteEntity(ent.id)} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Add new entity */}
              <div className="space-y-2 p-3 bg-gray-50 rounded-lg">
                <div className="flex gap-2">
                  <input type="text" value={newEntityName} onChange={(e) => setNewEntityName(e.target.value)} placeholder="New entity name" className={inputCls + ' flex-1'} />
                  <select value={newEntityColor} onChange={(e) => setNewEntityColor(e.target.value)} className="px-2 py-2 bg-white border border-gray-200 rounded-lg text-sm">
                    {AVAILABLE_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>

                {/* Type selector pills */}
                <div className="flex gap-2">
                  {[
                    { key: 'business', icon: '\u{1F3E2}', label: 'Business' },
                    { key: 'project', icon: '\u{1F4CB}', label: 'Project' },
                    { key: 'personal', icon: '\u{1F464}', label: 'Personal' },
                  ].map(({ key, icon, label }) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setNewEntityType(key)}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                        newEntityType === key
                          ? 'bg-indigo-100 text-indigo-700 border border-indigo-200'
                          : 'bg-white text-gray-500 border border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {icon} {label}
                    </button>
                  ))}
                </div>

                {/* Parent selector (only for projects) */}
                {newEntityType === 'project' && (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Belongs to</label>
                    <select value={newEntityParent} onChange={(e) => setNewEntityParent(e.target.value)} className="w-full px-2 py-2 bg-white border border-gray-200 rounded-lg text-sm">
                      <option value="">-- Select parent business --</option>
                      {entityList.filter((e) => e.type === 'business' || (!e.type && e.type !== 'personal')).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                  </div>
                )}

                {/* Shared toggle */}
                <label className="flex items-center gap-2 cursor-pointer">
                  <div className="relative">
                    <input type="checkbox" checked={newEntityShared} onChange={(e) => setNewEntityShared(e.target.checked)} className="sr-only" />
                    <div className={`w-9 h-5 rounded-full transition-colors ${newEntityShared ? 'bg-indigo-600' : 'bg-gray-300'}`} onClick={() => setNewEntityShared(!newEntityShared)}>
                      <div className={`w-4 h-4 bg-white rounded-full shadow transform transition-transform mt-0.5 ${newEntityShared ? 'translate-x-4 ml-0.5' : 'translate-x-0.5'}`} />
                    </div>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-gray-700">Share with household</span>
                    <p className="text-[10px] text-gray-400">Shared entities are visible to all users</p>
                  </div>
                </label>

                <button
                  onClick={handleCreateEntity}
                  disabled={!newEntityName.trim()}
                  className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-indigo-700 transition-colors"
                >Add Entity</button>
              </div>
            </div>
          )}

          {/* Users tab (admin only) */}
          {tab === 'users' && isAdmin && (
            <div className="space-y-3">
              <p className="text-xs text-gray-500">Manage user accounts, roles, and entity assignments.</p>

              {/* Existing users */}
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {userList.map((u) => {
                  if (editingUser === u.id) {
                    return (
                      <div key={u.id} className="p-3 bg-gray-50 rounded-lg space-y-2">
                        <div className="flex gap-2">
                          <input defaultValue={u.displayName} id={`u-dn-${u.id}`} placeholder="Display name" className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded" />
                          <input defaultValue={u.email} id={`u-em-${u.id}`} placeholder="Email" className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded" />
                        </div>
                        <div className="flex gap-2">
                          <select defaultValue={u.role} id={`u-role-${u.id}`} className="px-2 py-1 text-sm border border-gray-200 rounded">
                            <option value="admin">Admin</option>
                            <option value="member">Member</option>
                          </select>
                          <input id={`u-pw-${u.id}`} placeholder="New password (optional)" type="password" className="flex-1 px-2 py-1 text-sm border border-gray-200 rounded" />
                        </div>
                        {/* Entity checkboxes */}
                        <div className="flex flex-wrap gap-1.5">
                          {entityList.map((ent) => {
                            const style = getEntityStyle(ent.color);
                            const checked = (u.entityIds || []).includes(ent.name);
                            return (
                              <label key={ent.id} className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full border cursor-pointer ${checked ? `${style.bg} ${style.text} ${style.border}` : 'bg-gray-50 text-gray-400 border-gray-200'}`}>
                                <input type="checkbox" defaultChecked={checked} data-entity-name={ent.name} data-user-id={u.id} className="hidden" />
                                {ent.name}
                              </label>
                            );
                          })}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              const displayName = document.getElementById(`u-dn-${u.id}`).value;
                              const email = document.getElementById(`u-em-${u.id}`).value;
                              const role = document.getElementById(`u-role-${u.id}`).value;
                              const pw = document.getElementById(`u-pw-${u.id}`).value;
                              const checkboxes = document.querySelectorAll(`[data-user-id="${u.id}"]`);
                              const entityIds = [];
                              checkboxes.forEach((cb) => { if (cb.checked) entityIds.push(cb.dataset.entityName); });
                              const fields = { displayName, email, role, entityIds };
                              if (pw) fields.password = pw;
                              handleUpdateUser(u.id, fields);
                            }}
                            className="px-3 py-1 text-xs bg-indigo-600 text-white rounded"
                          >Save</button>
                          <button onClick={() => setEditingUser(null)} className="px-3 py-1 text-xs text-gray-500">Cancel</button>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={u.id} className="flex items-center justify-between px-3 py-2 rounded-lg border border-gray-100">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-800">{u.displayName || u.username}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${u.role === 'admin' ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-500'}`}>
                            {u.role}
                          </span>
                          {u.active === false && <span className="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-medium">inactive</span>}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {(u.entityIds || []).map((name) => {
                            const style = getTagStyle(name, entityList);
                            return <span key={name} className={`text-[10px] px-1.5 py-0.5 rounded-full ${style.bg} ${style.text}`}>{name}</span>;
                          })}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={() => { loadEntities(); setEditingUser(u.id); }} className="text-xs text-indigo-500 hover:text-indigo-700 px-1">Edit</button>
                        {u.id !== currentUser.id && (
                          <button onClick={() => handleDeleteUser(u.id)} className="text-xs text-red-400 hover:text-red-600 px-1">Delete</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Add new user */}
              {showAddUser ? (
                <div className="p-3 bg-indigo-50/30 rounded-lg border border-indigo-200 space-y-2">
                  <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide">New User</h4>
                  <div className="flex gap-2">
                    <input value={newUser.username} onChange={(e) => setNewUser((u) => ({ ...u, username: e.target.value }))} placeholder="Username *" className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded" />
                    <input value={newUser.displayName} onChange={(e) => setNewUser((u) => ({ ...u, displayName: e.target.value }))} placeholder="Display name" className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded" />
                  </div>
                  <div className="flex gap-2">
                    <input value={newUser.email} onChange={(e) => setNewUser((u) => ({ ...u, email: e.target.value }))} placeholder="Email" type="email" className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded" />
                    <input value={newUser.password} onChange={(e) => setNewUser((u) => ({ ...u, password: e.target.value }))} placeholder="Password *" type="password" className="flex-1 px-2 py-1.5 text-sm border border-gray-200 rounded" />
                  </div>
                  <div className="flex gap-2 items-center">
                    <select value={newUser.role} onChange={(e) => setNewUser((u) => ({ ...u, role: e.target.value }))} className="px-2 py-1.5 text-sm border border-gray-200 rounded">
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                    <span className="text-xs text-gray-400">Entities:</span>
                    {entityList.map((ent) => {
                      const style = getEntityStyle(ent.color);
                      const selected = newUser.entityIds.includes(ent.name);
                      return (
                        <button
                          key={ent.id}
                          type="button"
                          onClick={() => setNewUser((u) => ({
                            ...u,
                            entityIds: selected ? u.entityIds.filter((n) => n !== ent.name) : [...u.entityIds, ent.name],
                          }))}
                          className={`text-[10px] px-2 py-1 rounded-full border ${selected ? `${style.bg} ${style.text} ${style.border}` : 'bg-gray-50 text-gray-400 border-gray-200'}`}
                        >{ent.name}</button>
                      );
                    })}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setShowAddUser(false)} className="flex-1 px-3 py-1.5 border border-gray-200 rounded text-sm text-gray-600">Cancel</button>
                    <button onClick={handleCreateUser} disabled={!newUser.username.trim() || !newUser.password} className="flex-1 px-3 py-1.5 bg-indigo-600 text-white rounded text-sm font-medium disabled:opacity-50">Create User</button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => { loadEntities(); setShowAddUser(true); }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 border-2 border-dashed border-gray-200 rounded-xl text-gray-400 hover:border-indigo-300 hover:text-indigo-500 text-sm font-medium"
                >
                  <span className="text-base">+</span> Add user
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { AlertsModal } from './components/alerts/AlertsModal.jsx';

// ─────────────────────────────────────────────────────────────────────────────
// ADD TASK FORM
// ─────────────────────────────────────────────────────────────────────────────

function AddTaskForm({ onAdd, claudeKey, currentUser, entities, authToken, gcalConnected, forceOpen, onClose }) {
  const userEntityNames = entities.map((e) => e.name);
  const emptyForm = {
    title: '',
    description: '',
    priority: 'medium',
    dueDate: '',
    dueTime: '',
    tags: [],
    visibility: 'shared',
    syncToCalendar: false,
  };

  const [form, setForm] = useState(emptyForm);
  const [aiSuggested, setAiSuggested] = useState([]); // tags AI recommended
  const [suggesting, setSuggesting] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const debounceRef = useRef(null);

  const runSuggestion = useCallback(
    async (title, desc) => {
      if (!claudeKey || !title.trim()) return;
      setSuggesting(true);
      const suggested = await fetchSuggestedTags(title, desc, claudeKey, userEntityNames, authToken);
      setSuggesting(false);
      if (suggested.length > 0) {
        setAiSuggested(suggested);
        setForm((f) => ({
          ...f,
          tags: [...new Set([...f.tags, ...suggested])],
        }));
      }
    },
    [claudeKey, userEntityNames, authToken], // eslint-disable-line react-hooks/exhaustive-deps
  );

  function scheduleOrRunSuggestion(title, desc) {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSuggestion(title, desc), 600);
  }

  function handleTitleChange(e) {
    const val = e.target.value;
    setForm((f) => ({ ...f, title: val }));
    scheduleOrRunSuggestion(val, form.description);
  }

  function handleDescChange(e) {
    const val = e.target.value;
    setForm((f) => ({ ...f, description: val }));
    scheduleOrRunSuggestion(form.title, val);
  }

  function handleBlur() {
    clearTimeout(debounceRef.current);
    runSuggestion(form.title, form.description);
  }

  function toggleTag(tag) {
    setForm((f) => ({
      ...f,
      tags: f.tags.includes(tag)
        ? f.tags.filter((t) => t !== tag)
        : [...f.tags, tag],
    }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim()) return;
    onAdd({
      id: uid(),
      title: form.title,
      description: form.description,
      priority: form.priority,
      dueDate: form.dueDate,
      dueTime: form.dueTime || null,
      tags: form.tags,
      visibility: form.visibility,
      syncToCalendar: form.syncToCalendar,
      completed: false,
      owner: currentUser?.id || 'unknown',
      createdAt: new Date().toISOString(),
    });
    setForm(emptyForm);
    setAiSuggested([]);
    setIsOpen(false);
    onClose?.();
  }

  return (
    <div className={forceOpen ? '' : 'mb-5'}>
      {!forceOpen && !isOpen ? (
        <button
          onClick={() => setIsOpen(true)}
          className="w-full flex items-center gap-2 px-4 py-3 md:py-3 min-h-[48px] bg-white border-2 border-dashed border-gray-200 rounded-xl text-gray-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/30 transition-all text-sm font-medium group"
        >
          <span className="w-6 h-6 md:w-5 md:h-5 rounded-full bg-gray-100 group-hover:bg-indigo-100 flex items-center justify-center text-base leading-none transition-colors">
            +
          </span>
          Add new task
        </button>
      ) : (
        <div className={forceOpen ? '' : 'fixed inset-0 z-50 bg-white overflow-y-auto md:static md:inset-auto md:z-auto md:bg-transparent md:overflow-visible'}>
        <form
          onSubmit={handleSubmit}
          className="p-5 md:bg-white md:rounded-xl md:border md:border-gray-200 md:shadow-sm"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base md:text-sm font-semibold text-gray-900">New Task</h3>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setForm(emptyForm);
                setAiSuggested([]);
                onClose?.();
              }}
              className="text-gray-400 hover:text-gray-600 transition-colors min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center"
            >
              <XIcon className="w-5 h-5 md:w-4 md:h-4" />
            </button>
          </div>

          <div className="space-y-3">
            {/* Title */}
            <input
              type="text"
              placeholder="Task title *"
              value={form.title}
              onChange={handleTitleChange}
              onBlur={handleBlur}
              autoFocus
              required
              className="w-full px-3 py-2.5 md:py-2 bg-gray-50 border border-gray-200 rounded-lg text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
            />

            {/* Description */}
            <textarea
              placeholder="Description (optional) — helps AI suggest tags"
              value={form.description}
              onChange={handleDescChange}
              onBlur={handleBlur}
              rows={2}
              className="w-full px-3 py-2.5 md:py-2 bg-gray-50 border border-gray-200 rounded-lg text-base md:text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition resize-none"
            />

            {/* Priority + Due Date + Time */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Priority
                </label>
                <select
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                  className="w-full px-3 py-2.5 md:py-2 bg-gray-50 border border-gray-200 rounded-lg text-base md:text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition min-h-[44px] md:min-h-0"
                >
                  <option value="low">🟢 Low</option>
                  <option value="medium">🟡 Medium</option>
                  <option value="high">🔴 High</option>
                </select>
              </div>

              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Due Date
                </label>
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
                  className="w-full px-3 py-2.5 md:py-2 bg-gray-50 border border-gray-200 rounded-lg text-base md:text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition min-h-[44px] md:min-h-0"
                />
              </div>

              <div style={{ flex: '0 0 100px' }}>
                <label className="block text-xs font-medium text-gray-500 mb-1">
                  Time
                </label>
                <input
                  type="time"
                  value={form.dueTime}
                  onChange={(e) => setForm((f) => ({ ...f, dueTime: e.target.value }))}
                  className="w-full px-3 py-2.5 md:py-2 bg-gray-50 border border-gray-200 rounded-lg text-base md:text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition min-h-[44px] md:min-h-0"
                />
              </div>
            </div>

            {/* Tags */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-gray-500">Tags</span>
                {suggesting && (
                  <span className="text-xs text-indigo-500 flex items-center gap-1">
                    <SpinnerIcon className="w-3 h-3 animate-spin" />
                    AI suggesting…
                  </span>
                )}
                {!suggesting && aiSuggested.length > 0 && (
                  <span className="text-xs text-indigo-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 inline-block" />
                    AI auto-selected tags
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {buildGroupedEntities(entities).map((ent) => {
                  const tag = ent.name;
                  const style = getEntityStyle(ent.color);
                  const isSelected = form.tags.includes(tag);
                  const isAiPick = aiSuggested.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag(tag)}
                      className={`inline-flex items-center gap-1 text-xs px-3 py-2 md:px-2.5 md:py-1 rounded-full font-medium border transition-all min-h-[36px] md:min-h-0 ${
                        isSelected
                          ? `${style.bg} ${style.text} ${style.border} ring-2 ring-offset-1 ${style.ring}`
                          : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      {ent._indent ? '\u2514 ' : ''}{tag}{ent.shared ? ' \u{1F517}' : ''}
                      {isAiPick && isSelected && (
                        <span className="text-[9px] leading-none bg-indigo-500 text-white px-1 py-0.5 rounded-full">
                          AI
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Visibility */}
            <div>
              <span className="text-xs font-medium text-gray-500 mb-2 block">Visibility</span>
              <div className="flex gap-2">
                {[
                  { key: 'shared', label: 'Shared', desc: 'Visible to all users' },
                  { key: 'private', label: 'Private', desc: 'Only you' },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, visibility: key }))}
                    className={`flex-1 px-3 py-3 md:py-2 rounded-lg text-xs font-medium border transition-all min-h-[44px] md:min-h-0 ${
                      form.visibility === key
                        ? key === 'private'
                          ? 'bg-amber-50 text-amber-700 border-amber-300 ring-2 ring-offset-1 ring-amber-300'
                          : 'bg-indigo-50 text-indigo-700 border-indigo-300 ring-2 ring-offset-1 ring-indigo-300'
                        : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    {key === 'private' ? '🔒 ' : '👥 '}{label}
                  </button>
                ))}
              </div>
            </div>

            {/* Google Calendar sync option */}
            {gcalConnected && form.dueDate && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.syncToCalendar}
                  onChange={(e) => setForm((f) => ({ ...f, syncToCalendar: e.target.checked }))}
                  className="w-4 h-4 accent-indigo-600 rounded"
                />
                <span className="text-xs font-medium text-gray-600">📅 Add to Google Calendar</span>
              </label>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setForm(emptyForm);
                  setAiSuggested([]);
                  onClose?.();
                }}
                className="flex-1 px-4 py-3 md:py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 text-sm font-medium transition-colors min-h-[44px]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 px-4 py-3 md:py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors shadow-sm min-h-[44px]"
              >
                Add Task
              </button>
            </div>
          </div>
        </form>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK CARD
// ─────────────────────────────────────────────────────────────────────────────

function TaskCard({ task, onToggle, onDelete, onEdit, onToggleVisibility, onSyncCalendar, currentUser, gcalConnected, entities }) {
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(null);
  const overdue =
    task.dueDate && !task.completed && new Date(task.dueDate) < new Date();
  const isOwner = !task.owner || task.owner === currentUser?.id;

  async function handleSync() {
    if (!onSyncCalendar || syncing) return;
    setSyncing(true);
    await onSyncCalendar(task);
    setSyncing(false);
  }

  function openEdit() {
    setDraft({
      title: task.title,
      description: task.description || '',
      priority: task.priority,
      dueDate: task.dueDate || '',
      tags: [...(task.tags || [])],
      visibility: task.visibility || 'shared',
    });
    setEditing(true);
  }

  function handleSaveEdit(e) {
    e.preventDefault();
    if (!draft.title.trim()) return;
    onEdit(task.id, draft);
    setEditing(false);
    setDraft(null);
  }

  if (editing && draft) {
    return (
      <div className={`bg-white rounded-xl border border-gray-100 shadow-sm p-4 ${PRIORITY_BORDER[draft.priority]}`}>
        <form onSubmit={handleSaveEdit} className="space-y-3">
          <input
            type="text"
            value={draft.title}
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
            placeholder="Task title *"
            autoFocus
            required
          />
          <textarea
            value={draft.description}
            onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition resize-none"
            placeholder="Description (optional)"
            rows={2}
          />
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-500 mb-1">Priority</label>
              <select
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-500 mb-1">Due Date</label>
              <input
                type="date"
                value={draft.dueDate}
                onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Tags</label>
            <div className="flex flex-wrap gap-1.5">
              {buildGroupedEntities(entities || []).map((ent) => {
                const tag = ent.name;
                const style = getEntityStyle(ent.color);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setDraft((d) => ({
                      ...d,
                      tags: d.tags.includes(tag) ? d.tags.filter((t) => t !== tag) : [...d.tags, tag],
                    }))}
                    className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-all ${
                      draft.tags.includes(tag)
                        ? `${style.bg} ${style.text} ${style.border} ring-2 ring-offset-1 ${style.ring}`
                        : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                    }`}
                  >
                    {ent._indent ? '\u2514 ' : ''}{tag}{ent.shared ? ' \u{1F517}' : ''}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Visibility</label>
            <div className="flex gap-2">
              {['shared', 'private'].map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, visibility: v }))}
                  className={`flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-all ${
                    draft.visibility === v
                      ? v === 'private'
                        ? 'bg-amber-50 text-amber-700 border-amber-300 ring-2 ring-offset-1 ring-amber-300'
                        : 'bg-indigo-50 text-indigo-700 border-indigo-300 ring-2 ring-offset-1 ring-indigo-300'
                      : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100'
                  }`}
                >
                  {v === 'private' ? 'Private' : 'Shared'}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => { setEditing(false); setDraft(null); }}
              className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 text-sm font-medium transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors shadow-sm"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div
      className={`bg-white rounded-xl border border-gray-100 shadow-sm p-4 ${PRIORITY_BORDER[task.priority]} transition-opacity ${
        task.completed ? 'opacity-55' : 'opacity-100'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <label className="flex items-center mt-0.5 cursor-pointer min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 justify-center">
          <input
            type="checkbox"
            checked={task.completed}
            onChange={() => onToggle(task.id)}
            className="w-5 h-5 md:w-4 md:h-4 accent-indigo-600 rounded cursor-pointer"
          />
        </label>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h4
              className={`text-sm font-medium leading-snug ${
                task.completed
                  ? 'line-through text-gray-400'
                  : 'text-gray-900'
              }`}
            >
              {task.title}
            </h4>
            <div className="flex items-center gap-1 flex-shrink-0">
              {/* Edit button */}
              {isOwner && !task.completed && (
                <button
                  onClick={openEdit}
                  className="text-gray-300 hover:text-indigo-500 transition-colors min-w-[36px] min-h-[36px] md:min-w-0 md:min-h-0 flex items-center justify-center"
                  title="Edit task"
                >
                  <PencilIcon className="w-4 h-4 md:w-3.5 md:h-3.5" />
                </button>
              )}
              {/* Sync to Google Calendar */}
              {task.dueDate && gcalConnected && !task.completed && (
                <button
                  onClick={handleSync}
                  disabled={syncing}
                  className="text-[10px] px-2 py-1 md:px-1.5 md:py-0.5 rounded font-medium bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors disabled:opacity-50 min-w-[36px] min-h-[36px] md:min-w-0 md:min-h-0 flex items-center justify-center"
                  title="Sync to Google Calendar"
                >
                  {syncing ? <SpinnerIcon className="w-4 h-4 md:w-3 md:h-3 animate-spin" /> : <SyncIcon className="w-4 h-4 md:w-3 md:h-3" />}
                </button>
              )}
              {/* Visibility toggle */}
              {isOwner && (
                <button
                  onClick={() => onToggleVisibility(task.id)}
                  className={`text-[11px] md:text-[10px] px-2 py-1 md:px-1.5 md:py-0.5 rounded font-medium transition-colors min-w-[36px] min-h-[36px] md:min-w-0 md:min-h-0 flex items-center justify-center ${
                    task.visibility === 'private'
                      ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                      : 'bg-indigo-50 text-indigo-500 hover:bg-indigo-100'
                  }`}
                  title={task.visibility === 'private' ? 'Private — click to share' : 'Shared — click to make private'}
                >
                  {task.visibility === 'private' ? '🔒' : '👥'}
                </button>
              )}
              {!isOwner && (
                <span className="text-[11px] md:text-[10px] bg-gray-100 text-gray-400 px-2 py-1 md:px-1.5 md:py-0.5 rounded font-medium min-w-[36px] min-h-[36px] md:min-w-0 md:min-h-0 flex items-center justify-center">
                  👥
                </span>
              )}
              <button
                onClick={() => onDelete(task.id)}
                className="flex-shrink-0 text-gray-200 hover:text-red-400 transition-colors mt-0.5 min-w-[36px] min-h-[36px] md:min-w-0 md:min-h-0 flex items-center justify-center"
                title="Delete task"
              >
                <XIcon className="w-5 h-5 md:w-4 md:h-4" />
              </button>
            </div>
          </div>

          {task.description && (
            <p className="text-xs text-gray-500 mt-1 line-clamp-2 leading-relaxed">
              {task.description}
            </p>
          )}

          {/* Footer: tags left, meta right */}
          <div className="flex items-end justify-between gap-2 mt-2.5">
            <div className="flex flex-wrap gap-1">
              {task.tags.map((tag) => (
                <TagPill key={tag} tag={tag} entities={entities} />
              ))}
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0 ml-1">
              <span
                className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${PRIORITY_BADGE[task.priority]}`}
              >
                {task.priority}
              </span>
              {task.dueDate && (
                <span
                  className={`text-[11px] ${
                    overdue ? 'text-red-500 font-medium' : 'text-gray-400'
                  }`}
                >
                  {overdue && '⚠ '}
                  {task.dueDate}
                  {task.dueTime && (() => { const [h, m] = task.dueTime.split(':').map(Number); const ampm = h >= 12 ? 'PM' : 'AM'; const h12 = h % 12 || 12; return ` · ${h12}:${String(m).padStart(2, '0')} ${ampm}`; })()}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD PANEL
// ─────────────────────────────────────────────────────────────────────────────

function DashboardPanel({ tasks, currentUser, authToken, apiKeys, notes, onNavigate, onAIPrompt, entities, onAddTask, onQuickNote, onAddEvent, backend, onBackendChange }) {
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

// ─────────────────────────────────────────────────────────────────────────────
// NOTES PANEL
// ─────────────────────────────────────────────────────────────────────────────

const PILLAR_CONFIG = {
  hustle: { label: 'Hustle', bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-200', dot: 'bg-blue-500', emoji: '\u{1F535}' },
  home: { label: 'Home', bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200', dot: 'bg-green-500', emoji: '\u{1F7E2}' },
  move: { label: 'Move', bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200', dot: 'bg-orange-500', emoji: '\u{1F7E0}' },
  grow: { label: 'Grow', bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200', dot: 'bg-purple-500', emoji: '\u{1F7E3}' },
};

const PILLAR_KEYS = Object.keys(PILLAR_CONFIG);

// ── Tiptap Rich Text Editor Component ────────────────────────────────────────

function TiptapToolbar({ editor, onImageClick }) {
  if (!editor) return null;
  const btnBase = 'w-7 h-7 flex items-center justify-center rounded text-xs transition-colors';
  const active = 'bg-purple-600 text-white';
  const inactive = 'text-gray-600 hover:bg-gray-100';
  const btn = (isActive) => `${btnBase} ${isActive ? active : inactive}`;
  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-gray-100 flex-wrap overflow-x-auto" style={{ minHeight: 40 }}>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleBold().run()} className={btn(editor.isActive('bold'))} title="Bold (Cmd+B)"><strong>B</strong></button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleItalic().run()} className={btn(editor.isActive('italic'))} title="Italic (Cmd+I)"><em>I</em></button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleUnderline().run()} className={btn(editor.isActive('underline'))} title="Underline (Cmd+U)"><span style={{ textDecoration: 'underline' }}>U</span></button>
      <div className="w-px h-5 bg-gray-200 mx-0.5" />
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={btn(editor.isActive('heading', { level: 1 }))} title="Heading 1">H1</button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={btn(editor.isActive('heading', { level: 2 }))} title="Heading 2">H2</button>
      <div className="w-px h-5 bg-gray-200 mx-0.5" />
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleBulletList().run()} className={btn(editor.isActive('bulletList'))} title="Bullet list">•</button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btn(editor.isActive('orderedList'))} title="Ordered list">1.</button>
      <div className="w-px h-5 bg-gray-200 mx-0.5" />
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleBlockquote().run()} className={btn(editor.isActive('blockquote'))} title="Quote">"</button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={btn(editor.isActive('codeBlock'))} title="Code block">&lt;/&gt;</button>
      <button type="button" tabIndex={-1} onClick={() => editor.chain().focus().setHorizontalRule().run()} className={`${btnBase} ${inactive}`} title="Divider">—</button>
      {onImageClick && (
        <>
          <div className="w-px h-5 bg-gray-200 mx-0.5" />
          <button type="button" tabIndex={-1} onClick={onImageClick} className={`${btnBase} ${inactive}`} title="Add image">📷</button>
        </>
      )}
    </div>
  );
}

function useNoteEditor({ content, onUpdate }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2] } }),
      TiptapImage.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({ placeholder: 'Start writing...' }),
    ],
    content: content || '',
    editorProps: {
      attributes: {
        class: 'tiptap-editor outline-none',
        style: 'min-height:300px;padding:16px;font-size:15px;line-height:1.7',
      },
      handleKeyDown: (view, event) => {
        console.log('Tiptap keydown:', event.key, 'editable:', view.editable, 'hasFocus:', view.hasFocus());
        return false; // never block
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (onUpdate) onUpdate(ed.getHTML());
    },
  });
  return editor;
}

// Strips HTML tags for plain-text display/search
function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// Highlights matching text in search results
function highlightMatch(text, query) {
  if (!query) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? <strong key={i} className="text-purple-700 bg-purple-50">{part}</strong> : part
  );
}

// Wraps plain text in <p> tags if it doesn't contain HTML
function ensureHtml(content) {
  if (!content) return '';
  if (content.includes('<') && content.includes('>')) return content;
  return content.split('\n').map((line) => `<p>${line || '<br>'}</p>`).join('');
}

// ── Image Lightbox Component ─────────────────────────────────────────────────

function ImageLightbox({ images, startIndex, onClose, onDelete }) {
  const [idx, setIdx] = useState(startIndex || 0);
  const img = images[idx];
  if (!img) return null;
  return (
    <div className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center" onClick={onClose}>
      <div className="relative max-w-[90vw] max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
        <img src={img.url} alt={img.originalName || 'image'} className="max-w-full max-h-[85vh] object-contain rounded-lg" />
        <button type="button" tabIndex={-1} onClick={onClose} className="absolute top-2 right-2 w-8 h-8 bg-black/60 text-white rounded-full flex items-center justify-center hover:bg-black/80">✕</button>
        {images.length > 1 && (
          <>
            <button type="button" tabIndex={-1} onClick={() => setIdx((idx - 1 + images.length) % images.length)} className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/60 text-white rounded-full flex items-center justify-center hover:bg-black/80 text-lg">←</button>
            <button type="button" tabIndex={-1} onClick={() => setIdx((idx + 1) % images.length)} className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-black/60 text-white rounded-full flex items-center justify-center hover:bg-black/80 text-lg">→</button>
          </>
        )}
        {onDelete && (
          <button type="button" tabIndex={-1} onClick={() => onDelete(img.id)} className="absolute bottom-3 right-3 px-3 py-1.5 bg-red-600 text-white text-xs rounded-lg hover:bg-red-700 flex items-center gap-1">🗑️ Delete</button>
        )}
      </div>
    </div>
  );
}

// ── Note Image Gallery Strip ─────────────────────────────────────────────────

function NoteImageGallery({ noteId, authToken, images, setImages, onAddClick }) {
  const [lightboxIdx, setLightboxIdx] = useState(null);
  const [uploading, setUploading] = useState(false);

  async function handleDelete(imageId) {
    try {
      await apiFetch(`/api/notes/${noteId}/images/${imageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setImages((prev) => prev.filter((img) => img.id !== imageId));
      setLightboxIdx(null);
    } catch {}
  }

  if (!images.length) return null;

  return (
    <div className="border-t border-gray-100 pt-3 mt-3">
      <div className="text-xs text-gray-400 font-medium mb-2 flex items-center gap-1.5">
        📷 Attachments ({images.length})
      </div>
      <div className="flex gap-2 flex-wrap">
        {images.map((img, i) => (
          <div key={img.id} className="relative group cursor-pointer" onClick={() => setLightboxIdx(i)}>
            <img src={img.url} alt={img.originalName || 'attachment'} className="w-20 h-20 object-cover rounded-lg border border-gray-200" style={{ minWidth: 80 }} />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 rounded-lg flex items-center justify-center transition-opacity">
              <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); handleDelete(img.id); }} className="text-white text-sm">🗑️</button>
            </div>
          </div>
        ))}
        {onAddClick && (
          <button type="button" tabIndex={-1} onClick={onAddClick} className="w-20 h-20 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 hover:border-purple-400 hover:text-purple-500 transition-colors text-2xl" title="Add image">+</button>
        )}
      </div>
      {lightboxIdx !== null && (
        <ImageLightbox images={images} startIndex={lightboxIdx} onClose={() => setLightboxIdx(null)} onDelete={handleDelete} />
      )}
    </div>
  );
}

// Map active views to default pillar pre-selection
const VIEW_TO_PILLAR = {
  daily: 'hustle',
  priority: 'hustle',
};

// ─────────────────────────────────────────────────────────────────────────────
// Create Event Modal
// ─────────────────────────────────────────────────────────────────────────────

function CreateEventModal({ currentUser, onClose, onCreated, addToast }) {
  const todayStr = new Date().toLocaleDateString('en-CA');
  const [form, setForm] = useState({ title: '', date: todayStr, startTime: '09:00', endTime: '10:00', description: '', syncToGcal: true });
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.date) return;
    setSaving(true);
    try {
      if (form.syncToGcal) {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const body = {
          userId: currentUser.id,
          summary: form.title,
          description: form.description,
        };
        if (form.startTime) {
          body.start = { dateTime: `${form.date}T${form.startTime}:00`, timeZone: tz };
          body.end = { dateTime: `${form.date}T${form.endTime || form.startTime}:00`, timeZone: tz };
        } else {
          body.allDay = true;
          body.start = { date: form.date };
          body.end = { date: form.date };
        }
        const res = await apiFetch(`${API_BASE}/api/calendar/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create event');
        if (addToast) addToast({ type: 'success', message: 'Event added to Google Calendar \u2713' });
      }
      if (onCreated) onCreated();
      onClose();
    } catch (err) {
      if (addToast) addToast({ type: 'error', message: `Failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <h3 className="text-base font-semibold text-gray-900">New Event</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><XIcon className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="px-5 pb-5 space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Title *</label>
            <input type="text" required autoFocus value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-500 mb-1">Date *</label>
              <input type="date" required value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
            <div style={{ flex: '0 0 100px' }}>
              <label className="block text-xs font-medium text-gray-500 mb-1">Time</label>
              <input type="time" value={form.startTime} onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </div>
          </div>
          <div style={{ flex: '0 0 100px' }}>
            <label className="block text-xs font-medium text-gray-500 mb-1">End Time (optional)</label>
            <input type="time" value={form.endTime} onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" style={{ width: 120 }} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Description (optional)</label>
            <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} rows={2}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.syncToGcal} onChange={(e) => setForm((f) => ({ ...f, syncToGcal: e.target.checked }))}
              className="w-4 h-4 accent-indigo-600 rounded" />
            <span className="text-xs font-medium text-gray-600">{'\uD83D\uDCC5'} Add to Google Calendar</span>
          </label>
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 text-sm font-medium">Cancel</button>
            <button type="submit" disabled={saving} className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50">
              {saving ? 'Creating...' : 'Create Event'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Quick Capture FAB + Modal
// ─────────────────────────────────────────────────────────────────────────────

function QuickCaptureModal({ authToken, categories, activeView, onClose, onSaved, addToast }) {
  const textareaRef = useRef(null);
  const [content, setContent] = useState('');
  const [pillar, setPillar] = useState(() => {
    // Smart default: tab-based or last-used
    const viewDefault = VIEW_TO_PILLAR[activeView];
    if (activeView === 'notes' || !viewDefault) {
      return localStorage.getItem('qc_lastPillar') || '';
    }
    return viewDefault;
  });
  const [category, setCategory] = useState('');

  // Auto-focus textarea on mount
  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  // Escape to close
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && content.trim()) handleSave();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [content, pillar, category]); // eslint-disable-line react-hooks/exhaustive-deps

  // Filter categories by selected pillar
  const pillarCategories = useMemo(() => {
    if (!pillar) return [];
    return categories.filter((c) => c.pillar === pillar && !c.parentId);
  }, [pillar, categories]);

  // Reset category when pillar changes
  useEffect(() => { setCategory(''); }, [pillar]);

  // Auto-grow textarea
  function handleTextChange(e) {
    setContent(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 256) + 'px';
  }

  function handleSave() {
    if (!content.trim()) return;

    // Remember pillar choice
    if (pillar) localStorage.setItem('qc_lastPillar', pillar);
    else localStorage.removeItem('qc_lastPillar');

    // Close immediately (optimistic)
    onClose();

    // Toast with pillar badge
    const pillarLabel = pillar ? PILLAR_CONFIG[pillar]?.label : '';
    addToast({
      type: 'success',
      message: pillarLabel ? `Captured \u00b7 ${pillarLabel}` : 'Captured',
    });

    // POST in background
    const body = { title: null, content: content.trim(), type: 'quick', pillar: pillar || null, category: category || null };
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };
    apiFetch('/api/notes', { method: 'POST', headers, body: JSON.stringify(body) })
      .then((res) => {
        if (!res.ok) throw new Error('save failed');
        return res.json();
      })
      .then((saved) => { if (onSaved) onSaved(saved); })
      .catch(() => {
        addToast({ type: 'error', message: 'Failed to save \u2014 tap to retry' });
      });
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" style={{ animation: 'qcFadeIn 150ms ease-out' }} />

      {/* Modal */}
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-[480px] overflow-hidden"
        style={{ animation: 'qcSlideUp 150ms ease-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 pt-4 pb-2">
          <h3 className="text-sm font-medium text-gray-400 tracking-wide uppercase">Quick Capture</h3>
        </div>

        {/* Textarea */}
        <div className="px-5">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleTextChange}
            placeholder="What's on your mind?"
            rows={3}
            className="w-full resize-none border-0 focus:ring-0 text-gray-900 placeholder-gray-400 text-[15px] leading-relaxed p-0 outline-none"
            style={{ minHeight: '4.5rem', maxHeight: '16rem' }}
          />
        </div>

        {/* Pillar pills */}
        <div className="px-5 py-3 flex gap-2 flex-wrap">
          {PILLAR_KEYS.map((key) => {
            const cfg = PILLAR_CONFIG[key];
            const selected = pillar === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setPillar(selected ? '' : key)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  selected
                    ? `${cfg.bg} ${cfg.text} ${cfg.border} border`
                    : 'bg-gray-50 text-gray-500 border border-gray-200 hover:border-gray-300'
                }`}
              >
                {cfg.emoji} {cfg.label}
              </button>
            );
          })}
        </div>

        {/* Category dropdown (only if pillar selected and categories exist) */}
        {pillar && pillarCategories.length > 0 && (
          <div className="px-5 pb-3">
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 text-gray-700 focus:ring-2 focus:ring-purple-300 focus:border-purple-300 bg-gray-50"
            >
              <option value="">No category</option>
              {pillarCategories.map((c) => (
                <option key={c.id} value={c.name}>{c.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
          <span className="text-xs text-gray-400">{content.length} chars</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!content.trim()}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ backgroundColor: content.trim() ? '#7C3AED' : '#a78bfa' }}
            >
              Save
            </button>
          </div>
        </div>
      </div>

      {/* Animations */}
      <style>{`
        @keyframes qcFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes qcSlideUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}

function QuickCaptureFAB({ authToken, categories, activeView, hideFAB, addToast, onNoteSaved, chatPanelOpen, onToggleChat }) {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <QuickCaptureModal
        authToken={authToken}
        categories={categories}
        activeView={activeView}
        onClose={() => setOpen(false)}
        onSaved={onNoteSaved}
        addToast={addToast}
      />
    );
  }

  if (hideFAB) return null;

  const fabRight = 24;
  const bottomBase = window.innerWidth < 768 ? 80 : 24;

  return (
    <>
      {/* Chat FAB (top) */}
      <button
        onClick={onToggleChat}
        className="fixed z-50 flex items-center justify-center rounded-full shadow-lg transition-all duration-150 hover:scale-105 active:scale-95"
        style={{
          width: 56,
          height: 56,
          bottom: bottomBase + 48 + 12, // above note FAB + spacing
          right: fabRight,
          backgroundColor: chatPanelOpen ? '#6366F1' : '#7C3AED',
        }}
        title={chatPanelOpen ? 'Hide chat' : 'Open chat'}
      >
        {chatPanelOpen ? (
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
          </svg>
        )}
      </button>
      {/* Quick Note FAB (bottom) */}
      <button
        onClick={() => setOpen(true)}
        className="fixed z-50 flex items-center justify-center rounded-full shadow-lg transition-all duration-150 hover:scale-105 active:scale-95"
        style={{
          width: 48,
          height: 48,
          bottom: bottomBase,
          right: fabRight,
          backgroundColor: '#7C3AED',
        }}
        aria-label="Quick Capture"
        title="Quick capture"
      >
        <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      </button>
    </>
  );
}

function relativeTime(dateStr) {
  const now = new Date();
  const d = new Date(dateStr);
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

function NotesPanel({ authToken, onEditorStateChange, onCategoriesLoaded, onNotesLoaded, quickCapturedNote, addToast, entities = [] }) {
  const [notes, setNotes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pillarFilter, setPillarFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [selectedNote, setSelectedNote] = useState(null);
  const [editorData, setEditorData] = useState({ title: '', content: '', pillar: '', category: '', subcategory: '', tags: '', entityId: '' });
  const [saveStatus, setSaveStatus] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState(null); // { pillar, category, confidence, reason }
  const [noteImages, setNoteImages] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const suggestTimerRef = useRef(null);
  const saveTimerRef = useRef(null);
  const searchTimerRef = useRef(null);
  const fileInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };

  const loadNotes = useCallback(async () => {
    const params = new URLSearchParams();
    if (pillarFilter) params.set('entityId', pillarFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    try {
      const res = await apiFetch(`/api/notes?${params}`, { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (Array.isArray(data)) setNotes(data.filter((n) => n.type !== 'digest'));
    } catch {}
  }, [authToken, pillarFilter, categoryFilter]);

  const loadCategories = useCallback(async () => {
    try {
      const res = await apiFetch('/api/notes/categories', { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (Array.isArray(data)) setCategories(data);
    } catch {}
  }, [authToken]);

  useEffect(() => {
    Promise.all([loadNotes(), loadCategories()]).then(() => setLoading(false));
  }, [loadNotes, loadCategories]);

  // Report editor state to parent (for FAB visibility)
  useEffect(() => {
    if (onEditorStateChange) onEditorStateChange(selectedNote !== null);
  }, [selectedNote, onEditorStateChange]);

  // Forward categories to parent (for quick capture modal)
  useEffect(() => {
    if (onCategoriesLoaded) onCategoriesLoaded(categories);
  }, [categories, onCategoriesLoaded]);

  // Forward notes to parent (for chat context)
  useEffect(() => {
    if (onNotesLoaded) onNotesLoaded(notes);
  }, [notes, onNotesLoaded]);

  // Prepend quick-captured note if received from FAB
  useEffect(() => {
    if (quickCapturedNote) setNotes((prev) => [quickCapturedNote, ...prev]);
  }, [quickCapturedNote]);

  // ── Tiptap editor ──
  const tiptapEditor = useNoteEditor({
    content: ensureHtml(editorData.content),
    onUpdate: (html) => {
      handleEditorChange('content', html);
    },
  });

  // ── Sync editor content & focus when note changes ──
  const pendingContentRef = useRef(null);
  useEffect(() => {
    if (!tiptapEditor || !selectedNote) return;
    let cancelled = false;

    function applyContentAndFocus() {
      if (cancelled) return;
      const dom = tiptapEditor.view?.dom;
      // Wait until the editor's contenteditable is actually in the document
      if (!dom || !dom.isConnected) {
        requestAnimationFrame(applyContentAndFocus);
        return;
      }
      // Set content from pendingContentRef (set by openNote / handleNewNote)
      const html = pendingContentRef.current;
      if (html !== null) {
        pendingContentRef.current = null;
        tiptapEditor.commands.setContent(html);
      }
      // Focus the contenteditable directly, then set cursor position
      dom.focus({ preventScroll: true });
      tiptapEditor.commands.focus('end');
      console.log('Editor focus result:', tiptapEditor.isFocused, document.activeElement?.tagName, document.activeElement?.contentEditable);
    }
    requestAnimationFrame(applyContentAndFocus);

    return () => { cancelled = true; };
  }, [selectedNote?.id, tiptapEditor]);

  // ── Load images when note changes ──
  useEffect(() => {
    if (!selectedNote?.id) { setNoteImages([]); return; }
    apiFetch(`/api/notes/${selectedNote.id}/images`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setNoteImages(data); })
      .catch(() => setNoteImages([]));
  }, [selectedNote?.id, authToken]);

  // ── Image upload handler ──
  async function uploadImages(files) {
    if (!selectedNote?.id || !files?.length) return;
    for (const file of files) {
      if (file.size > 10 * 1024 * 1024) { if (addToast) addToast({ type: 'error', message: `${file.name} exceeds 10MB limit` }); continue; }
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) { if (addToast) addToast({ type: 'error', message: `${file.name}: unsupported format` }); continue; }
      const formData = new FormData();
      formData.append('image', file);
      try {
        const res = await apiFetch(`/api/notes/${selectedNote.id}/images`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${authToken}` },
          body: formData,
        });
        const img = await res.json();
        if (img.id) setNoteImages((prev) => [...prev, img]);
      } catch { if (addToast) addToast({ type: 'error', message: `Failed to upload ${file.name}` }); }
    }
  }

  // ── Drag & drop handlers for editor area ──
  function handleDragOver(e) { e.preventDefault(); setDragOver(true); }
  function handleDragLeave(e) { e.preventDefault(); setDragOver(false); }
  function handleDrop(e) {
    e.preventDefault(); setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length) uploadImages(files);
  }

  // ── Paste handler for images ──
  function handlePaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageFiles = items.filter((i) => i.type.startsWith('image/')).map((i) => i.getAsFile()).filter(Boolean);
    if (imageFiles.length) uploadImages(imageFiles);
  }

  // ── Search ──
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) { setSearchResults(null); return; }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/notes/search?q=${encodeURIComponent(searchQuery)}`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        const data = await res.json();
        setSearchResults(Array.isArray(data) ? data : []);
      } catch { setSearchResults([]); }
    }, 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery, authToken]);

  // ── Cmd+F shortcut for search ──
  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Escape' && searchQuery) {
        setSearchQuery('');
        setSearchResults(null);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchQuery]);

  // Build category tree
  const parentCategories = useMemo(() => categories.filter((c) => !c.parentId), [categories]);
  const childCategories = useMemo(() => categories.filter((c) => c.parentId), [categories]);

  function getSubcategories(parentName, pillar) {
    const parent = parentCategories.find((p) => p.pillar === pillar);
    if (!parent) return [];
    return childCategories.filter((c) => c.parentId === parent.id);
  }


  function handleNewNote() {
    const tempNote = {
      id: null, title: '', content: '', type: 'structured',
      pillar: pillarFilter || null, category: '', subcategory: '',
      tags: [], pinned: false, archived: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    setSelectedNote(tempNote);
    setEditorData({ title: '', content: '', pillar: pillarFilter || '', category: '', subcategory: '', tags: '', entityId: '' });
    setSaveStatus('new');
    setShowDeleteConfirm(false);
    setNoteImages([]);
    pendingContentRef.current = '';
  }

  function openNote(note) {
    const htmlContent = ensureHtml(note.content || '');
    pendingContentRef.current = htmlContent;
    setSelectedNote(note);
    setEditorData({
      title: note.title || '',
      content: note.content || '',
      pillar: note.pillar || '',
      category: note.category || '',
      subcategory: note.subcategory || '',
      tags: (note.tags || []).join(', '),
      entityId: note.entityId || '',
    });
    setSaveStatus('saved');
    setShowDeleteConfirm(false);
    setAiSuggestion(null);
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
  }

  function handleEditorChange(field, value) {
    setEditorData((prev) => ({ ...prev, [field]: value }));
    setSaveStatus('saving...');
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveNote({ ...editorData, [field]: value });
    }, 2000);
  }

  async function saveNote(data) {
    if (!selectedNote) return;
    const body = {
      title: data.title,
      content: data.content,
      pillar: data.pillar || null,
      category: data.category,
      subcategory: data.subcategory,
      tags: data.tags ? data.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      entityId: data.entityId || null,
    };
    try {
      if (!selectedNote.id) {
        // New note — POST to create
        body.type = 'structured';
        const res = await apiFetch('/api/notes', { method: 'POST', headers, body: JSON.stringify(body) });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setSaveStatus(`Save failed — ${err.error || res.statusText}`);
          return;
        }
        const created = await res.json();
        setSelectedNote(created);
        setNotes((prev) => [created, ...prev]);
        setSaveStatus('saved');
        // Schedule AI pillar suggestion
        if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
        suggestTimerRef.current = setTimeout(() => requestPillarSuggestion(created.id, data.content, data.pillar), 2000);
      } else {
        // Existing note — PUT to update
        const res = await apiFetch(`/api/notes/${selectedNote.id}`, { method: 'PUT', headers, body: JSON.stringify(body) });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          setSaveStatus(`Save failed — ${err.error || res.statusText}`);
          return;
        }
        const updated = await res.json();
        setSelectedNote(updated);
        setNotes((prev) => prev.map((n) => n.id === updated.id ? updated : n));
        setSaveStatus('saved');
        // Schedule AI pillar suggestion
        if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
        suggestTimerRef.current = setTimeout(() => requestPillarSuggestion(updated.id, data.content, data.pillar), 2000);
      }
    } catch (e) { setSaveStatus(`Save failed — ${e.message || 'network error'}`); }
  }

  // AI pillar suggestion — called 2s after save completes
  async function requestPillarSuggestion(noteId, content, currentPillar) {
    // Only suggest if no pillar manually set and 10+ words
    if (currentPillar || !content || content.trim().split(/\s+/).length < 10) return;
    try {
      const res = await apiFetch(`/api/notes/${noteId}/suggest-pillar`, {
        method: 'POST', headers,
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!data.pillar || data.confidence < 0.5) return;
      if (data.confidence > 0.85) {
        // Auto-apply silently
        await apiFetch(`/api/notes/${noteId}`, {
          method: 'PUT', headers,
          body: JSON.stringify({ pillar: data.pillar, category: data.category }),
        });
        setSelectedNote((prev) => prev && prev.id === noteId ? { ...prev, pillar: data.pillar, category: data.category } : prev);
        setEditorData((prev) => ({ ...prev, pillar: data.pillar, category: data.category || prev.category }));
        setNotes((prev) => prev.map((n) => n.id === noteId ? { ...n, pillar: data.pillar, category: data.category } : n));
        if (addToast) addToast({ type: 'success', message: `✨ Aria tagged this as ${data.category || PILLAR_CONFIG[data.pillar]?.label || data.pillar}` });
      } else {
        // Show suggestion pill
        setAiSuggestion({ pillar: data.pillar, category: data.category, confidence: data.confidence, reason: data.reason, noteId });
      }
    } catch {}
  }

  function applyAiSuggestion() {
    if (!aiSuggestion || !selectedNote) return;
    const { pillar, category, noteId } = aiSuggestion;
    apiFetch(`/api/notes/${noteId}`, { method: 'PUT', headers, body: JSON.stringify({ pillar, category }) }).catch(() => {});
    setEditorData((prev) => ({ ...prev, pillar, category: category || prev.category }));
    setSelectedNote((prev) => prev && prev.id === noteId ? { ...prev, pillar, category } : prev);
    setNotes((prev) => prev.map((n) => n.id === noteId ? { ...n, pillar, category } : n));
    setAiSuggestion(null);
    if (addToast) addToast({ type: 'success', message: `✨ Tagged as ${category || PILLAR_CONFIG[pillar]?.label || pillar}` });
  }

  async function handlePin() {
    if (!selectedNote || !selectedNote.id) return;
    try {
      const res = await apiFetch(`/api/notes/${selectedNote.id}/pin`, { method: 'PUT', headers });
      const updated = await res.json();
      if (updated.id) {
        setSelectedNote(updated);
        setNotes((prev) => prev.map((n) => n.id === updated.id ? updated : n));
      }
    } catch {}
  }

  async function handleDelete(noteId) {
    const id = noteId || selectedNote?.id;
    if (!id) {
      // Unsaved new note — just discard
      setSelectedNote(null);
      setShowDeleteConfirm(false);
      return;
    }
    try {
      await apiFetch(`/api/notes/${id}`, { method: 'DELETE', headers });
      setNotes((prev) => prev.filter((n) => n.id !== id));
      if (selectedNote?.id === id) setSelectedNote(null);
      setShowDeleteConfirm(false);
    } catch {}
  }

  function closeEditor() {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      // Only save if there's actual content
      if (selectedNote && (editorData.title || editorData.content)) {
        saveNote(editorData);
      }
    }
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    setAiSuggestion(null);
    setSelectedNote(null);
  }

  // Filtered subcategories based on selected pillar in editor
  const editorSubcats = useMemo(() => {
    if (!editorData.pillar) return [];
    return getSubcategories(editorData.pillar, editorData.pillar);
  }, [editorData.pillar, categories]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Date grouping helper (must be before useMemo) ──
  function getDateGroup(dateStr) {
    const now = new Date();
    const d = new Date(dateStr);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 7);
    if (d >= today) return 'Today';
    if (d >= yesterday) return 'Yesterday';
    if (d >= weekAgo) return 'This Week';
    return 'Earlier';
  }

  const displayNotes = (searchResults !== null ? searchResults : notes).filter((n) => !pillarFilter || n.entityId === pillarFilter);

  // Group notes by date — must be called unconditionally (before any early return)
  const groupedNotes = useMemo(() => {
    const groups = {};
    const order = ['Today', 'Yesterday', 'This Week', 'Earlier'];
    displayNotes.forEach((note) => {
      const group = getDateGroup(note.updatedAt || note.createdAt);
      if (!groups[group]) groups[group] = [];
      groups[group].push(note);
    });
    return order.filter((g) => groups[g]?.length).map((g) => ({ label: g, notes: groups[g] }));
  }, [displayNotes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <SpinnerIcon className="w-6 h-6 text-indigo-400 animate-spin" />
      </div>
    );
  }

  // ── Editor view (mobile replaces list, desktop is right panel) ──
  const editorPanel = selectedNote && (
    <div className="flex-1 flex flex-col overflow-hidden bg-white">
      {/* Editor header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <button onClick={closeEditor} className="text-sm text-gray-500 hover:text-gray-700 md:hidden">← Back</button>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-0.5 rounded ${saveStatus === 'saved' ? 'bg-green-50 text-green-600' : saveStatus.startsWith('Save failed') ? 'bg-red-50 text-red-600' : saveStatus === 'new' ? 'bg-blue-50 text-blue-600' : 'bg-yellow-50 text-yellow-600'}`}>
            {saveStatus === 'saved' ? '✓ Saved' : saveStatus.startsWith('Save failed') ? saveStatus : saveStatus === 'new' ? 'New note' : '⏳ Saving...'}
          </span>
          <button onClick={handlePin} className={`p-1.5 rounded hover:bg-gray-100 ${selectedNote.pinned ? 'text-amber-500' : 'text-gray-400'}`} title={selectedNote.pinned ? 'Unpin' : 'Pin'}>📌</button>
        </div>
      </div>

      {/* Tiptap toolbar */}
      <TiptapToolbar editor={tiptapEditor} onImageClick={selectedNote?.id ? () => fileInputRef.current?.click() : undefined} />
      {/* Hidden file input for image uploads */}
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple style={{ display: 'none' }} onChange={(e) => { uploadImages(Array.from(e.target.files)); e.target.value = ''; }} />

      {/* Editor body */}
      <div
        className={`flex-1 overflow-y-auto px-4 py-3 space-y-3 relative ${dragOver ? 'ring-2 ring-purple-400 ring-inset' : ''}`}
        onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onPaste={handlePaste}
      >
        {dragOver && (
          <div className="absolute inset-0 bg-purple-50/80 z-10 flex items-center justify-center rounded-lg pointer-events-none">
            <span className="text-purple-600 font-medium text-sm">Drop image here</span>
          </div>
        )}
        <input
          type="text" value={editorData.title}
          onChange={(e) => handleEditorChange('title', e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              tiptapEditor?.commands?.focus('start');
            }
          }}
          placeholder="Title (optional)"
          className="w-full text-lg font-semibold bg-transparent border-0 outline-none placeholder-gray-300"
        />
        {/* Entity picker */}
        <div className="flex gap-2 flex-wrap pb-1">
          <button type="button"
            onClick={() => handleEditorChange('entityId', '')}
            className={`px-3 py-1 rounded-full text-[11px] font-bold transition-colors ${!editorData.entityId ? 'bg-primary text-on-primary' : 'bg-surface-variant text-on-surface-variant hover:bg-surface-variant/70'}`}>
            None
          </button>
          {(entities || []).map((ent) => (
            <button type="button" key={ent.id}
              onClick={() => handleEditorChange('entityId', editorData.entityId === ent.id ? '' : ent.id)}
              className={`px-3 py-1 rounded-full text-[11px] font-bold transition-colors ${editorData.entityId === ent.id ? 'bg-primary text-on-primary' : 'bg-surface-variant text-on-surface-variant hover:bg-surface-variant/70'}`}>
              {ent.name}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, cursor: 'text', minHeight: '100%' }} onClick={() => tiptapEditor?.commands?.focus()}>
          <EditorContent editor={tiptapEditor} />
        </div>

        {/* Image gallery strip */}
        {selectedNote?.id && (
          <NoteImageGallery
            noteId={selectedNote.id}
            authToken={authToken}
            images={noteImages}
            setImages={setNoteImages}
            onAddClick={() => fileInputRef.current?.click()}
          />
        )}

      </div>
    </div>
  );

  // ── Main layout ──
  return (
    <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
      {/* Left sidebar — notes list */}
      <div className={`w-full md:w-96 flex-shrink-0 flex flex-col bg-surface-container-low ${selectedNote ? 'hidden md:flex' : 'flex'}`}>
        {/* Library header */}
        <div className="px-6 pt-6 pb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold font-headline tracking-tight text-on-background">Library</h2>
          <span className="text-xs font-bold text-on-surface-variant uppercase tracking-widest">{notes.length} Notes</span>
        </div>
        {/* Search bar */}
        <div className="px-6 pb-4">
          <div className="relative">
            <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline text-lg">search</span>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes..."
              className="w-full bg-surface-container-lowest rounded-xl py-3 pl-11 pr-4 border-none text-sm focus:ring-2 focus:ring-primary/10 text-on-background placeholder:text-outline"
            />
            {searchQuery && (
              <button type="button" onClick={() => { setSearchQuery(''); setSearchResults(null); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-background text-xs">✕</button>
            )}
          </div>
          {searchResults !== null && (
            <div className="text-[10px] text-on-surface-variant mt-1 px-1">{searchResults.length} note{searchResults.length !== 1 ? 's' : ''} found</div>
          )}
        </div>



        {/* Entity filter pills */}
        <div className="px-6 pb-4 flex gap-2 flex-wrap">
          <button type="button" onClick={() => { setPillarFilter(''); setCategoryFilter(''); }}
            className={`px-4 py-2 rounded-full text-xs font-bold transition-colors ${!pillarFilter ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-variant/50'}`}>
            All
          </button>
          {(entities || []).map((ent) => (
            <button type="button" key={ent.id} onClick={() => { setPillarFilter(pillarFilter === ent.id ? '' : ent.id); setCategoryFilter(''); }}
              className={`px-4 py-2 rounded-full text-xs font-bold transition-colors ${pillarFilter === ent.id ? 'bg-primary text-on-primary' : 'bg-surface-container-lowest text-on-surface-variant hover:bg-surface-variant/50'}`}>
              {ent.name}
            </button>
          ))}
        </div>

        {/* New Note button — above list */}
        <div className="px-6 pb-4 flex-shrink-0">
          <button type="button" onClick={handleNewNote}
            className="w-full bg-gradient-to-br from-primary to-primary-container text-on-primary py-3 rounded-xl font-bold flex items-center justify-center gap-2 shadow-[0px_10px_30px_rgba(79,77,207,0.2)] hover:scale-[1.02] active:scale-[0.98] transition-all text-sm">
            <span className="material-symbols-outlined text-lg">add</span>
            New Note
          </button>
        </div>
        {/* Notes list grouped by date */}
        <div className="flex-1 overflow-y-auto">
          {searchResults !== null && displayNotes.length === 0 ? (
            <div className="flex flex-col items-center text-gray-400 py-10 px-3">
              <p className="text-sm text-gray-500 mb-2">No notes found for '{searchQuery}'</p>
              <button type="button" onClick={() => { setSearchQuery(''); setSearchResults(null); }} className="text-xs text-purple-600 hover:underline">Clear search</button>
            </div>
          ) : displayNotes.length === 0 ? (
            <div className="flex flex-col items-center text-gray-400 py-10 px-3">
              <p className="text-sm text-gray-500 mb-1">No notes yet</p>
              <button type="button" onClick={handleNewNote}
                className="mt-2 px-4 py-1.5 bg-purple-600 text-white text-xs font-medium rounded-lg hover:bg-purple-700 transition-colors">
                + Create your first note
              </button>
            </div>
          ) : (
            groupedNotes.map(({ label, notes: groupNotes }) => (
              <div key={label}>
                <div className="px-3 pt-3 pb-1">
                  <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">{label}</span>
                </div>
                {groupNotes.map((note) => {
                  const plainContent = stripHtml(note.content || '');
                  const titleText = note.title || plainContent.slice(0, 30) || 'Untitled';
                  const isActive = selectedNote?.id === note.id || (selectedNote && !selectedNote.id && !note.id);
                  const pillarCfg = note.pillar && PILLAR_CONFIG[note.pillar];
                  // Build meta line: "Hustle · Careific · 2 min ago"
                  const metaParts = [];
                  if (pillarCfg) metaParts.push(pillarCfg.label);
                  if (note.category) metaParts.push(note.category);
                  metaParts.push(relativeTime(note.updatedAt || note.createdAt));
                  return (
                    <button type="button" key={note.id || 'new'} onClick={() => openNote(note)}
                      className={`group w-full text-left px-6 py-1.5 transition-all hover:translate-x-1`}
                    >
                      <div className={`bg-surface-container-lowest p-5 rounded-xl border-l-4 shadow-[0px_4px_12px_rgba(0,0,0,0.02)] transition-all ${isActive ? 'border-primary shadow-[0px_4px_20px_rgba(79,77,207,0.06)]' : 'border-transparent hover:border-surface-variant'}`}>
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-1.5 flex-1 min-w-0">
                          {note.pinned && <span className="material-symbols-outlined text-sm text-outline" style={{fontVariationSettings:"'FILL' 1"}}>push_pin</span>}
                          <h3 className="font-bold text-on-surface line-clamp-1 text-sm">
                            {searchQuery && titleText.toLowerCase().includes(searchQuery.toLowerCase())
                              ? highlightMatch(titleText.slice(0, 40), searchQuery)
                              : titleText.slice(0, 40)}
                          </h3>
                        </div>
                        {isActive && <span className="text-[10px] font-bold text-primary bg-primary-container/10 px-2 py-0.5 rounded-full flex-shrink-0 ml-2">ACTIVE</span>}
                        {note.id && (
                          <div className="flex-shrink-0 relative ml-auto"
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <button type="button" tabIndex={-1}
                              onClick={(e) => { e.stopPropagation(); handleDelete(note.id); }}
                              className="w-7 h-7 flex items-center justify-center rounded-full text-error bg-error-container/20 hover:bg-error-container/50 transition-colors"
                              title="Delete note">
                              <span className="material-symbols-outlined" style={{fontSize:'16px'}}>close</span>
                            </button>
                          </div>
                        )}
                      </div>
                      <p className="text-sm text-on-surface-variant line-clamp-2 mb-3 leading-relaxed">
                        {stripHtml(note.content || '').slice(0, 80) || 'No content'}
                      </p>
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] font-bold text-outline">{metaParts[metaParts.length - 1]}</span>
                        {metaParts.length > 1 && <><div className="w-1 h-1 rounded-full bg-outline-variant" /><span className="text-[11px] font-bold text-outline">{metaParts.slice(0, -1).join(' · ')}</span></>}
                      </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

      </div>

      {/* Editor panel — single instance for both mobile & desktop */}
      {selectedNote ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          {editorPanel}
        </div>
      ) : (
        <div className="hidden md:flex md:flex-1 md:border-l md:border-gray-100">
          <div className="flex-1 flex items-center justify-center text-gray-300 text-sm">
            Select a note or create a new one
          </div>
        </div>
      )}
    </div>
  );
}
// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_TASKS = [
  {
    id: uid(),
    title: 'Review Q1 care management SaaS roadmap',
    description: 'Check sprint backlog and confirm priorities with engineering team',
    priority: 'high',
    dueDate: '2026-03-05',
    tags: ['Careific'],
    completed: false,
    visibility: 'shared',
    owner: 'user-lyle',
    createdAt: new Date().toISOString(),
  },
  {
    id: uid(),
    title: 'Order supplies for Rose facility',
    description: 'Medical consumables and kitchen supplies for March',
    priority: 'medium',
    dueDate: '2026-03-04',
    tags: ['Rose', 'Care Home'],
    completed: false,
    visibility: 'shared',
    owner: 'user-lyle',
    createdAt: new Date().toISOString(),
  },
  {
    id: uid(),
    title: 'Buyflip investor deck update',
    description: 'Update slides with latest revenue figures',
    priority: 'high',
    dueDate: '2026-03-07',
    tags: ['Buyflip'],
    completed: false,
    visibility: 'shared',
    owner: 'user-lyle',
    createdAt: new Date().toISOString(),
  },
  {
    id: uid(),
    title: 'Gym session',
    description: '',
    priority: 'low',
    dueDate: '',
    tags: ['Personal'],
    completed: true,
    visibility: 'private',
    owner: 'user-lyle',
    createdAt: new Date().toISOString(),
  },
];

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
    setCurrentUser(null);
    setAuthToken(null);
    setSessionExpired(false);
    localStorage.removeItem('tm_token');
    localStorage.removeItem('tm_user');
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
  const [activeView, setActiveView]             = useState('dashboard');
  const [activeTagFilters, setActiveTagFilters] = useState([]);
  const [statusFilter, setStatusFilter]         = useState('all');
  const [taskFilter, setTaskFilter]             = useState('');
  const [showSettings, setShowSettings]         = useState(false);
  const [showAlerts, setShowAlerts]             = useState(false);
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
  const [entities, setEntities]                 = useState([]);
  const firedAlertsRef                          = useRef((() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const saved = JSON.parse(localStorage.getItem('dizon_fired_alerts') || '[]');
    const filtered = saved.filter(k => !k.match(/\d{4}-\d{2}-\d{2}/) || k.includes(todayStr));
    return new Set(filtered);
  })());

  // Quick Capture FAB state
  const [noteCategories, setNoteCategories]     = useState([]);
  const [allNotes, setAllNotes]                 = useState([]);
  const [notesEditorOpen, setNotesEditorOpen]   = useState(false);
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
      .catch(() => {});
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
    // Open sliding panel on desktop if not on chat tab
    if (window.innerWidth >= 768 && activeView !== 'chat') {
      setChatPanelOpen(true);
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

  // Filter entities to only those the user is assigned to (non-admin sees only their entities)
  const userEntities = useMemo(() => {
    if (currentUser?.role === 'admin') return entities;
    const assigned = currentUser?.entityIds || [];
    if (assigned.length === 0) return entities; // fallback: show all if not yet assigned
    return entities.filter((e) => assigned.includes(e.name));
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

  // Load tasks on mount; fall back to SAMPLE_TASKS if server has none
  useEffect(() => {
    apiFetch('/api/tasks', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setTasks(data);
        } else {
          setTasks(SAMPLE_TASKS);
        }
      })
      .catch(() => setTasks(SAMPLE_TASKS))
      .finally(() => { tasksLoadedRef.current = true; });
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
      emailSettingsRef.current, firedAlertsRef, addToast, apiFetch,
    );
    const id = setInterval(() => {
      runAlertRules(
        tasksRef.current, alertRulesRef.current,
        emailSettingsRef.current, firedAlertsRef, addToast, apiFetch,
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
        headers: { 'Content-Type': 'application/json' },
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
  const enabledRulesCount = alertRules.filter((r) => r.enabled).length;

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
      <div className="flex-1 md:ml-52 flex flex-col min-h-screen overflow-hidden">

        {/* ── Top bar ── */}
        <header className="hidden md:flex items-center justify-end px-8 h-12 bg-background/80 backdrop-blur-xl sticky top-0 z-40 border-b border-surface-container-low flex-shrink-0">
          <div className="flex items-center gap-2">
            <button onClick={() => setShowAlerts(true)} className="relative p-1.5 text-slate-400 hover:text-primary transition-colors" title="Alerts">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
              </svg>
              {enabledRulesCount > 0 && <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-primary rounded-full" />}
            </button>
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
            <button onClick={() => setShowAlerts(true)} className="p-2 text-slate-400 hover:text-primary">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            </button>
            <button onClick={() => setShowSettings(true)} className="p-2 text-slate-400 hover:text-primary">
              <GearIcon className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Mobile prompt bar */}
        <div className="md:hidden flex-shrink-0">
          <UniversalPromptBar
            input={chatInput}
            onInputChange={setChatInput}
            backend={chatBackend}
            onBackendChange={setChatBackend}
            onSend={handleChatSend}
            loading={chatLoading}
            activeTab={mobileView}
            personaPill={lastAutoPersona ? { emoji: lastAutoPersona.emoji, name: lastAutoPersona.defaultName } : null}
          />
        </div>

        {/* ── Content ── */}
        <div className="flex flex-row flex-1 overflow-hidden pb-20 md:pb-0" style={{ minHeight: 0 }}>
        <section
          className={`flex-col overflow-hidden w-full ${(mobileView === 'tasks' || mobileView === 'daily') ? 'flex' : 'hidden md:flex'}`}
          style={{ flex: chatPanelOpen && activeView !== 'chat' ? '0 0 75%' : '1 1 100%', transition: 'flex 0.2s', minHeight: 0 }}
        >

          {/* View routing */}
          {activeView === 'dashboard' ? (
            <DashboardPanel
              tasks={tasks}
              currentUser={currentUser}
              authToken={authToken}
              apiKeys={apiKeys}
              notes={dashboardNotes}
              entities={userEntities}
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
              backend={chatBackend}
              onBackendChange={setChatBackend}
            />
          ) : activeView === 'inbox' ? (
            <InboxPanel tasks={tasks} authToken={authToken} currentUser={currentUser} onToggleTask={(id) => { toggleTask(id); }} onEditTask={(id, fields) => { editTask(id, fields); }} addToast={addToast} apiFetch={apiFetch} />
          ) : activeView === 'calendar' ? (
            <CalendarPanel currentUser={currentUser} addToast={addToast} apiFetch={apiFetch} />
          ) : activeView === 'notes' ? (
            <NotesPanel authToken={authToken} onEditorStateChange={setNotesEditorOpen} onCategoriesLoaded={setNoteCategories} onNotesLoaded={setAllNotes} quickCapturedNote={quickCapturedNote} addToast={addToast} entities={userEntities} />
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
                {visibleTasks.filter((t) => !t.completed && t.dueDate && t.dueDate < new Date().toISOString().slice(0,10)).length} overdue
                {' · '}
                {visibleTasks.filter((t) => !t.completed && t.dueDate === new Date().toISOString().slice(0,10)).length} due today
                {' · '}
                {visibleTasks.filter((t) => !t.completed && (!t.dueDate || t.dueDate > new Date().toISOString().slice(0,10))).length} upcoming
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
              const todayStr = new Date().toISOString().slice(0,10);
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
                      {new Date(t.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
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



        {/* ── Chat panel (mobile only — full screen when mobileView is 'chat') ── */}
        <section
          className={`flex-col overflow-hidden w-full md:hidden ${
            mobileView === 'chat' ? 'flex' : 'hidden'
          }`}
        >
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
        </section>

        {/* ── Calendar panel (mobile only — on desktop it's in the task section tabs) ── */}
        <section
          className={`flex-col overflow-hidden w-full md:hidden ${
            mobileView === 'calendar' ? 'flex' : 'hidden'
          }`}
        >
          <CalendarPanel currentUser={currentUser} addToast={addToast} apiFetch={apiFetch} />
        </section>

        {/* ── Notes panel (mobile only — on desktop it's in the task section tabs) ── */}
        <section
          className={`flex-col overflow-hidden w-full md:hidden ${
            mobileView === 'notes' ? 'flex' : 'hidden'
          }`}
        >
          <NotesPanel authToken={authToken} onEditorStateChange={setNotesEditorOpen} onCategoriesLoaded={setNoteCategories} onNotesLoaded={setAllNotes} quickCapturedNote={quickCapturedNote} addToast={addToast} entities={userEntities} />
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
        />
      )}
      {showSettings && (
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
        />
      )}

      {showAlerts && (
        <AlertsModal
          rules={alertRules}
          onUpdateRules={setAlertRules}
          emailSettings={emailSettings}
          tasks={tasks}
          firedAlertsRef={firedAlertsRef}
          addToast={addToast}
          onClose={() => setShowAlerts(false)}
          entities={userEntities}
          envStatus={{
            slack:    !!envConfigured.channelSlack,
            whatsapp: !!envConfigured.channelWhatsapp,
            sms:      !!envConfigured.channelSms,
            email:    !!envConfigured.channelEmail,
          }}
          apiFetch={apiFetch}
          EntitySelectOptions={EntitySelectOptions}
        />
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
            <AddTaskForm
              onAdd={(task) => { addTask(task); setShowTaskModal(false); }}
              claudeKey={apiKeys.claude}
              currentUser={currentUser}
              entities={userEntities}
              authToken={authToken}
              gcalConnected={gcalConnected}
              forceOpen={true}
              onClose={() => setShowTaskModal(false)}
            />
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

      {/* ── Quick Capture FAB ── */}
      <QuickCaptureFAB
        authToken={authToken}
        categories={noteCategories}
        activeView={window.innerWidth >= 768 ? activeView : mobileView}
        hideFAB={(activeView === 'notes' || mobileView === 'notes') && notesEditorOpen}
        addToast={addToast}
        onNoteSaved={(saved) => setQuickCapturedNote(saved)}
        chatPanelOpen={chatPanelOpen}
        onToggleChat={toggleChatPanel}
      />

      {/* ── Toast notifications handled by ToastProvider in main.jsx ── */}
    </div>
  );
}
