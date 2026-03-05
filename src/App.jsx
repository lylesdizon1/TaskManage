import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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

/** Decode a JWT payload without a library (base64url decode the middle section). */
function decodeJwtPayload(token) {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64));
  } catch { return null; }
}

/** Returns true if the token expires within `thresholdSeconds` (default 7 days). */
function tokenExpiresSoon(token, thresholdSeconds = 7 * 86400) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return false;
  return payload.exp - Date.now() / 1000 < thresholdSeconds;
}

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

// Color presets for entities — maps color name to Tailwind classes
const COLOR_PRESETS = {
  indigo: { bg: 'bg-indigo-100', text: 'text-indigo-700', border: 'border-indigo-200', ring: 'ring-indigo-400', dot: 'bg-indigo-500' },
  pink:   { bg: 'bg-pink-100',   text: 'text-pink-700',   border: 'border-pink-200',   ring: 'ring-pink-400',   dot: 'bg-pink-500' },
  amber:  { bg: 'bg-amber-100',  text: 'text-amber-700',  border: 'border-amber-200',  ring: 'ring-amber-400',  dot: 'bg-amber-500' },
  teal:   { bg: 'bg-teal-100',   text: 'text-teal-700',   border: 'border-teal-200',   ring: 'ring-teal-400',   dot: 'bg-teal-500' },
  slate:  { bg: 'bg-slate-100',  text: 'text-slate-600',  border: 'border-slate-200',  ring: 'ring-slate-400',  dot: 'bg-slate-500' },
  red:    { bg: 'bg-red-100',    text: 'text-red-700',    border: 'border-red-200',    ring: 'ring-red-400',    dot: 'bg-red-500' },
  green:  { bg: 'bg-green-100',  text: 'text-green-700',  border: 'border-green-200',  ring: 'ring-green-400',  dot: 'bg-green-500' },
  blue:   { bg: 'bg-blue-100',   text: 'text-blue-700',   border: 'border-blue-200',   ring: 'ring-blue-400',   dot: 'bg-blue-500' },
  purple: { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200', ring: 'ring-purple-400', dot: 'bg-purple-500' },
  orange: { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200', ring: 'ring-orange-400', dot: 'bg-orange-500' },
};

const AVAILABLE_COLORS = Object.keys(COLOR_PRESETS);

function getEntityStyle(colorName) {
  return COLOR_PRESETS[colorName] || COLOR_PRESETS.slate;
}

function getTagStyle(tagName, entities) {
  const entity = entities.find((e) => e.name === tagName);
  return getEntityStyle(entity?.color);
}

// Build grouped entity list for dropdowns: Business (+ children) > Personal
function buildGroupedEntities(entities) {
  const businesses = entities.filter((e) => e.type === 'business' || (!e.type && e.type !== 'personal' && e.type !== 'project'));
  const projects = entities.filter((e) => e.type === 'project');
  const personals = entities.filter((e) => e.type === 'personal');
  const result = [];
  businesses.forEach((b) => {
    result.push({ ...b, _indent: 0, _group: 'business' });
    projects.filter((p) => p.parentId === b.id).forEach((p) => result.push({ ...p, _indent: 1, _group: 'business' }));
  });
  projects.filter((p) => !p.parentId || !businesses.find((b) => b.id === p.parentId)).forEach((p) => result.push({ ...p, _indent: 0, _group: 'business' }));
  personals.forEach((p) => result.push({ ...p, _indent: 0, _group: 'personal' }));
  return result;
}

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

const PRIORITY_BORDER = {
  high:   'border-l-4 border-l-red-500',
  medium: 'border-l-4 border-l-amber-400',
  low:    'border-l-4 border-l-green-500',
};

const PRIORITY_BADGE = {
  high:   'bg-red-50   text-red-500',
  medium: 'bg-amber-50 text-amber-500',
  low:    'bg-green-50 text-green-600',
};

// ─────────────────────────────────────────────────────────────────────────────
// ALERT RULES CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ALERT_RULES = [
  {
    id: 'rule-overdue',
    name: 'Overdue Tasks',
    description: 'Alert when tasks are past their due date',
    enabled: true,
    condition: { type: 'overdue' },
    recipientOverride: '',
    isCustom: false,
  },
  {
    id: 'rule-due-24h',
    name: 'Due in 24 Hours',
    description: 'Alert when tasks are due within 24 hours',
    enabled: true,
    condition: { type: 'due-in-hours', hours: 24 },
    recipientOverride: '',
    isCustom: false,
  },
  {
    id: 'rule-high-priority',
    name: 'High Priority Backlog',
    description: 'Alert when incomplete high-priority tasks exist',
    enabled: false,
    condition: { type: 'high-priority' },
    recipientOverride: '',
    isCustom: false,
  },
  {
    id: 'rule-daily-digest',
    name: 'Daily Digest',
    description: 'Session summary of all active tasks on app load',
    enabled: false,
    condition: { type: 'daily-digest' },
    recipientOverride: '',
    isCustom: false,
  },
];

// condition type → { label, hasTag, hasHours }
const CONDITION_META = {
  'overdue':        { label: 'Overdue tasks',             hasTag: false, hasHours: false },
  'due-in-hours':   { label: 'Due within N hours',        hasTag: false, hasHours: true  },
  'high-priority':  { label: 'High-priority tasks',       hasTag: false, hasHours: false },
  'tag-match':      { label: 'All active tasks for tag',  hasTag: true,  hasHours: false },
  'tag-overdue':    { label: 'Overdue tasks for tag',     hasTag: true,  hasHours: false },
  'daily-digest':   { label: 'Daily summary (all tasks)', hasTag: false, hasHours: false },
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL & ALERT UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function conditionDescription(condition) {
  switch (condition.type) {
    case 'overdue':        return 'Tasks past their due date';
    case 'due-in-hours':   return `Tasks due within ${condition.hours || 24} hours`;
    case 'high-priority':  return 'All incomplete high-priority tasks';
    case 'tag-match':      return `All active "${condition.tag}" tasks`;
    case 'tag-overdue':    return `Overdue "${condition.tag}" tasks`;
    case 'daily-digest':   return 'All active tasks (session summary)';
    default:               return 'Unknown condition';
  }
}

// Returns 'per-task' | 'daily' | 'session'
function getRuleScope(type) {
  if (type === 'daily-digest')  return 'session';
  if (type === 'high-priority') return 'daily';
  if (type === 'tag-match')     return 'daily';
  return 'per-task'; // overdue, due-in-hours, tag-overdue
}

function evaluateRule(rule, tasks) {
  const now      = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const active   = tasks.filter((t) => !t.completed);

  switch (rule.condition.type) {
    case 'overdue':
      return active.filter((t) => t.dueDate && t.dueDate < todayStr);

    case 'due-in-hours': {
      const windowMs = (rule.condition.hours || 24) * 3_600_000;
      return active.filter((t) => {
        if (!t.dueDate) return false;
        const dueMs = new Date(t.dueDate + 'T23:59:59').getTime();
        return dueMs > now.getTime() && dueMs - now.getTime() <= windowMs;
      });
    }

    case 'high-priority':
      return active.filter((t) => t.priority === 'high');

    case 'tag-match':
      return active.filter((t) => t.tags.includes(rule.condition.tag));

    case 'tag-overdue':
      return active.filter(
        (t) => t.dueDate && t.dueDate < todayStr && t.tags.includes(rule.condition.tag),
      );

    case 'daily-digest':
      return active;

    default:
      return [];
  }
}

/** Build a professional HTML alert email for the given tasks. */
function buildEmailHtml(ruleName, ruleDesc, tasks) {
  const h        = escapeHtml;
  const todayStr = new Date().toISOString().slice(0, 10);
  const pColor   = { high: '#dc2626', medium: '#d97706', low: '#16a34a' };
  const pBg      = { high: '#fef2f2', medium: '#fffbeb', low: '#f0fdf4' };

  const rows = tasks
    .map((t) => {
      const overdue  = t.dueDate && t.dueDate < todayStr;
      const tagPills = t.tags
        .map(
          (tag) =>
            `<span style="display:inline-block;margin:1px 2px;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:500;background:#eef2ff;color:#4338ca;border:1px solid #e0e7ff;">${h(tag)}</span>`,
        )
        .join('');
      return `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #f3f4f6;vertical-align:top;">
            <div style="font-weight:600;color:#111827;font-size:13px;">${h(t.title)}</div>
            ${t.description ? `<div style="color:#6b7280;font-size:11px;margin-top:3px;">${h(t.description)}</div>` : ''}
          </td>
          <td style="padding:10px 14px;border-bottom:1px solid #f3f4f6;text-align:center;white-space:nowrap;vertical-align:top;">
            <span style="padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:${pBg[t.priority]};color:${pColor[t.priority]};">${h(t.priority)}</span>
          </td>
          <td style="padding:10px 14px;border-bottom:1px solid #f3f4f6;text-align:center;white-space:nowrap;vertical-align:top;font-size:12px;color:${overdue ? '#dc2626' : '#6b7280'};">
            ${t.dueDate ? `${overdue ? '&#9888; ' : ''}${h(t.dueDate)}` : '&mdash;'}
          </td>
          <td style="padding:10px 14px;border-bottom:1px solid #f3f4f6;vertical-align:top;">${tagPills}</td>
        </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f9fafb;margin:0;padding:32px 16px;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,.08);">
  <div style="background:linear-gradient(135deg,#4f46e5 0%,#6366f1 100%);padding:32px 24px;text-align:center;">
    <div style="font-size:32px;margin-bottom:10px;">&#128203;</div>
    <h1 style="color:#fff;margin:0 0 6px;font-size:20px;font-weight:700;letter-spacing:-.3px;">${h(ruleName)}</h1>
    <p style="color:#c7d2fe;margin:0;font-size:13px;">${h(ruleDesc)}</p>
  </div>
  <div style="padding:24px;">
    <p style="color:#374151;font-size:14px;margin:0 0 20px;">
      <strong style="color:#111827;">${tasks.length}</strong> task${tasks.length !== 1 ? 's' : ''}
      require${tasks.length === 1 ? 's' : ''} your attention:
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #f3f4f6;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:8px 14px;text-align:left;color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;border-bottom:1px solid #f3f4f6;">Task</th>
          <th style="padding:8px 14px;text-align:center;color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;border-bottom:1px solid #f3f4f6;">Priority</th>
          <th style="padding:8px 14px;text-align:center;color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;border-bottom:1px solid #f3f4f6;">Due</th>
          <th style="padding:8px 14px;text-align:left;color:#9ca3af;font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;border-bottom:1px solid #f3f4f6;">Tags</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div style="background:#f9fafb;padding:14px 24px;border-top:1px solid #f3f4f6;display:flex;justify-content:space-between;align-items:center;">
    <span style="color:#9ca3af;font-size:11px;font-weight:500;">Dizon.ai Alerts</span>
    <span style="color:#9ca3af;font-size:11px;">${new Date().toLocaleString()}</span>
  </div>
</div>
</body></html>`;
}

/** POST to /api/email/send via the proxy (Resend). */
async function sendAlertEmail(emailSettings, to, subject, html) {
  const res = await apiFetch('/api/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, subject, html }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Evaluate all enabled rules and send emails for new matches.
 * firedRef (Set) prevents duplicate sends within the same browser session.
 */
async function runAlertRules(tasks, rules, emailSettings, firedRef, addToast) {
  const { recipientEmail, resendConfigured } = emailSettings;
  if (!resendConfigured || !recipientEmail) return;

  const todayStr = new Date().toISOString().slice(0, 10);

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const matching = evaluateRule(rule, tasks);
    if (matching.length === 0) continue;

    const to    = rule.recipientOverride || recipientEmail;
    const scope = getRuleScope(rule.condition.type);
    let tasksToSend = [];

    if (scope === 'per-task') {
      tasksToSend = matching.filter((t) => !firedRef.current.has(`${rule.id}::${t.id}`));
      if (tasksToSend.length === 0) continue;
      tasksToSend.forEach((t) => firedRef.current.add(`${rule.id}::${t.id}`));
    } else if (scope === 'daily') {
      const key = `${rule.id}::${todayStr}`;
      if (firedRef.current.has(key)) continue;
      firedRef.current.add(key);
      tasksToSend = matching;
    } else {
      // session — once per browser load
      if (firedRef.current.has(rule.id)) continue;
      firedRef.current.add(rule.id);
      tasksToSend = matching;
    }

    const count   = tasksToSend.length;
    const subject = `[Dizon.ai] ${rule.name} — ${count} task${count !== 1 ? 's' : ''}`;
    const html    = buildEmailHtml(rule.name, conditionDescription(rule.condition), tasksToSend);

    try {
      await sendAlertEmail(emailSettings, to, subject, html);
      addToast({
        type: 'success',
        message: `Alert sent: "${rule.name}" (${count} task${count !== 1 ? 's' : ''})`,
      });
    } catch (err) {
      addToast({ type: 'error', message: `Alert failed: ${err.message}` });
    }
  }
}

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

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed');
        return;
      }
      localStorage.setItem('tm_token', data.token);
      localStorage.setItem('tm_user', JSON.stringify(data.user));
      onLogin(data.user, data.token);
    } catch {
      setError('Unable to connect to server');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center shadow-lg mx-auto mb-4">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Dizon.ai</h1>
          <p className="text-sm text-gray-500 mt-1">Life OS for high performers</p>
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              autoFocus
              autoComplete="username"
              className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              autoComplete="current-password"
              className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !username.trim() || !password}
            className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAG PILL
// ─────────────────────────────────────────────────────────────────────────────

function TagPill({ tag, isAi = false, entities = [] }) {
  const style = getTagStyle(tag, entities);
  const entity = entities.find((e) => e.name === tag);
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border ${style.bg} ${style.text} ${style.border}`}
    >
      {tag}
      {entity?.shared && <span>{'\u{1F517}'}</span>}
      {isAi && (
        <span className="text-[9px] leading-none bg-indigo-500 text-white px-1 py-0.5 rounded-full">
          AI
        </span>
      )}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOAST NOTIFICATIONS
// ─────────────────────────────────────────────────────────────────────────────

function ToastContainer({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-20 md:bottom-5 right-3 md:right-5 left-3 md:left-auto z-50 flex flex-col gap-2 max-w-sm md:max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium ${
            t.type === 'success'
              ? 'bg-white border-green-200 text-green-800'
              : 'bg-white border-red-200 text-red-700'
          }`}
        >
          <span className="flex-shrink-0 mt-0.5">{t.type === 'success' ? '✉️' : '❌'}</span>
          <span className="flex-1 leading-snug">{t.message}</span>
          <button
            onClick={() => onDismiss(t.id)}
            className="flex-shrink-0 text-gray-300 hover:text-gray-500 transition-colors"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

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
    if (isAdmin && (tab === 'entities' || tab === 'users')) {
      if (tab === 'entities') loadEntities();
      if (tab === 'users') loadUsers();
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

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
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Persona</label>
                <div className="flex flex-wrap gap-2 mb-3">
                  {[
                    { key: 'executive_assistant', label: 'Executive Assistant' },
                    { key: 'coo', label: 'COO' },
                    { key: 'best_friend', label: 'Best Friend' },
                    { key: 'life_coach', label: 'Life Coach' },
                    { key: 'cfo', label: 'CFO' },
                  ].map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => { setPersonaType(key); setPersonaStatus(null); }}
                      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                        personaType === key
                          ? 'bg-indigo-100 text-indigo-700 border border-indigo-300'
                          : 'bg-gray-50 text-gray-500 border border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="bg-gray-50 border border-gray-100 rounded-lg px-3 py-2.5 text-xs text-gray-500 italic">
                  {personaType === 'executive_assistant' && `"You have one overdue item and LJ's game at 3:30. Careific is your priority."`}
                  {personaType === 'coo' && `"One blocker: overdue task. Careific is your bottleneck. Clear it today."`}
                  {personaType === 'best_friend' && `"Yo don't sleep on that overdue task. LJ's game at 3:30 — don't be late bro."`}
                  {personaType === 'life_coach' && `"Every task you close today compounds. One overdue — handle it and move forward."`}
                  {personaType === 'cfo' && `"Net +$42k this month. One overdue task blocking operational momentum."`}
                </div>
              </div>

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

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS MODAL
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_NEW_RULE = {
  name: '',
  condition: { type: 'overdue', hours: 24, tag: '' },
  recipientOverride: '',
};

function RuleRow({ rule, defaultRecipient, onToggle, onDelete, onRecipientChange }) {
  const [expanded, setExpanded] = useState(false);
  const scope = getRuleScope(rule.condition.type);
  const scopeLabel = { 'per-task': 'per task', daily: 'daily', session: 'once/session' }[scope];

  return (
    <div
      className={`rounded-xl border transition-all ${
        rule.enabled ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50/50'
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Toggle */}
        <button
          onClick={onToggle}
          className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors ${
            rule.enabled ? 'bg-indigo-600' : 'bg-gray-200'
          }`}
          title={rule.enabled ? 'Disable' : 'Enable'}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
              rule.enabled ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-sm font-medium ${rule.enabled ? 'text-gray-900' : 'text-gray-400'}`}>
              {rule.name}
            </span>
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-medium">
              {scopeLabel}
            </span>
            {rule.isCustom && (
              <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded font-medium">
                custom
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-0.5 truncate">{rule.description}</p>
        </div>

        {/* Expand / delete */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-gray-300 hover:text-gray-500 transition-colors p-1"
            title="Set per-rule recipient"
          >
            <svg
              className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              className="text-gray-300 hover:text-red-400 transition-colors p-1"
              title="Delete rule"
            >
              <XIcon className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Expanded: recipient override */}
      {expanded && (
        <div className="px-4 pb-3 border-t border-gray-100">
          <label className="block text-xs font-medium text-gray-500 mb-1.5 mt-2.5">
            Recipient override{' '}
            <span className="font-normal text-gray-400">
              (blank = default: {defaultRecipient || 'not set'})
            </span>
          </label>
          <input
            type="email"
            value={rule.recipientOverride}
            onChange={(e) => onRecipientChange(e.target.value)}
            placeholder={defaultRecipient || 'override@example.com'}
            className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      )}
    </div>
  );
}

function AlertsModal({ rules, onUpdateRules, emailSettings, tasks, firedAlertsRef, addToast, onClose, entities }) {
  const [showAdd, setShowAdd]       = useState(false);
  const [newRule, setNewRule]       = useState(EMPTY_NEW_RULE);
  const [evaluating, setEvaluating] = useState(false);
  const [sending, setSending]       = useState(false);

  const emailConfigured =
    emailSettings.resendConfigured && emailSettings.recipientEmail;

  function toggleRule(id) {
    onUpdateRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  }

  function deleteRule(id) {
    onUpdateRules((prev) => prev.filter((r) => r.id !== id));
  }

  function updateRecipient(id, value) {
    onUpdateRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, recipientOverride: value } : r)),
    );
  }

  function handleAddRule() {
    if (!newRule.name.trim()) return;
    onUpdateRules((prev) => [
      ...prev,
      {
        id: uid(),
        name: newRule.name.trim(),
        description: conditionDescription(newRule.condition),
        enabled: true,
        condition: { ...newRule.condition },
        recipientOverride: newRule.recipientOverride.trim(),
        isCustom: true,
      },
    ]);
    setNewRule(EMPTY_NEW_RULE);
    setShowAdd(false);
  }

  async function handleEvaluateNow() {
    if (!emailConfigured) {
      addToast({ type: 'error', message: 'Set RESEND_API_KEY and alert recipient in Settings first' });
      return;
    }
    setEvaluating(true);
    await runAlertRules(tasks, rules, emailSettings, firedAlertsRef, addToast);
    setEvaluating(false);
  }

  async function handleSendTest() {
    if (!emailConfigured) {
      addToast({ type: 'error', message: 'Set RESEND_API_KEY and alert recipient in Settings first' });
      return;
    }
    setSending(true);
    try {
      const sampleTasks = tasks.filter((t) => !t.completed).slice(0, 3);
      const html = buildEmailHtml(
        'Test Email',
        'This is a test from Dizon.ai',
        sampleTasks.length ? sampleTasks : tasks.slice(0, 2),
      );
      await sendAlertEmail(
        emailSettings,
        emailSettings.recipientEmail,
        '[Dizon.ai] Test Email',
        html,
      );
      addToast({ type: 'success', message: 'Test email sent!' });
    } catch (err) {
      addToast({ type: 'error', message: `Test failed: ${err.message}` });
    } finally {
      setSending(false);
    }
  }

  const selectedMeta = CONDITION_META[newRule.condition.type] || {};

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 flex-shrink-0 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-indigo-100 rounded-lg flex items-center justify-center">
              <BellIcon className="w-4 h-4 text-indigo-600" />
            </div>
            <h2 className="text-lg font-bold text-gray-900">Alert Rules</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleEvaluateNow}
              disabled={evaluating}
              className="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
            >
              {evaluating ? 'Running…' : '▶ Evaluate Now'}
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg p-1 transition-colors"
            >
              <XIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Email status */}
        <div
          className={`px-6 py-2.5 text-xs flex items-center gap-1.5 flex-shrink-0 ${
            emailConfigured
              ? 'bg-green-50 text-green-700 border-b border-green-100'
              : 'bg-amber-50 text-amber-700 border-b border-amber-100'
          }`}
        >
          <span>{emailConfigured ? '✓' : '⚠️'}</span>
          <span>
            {emailConfigured
              ? `Alerts → ${emailSettings.recipientEmail} · Rules check every 60 s`
              : 'Set RESEND_API_KEY env var and alert recipient in Settings to activate'}
          </span>
        </div>

        {/* Scrollable rules list */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              defaultRecipient={emailSettings.recipientEmail}
              onToggle={() => toggleRule(rule.id)}
              onDelete={rule.isCustom ? () => deleteRule(rule.id) : null}
              onRecipientChange={(v) => updateRecipient(rule.id, v)}
            />
          ))}

          {/* Add custom rule inline form */}
          {showAdd ? (
            <div className="border border-indigo-200 rounded-xl p-4 bg-indigo-50/30 mt-2">
              <h4 className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-3">
                New Custom Rule
              </h4>
              <div className="space-y-2.5">
                <input
                  type="text"
                  placeholder="Rule name *"
                  value={newRule.name}
                  onChange={(e) => setNewRule((r) => ({ ...r, name: e.target.value }))}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />

                <select
                  value={newRule.condition.type}
                  onChange={(e) =>
                    setNewRule((r) => ({
                      ...r,
                      condition: { ...r.condition, type: e.target.value },
                    }))
                  }
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {Object.entries(CONDITION_META).map(([type, meta]) => (
                    <option key={type} value={type}>{meta.label}</option>
                  ))}
                </select>

                {selectedMeta.hasHours && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-500 w-16 flex-shrink-0">Hours:</label>
                    <select
                      value={newRule.condition.hours || 24}
                      onChange={(e) =>
                        setNewRule((r) => ({
                          ...r,
                          condition: { ...r.condition, hours: Number(e.target.value) },
                        }))
                      }
                      className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {[2, 4, 8, 24, 48, 72].map((h) => (
                        <option key={h} value={h}>{h} h</option>
                      ))}
                    </select>
                  </div>
                )}

                {selectedMeta.hasTag && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-500 w-16 flex-shrink-0">Tag:</label>
                    <select
                      value={newRule.condition.tag || (entities[0]?.name || '')}
                      onChange={(e) =>
                        setNewRule((r) => ({
                          ...r,
                          condition: { ...r.condition, tag: e.target.value },
                        }))
                      }
                      className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <EntitySelectOptions entities={entities || []} />
                    </select>
                  </div>
                )}

                <input
                  type="email"
                  placeholder="Recipient override (optional)"
                  value={newRule.recipientOverride}
                  onChange={(e) => setNewRule((r) => ({ ...r, recipientOverride: e.target.value }))}
                  className="w-full px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />

                <div className="flex gap-2">
                  <button
                    onClick={() => { setShowAdd(false); setNewRule(EMPTY_NEW_RULE); }}
                    className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 text-sm font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddRule}
                    disabled={!newRule.name.trim()}
                    className="flex-1 px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors disabled:opacity-40"
                  >
                    Add Rule
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              className="w-full flex items-center gap-2 px-4 py-3 border-2 border-dashed border-gray-200 rounded-xl text-gray-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/20 transition-all text-sm font-medium mt-1"
            >
              <span className="text-base leading-none">+</span> Add custom rule
            </button>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 flex gap-2 flex-shrink-0">
          <button
            onClick={handleSendTest}
            disabled={sending}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 hover:bg-gray-50 text-sm font-medium transition-colors disabled:opacity-50"
          >
            <MailIcon className="w-4 h-4" />
            {sending ? 'Sending…' : 'Send Test Email'}
          </button>
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 text-sm font-medium transition-colors shadow-sm"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD TASK FORM
// ─────────────────────────────────────────────────────────────────────────────

function AddTaskForm({ onAdd, claudeKey, currentUser, entities, authToken }) {
  const userEntityNames = entities.map((e) => e.name);
  const emptyForm = {
    title: '',
    description: '',
    priority: 'medium',
    dueDate: '',
    tags: [],
    visibility: 'shared',
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
      ...form,
      completed: false,
      owner: currentUser?.id || 'unknown',
      createdAt: new Date().toISOString(),
    });
    setForm(emptyForm);
    setAiSuggested([]);
    setIsOpen(false);
  }

  return (
    <div className="mb-5">
      {!isOpen ? (
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
        <div className="fixed inset-0 z-50 bg-white overflow-y-auto md:static md:inset-auto md:z-auto md:bg-transparent md:overflow-visible">
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

            {/* Priority + Due Date */}
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

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setForm(emptyForm);
                  setAiSuggested([]);
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
// FILTER BAR
// ─────────────────────────────────────────────────────────────────────────────

function FilterBar({
  activeTagFilters,
  setActiveTagFilters,
  statusFilter,
  setStatusFilter,
  entities,
}) {
  const hasFilters = activeTagFilters.length > 0 || statusFilter !== 'all';

  return (
    <div className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 mb-4">
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1 md:flex-wrap md:overflow-visible">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex-shrink-0">
          Filter
        </span>

        {/* Tag filters — dynamic from user's entities */}
        {buildGroupedEntities(entities || []).map((ent) => {
          const tag = ent.name;
          const style = getEntityStyle(ent.color);
          const active = activeTagFilters.includes(tag);
          return (
            <button
              key={tag}
              onClick={() =>
                setActiveTagFilters((f) =>
                  active ? f.filter((t) => t !== tag) : [...f, tag],
                )
              }
              className={`text-xs px-2.5 py-1.5 md:py-1 rounded-full font-medium border transition-all flex-shrink-0 min-h-[32px] md:min-h-0 ${
                active
                  ? `${style.bg} ${style.text} ${style.border} ring-2 ring-offset-1 ${style.ring}`
                  : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 hover:text-gray-600'
              }`}
            >
              {tag}{ent.shared ? ' \u{1F517}' : ''}
            </button>
          );
        })}

        {/* Divider */}
        <span className="text-gray-200 flex-shrink-0">|</span>

        {/* Status filters */}
        {[
          { key: 'all', label: 'All' },
          { key: 'active', label: 'Active' },
          { key: 'done', label: 'Done' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`text-xs px-2.5 py-1.5 md:py-1 rounded-full font-medium border transition-all flex-shrink-0 min-h-[32px] md:min-h-0 ${
              statusFilter === key
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 hover:text-gray-600'
            }`}
          >
            {label}
          </button>
        ))}

        {/* Clear */}
        {hasFilters && (
          <button
            onClick={() => {
              setActiveTagFilters([]);
              setStatusFilter('all');
            }}
            className="text-xs text-indigo-500 hover:text-indigo-700 font-medium ml-1 transition-colors flex-shrink-0"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAT PANEL
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Chat Message Thread (reusable for sliding panel and Chat tab)
// ─────────────────────────────────────────────────────────────────────────────

function ChatMessageThread({ messages, loading }) {
  const messagesEndRef = useRef(null);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50/50">
      {messages.length === 0 && (
        <div className="text-center py-10 text-gray-400">
          <div className="text-4xl mb-3">{'\u{1F916}'}</div>
          <p className="text-sm font-medium text-gray-500">Ask your AI assistant</p>
          <p className="text-xs text-gray-400 mt-1">&ldquo;What should I focus on today?&rdquo;</p>
          <p className="text-xs text-gray-400">&ldquo;Which Careific tasks are overdue?&rdquo;</p>
        </div>
      )}
      {messages.map((msg, i) => (
        <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          {msg.role === 'assistant' && (
            <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center mr-2 mt-0.5 flex-shrink-0 text-xs">{'\u{1F916}'}</div>
          )}
          <div className={`max-w-[82%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
            msg.role === 'user' ? 'bg-indigo-600 text-white rounded-br-sm' : 'bg-white text-gray-800 border border-gray-200 shadow-sm rounded-bl-sm'
          }`}>{msg.content}</div>
        </div>
      ))}
      {loading && (
        <div className="flex justify-start items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center text-xs">{'\u{1F916}'}</div>
          <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
            <div className="flex gap-1 items-center">
              {[0, 1, 2].map((j) => (
                <div key={j} className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: `${j * 0.18}s` }} />
              ))}
            </div>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sliding Chat Panel (no input — universal prompt bar handles input)
// ─────────────────────────────────────────────────────────────────────────────

function SlidingChatPanel({ messages, loading, backend, contextBadge, onHide }) {
  return (
    <div className="flex flex-col h-full bg-white border-l border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <span>{'\u{1F4AC}'}</span>
          <span className="text-sm font-semibold text-gray-900">Chat</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${backend === 'claude' ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700'}`}>
            {backend === 'claude' ? 'Claude' : 'ChatGPT'}
          </span>
        </div>
        <button onClick={onHide} className="text-xs text-gray-400 hover:text-gray-700 font-medium px-2 py-1 flex items-center gap-1 transition-colors">
          <span>&rarr;</span> Hide
        </button>
      </div>
      {/* Context badge */}
      {contextBadge && (
        <div className="bg-indigo-50 border-b border-indigo-100 px-4 py-1.5 text-[11px] text-indigo-600 flex items-center gap-1.5 flex-shrink-0">
          <span>{'\u{1F4CB}'}</span><span>{contextBadge}</span>
        </div>
      )}
      {/* Messages */}
      <ChatMessageThread messages={messages} loading={loading} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat Tab Panel (conversation list + message view)
// ─────────────────────────────────────────────────────────────────────────────

function chatDateGroup(dateStr) {
  if (!dateStr) return 'Earlier';
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  if (d >= today) return 'Today';
  if (d >= yesterday) return 'Yesterday';
  return 'Earlier';
}

function ChatTabPanel({ conversations, activeConvId, activeMessages, loading, backend, onSelectConv, onNewChat, onDeleteConv, onRenameConv }) {
  const [editingTitle, setEditingTitle] = useState(null);

  // Group conversations by date
  const grouped = useMemo(() => {
    const groups = { Today: [], Yesterday: [], Earlier: [] };
    conversations.forEach((c) => {
      const group = chatDateGroup(c.updatedAt || c.createdAt);
      groups[group].push(c);
    });
    return groups;
  }, [conversations]);

  return (
    <div className="flex h-full">
      {/* Left sidebar */}
      <div className="w-64 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col overflow-hidden">
        <div className="px-4 pt-4 pb-3 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold text-gray-900">{'\u{1F4AC}'} Conversations</span>
          </div>
          <button onClick={onNewChat} className="w-full px-3 py-2 text-sm font-medium text-white rounded-lg transition-colors hover:opacity-90" style={{ backgroundColor: '#7C3AED' }}>
            + New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 && (
            <p className="text-xs text-gray-400 px-2 py-4 text-center">No conversations yet</p>
          )}
          {['Today', 'Yesterday', 'Earlier'].map((group) => {
            const items = grouped[group];
            if (items.length === 0) return null;
            return (
              <div key={group} className="mb-2">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide px-2 py-1">{group}</p>
                {items.map((conv) => (
                  <div
                    key={conv.id}
                    onClick={() => onSelectConv(conv.id)}
                    className={`group flex items-center justify-between px-2.5 py-2 rounded-lg cursor-pointer transition-colors ${
                      activeConvId === conv.id ? 'bg-indigo-50 text-indigo-700' : 'hover:bg-gray-50 text-gray-700'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate">{conv.title || 'New conversation'}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${conv.model === 'chatgpt' ? 'bg-green-50 text-green-600' : 'bg-indigo-50 text-indigo-600'}`}>
                          {conv.model === 'chatgpt' ? 'GPT' : 'Claude'}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteConv(conv.id); }}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs px-1 transition-opacity"
                    >{'\u{1F5D1}\u{FE0F}'}</button>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 flex flex-col overflow-hidden bg-gray-50">
        {!activeConvId ? (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
            <div className="text-4xl mb-3">{'\u{1F4AC}'}</div>
            <p className="text-sm font-medium text-gray-500">Select a conversation or start a new one</p>
            <button onClick={onNewChat} className="mt-4 px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors hover:opacity-90" style={{ backgroundColor: '#7C3AED' }}>
              + New Chat
            </button>
          </div>
        ) : (
          <>
            {/* Conversation header */}
            <div className="bg-white border-b border-gray-200 px-5 py-3 flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {editingTitle === activeConvId ? (
                  <input
                    autoFocus
                    defaultValue={conversations.find((c) => c.id === activeConvId)?.title || ''}
                    onBlur={(e) => { onRenameConv(activeConvId, e.target.value); setEditingTitle(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { onRenameConv(activeConvId, e.target.value); setEditingTitle(null); } }}
                    className="text-sm font-semibold text-gray-900 bg-gray-50 border border-gray-200 rounded px-2 py-1 flex-1"
                  />
                ) : (
                  <h3 onClick={() => setEditingTitle(activeConvId)} className="text-sm font-semibold text-gray-900 truncate cursor-pointer hover:text-indigo-600 transition-colors">
                    {conversations.find((c) => c.id === activeConvId)?.title || 'New conversation'}
                  </h3>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${backend === 'claude' ? 'bg-indigo-100 text-indigo-700' : 'bg-green-100 text-green-700'}`}>
                  {backend === 'claude' ? 'Claude' : 'ChatGPT'}
                </span>
              </div>
              <button onClick={() => onDeleteConv(activeConvId)} className="text-xs text-gray-400 hover:text-red-500 transition-colors font-medium px-2 py-1">
                {'\u{1F5D1}\u{FE0F}'} Delete
              </button>
            </div>
            {/* Messages */}
            <ChatMessageThread messages={activeMessages} loading={loading} />
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Universal Prompt Bar
// ─────────────────────────────────────────────────────────────────────────────

function UniversalPromptBar({ input, onInputChange, backend, onBackendChange, onSend, loading, activeTab }) {
  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
  }

  const placeholders = {
    dashboard: 'What do you want to focus on today?',
    daily: 'Ask about your tasks...',
    calendar: 'Ask about your schedule...',
    financials: 'Ask about your finances...',
    notes: 'Ask about your notes...',
    chat: 'Ask anything...',
  };
  const placeholder = placeholders[activeTab] || 'Ask anything...';

  return (
    <div className="z-40 bg-white border-b border-gray-200 flex-shrink-0">
      <div className="flex items-center justify-center" style={{ height: 72, padding: '12px 24px' }}>
        <div className="flex items-center gap-2 w-full" style={{ maxWidth: 860, height: 52, borderRadius: 26, border: '1px solid #e5e7eb', backgroundColor: '#f9fafb', padding: '0 20px' }}>
          <input
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="flex-1 min-w-0 bg-transparent text-gray-900 placeholder-gray-400 border-0 outline-none focus:ring-0"
            style={{ fontSize: 16 }}
          />
          <select
            value={backend}
            onChange={(e) => onBackendChange(e.target.value)}
            className="flex-shrink-0 px-2 py-1 font-semibold bg-transparent border-0 text-gray-500 focus:ring-0 cursor-pointer"
            style={{ fontSize: 15 }}
          >
            <option value="claude">Claude</option>
            <option value="chatgpt">ChatGPT</option>
          </select>
          <button
            onClick={onSend}
            disabled={loading || !input.trim()}
            className="flex-shrink-0 flex items-center justify-center text-white rounded-full disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ backgroundColor: '#7C3AED', width: 40, height: 40 }}
          >
            {loading ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <SendIcon className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// Build AI system prompt (extracted from old ChatPanel for reuse)
function buildSystemPrompt(tasks, entities, financialAccounts, financialTransactions, notes) {
  const taskSummary = tasks.map((t) => ({ title: t.title, priority: t.priority, tags: t.tags, completed: t.completed, dueDate: t.dueDate || null }));
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
  const acctMap = {}; (financialAccounts || []).forEach((a) => { acctMap[a.id] = a.name || a.institution || 'Unknown'; });
  let txContext = '';
  if (financialTransactions && financialTransactions.length > 0) {
    const recent = financialTransactions.slice(0, 200);
    const txLines = recent.map((t) => { const n = acctMap[t.accountId] || 'Unknown'; const s = t.type === 'credit' ? '+' : '-'; return `${t.date} | ${n} | ${t.description || ''} | ${s}$${Number(t.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ${t.category || 'Uncategorized'}`; });
    txContext = `\n\nFinancial transactions (${financialTransactions.length} total, ${recent.length} shown):\nDate | Account | Description | Amount | Category\n${txLines.join('\n')}`;
  }
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
  return `You are a business productivity assistant. The user manages multiple ventures. Current tasks: ${JSON.stringify(taskSummary)}. Help prioritize and plan.` + entityContext + txContext + notesContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG ICON HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function GearIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function XIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function SendIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
    </svg>
  );
}

function ChatIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
      />
    </svg>
  );
}

function SpinnerIcon({ className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function BellIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  );
}

function MailIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

function ChecklistIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"
      />
    </svg>
  );
}

function LogoutIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
    </svg>
  );
}

function CalendarIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

function DollarIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function NotesIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}

function UploadIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
    </svg>
  );
}

function SyncIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  );
}

function PencilIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FINANCIALS PANEL
// ─────────────────────────────────────────────────────────────────────────────

const ACCOUNT_TYPE_COLORS = {
  checking: { bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200', dot: 'bg-green-500' },
  savings: { bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-200', dot: 'bg-blue-500' },
  credit_card: { bg: 'bg-red-100', text: 'text-red-700', border: 'border-red-200', dot: 'bg-red-500' },
  loan: { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200', dot: 'bg-orange-500' },
};

const ACCOUNT_TYPE_LABELS = { checking: 'Checking', savings: 'Savings', credit_card: 'Credit Card', loan: 'Loan' };

function FinancialsPanel({ authToken, currentUser, entities, onDataChange }) {
  const [subTab, setSubTab] = useState('dashboard');
  const [accounts, setAccounts] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  // Account form
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [acctForm, setAcctForm] = useState({ name: '', type: 'checking', institution: '', entityId: '', accountClass: 'personal' });

  // Transaction form
  const [showAddTx, setShowAddTx] = useState(false);
  const [txForm, setTxForm] = useState({ accountId: '', date: new Date().toISOString().slice(0, 10), description: '', amount: '', type: 'debit', category: '', entityId: '', accountClass: 'personal', notes: '' });

  // File import (CSV, Excel, PDF)
  const [showImport, setShowImport] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [importFileData, setImportFileData] = useState(null); // base64 for xlsx/pdf
  const [importFileType, setImportFileType] = useState('csv'); // 'csv' | 'xlsx' | 'pdf'
  const [importFileName, setImportFileName] = useState('');
  const [importAccountId, setImportAccountId] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);

  // Filters
  const [filterAccount, setFilterAccount] = useState('');
  const [filterEntity, setFilterEntity] = useState('');
  const [filterClass, setFilterClass] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');

  // Editing transaction
  const [editingTx, setEditingTx] = useState(null);

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };

  const [loadError, setLoadError] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [acctRes, summRes] = await Promise.all([
        apiFetch('/api/financial/accounts', { headers: { Authorization: `Bearer ${authToken}` } }),
        apiFetch('/api/financial/summary', { headers: { Authorization: `Bearer ${authToken}` } }),
      ]);
      if (!acctRes.ok) {
        const err = await acctRes.json().catch(() => ({}));
        setLoadError(`Failed to load accounts: ${err.error || acctRes.statusText}`);
      } else {
        const acctData = await acctRes.json();
        if (Array.isArray(acctData)) setAccounts(acctData);
      }
      if (summRes.ok) {
        const summData = await summRes.json();
        if (summData) setSummary(summData);
      }
    } catch (e) { setLoadError(`Network error: ${e.message}`); }
    setLoading(false);
  }, [authToken]);

  const loadTransactions = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterAccount) params.set('accountId', filterAccount);
    if (filterEntity) params.set('entityId', filterEntity);
    if (filterClass) params.set('accountClass', filterClass);
    if (filterCategory) params.set('category', filterCategory);
    if (filterStartDate) params.set('startDate', filterStartDate);
    if (filterEndDate) params.set('endDate', filterEndDate);
    try {
      const res = await apiFetch(`/api/financial/transactions?${params}`, { headers: { Authorization: `Bearer ${authToken}` } });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setLoadError(`Failed to load transactions: ${err.error || res.statusText}`);
        return;
      }
      const data = await res.json();
      if (Array.isArray(data)) {
        setTransactions(data);
        if (onDataChange) onDataChange();
      }
    } catch (e) { setLoadError(`Network error: ${e.message}`); }
  }, [authToken, filterAccount, filterEntity, filterClass, filterCategory, filterStartDate, filterEndDate]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => { loadTransactions(); }, [loadTransactions]);

  async function handleCreateAccount(e) {
    e.preventDefault();
    if (!acctForm.name.trim()) return;
    await apiFetch('/api/financial/accounts', { method: 'POST', headers, body: JSON.stringify(acctForm) });
    setAcctForm({ name: '', type: 'checking', institution: '', entityId: '', accountClass: 'personal' });
    setShowAddAccount(false);
    loadAll();
  }

  async function handleDeleteAccount(id) {
    await apiFetch(`/api/financial/accounts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
    loadAll();
    loadTransactions();
  }

  async function handleCreateTx(e) {
    e.preventDefault();
    if (!txForm.accountId || !txForm.amount) return;
    const acct = accounts.find((a) => a.id === txForm.accountId);
    await apiFetch('/api/financial/transactions', {
      method: 'POST', headers,
      body: JSON.stringify({
        ...txForm,
        amount: parseFloat(txForm.amount),
        entityId: txForm.entityId || acct?.entityId || '',
        accountClass: txForm.accountClass || acct?.accountClass || 'personal',
      }),
    });
    setTxForm({ accountId: txForm.accountId, date: new Date().toISOString().slice(0, 10), description: '', amount: '', type: 'debit', category: '', entityId: '', accountClass: 'personal', notes: '' });
    setShowAddTx(false);
    loadTransactions();
    loadAll();
  }

  async function handleDeleteTx(id) {
    await apiFetch(`/api/financial/transactions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
    loadTransactions();
    loadAll();
  }

  async function handleUpdateTx(id, fields) {
    await apiFetch(`/api/financial/transactions/${id}`, { method: 'PUT', headers, body: JSON.stringify(fields) });
    setEditingTx(null);
    loadTransactions();
    loadAll();
  }

  async function handleImportFile() {
    if (!importAccountId) return;
    if (importFileType === 'csv' && !csvText) return;
    if ((importFileType === 'xlsx' || importFileType === 'pdf') && !importFileData) return;
    setImporting(true);
    setImportResult(null);
    try {
      const acct = accounts.find((a) => a.id === importAccountId);
      const body = {
        accountId: importAccountId,
        entityId: acct?.entityId || '',
        accountClass: acct?.accountClass || 'personal',
        fileType: importFileType,
      };
      if (importFileType === 'csv') {
        body.csvText = csvText;
      } else {
        body.fileData = importFileData;
      }
      const res = await apiFetch('/api/financial/import-csv', {
        method: 'POST', headers,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setImportResult({ ok: true, msg: `Imported ${data.count} transactions (format: ${data.format})` });
        setCsvText('');
        setImportFileData(null);
        setImportFileName('');
        loadTransactions();
        loadAll();
      } else {
        setImportResult({ ok: false, msg: data.error || 'Import failed' });
      }
    } catch (err) {
      setImportResult({ ok: false, msg: err.message });
    }
    setImporting(false);
  }

  function handleFileDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!file) return;
    // Reset file input so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';

    const name = file.name || '';
    const ext = name.split('.').pop().toLowerCase();
    // Also check MIME type for drag-and-drop where extension may not be reliable
    const mime = file.type || '';
    const isPdf = ext === 'pdf' || mime === 'application/pdf';
    const isExcel = ext === 'xlsx' || ext === 'xls' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mime === 'application/vnd.ms-excel';

    setImportFileName(name);
    setImportResult(null);

    if (isExcel) {
      setImportFileType('xlsx');
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = ev.target.result.split(',')[1];
        setImportFileData(base64);
        setCsvText('');
      };
      reader.readAsDataURL(file);
    } else if (isPdf) {
      setImportFileType('pdf');
      const reader = new FileReader();
      reader.onload = (ev) => {
        const base64 = ev.target.result.split(',')[1];
        setImportFileData(base64);
        setCsvText('');
      };
      reader.readAsDataURL(file);
    } else {
      setImportFileType('csv');
      setImportFileData(null);
      const reader = new FileReader();
      reader.onload = (ev) => setCsvText(ev.target.result);
      reader.readAsText(file);
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // Compute account balances from summary
  const accountBalances = useMemo(() => {
    const map = {};
    if (summary?.balances) {
      for (const b of summary.balances) map[b.accountId] = b.balance;
    }
    return map;
  }, [summary]);

  const totalBalance = useMemo(() => Object.values(accountBalances).reduce((s, b) => s + b, 0), [accountBalances]);

  // Monthly income/expenses for chart
  const monthlyData = useMemo(() => {
    if (!summary?.monthly) return [];
    const map = {};
    for (const row of summary.monthly) {
      if (!map[row.month]) map[row.month] = { month: row.month, income: 0, expenses: 0 };
      map[row.month].income += row.income;
      map[row.month].expenses += row.expenses;
    }
    return Object.values(map).sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  }, [summary]);

  // Entity breakdown
  const entityBreakdown = useMemo(() => {
    if (!summary?.monthly) return [];
    const map = {};
    for (const row of summary.monthly) {
      const key = row.entityId || 'Unassigned';
      if (!map[key]) map[key] = { entityId: key, income: 0, expenses: 0 };
      map[key].income += row.income;
      map[key].expenses += row.expenses;
    }
    return Object.values(map);
  }, [summary]);

  // Personal vs business breakdown
  const classBreakdown = useMemo(() => {
    if (!summary?.monthly) return [];
    const map = {};
    for (const row of summary.monthly) {
      const key = row.accountClass || 'personal';
      if (!map[key]) map[key] = { accountClass: key, income: 0, expenses: 0 };
      map[key].income += row.income;
      map[key].expenses += row.expenses;
    }
    return Object.values(map);
  }, [summary]);

  const uniqueCategories = useMemo(() => {
    const cats = new Set(transactions.map((t) => t.category).filter(Boolean));
    return [...cats].sort();
  }, [transactions]);

  const inputCls = 'w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition';

  const maxMonthlyVal = useMemo(() => Math.max(...monthlyData.map((m) => Math.max(m.income, m.expenses)), 1), [monthlyData]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <SpinnerIcon className="w-6 h-6 animate-spin text-indigo-500" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {loadError && (
        <div className="mx-4 mt-3 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-center justify-between">
          <span>{loadError}</span>
          <button onClick={() => { setLoadError(''); loadAll(); loadTransactions(); }} className="ml-3 text-xs font-medium text-red-600 hover:text-red-800 underline">Retry</button>
        </div>
      )}
      {/* Sub-tabs */}
      <div className="bg-white border-b border-gray-100 px-4 pt-3 pb-0 flex-shrink-0">
        <div className="flex gap-1">
          {[
            { key: 'dashboard', label: 'Dashboard' },
            { key: 'accounts', label: 'Accounts' },
            { key: 'transactions', label: 'Transactions' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setSubTab(key)}
              className={`px-3 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px ${
                subTab === key
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {/* ── DASHBOARD ── */}
        {subTab === 'dashboard' && (
          <div className="space-y-5">
            {/* Total balance */}
            <div className="bg-gradient-to-r from-indigo-600 to-indigo-500 rounded-2xl p-5 text-white shadow-lg">
              <p className="text-sm font-medium opacity-80">Total Balance</p>
              <p className="text-3xl font-bold mt-1">${totalBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
              <p className="text-xs opacity-70 mt-1">{accounts.length} account{accounts.length !== 1 ? 's' : ''}</p>
            </div>

            {/* Income vs Expenses bar chart */}
            {monthlyData.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 p-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Income vs Expenses by Month</h3>
                <div className="space-y-2">
                  {monthlyData.map((m) => (
                    <div key={m.month} className="flex items-center gap-2 text-xs">
                      <span className="w-16 text-gray-500 font-medium flex-shrink-0">{m.month}</span>
                      <div className="flex-1 flex flex-col gap-1">
                        <div className="flex items-center gap-1">
                          <div className="h-3 bg-green-400 rounded" style={{ width: `${Math.max((m.income / maxMonthlyVal) * 100, 0)}%`, minWidth: m.income > 0 ? '4px' : '0' }} />
                          <span className="text-green-600">${m.income.toLocaleString('en-US', { minimumFractionDigits: 0 })}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <div className="h-3 bg-red-400 rounded" style={{ width: `${Math.max((m.expenses / maxMonthlyVal) * 100, 0)}%`, minWidth: m.expenses > 0 ? '4px' : '0' }} />
                          <span className="text-red-600">${m.expenses.toLocaleString('en-US', { minimumFractionDigits: 0 })}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-4 mt-3 text-[10px] text-gray-400">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-green-400" /> Income</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-400" /> Expenses</span>
                </div>
              </div>
            )}

            {/* Entity breakdown */}
            {entityBreakdown.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 p-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Breakdown by Entity</h3>
                <div className="space-y-2">
                  {entityBreakdown.map((e) => {
                    const ent = entities.find((en) => en.name === e.entityId);
                    const style = getEntityStyle(ent?.color);
                    return (
                      <div key={e.entityId} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-50">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                          {e.entityId || 'Unassigned'}
                        </span>
                        <div className="text-xs text-right">
                          <span className="text-green-600">+${e.income.toLocaleString()}</span>
                          <span className="text-gray-300 mx-1">/</span>
                          <span className="text-red-600">-${e.expenses.toLocaleString()}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Personal vs Business */}
            {classBreakdown.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 p-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Personal vs Business</h3>
                <div className="grid grid-cols-2 gap-3">
                  {classBreakdown.map((c) => (
                    <div key={c.accountClass} className={`rounded-lg p-3 ${c.accountClass === 'business' ? 'bg-indigo-50 border border-indigo-100' : 'bg-gray-50 border border-gray-100'}`}>
                      <p className="text-xs font-semibold text-gray-600 uppercase">{c.accountClass}</p>
                      <p className="text-green-600 text-sm font-medium mt-1">+${c.income.toLocaleString()}</p>
                      <p className="text-red-600 text-sm font-medium">-${c.expenses.toLocaleString()}</p>
                      <p className="text-gray-900 text-sm font-bold mt-1">Net: ${(c.income - c.expenses).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top spending categories */}
            {summary?.topCategories?.length > 0 && (
              <div className="bg-white rounded-xl border border-gray-100 p-4">
                <h3 className="text-sm font-semibold text-gray-900 mb-3">Top Spending Categories</h3>
                <div className="space-y-1.5">
                  {summary.topCategories.map((c, i) => (
                    <div key={c.category} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 w-4">{i + 1}.</span>
                        <span className="text-gray-700">{c.category}</span>
                      </div>
                      <span className="font-medium text-red-600">${c.total.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {accounts.length === 0 && (
              <div className="text-center py-12 text-gray-400">
                <DollarIcon className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                <p className="font-medium text-gray-500">No financial accounts yet</p>
                <p className="text-xs mt-1">Go to the Accounts tab to add your first account</p>
              </div>
            )}
          </div>
        )}

        {/* ── ACCOUNTS ── */}
        {subTab === 'accounts' && (
          <div className="space-y-3">
            {/* Add account button/form */}
            {showAddAccount ? (
              <form onSubmit={handleCreateAccount} className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">New Account</h3>
                <input type="text" placeholder="Account name *" value={acctForm.name} onChange={(e) => setAcctForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} required autoFocus />
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
                    <select value={acctForm.type} onChange={(e) => setAcctForm((f) => ({ ...f, type: e.target.value }))} className={inputCls}>
                      <option value="checking">Checking</option>
                      <option value="savings">Savings</option>
                      <option value="credit_card">Credit Card</option>
                      <option value="loan">Loan</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Class</label>
                    <select value={acctForm.accountClass} onChange={(e) => setAcctForm((f) => ({ ...f, accountClass: e.target.value }))} className={inputCls}>
                      <option value="personal">Personal</option>
                      <option value="business">Business</option>
                    </select>
                  </div>
                </div>
                <input type="text" placeholder="Institution (e.g. Chase)" value={acctForm.institution} onChange={(e) => setAcctForm((f) => ({ ...f, institution: e.target.value }))} className={inputCls} />
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Entity</label>
                  <select value={acctForm.entityId} onChange={(e) => setAcctForm((f) => ({ ...f, entityId: e.target.value }))} className={inputCls}>
                    <option value="">-- None --</option>
                    <EntitySelectOptions entities={entities} />
                  </select>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setShowAddAccount(false)} className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 text-sm font-medium">Cancel</button>
                  <button type="submit" className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium shadow-sm">Add Account</button>
                </div>
              </form>
            ) : (
              <button onClick={() => setShowAddAccount(true)} className="w-full flex items-center gap-2 px-4 py-3 bg-white border-2 border-dashed border-gray-200 rounded-xl text-gray-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/30 transition-all text-sm font-medium">
                <span className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center text-base leading-none">+</span>
                Add account
              </button>
            )}

            {/* Account list */}
            {accounts.map((acct) => {
              const typeStyle = ACCOUNT_TYPE_COLORS[acct.type] || ACCOUNT_TYPE_COLORS.checking;
              const balance = accountBalances[acct.id] || 0;
              const ent = entities.find((e) => e.name === acct.entityId);
              const entStyle = getEntityStyle(ent?.color);
              return (
                <div key={acct.id} className={`bg-white rounded-xl border border-gray-100 shadow-sm p-4 border-l-4 ${typeStyle.border}`}>
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="text-sm font-semibold text-gray-900">{acct.name}</h4>
                      <p className="text-xs text-gray-400 mt-0.5">{acct.institution || 'No institution'}</p>
                      <div className="flex gap-1.5 mt-2">
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${typeStyle.bg} ${typeStyle.text}`}>
                          {ACCOUNT_TYPE_LABELS[acct.type]}
                        </span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${acct.accountClass === 'business' ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-500'}`}>
                          {acct.accountClass}
                        </span>
                        {acct.entityId && (
                          <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${entStyle.bg} ${entStyle.text}`}>
                            {acct.entityId}{ent?.shared ? ' \u{1F517}' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={`text-lg font-bold ${balance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        ${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </p>
                      <button onClick={() => handleDeleteAccount(acct.id)} className="text-[10px] text-red-400 hover:text-red-600 mt-1">Delete</button>
                    </div>
                  </div>
                </div>
              );
            })}

            {accounts.length === 0 && !showAddAccount && (
              <div className="text-center py-12 text-gray-400">
                <DollarIcon className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                <p className="text-sm font-medium text-gray-500">No accounts yet</p>
              </div>
            )}
          </div>
        )}

        {/* ── TRANSACTIONS ── */}
        {subTab === 'transactions' && (
          <div className="space-y-3">
            {/* Action buttons */}
            <div className="flex gap-2">
              <button onClick={() => setShowAddTx(true)} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 shadow-sm">
                <span>+</span> Add Transaction
              </button>
              <button onClick={() => setShowImport(true)} className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50">
                <UploadIcon className="w-4 h-4" /> Import File
              </button>
            </div>

            {/* Filters */}
            <div className="bg-white rounded-xl border border-gray-100 px-3 py-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex-shrink-0">Filter</span>
                <select value={filterAccount} onChange={(e) => setFilterAccount(e.target.value)} className="text-xs px-2 py-1 border border-gray-200 rounded-lg bg-gray-50">
                  <option value="">All Accounts</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <select value={filterEntity} onChange={(e) => setFilterEntity(e.target.value)} className="text-xs px-2 py-1 border border-gray-200 rounded-lg bg-gray-50">
                  <option value="">All Entities</option>
                  <EntitySelectOptions entities={entities} />
                </select>
                <select value={filterClass} onChange={(e) => setFilterClass(e.target.value)} className="text-xs px-2 py-1 border border-gray-200 rounded-lg bg-gray-50">
                  <option value="">All Classes</option>
                  <option value="personal">Personal</option>
                  <option value="business">Business</option>
                </select>
                <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="text-xs px-2 py-1 border border-gray-200 rounded-lg bg-gray-50">
                  <option value="">All Categories</option>
                  {uniqueCategories.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <input type="date" value={filterStartDate} onChange={(e) => setFilterStartDate(e.target.value)} className="text-xs px-2 py-1 border border-gray-200 rounded-lg bg-gray-50" placeholder="From" />
                <input type="date" value={filterEndDate} onChange={(e) => setFilterEndDate(e.target.value)} className="text-xs px-2 py-1 border border-gray-200 rounded-lg bg-gray-50" placeholder="To" />
                {(filterAccount || filterEntity || filterClass || filterCategory || filterStartDate || filterEndDate) && (
                  <button onClick={() => { setFilterAccount(''); setFilterEntity(''); setFilterClass(''); setFilterCategory(''); setFilterStartDate(''); setFilterEndDate(''); }} className="text-xs text-indigo-500 hover:text-indigo-700 font-medium">Clear all</button>
                )}
              </div>
            </div>

            {/* Add Transaction form */}
            {showAddTx && (
              <form onSubmit={handleCreateTx} className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">New Transaction</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Account *</label>
                    <select value={txForm.accountId} onChange={(e) => { const acct = accounts.find((a) => a.id === e.target.value); setTxForm((f) => ({ ...f, accountId: e.target.value, entityId: acct?.entityId || '', accountClass: acct?.accountClass || 'personal' })); }} className={inputCls} required>
                      <option value="">Select...</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Date *</label>
                    <input type="date" value={txForm.date} onChange={(e) => setTxForm((f) => ({ ...f, date: e.target.value }))} className={inputCls} required />
                  </div>
                </div>
                <input type="text" placeholder="Description" value={txForm.description} onChange={(e) => setTxForm((f) => ({ ...f, description: e.target.value }))} className={inputCls} />
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Amount *</label>
                    <input type="number" step="0.01" placeholder="0.00" value={txForm.amount} onChange={(e) => setTxForm((f) => ({ ...f, amount: e.target.value }))} className={inputCls} required />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Type</label>
                    <select value={txForm.type} onChange={(e) => setTxForm((f) => ({ ...f, type: e.target.value }))} className={inputCls}>
                      <option value="debit">Debit (expense)</option>
                      <option value="credit">Credit (income)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
                    <input type="text" placeholder="e.g. Food" value={txForm.category} onChange={(e) => setTxForm((f) => ({ ...f, category: e.target.value }))} className={inputCls} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Entity</label>
                    <select value={txForm.entityId} onChange={(e) => setTxForm((f) => ({ ...f, entityId: e.target.value }))} className={inputCls}>
                      <option value="">-- None --</option>
                      <EntitySelectOptions entities={entities} />
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Class</label>
                    <select value={txForm.accountClass} onChange={(e) => setTxForm((f) => ({ ...f, accountClass: e.target.value }))} className={inputCls}>
                      <option value="personal">Personal</option>
                      <option value="business">Business</option>
                    </select>
                  </div>
                </div>
                <input type="text" placeholder="Notes (optional)" value={txForm.notes} onChange={(e) => setTxForm((f) => ({ ...f, notes: e.target.value }))} className={inputCls} />
                <div className="flex gap-2">
                  <button type="button" onClick={() => setShowAddTx(false)} className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 text-sm font-medium">Cancel</button>
                  <button type="submit" className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium shadow-sm">Add</button>
                </div>
              </form>
            )}

            {/* File Import modal (CSV, Excel, PDF) */}
            {showImport && (
              <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">Import Transactions</h3>
                  <button onClick={() => { setShowImport(false); setCsvText(''); setImportFileData(null); setImportFileName(''); setImportResult(null); }} className="text-gray-400 hover:text-gray-600">
                    <XIcon className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">CSV</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">Excel (.xlsx)</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">PDF (AI-powered)</span>
                </div>
                <p className="text-xs text-gray-500">Supports CSV (Chase, BoA, Amex, generic), Excel spreadsheets, and PDF bank statements. PDFs are parsed using Claude AI.</p>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Import to Account *</label>
                  <select value={importAccountId} onChange={(e) => setImportAccountId(e.target.value)} className={inputCls}>
                    <option value="">Select account...</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div
                  onDrop={handleFileDrop}
                  onDragOver={handleDragOver}
                  onDragEnter={handleDragOver}
                  className="border-2 border-dashed border-gray-200 rounded-lg p-6 text-center hover:border-indigo-300 hover:bg-indigo-50/20 transition-all cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input ref={fileInputRef} type="file" accept=".csv,.txt,.xlsx,.xls,.pdf" className="hidden" onChange={handleFileDrop} />
                  <UploadIcon className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                  {importFileName ? (
                    <div>
                      <p className="text-sm text-gray-700 font-medium">{importFileName}</p>
                      <p className="text-xs mt-1">
                        <span className={`px-1.5 py-0.5 rounded font-medium ${
                          importFileType === 'pdf' ? 'bg-red-100 text-red-600' :
                          importFileType === 'xlsx' ? 'bg-blue-100 text-blue-600' :
                          'bg-green-100 text-green-600'
                        }`}>
                          {importFileType === 'pdf' ? 'PDF — will use AI to parse' :
                           importFileType === 'xlsx' ? 'Excel spreadsheet' :
                           `CSV — ${csvText.split('\n').length - 1} rows`}
                        </span>
                      </p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-sm text-gray-500 font-medium">Drop file here or click to browse</p>
                      <p className="text-xs text-gray-400 mt-1">CSV, Excel (.xlsx), or PDF bank statements</p>
                    </div>
                  )}
                </div>
                {importFileType === 'csv' && !importFileName && (
                  <textarea value={csvText} onChange={(e) => { setCsvText(e.target.value); setImportFileType('csv'); }} rows={3} className={inputCls + ' font-mono text-xs'} placeholder="Or paste CSV text here..." />
                )}
                {importFileType === 'csv' && csvText && importFileName && (
                  <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={4} className={inputCls + ' font-mono text-xs'} placeholder="CSV content..." />
                )}
                {importFileType === 'pdf' && importFileData && (
                  <div className="text-xs px-3 py-2 rounded-lg bg-amber-50 text-amber-700 border border-amber-200">
                    PDF will be processed using Claude AI to extract transactions. This may take a moment.
                  </div>
                )}
                {importResult && (
                  <div className={`text-xs px-3 py-2 rounded-lg font-medium ${importResult.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                    {importResult.ok ? '✓ ' : '✗ '}{importResult.msg}
                  </div>
                )}
                <button
                  onClick={handleImportFile}
                  disabled={importing || !importAccountId || (importFileType === 'csv' ? !csvText : !importFileData)}
                  className="w-full px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium text-sm transition-colors shadow-sm disabled:opacity-50"
                >
                  {importing ? (importFileType === 'pdf' ? 'AI is parsing PDF...' : 'Importing...') : 'Import Transactions'}
                </button>
              </div>
            )}

            {/* Transaction list */}
            <div className="space-y-1.5">
              {transactions.map((tx) => {
                const acct = accounts.find((a) => a.id === tx.accountId);
                const ent = entities.find((e) => e.name === tx.entityId);
                const entStyle = getEntityStyle(ent?.color);

                if (editingTx === tx.id) {
                  return (
                    <div key={tx.id} className="bg-white rounded-lg border border-indigo-200 p-3 space-y-2">
                      <div className="grid grid-cols-3 gap-2">
                        <select defaultValue={tx.entityId} id={`tx-ent-${tx.id}`} className="text-xs px-2 py-1 border border-gray-200 rounded">
                          <option value="">No entity</option>
                          <EntitySelectOptions entities={entities} />
                        </select>
                        <select defaultValue={tx.accountClass} id={`tx-cls-${tx.id}`} className="text-xs px-2 py-1 border border-gray-200 rounded">
                          <option value="personal">Personal</option>
                          <option value="business">Business</option>
                        </select>
                        <input defaultValue={tx.category} id={`tx-cat-${tx.id}`} placeholder="Category" className="text-xs px-2 py-1 border border-gray-200 rounded" />
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => {
                          handleUpdateTx(tx.id, {
                            entityId: document.getElementById(`tx-ent-${tx.id}`).value,
                            accountClass: document.getElementById(`tx-cls-${tx.id}`).value,
                            category: document.getElementById(`tx-cat-${tx.id}`).value,
                          });
                        }} className="px-3 py-1 text-xs bg-indigo-600 text-white rounded">Save</button>
                        <button onClick={() => setEditingTx(null)} className="px-3 py-1 text-xs text-gray-500">Cancel</button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={tx.id} className={`bg-white rounded-lg border border-gray-100 shadow-sm px-3 py-2.5 flex items-center gap-3 ${tx.type === 'credit' ? 'border-l-4 border-l-green-400' : 'border-l-4 border-l-red-300'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">{tx.description || '(no description)'}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        <span className="text-[10px] text-gray-400">{tx.date}</span>
                        {acct && <span className="text-[10px] text-gray-400">· {acct.name}</span>}
                        {tx.category && <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{tx.category}</span>}
                        {tx.entityId && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${entStyle.bg} ${entStyle.text}`}>{tx.entityId}{ent?.shared ? ' \u{1F517}' : ''}</span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${tx.accountClass === 'business' ? 'bg-indigo-100 text-indigo-600' : 'bg-gray-100 text-gray-500'}`}>
                          {tx.accountClass}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-sm font-bold ${tx.type === 'credit' ? 'text-green-600' : 'text-red-600'}`}>
                        {tx.type === 'credit' ? '+' : '-'}${tx.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </span>
                      <div className="flex flex-col gap-0.5">
                        <button onClick={() => setEditingTx(tx.id)} className="text-[10px] text-indigo-400 hover:text-indigo-600">Edit</button>
                        <button onClick={() => handleDeleteTx(tx.id)} className="text-[10px] text-red-400 hover:text-red-600">Del</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {transactions.length === 0 && !showAddTx && !showImport && (
              <div className="text-center py-12 text-gray-400">
                <DollarIcon className="w-10 h-10 mx-auto mb-2 text-gray-300" />
                <p className="text-sm font-medium text-gray-500">No transactions yet</p>
                <p className="text-xs mt-1">Add a transaction or import from CSV</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD PANEL
// ─────────────────────────────────────────────────────────────────────────────

function SkeletonBlock({ className = '' }) {
  return <div className={`bg-gray-200 rounded-lg animate-pulse ${className}`} />;
}

function DashboardPanel({ tasks, financialTransactions, currentUser, authToken, apiKeys, notes, onNavigate, onAIPrompt, entities, onAddTask, onQuickNote, onLogExpense }) {
  const [digest, setDigest] = useState(null);
  const [digestLoading, setDigestLoading] = useState(true);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  const [timelineSummary, setTimelineSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [ariaBrief, setAriaBrief] = useState(null);
  const [ariaBriefLoading, setAriaBriefLoading] = useState(true);

  const today = new Date().toISOString().slice(0, 10);
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

  // Financial: net cash flow this month
  const netCashFlow = useMemo(() => {
    if (!financialTransactions || financialTransactions.length === 0) return null;
    const monthPrefix = today.slice(0, 7);
    let net = 0;
    financialTransactions.forEach((t) => {
      if (t.date && t.date.startsWith(monthPrefix)) {
        net += parseFloat(t.amount) || 0;
      }
    });
    return net;
  }, [financialTransactions, today]);

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

    // Today's tasks + high priority tasks (no due date treated as EOD)
    const taskSet = new Set();
    overdueTasks.forEach((t) => taskSet.add(t.id));
    [...todayTasks, ...highPriorityTasks.filter((t) => !t.dueDate || t.dueDate === today)].forEach((t) => {
      if (taskSet.has(t.id)) return;
      taskSet.add(t.id);
      items.push({ type: t.priority === 'high' ? 'high' : 'task', time: 'EOD', sortKey: 9999, title: t.title, priority: t.priority, tags: t.tags, id: t.id });
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
    const cacheKey = `aria_brief_${today}_${currentUser?.id || ''}`;
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
    const txSummary = netCashFlow !== null ? `Net ${netCashFlow >= 0 ? '+' : ''}$${Math.abs(netCashFlow).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} this month` : 'No data';
    const entStr = (entities || []).filter((e) => e.type === 'business').map((e) => e.name).join(', ') || 'None';

    console.log('[aria-brief] Generating with context:', {
      overdue: overdueStr, dueToday: dueTodayStr, highPriority: highStr,
      events: eventsStr, cashFlow: txSummary, entities: entStr, notesThisWeek
    });

    const sysPrompt = `You are ${aName}, an Executive Assistant. Write a warm, professional ${tod} brief for ${firstName} in 2-3 sentences. TODAY IS ${dateStr} — ONLY reference events and tasks happening TODAY. Never mention future dates or upcoming events unless explicitly in the data below. Be specific — reference actual data. Write naturally like a real person. No bullet points. Do NOT include a sign-off or signature.`;
    const userMsg = `Write my ${tod} brief.\n\nTODAY'S DATA ONLY:\n- Today's calendar events: ${eventsStr}\n- Overdue tasks: ${overdueStr}\n- Due today: ${dueTodayStr}\n- High priority tasks: ${highStr}\n- This month's net cash flow: ${txSummary}\n- Notes this week: ${notesThisWeek}\n- Active businesses: ${entStr}`;

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
  }, [today, allDataReady, calendarEvents.length, overdueTasks.length, todayTasks.length, highPriorityTasks.length, notesThisWeek, netCashFlow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Digest: load from localStorage cache or fetch
  useEffect(() => {
    const cacheKey = `digest_${today}`;
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

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };
    apiFetch('/api/notes/daily-digest', {
      method: 'POST', headers,
      body: JSON.stringify({ apiKey: apiKeys?.claude || '' }),
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

  return (
    <div className="flex-1 overflow-y-auto px-4 md:px-6 pt-5 pb-6 space-y-5" style={{ minHeight: 0 }}>

      {/* ── ROW 1: Greeting (left 50%) + Stats Pills (right 50%) ── */}
      {(() => {
        const statsData = [
          { icon: '\u26A0\uFE0F', value: overdueTasks.length, label: 'overdue', onClick: () => onNavigate('daily', 'overdue'), color: '#F59E0B', priority: true },
          { icon: '\uD83D\uDD34', value: highPriorityTasks.length, label: 'high pri', onClick: () => onNavigate('daily', 'high'), color: '#EF4444', priority: true },
          { icon: '\uD83D\uDCC5', value: calendarEvents.length, label: 'events', onClick: () => onNavigate('calendar'), color: '#3B82F6', priority: true },
          { icon: '\u2705', value: doneToday, label: 'done', onClick: () => onNavigate('daily', 'done'), color: '#10B981' },
          { icon: '\uD83D\uDCB0', value: netCashFlow !== null ? `${netCashFlow >= 0 ? '+' : ''}$${Math.abs(netCashFlow).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : '\u2014', label: 'month', onClick: () => onNavigate('financials'), color: netCashFlow !== null && netCashFlow >= 0 ? '#10B981' : '#EF4444' },
          { icon: '\uD83D\uDCDD', value: notesThisWeek, label: 'notes', onClick: () => onNavigate('notes'), color: '#8B5CF6' },
        ];
        return (
          <div className="flex items-center" style={{ width: '100%' }}>
            {/* Left 50%: Greeting */}
            <div style={{ width: '50%', flexShrink: 0 }}>
              <h2 className="text-xl md:text-2xl font-bold text-gray-900 leading-tight">
                {greeting}, {firstName} <span style={{ fontWeight: 400, color: '#6B7280', fontSize: 'inherit' }}>&middot; {dateStr}</span>
              </h2>
            </div>
            {/* Right 50%: Stats pills */}
            <div className="flex flex-wrap justify-end items-center overflow-hidden" style={{ width: '50%', gap: 4 }}>
              {statsData.map(({ icon, value, label, onClick, color, priority }) => {
                const isZero = value === 0 || value === '\u2014';
                return (
                  <button
                    key={label}
                    onClick={onClick}
                    className={`inline-flex items-center gap-0.5 cursor-pointer transition-opacity hover:opacity-80 flex-shrink-0${!priority ? ' hidden md:inline-flex' : ''}`}
                    style={{ height: 22, borderRadius: 9999, padding: '0 8px', fontSize: 11, fontWeight: 500, backgroundColor: isZero ? '#E5E7EB' : color, color: isZero ? '#6B7280' : '#fff' }}
                  >
                    <span>{icon}</span>
                    <span>{value} {label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ── ROW 2: Aria Card — 2 columns (brief + actions) ── */}
      <div className="bg-white rounded-xl overflow-hidden" style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.08)', borderRadius: 12 }}>
        <div className="flex flex-col md:flex-row" style={{ alignItems: 'stretch' }}>

          {/* LEFT — AI Brief (60%) */}
          <div className="min-w-0" style={{ flex: '0 0 60%', borderRight: '1px solid #f3f4f6', padding: 20 }}>
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-sm">{'\uD83E\uDD16'}</span>
              <span className="text-xs font-semibold text-gray-500">{assistantName}</span>
            </div>
            {ariaBriefLoading ? (
              <div className="flex items-center gap-2">
                <SpinnerIcon className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                <span className="text-sm text-gray-400">...</span>
              </div>
            ) : ariaBrief ? (
              <p className="text-sm text-gray-700 leading-relaxed">{ariaBrief}</p>
            ) : null}
            {digest && (
              <button onClick={() => onNavigate('notes')} className="mt-2 text-xs font-medium text-purple-600 hover:text-purple-800 transition-colors">
                Read full digest &rarr;
              </button>
            )}
            <p className="text-xs text-gray-400 italic mt-3 text-right">&mdash; {assistantName}</p>
          </div>

          {/* RIGHT — Quick Actions (40%) */}
          <div className="border-t md:border-t-0" style={{ flex: '0 0 40%', padding: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {[
                { icon: '\uFF0B', label: 'Add Task', onClick: onAddTask },
                { icon: '\uFF0B', label: 'Quick Note', onClick: onQuickNote },
                { icon: '\uD83D\uDCC5', label: 'Add Event', onClick: () => onNavigate('calendar') },
                { icon: '\uD83D\uDCB0', label: 'Log Expense', onClick: onLogExpense || (() => onNavigate('financials')) },
              ].map(({ icon, label, onClick }) => (
                <button
                  key={label}
                  onClick={onClick}
                  className="w-full flex items-center justify-center gap-1.5 font-medium text-gray-600 bg-white hover:bg-purple-600 hover:text-white hover:border-purple-600 transition-all"
                  style={{ height: 36, borderRadius: 8, fontSize: 12, border: '1px solid #e5e7eb', transition: 'all 150ms ease' }}
                >
                  <span>{icon}</span> {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Timeline + Digest 50/50 ── */}
      <div className="flex flex-col md:flex-row gap-4" style={{ alignItems: 'stretch' }}>

        {/* Today's Timeline (left) */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-shadow h-full flex flex-col">
            <h3 className="text-sm font-semibold text-gray-900 mb-1 flex items-center gap-2">
              {'\uD83D\uDCC5'} Today&rsquo;s Timeline
            </h3>
            {/* AI one-liner summary */}
            {summaryLoading ? (
              <p className="text-xs text-gray-400 italic mb-3">...</p>
            ) : timelineSummary ? (
              <p className="text-xs text-gray-400 italic mb-3">{timelineSummary}</p>
            ) : null}

            {!tasksReady ? (
              <div className="space-y-3 flex-1">
                {[1,2,3].map((i) => <SkeletonBlock key={i} className="h-10 w-full" />)}
              </div>
            ) : timelineItems.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-sm text-gray-400 py-4">{`Clear day \u2014 great time to get ahead \uD83C\uDFAF`}</p>
              </div>
            ) : (
              <div className="space-y-1 flex-1">
                {timelineItems.slice(0, 6).map((item, i) => (
                  <button
                    key={`${item.type}-${item.id}-${i}`}
                    onClick={() => item.type === 'calendar' ? onNavigate('calendar') : onNavigate('daily')}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-gray-50 transition-colors text-left group"
                  >
                    {/* Time column */}
                    <span className="w-16 flex-shrink-0 text-[11px] font-medium text-gray-400 text-right">
                      {item.type === 'overdue' ? (
                        <span className="text-red-500">{'\u26A0\uFE0F'} OVR</span>
                      ) : item.time}
                    </span>
                    {/* Icon */}
                    <span className="flex-shrink-0 text-sm">
                      {item.type === 'calendar' ? '\uD83D\uDCC5' : item.type === 'high' || item.type === 'overdue' ? '\uD83D\uDD34' : (
                        <span className="inline-block w-2 h-2 rounded-full bg-gray-400" />
                      )}
                    </span>
                    {/* Title */}
                    <span className="text-sm text-gray-800 truncate flex-1 min-w-0">
                      {item.title.length > 35 ? item.title.slice(0, 35) + '\u2026' : item.title}
                    </span>
                    {/* Badge */}
                    <span className="flex-shrink-0">
                      {item.type === 'calendar' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Calendar</span>
                      ) : item.type === 'overdue' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">Overdue</span>
                      ) : item.type === 'high' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">High Pri</span>
                      ) : item.tags ? entityBadge(item.tags) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Task</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {timelineItems.length > 6 && (
              <button onClick={() => onNavigate('daily')} className="mt-2 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition-colors">
                View all {timelineItems.length} items &rarr;
              </button>
            )}
          </div>
        </div>

        {/* Daily Digest (right) */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:shadow-md transition-shadow border-l-4 border-l-purple-500 h-full flex flex-col">
            <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
              {'\uD83E\uDDE0'} Daily Digest <span className="text-gray-400 font-normal">&middot; {dateStr}</span>
            </h3>
            <div className="flex-1">
              {digestLoading ? (
                <div className="flex items-center gap-2 py-3">
                  <SpinnerIcon className="w-4 h-4 animate-spin text-purple-400" />
                  <span className="text-sm text-gray-400">Generating...</span>
                </div>
              ) : digest ? (
                <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                  {digest.content.split('\n').slice(0, 4).join('\n')}
                  {digest.content.split('\n').length > 4 && '\u2026'}
                </div>
              ) : (
                <p className="text-sm text-gray-400 py-2">No digest yet &mdash; check back tomorrow</p>
              )}
            </div>
            {digest && digest.content.split('\n').length > 4 && (
              <button onClick={() => onNavigate('notes')} className="mt-3 text-xs font-medium text-purple-600 hover:text-purple-800 transition-colors">
                Read full digest &rarr;
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Pillar Strip ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

        {/* Hustle */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 hover:shadow-md transition-shadow">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
            <h4 className="text-sm font-semibold text-gray-900">Hustle</h4>
          </div>
          {!tasksReady ? (
            <div className="space-y-2"><SkeletonBlock className="h-4 w-3/4" /><SkeletonBlock className="h-4 w-1/2" /><SkeletonBlock className="h-4 w-2/3" /></div>
          ) : (
            <div className="space-y-1.5 text-sm">
              <p className={highPriorityTasks.length > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}>
                {highPriorityTasks.length} high priority
              </p>
              <p className={overdueTasks.length > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}>
                {overdueTasks.length} overdue
              </p>
              <p className={netCashFlow !== null ? (netCashFlow >= 0 ? 'text-green-600 font-medium' : 'text-red-600 font-medium') : 'text-gray-400'}>
                {netCashFlow !== null
                  ? `${netCashFlow >= 0 ? '+' : ''}$${Math.abs(netCashFlow).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} this month`
                  : '\u2014'}
              </p>
            </div>
          )}
          <button onClick={() => onNavigate('daily')} className="mt-3 text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors">
            View Tasks &rarr;
          </button>
        </div>

        {/* Home */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 hover:shadow-md transition-shadow">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            <h4 className="text-sm font-semibold text-gray-900">Home</h4>
          </div>
          {!tasksReady ? (
            <div className="space-y-2"><SkeletonBlock className="h-4 w-3/4" /><SkeletonBlock className="h-4 w-1/2" /><SkeletonBlock className="h-4 w-2/3" /></div>
          ) : (
            <div className="space-y-1.5 text-sm">
              <p className="text-gray-500">No events today</p>
              <p className="text-gray-400">&mdash;</p>
              <p className="text-gray-500">{todayTasks.length} task{todayTasks.length !== 1 ? 's' : ''} due today</p>
            </div>
          )}
          <button onClick={() => onNavigate('calendar')} className="mt-3 text-xs font-medium text-green-600 hover:text-green-800 transition-colors">
            View Calendar &rarr;
          </button>
        </div>

        {/* Grow */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 hover:shadow-md transition-shadow">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-purple-500" />
            <h4 className="text-sm font-semibold text-gray-900">Grow</h4>
          </div>
          {notes.length === 0 && !tasksReady ? (
            <div className="space-y-2"><SkeletonBlock className="h-4 w-3/4" /><SkeletonBlock className="h-4 w-1/2" /><SkeletonBlock className="h-4 w-2/3" /></div>
          ) : (
            <div className="space-y-1.5 text-sm">
              <p className="text-gray-500">{notesThisWeek} note{notesThisWeek !== 1 ? 's' : ''} this week</p>
              <p className="text-gray-400 truncate">{latestNote ? (latestNote.content || '').slice(0, 40) : 'No notes yet'}</p>
              <p className={digest ? 'text-purple-600 font-medium' : 'text-gray-400'}>
                {digest ? 'Daily Digest ready \u2728' : 'No digest yet'}
              </p>
            </div>
          )}
          <button onClick={() => onNavigate('notes')} className="mt-3 text-xs font-medium text-purple-600 hover:text-purple-800 transition-colors">
            View Notes &rarr;
          </button>
        </div>

        {/* Move (placeholder) */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 opacity-60">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full bg-orange-400" />
            <h4 className="text-sm font-semibold text-gray-500">Move</h4>
          </div>
          <div className="space-y-1.5 text-sm">
            <p className="text-gray-400">Coming soon</p>
            <p className="text-gray-400">Workouts &amp; health tracking</p>
            <p className="text-gray-400">&mdash;</p>
          </div>
          <span className="mt-3 inline-block text-xs font-medium text-gray-300 cursor-not-allowed">
            View Move &rarr;
          </span>
        </div>
      </div>

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
  financials: 'hustle',
};

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

function NotesPanel({ authToken, onEditorStateChange, onCategoriesLoaded, onNotesLoaded, quickCapturedNote, addToast }) {
  const [notes, setNotes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pillarFilter, setPillarFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [selectedNote, setSelectedNote] = useState(null);
  const [editorData, setEditorData] = useState({ title: '', content: '', pillar: '', category: '', subcategory: '', tags: '' });
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
    if (pillarFilter) params.set('pillar', pillarFilter);
    if (categoryFilter) params.set('category', categoryFilter);
    try {
      const res = await apiFetch(`/api/notes?${params}`, { headers: { Authorization: `Bearer ${authToken}` } });
      const data = await res.json();
      if (Array.isArray(data)) setNotes(data);
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
    setEditorData({ title: '', content: '', pillar: pillarFilter || '', category: '', subcategory: '', tags: '' });
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

  const displayNotes = searchResults !== null ? searchResults : notes;

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
      <div className={`w-full md:w-[260px] flex-shrink-0 border-r border-gray-100 flex flex-col bg-white ${selectedNote ? 'hidden md:flex' : 'flex'}`}>
        {/* Search bar */}
        <div className="px-3 pt-3 pb-1">
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none">🔍</span>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes..."
              className="w-full pl-8 pr-7 py-1.5 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-purple-300"
              style={{ height: 36, fontSize: 14 }}
            />
            {searchQuery && (
              <button type="button" onClick={() => { setSearchQuery(''); setSearchResults(null); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">✕</button>
            )}
          </div>
          {searchResults !== null && (
            <div className="text-[10px] text-gray-400 mt-1 px-1">{searchResults.length} note{searchResults.length !== 1 ? 's' : ''} found</div>
          )}
        </div>

        {/* New Note button */}
        <div className="px-3 pb-2 pt-1">
          <button type="button" onClick={handleNewNote}
            className="w-full px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition-colors flex items-center justify-center gap-2">
            <span className="text-lg leading-none">+</span> New Note
          </button>
        </div>

        {/* Pillar filter pills — slim row */}
        <div className="px-3 pb-2 flex gap-1 flex-wrap">
          <button type="button" onClick={() => { setPillarFilter(''); setCategoryFilter(''); }}
            className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-all ${!pillarFilter ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
            All
          </button>
          {Object.entries(PILLAR_CONFIG).map(([key, cfg]) => (
            <button type="button" key={key} onClick={() => { setPillarFilter(pillarFilter === key ? '' : key); setCategoryFilter(''); }}
              className={`px-2 py-0.5 rounded-full text-[11px] font-medium transition-all ${pillarFilter === key ? `${cfg.bg} ${cfg.text}` : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
              {cfg.label}
            </button>
          ))}
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
                      className={`group w-full text-left px-3 py-2.5 transition-colors flex items-start gap-2 ${isActive ? 'bg-purple-50 border-l-2 border-purple-500' : 'hover:bg-gray-50 border-l-2 border-transparent'}`}
                      style={{ minHeight: 56 }}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          {note.pinned && <span className="text-[10px]">📌</span>}
                          <span className="text-sm font-medium text-gray-800 truncate block" style={{ maxWidth: '100%' }}>
                            {searchQuery && titleText.toLowerCase().includes(searchQuery.toLowerCase())
                              ? highlightMatch(titleText.slice(0, 30), searchQuery)
                              : titleText.slice(0, 30)}
                          </span>
                        </div>
                        <div className="text-[11px] text-gray-400 mt-0.5 truncate">
                          {metaParts.join(' · ')}
                        </div>
                      </div>
                      {note.id && (
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 relative"
                          onClick={(e) => e.stopPropagation()}
                          onMouseDown={(e) => e.stopPropagation()}
                        >
                          <button type="button" tabIndex={-1}
                            onClick={(e) => { e.stopPropagation(); setShowDeleteConfirm(showDeleteConfirm === note.id ? false : note.id); }}
                            className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 text-xs"
                            title="More options">···</button>
                          {showDeleteConfirm === note.id && (
                            <div className="absolute right-0 top-7 z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[120px]">
                              <button type="button" tabIndex={-1}
                                onClick={(e) => { e.stopPropagation(); handleDelete(note.id); }}
                                className="w-full text-left px-3 py-1.5 text-xs text-red-600 hover:bg-red-50">
                                Delete note
                              </button>
                            </div>
                          )}
                        </div>
                      )}
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
        <div className="flex-1 flex flex-col overflow-hidden md:border-l md:border-gray-100">
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
// GOOGLE CALENDAR PANEL
// ─────────────────────────────────────────────────────────────────────────────

function CalendarPanel({ currentUser, addToast }) {
  const [gcalStatus, setGcalStatus] = useState({ connected: false, email: null });
  const [loading, setLoading]       = useState(true);

  // Check connection status on mount and after OAuth redirect
  useEffect(() => {
    checkStatus();
    // Handle ?gcal=connected redirect from OAuth callback
    const params = new URLSearchParams(window.location.search);
    if (params.get('gcal') === 'connected') {
      window.history.replaceState({}, '', window.location.pathname);
      checkStatus();
      addToast({ type: 'success', message: 'Google Calendar connected!' });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function checkStatus() {
    setLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/api/gcal/status?userId=${currentUser.id}`);
      const data = await res.json();
      setGcalStatus(data);
    } catch {
      setGcalStatus({ connected: false });
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    try {
      const res = await apiFetch(`${API_BASE}/api/gcal/auth-url?userId=${currentUser.id}`);
      const data = await res.json();
      if (data.error) {
        addToast({ type: 'error', message: data.error });
        return;
      }
      window.location.href = data.url;
    } catch (err) {
      addToast({ type: 'error', message: 'Failed to start Google sign-in' });
    }
  }

  async function handleDisconnect() {
    try {
      await apiFetch(`${API_BASE}/api/gcal/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id }),
      });
      setGcalStatus({ connected: false, email: null });
      addToast({ type: 'success', message: 'Google Calendar disconnected' });
    } catch {
      addToast({ type: 'error', message: 'Failed to disconnect' });
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400">
        <SpinnerIcon className="w-6 h-6 animate-spin" />
      </div>
    );
  }

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

  // Connected — show embedded calendar
  // Build a public embeddable Google Calendar URL for the user's primary calendar
  const calendarSrc = `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(gcalStatus.email)}&ctz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Connection status bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-green-50 border-b border-green-100 flex-shrink-0">
        <div className="flex items-center gap-2 text-xs text-green-700">
          <span className="w-2 h-2 bg-green-500 rounded-full" />
          Connected as {gcalStatus.email}
        </div>
        <button
          onClick={handleDisconnect}
          className="text-xs text-gray-400 hover:text-red-500 transition-colors font-medium"
        >
          Disconnect
        </button>
      </div>
      {/* Calendar iframe (desktop) / Open button (mobile) */}
      <iframe
        src={calendarSrc}
        className="flex-1 w-full border-0 hidden md:block"
        title="Google Calendar"
      />
      <div className="flex-1 flex flex-col items-center justify-center px-6 md:hidden">
        <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center mb-4">
          <CalendarIcon className="w-8 h-8 text-indigo-600" />
        </div>
        <h3 className="text-lg font-bold text-gray-900 mb-2">Your Calendar</h3>
        <p className="text-sm text-gray-500 mb-6 max-w-xs text-center">
          View and manage your Google Calendar events in a new tab.
        </p>
        <a
          href={`https://calendar.google.com/calendar/r?authuser=${encodeURIComponent(gcalStatus.email)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-3 px-6 py-3 bg-indigo-600 text-white rounded-xl shadow-sm hover:bg-indigo-700 transition-colors text-sm font-medium min-h-[48px]"
        >
          <CalendarIcon className="w-5 h-5" />
          Open Google Calendar
        </a>
      </div>
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
  const [showSettings, setShowSettings]         = useState(false);
  const [showAlerts, setShowAlerts]             = useState(false);
  const [apiKeys, setApiKeys]                   = useState({ claude: '', openai: '' });
  const [emailSettings, setEmailSettings]       = useState({
    gmailUser: '',
    gmailAppPassword: '',
    recipientEmail: '',
  });
  const [alertRules, setAlertRules]             = useState(DEFAULT_ALERT_RULES);
  const [toasts, setToasts]                     = useState([]);
  const [gcalConnected, setGcalConnected]       = useState(false);
  const [envConfigured, setEnvConfigured]       = useState({});
  const [mobileView, setMobileView]            = useState('tasks'); // 'tasks' | 'chat' | 'calendar' | 'financials' | 'notes'
  const [entities, setEntities]                 = useState([]);
  const [financialTransactions, setFinancialTransactions] = useState([]);
  const [financialAccounts, setFinancialAccounts] = useState([]);
  const firedAlertsRef                          = useRef(new Set());

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
  const [chatLoading, setChatLoading]           = useState(false);
  const [chatPanelOpen, setChatPanelOpen]       = useState(false);

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
    // Load financial data for AI context
    apiFetch('/api/financial/transactions', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setFinancialTransactions(data); })
      .catch(() => {});
    apiFetch('/api/financial/accounts', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setFinancialAccounts(data); })
      .catch(() => {});
    // Load notes for dashboard
    apiFetch('/api/notes', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setDashboardNotes(data); })
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

  function reloadFinancialData() {
    apiFetch('/api/financial/transactions', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setFinancialTransactions(data); })
      .catch(() => {});
    apiFetch('/api/financial/accounts', { headers: { Authorization: `Bearer ${authToken}` } })
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setFinancialAccounts(data); })
      .catch(() => {});
  }

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

  async function handleChatSend() {
    const text = chatInput.trim();
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
    const sysPrompt = buildSystemPrompt(tasks, userEntities, financialAccounts, financialTransactions, allNotes);
    try {
      let reply;
      if (chatBackend === 'claude') {
        reply = await callClaudeChat(updatedMessages, sysPrompt, apiKeys.claude, authToken);
      } else {
        reply = await callOpenAIChat(updatedMessages, sysPrompt, apiKeys.openai, authToken);
      }
      const assistantMsg = { role: 'assistant', content: reply };
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

  // Handle chatInitialMsg from Dashboard
  useEffect(() => {
    if (chatInitialMsg) {
      setChatInput(chatInitialMsg);
      setChatInitialMsg('');
    }
  }, [chatInitialMsg]);

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
        if (data.alertRules)    setAlertRules(data.alertRules);
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

  function addToast(t) {
    const id = uid();
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setToasts((prev) => prev.filter((x) => x.id !== id)), 5000);
  }

  function dismissToast(id) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  // Evaluate rules on mount (catches session-scoped digest) + every 60 s
  useEffect(() => {
    runAlertRules(
      tasksRef.current, alertRulesRef.current,
      emailSettingsRef.current, firedAlertsRef, addToast,
    );
    const id = setInterval(() => {
      runAlertRules(
        tasksRef.current, alertRulesRef.current,
        emailSettingsRef.current, firedAlertsRef, addToast,
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
      const res = await apiFetch(`${API_BASE}/api/gcal/sync-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: currentUser.id,
          title: task.title,
          description: task.description || '',
          dueDate: task.dueDate,
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
    setTasks((prev) => [task, ...prev]);
  }

  function toggleTask(id) {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)),
    );
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
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-200 px-3 md:px-6 py-2.5 md:py-3.5 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="w-8 h-8 md:w-9 md:h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-sm">
            <ChecklistIcon className="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm md:text-base font-bold text-gray-900 leading-none">Dizon.ai</h1>
            <p className="hidden md:block text-[11px] text-gray-400 mt-0.5">Life OS for high performers</p>
          </div>
        </div>

        <div className="flex items-center gap-1 md:gap-2">
          <span className="hidden sm:inline-flex text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full font-medium">
            {visibleTasks.filter((t) => !t.completed).length} active ·{' '}
            {visibleTasks.filter((t) => t.completed).length} done
          </span>

          {/* Bell — alert rules */}
          <button
            onClick={() => setShowAlerts(true)}
            className="relative p-2 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            title="Alert rules"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            {enabledRulesCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-indigo-600 rounded-full" />
            )}
          </button>

          {/* Gear — settings */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            title="Settings"
          >
            <GearIcon className="w-5 h-5" />
          </button>

          {/* User badge + Logout */}
          <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-gray-200">
            <span className="hidden md:inline text-xs font-medium text-gray-600 bg-indigo-50 px-2 py-1 rounded-full">
              {currentUser.displayName}
            </span>
            <button
              onClick={onLogout}
              className="p-1.5 min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="Sign out"
            >
              <LogoutIcon className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* ── Main layout ── */}
      <main className="flex flex-col overflow-hidden" style={{ height: 'calc(100vh - 49px)', minHeight: 0 }}>
        {/* Sticky prompt bar — always visible on all tabs */}
        <UniversalPromptBar
          input={chatInput}
          onInputChange={setChatInput}
          backend={chatBackend}
          onBackendChange={setChatBackend}
          onSend={handleChatSend}
          loading={chatLoading}
          activeTab={window.innerWidth >= 768 ? activeView : mobileView}
        />

        {/* Content row */}
        <div className="flex flex-col md:flex-row flex-1 pb-20 md:pb-6 overflow-hidden" style={{ minHeight: 0 }}>
        {/* ── Left: Task panel (shrinks when sliding chat is open) ── */}
        <section
          className={`flex-col md:border-r border-gray-200 overflow-hidden w-full ${
            mobileView === 'tasks' ? 'flex' : 'hidden md:flex'
          }`}
          style={{ flex: chatPanelOpen && activeView !== 'chat' ? '0 0 75%' : '1 1 100%', transition: 'flex 0.2s', minHeight: 0 }}
        >
          {/* View Tabs — calendar tab hidden on mobile (use bottom nav) */}
          <div className="bg-white border-b border-gray-100 px-4 md:px-6 pt-3 md:pt-4 pb-0 flex-shrink-0">
            <div className="flex gap-1 w-fit">
              {[
                { key: 'dashboard', label: 'Dashboard' },
                { key: 'daily', label: 'Daily Tasks' },
                { key: 'calendar', label: 'Calendar', desktopOnly: true },
                { key: 'financials', label: 'Financials', desktopOnly: true },
                { key: 'notes', label: 'Notes', desktopOnly: true },
                { key: 'chat', label: 'Chat', desktopOnly: true },
              ].map(({ key, label, desktopOnly }) => (
                <button
                  key={key}
                  onClick={() => setActiveView(key)}
                  className={`px-3 md:px-4 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px items-center gap-1.5 ${
                    desktopOnly ? 'hidden md:flex' : 'flex'
                  } ${
                    activeView === key
                      ? 'border-indigo-600 text-indigo-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-200'
                  }`}
                >
                  {key === 'calendar' && <CalendarIcon className="w-3.5 h-3.5" />}
                  {key === 'financials' && <DollarIcon className="w-3.5 h-3.5" />}
                  {key === 'notes' && <NotesIcon className="w-3.5 h-3.5" />}
                  {key === 'chat' && <ChatIcon className="w-3.5 h-3.5" />}
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* View routing */}
          {activeView === 'dashboard' ? (
            <DashboardPanel
              tasks={tasks}
              financialTransactions={financialTransactions}
              currentUser={currentUser}
              authToken={authToken}
              apiKeys={apiKeys}
              notes={dashboardNotes}
              entities={userEntities}
              onNavigate={(view, filter) => {
                setActiveView(view);
                if (window.innerWidth < 768) {
                  if (view === 'calendar') setMobileView('calendar');
                  else if (view === 'financials') setMobileView('financials');
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
              }}
              onAddTask={() => { setActiveView('daily'); }}
              onQuickNote={() => { document.querySelector('[aria-label="Quick Capture"]')?.click(); }}
              onLogExpense={() => { setActiveView('financials'); if (window.innerWidth < 768) setMobileView('financials'); }}
            />
          ) : activeView === 'calendar' ? (
            <CalendarPanel currentUser={currentUser} addToast={addToast} />
          ) : activeView === 'financials' ? (
            <FinancialsPanel authToken={authToken} currentUser={currentUser} entities={userEntities} onDataChange={reloadFinancialData} />
          ) : activeView === 'notes' ? (
            <NotesPanel authToken={authToken} onEditorStateChange={setNotesEditorOpen} onCategoriesLoaded={setNoteCategories} onNotesLoaded={setAllNotes} quickCapturedNote={quickCapturedNote} addToast={addToast} />
          ) : activeView === 'chat' ? (
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
          ) : (
          /* Scrollable task content */
          <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4 md:py-5">
            <AddTaskForm onAdd={addTask} claudeKey={apiKeys.claude} currentUser={currentUser} entities={userEntities} authToken={authToken} />
            <FilterBar
              activeTagFilters={activeTagFilters}
              setActiveTagFilters={setActiveTagFilters}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              entities={userEntities}
            />

            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-gray-400">
                {filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}
                {activeView === 'priority' ? ' (high priority)' : ''}
              </span>
              {completedCount > 0 && (
                <span className="text-xs text-gray-400">{completedCount} completed</span>
              )}
            </div>

            <div className="space-y-2.5">
              {filteredTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-gray-400">
                  <div className="text-5xl mb-3">✓</div>
                  <p className="text-sm font-medium text-gray-500">
                    {activeView === 'priority' ? 'No high-priority tasks' : 'No tasks here'}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {activeTagFilters.length > 0 || statusFilter !== 'all'
                      ? 'Try clearing filters'
                      : 'Click "Add new task" above'}
                  </p>
                </div>
              ) : (
                filteredTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                    onEdit={editTask}
                    onToggleVisibility={toggleVisibility}
                    onSyncCalendar={handleSyncToCalendar}
                    currentUser={currentUser}
                    gcalConnected={gcalConnected}
                    entities={userEntities}
                  />
                ))
              )}
            </div>
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
              contextBadge={`${tasks.filter((t) => !t.completed).length} tasks · ${financialTransactions.length} transactions${allNotes.filter((n) => !n.archived && n.content).length > 0 ? ` · ${allNotes.filter((n) => !n.archived && n.content).length} note${allNotes.filter((n) => !n.archived && n.content).length !== 1 ? 's' : ''}` : ''}`}
              onHide={toggleChatPanel}
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
          <CalendarPanel currentUser={currentUser} addToast={addToast} />
        </section>

        {/* ── Financials panel (mobile only — on desktop it's in the task section tabs) ── */}
        <section
          className={`flex-col overflow-hidden w-full md:hidden ${
            mobileView === 'financials' ? 'flex' : 'hidden'
          }`}
        >
          <FinancialsPanel authToken={authToken} currentUser={currentUser} entities={userEntities} onDataChange={reloadFinancialData} />
        </section>

        {/* ── Notes panel (mobile only — on desktop it's in the task section tabs) ── */}
        <section
          className={`flex-col overflow-hidden w-full md:hidden ${
            mobileView === 'notes' ? 'flex' : 'hidden'
          }`}
        >
          <NotesPanel authToken={authToken} onEditorStateChange={setNotesEditorOpen} onCategoriesLoaded={setNoteCategories} onNotesLoaded={setAllNotes} quickCapturedNote={quickCapturedNote} addToast={addToast} />
        </section>
        </div>{/* end content row */}
      </main>

      {/* ── Mobile bottom navigation ── */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex z-40 safe-area-bottom">
        {[
          { key: 'tasks', label: 'Tasks', icon: <ChecklistIcon className="w-5 h-5" /> },
          { key: 'chat', label: 'Chat', icon: <ChatIcon className="w-5 h-5" /> },
          { key: 'calendar', label: 'Calendar', icon: <CalendarIcon className="w-5 h-5" /> },
          { key: 'financials', label: 'Financials', icon: <DollarIcon className="w-5 h-5" /> },
          { key: 'notes', label: 'Notes', icon: <NotesIcon className="w-5 h-5" /> },
        ].map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => {
              setMobileView(key);
              if (key === 'tasks' && (activeView === 'calendar' || activeView === 'financials' || activeView === 'notes')) setActiveView('dashboard');
            }}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 min-h-[56px] text-xs font-medium transition-colors ${
              mobileView === key
                ? 'text-indigo-600'
                : 'text-gray-400 active:text-gray-600'
            }`}
          >
            {icon}
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {/* ── Modals ── */}
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
        />
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

      {/* ── Toast notifications ── */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
