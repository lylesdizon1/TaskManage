import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TAGS = ['Careific', 'Rose', 'Buyflip', 'Care Home', 'Personal'];

const TAG_STYLES = {
  Careific:    'bg-indigo-100 text-indigo-700 border-indigo-200',
  Rose:        'bg-pink-100   text-pink-700   border-pink-200',
  Buyflip:     'bg-amber-100  text-amber-700  border-amber-200',
  'Care Home': 'bg-teal-100   text-teal-700   border-teal-200',
  Personal:    'bg-slate-100  text-slate-600  border-slate-200',
};

const TAG_ACTIVE_RING = {
  Careific:    'ring-indigo-400',
  Rose:        'ring-pink-400',
  Buyflip:     'ring-amber-400',
  'Care Home': 'ring-teal-400',
  Personal:    'ring-slate-400',
};

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
    <span style="color:#9ca3af;font-size:11px;font-weight:500;">TaskManage Alerts</span>
    <span style="color:#9ca3af;font-size:11px;">${new Date().toLocaleString()}</span>
  </div>
</div>
</body></html>`;
}

/** POST to /api/email/send via the local proxy. */
async function sendAlertEmail(emailSettings, to, subject, html) {
  const res = await fetch('/api/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      gmailUser: emailSettings.gmailUser,
      gmailAppPassword: emailSettings.gmailAppPassword,
      to,
      subject,
      html,
    }),
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
  const { gmailUser, gmailAppPassword, recipientEmail } = emailSettings;
  if (!gmailUser || !gmailAppPassword || !recipientEmail) return;

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
    const subject = `[TaskManage] ${rule.name} — ${count} task${count !== 1 ? 's' : ''}`;
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

async function fetchSuggestedTags(title, description, claudeKey) {
  if (!claudeKey || !title.trim()) return [];

  const prompt =
    `Given these business categories: Careific (AI care management SaaS platform), ` +
    `Rose (a specific care home facility), Buyflip (a separate business venture), ` +
    `Care Home (general care home operations), Personal (personal tasks). ` +
    `Based on this task title and description: '${title} - ${description}', ` +
    `suggest which tags apply. Respond ONLY with a JSON array of matching tag names, ` +
    `e.g. ["Careific", "Personal"]. No explanation.`;

  try {
    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    return parsed.filter((t) => TAGS.includes(t));
  } catch {
    return [];
  }
}

async function callClaudeChat(messages, systemPrompt, apiKey) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

async function callOpenAIChat(messages, systemPrompt, apiKey) {
  const res = await fetch('/api/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
// TAG PILL
// ─────────────────────────────────────────────────────────────────────────────

function TagPill({ tag, isAi = false }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium border ${TAG_STYLES[tag]}`}
    >
      {tag}
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
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm">
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

function SettingsModal({ apiKeys, onSave, emailSettings, onSaveEmail, onClose }) {
  const [tab, setTab]               = useState('keys');
  const [draftKeys, setDraftKeys]   = useState({ ...apiKeys });
  const [draftEmail, setDraftEmail] = useState({ ...emailSettings });
  const [testing, setTesting]       = useState(false);
  const [testResult, setTestResult] = useState(null);

  function handleKeyDown(e) {
    if (e.key === 'Escape') onClose();
  }

  async function handleTestConnection() {
    if (!draftEmail.gmailUser || !draftEmail.gmailAppPassword) {
      setTestResult({ ok: false, msg: 'Enter Gmail address and App Password first.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gmailUser: draftEmail.gmailUser,
          gmailAppPassword: draftEmail.gmailAppPassword,
        }),
      });
      const data = await res.json();
      setTestResult(
        res.ok ? { ok: true, msg: 'Connection verified!' } : { ok: false, msg: data.error || 'Failed' },
      );
    } catch (err) {
      setTestResult({ ok: false, msg: err.message });
    } finally {
      setTesting(false);
    }
  }

  const inputCls =
    'w-full px-3 py-2 bg-gray-100 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition';

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50"
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4">
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
        <div className="flex border-b border-gray-100 mx-6">
          {[
            { key: 'keys',  label: 'API Keys' },
            { key: 'email', label: 'Email & Alerts' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px ${
                tab === key
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="px-6 py-5">
          {/* API Keys tab */}
          {tab === 'keys' && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                Keys are stored in memory only and never persisted beyond this session.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Claude API Key</label>
                <input
                  type="password"
                  value={draftKeys.claude}
                  onChange={(e) => setDraftKeys((k) => ({ ...k, claude: e.target.value }))}
                  placeholder="sk-ant-api03-..."
                  autoComplete="off"
                  className={inputCls}
                />
                <p className="text-xs text-gray-400 mt-1">AI tag suggestions + Claude chat</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">OpenAI API Key</label>
                <input
                  type="password"
                  value={draftKeys.openai}
                  onChange={(e) => setDraftKeys((k) => ({ ...k, openai: e.target.value }))}
                  placeholder="sk-..."
                  autoComplete="off"
                  className={inputCls}
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
              <p className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                Use a Gmail <strong>App Password</strong> — not your account password.
                Generate one at <span className="font-mono text-blue-700">myaccount.google.com → Security → App passwords</span>.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Gmail Address</label>
                <input
                  type="email"
                  value={draftEmail.gmailUser}
                  onChange={(e) => { setDraftEmail((s) => ({ ...s, gmailUser: e.target.value })); setTestResult(null); }}
                  placeholder="you@gmail.com"
                  autoComplete="off"
                  className={inputCls}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">App Password</label>
                <input
                  type="password"
                  value={draftEmail.gmailAppPassword}
                  onChange={(e) => { setDraftEmail((s) => ({ ...s, gmailAppPassword: e.target.value })); setTestResult(null); }}
                  placeholder="xxxx xxxx xxxx xxxx"
                  autoComplete="off"
                  className={inputCls}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Default Alert Recipient
                </label>
                <input
                  type="email"
                  value={draftEmail.recipientEmail}
                  onChange={(e) => setDraftEmail((s) => ({ ...s, recipientEmail: e.target.value }))}
                  placeholder="alerts@example.com"
                  autoComplete="off"
                  className={inputCls}
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
                  disabled={testing}
                  className="flex-1 px-4 py-2.5 border border-gray-200 rounded-xl text-gray-700 hover:bg-gray-50 font-medium text-sm transition-colors disabled:opacity-50"
                >
                  {testing ? 'Testing…' : 'Test Connection'}
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
  condition: { type: 'overdue', hours: 24, tag: TAGS[0] },
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

function AlertsModal({ rules, onUpdateRules, emailSettings, tasks, firedAlertsRef, addToast, onClose }) {
  const [showAdd, setShowAdd]       = useState(false);
  const [newRule, setNewRule]       = useState(EMPTY_NEW_RULE);
  const [evaluating, setEvaluating] = useState(false);
  const [sending, setSending]       = useState(false);

  const emailConfigured =
    emailSettings.gmailUser && emailSettings.gmailAppPassword && emailSettings.recipientEmail;

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
      addToast({ type: 'error', message: 'Configure email credentials in Settings first' });
      return;
    }
    setEvaluating(true);
    await runAlertRules(tasks, rules, emailSettings, firedAlertsRef, addToast);
    setEvaluating(false);
  }

  async function handleSendTest() {
    if (!emailConfigured) {
      addToast({ type: 'error', message: 'Configure email credentials in Settings first' });
      return;
    }
    setSending(true);
    try {
      const sampleTasks = tasks.filter((t) => !t.completed).slice(0, 3);
      const html = buildEmailHtml(
        'Test Email',
        'This is a test from TaskManage',
        sampleTasks.length ? sampleTasks : tasks.slice(0, 2),
      );
      await sendAlertEmail(
        emailSettings,
        emailSettings.recipientEmail,
        '[TaskManage] Test Email',
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
              : 'Configure Gmail credentials in Settings → Email & Alerts to activate'}
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
                      value={newRule.condition.tag || TAGS[0]}
                      onChange={(e) =>
                        setNewRule((r) => ({
                          ...r,
                          condition: { ...r.condition, tag: e.target.value },
                        }))
                      }
                      className="flex-1 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      {TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
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

function AddTaskForm({ onAdd, claudeKey }) {
  const emptyForm = {
    title: '',
    description: '',
    priority: 'medium',
    dueDate: '',
    tags: [],
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
      const suggested = await fetchSuggestedTags(title, desc, claudeKey);
      setSuggesting(false);
      if (suggested.length > 0) {
        setAiSuggested(suggested);
        setForm((f) => ({
          ...f,
          tags: [...new Set([...f.tags, ...suggested])],
        }));
      }
    },
    [claudeKey],
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
          className="w-full flex items-center gap-2 px-4 py-3 bg-white border-2 border-dashed border-gray-200 rounded-xl text-gray-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/30 transition-all text-sm font-medium group"
        >
          <span className="w-5 h-5 rounded-full bg-gray-100 group-hover:bg-indigo-100 flex items-center justify-center text-base leading-none transition-colors">
            +
          </span>
          Add new task
        </button>
      ) : (
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-xl border border-gray-200 shadow-sm p-5"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900">New Task</h3>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setForm(emptyForm);
                setAiSuggested([]);
              }}
              className="text-gray-300 hover:text-gray-500 transition-colors"
            >
              <XIcon className="w-4 h-4" />
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
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
            />

            {/* Description */}
            <textarea
              placeholder="Description (optional) — helps AI suggest tags"
              value={form.description}
              onChange={handleDescChange}
              onBlur={handleBlur}
              rows={2}
              className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition resize-none"
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
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
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
                  className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition"
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
                {TAGS.map((tag) => {
                  const isSelected = form.tags.includes(tag);
                  const isAiPick = aiSuggested.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag(tag)}
                      className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium border transition-all ${
                        isSelected
                          ? `${TAG_STYLES[tag]} ring-2 ring-offset-1 ${TAG_ACTIVE_RING[tag]}`
                          : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-100'
                      }`}
                    >
                      {tag}
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

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setIsOpen(false);
                  setForm(emptyForm);
                  setAiSuggested([]);
                }}
                className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-50 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium transition-colors shadow-sm"
              >
                Add Task
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK CARD
// ─────────────────────────────────────────────────────────────────────────────

function TaskCard({ task, onToggle, onDelete }) {
  const overdue =
    task.dueDate && !task.completed && new Date(task.dueDate) < new Date();

  return (
    <div
      className={`bg-white rounded-xl border border-gray-100 shadow-sm p-4 ${PRIORITY_BORDER[task.priority]} transition-opacity ${
        task.completed ? 'opacity-55' : 'opacity-100'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <label className="flex items-center mt-0.5 cursor-pointer">
          <input
            type="checkbox"
            checked={task.completed}
            onChange={() => onToggle(task.id)}
            className="w-4 h-4 accent-indigo-600 rounded cursor-pointer"
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
            <button
              onClick={() => onDelete(task.id)}
              className="flex-shrink-0 text-gray-200 hover:text-red-400 transition-colors mt-0.5"
              title="Delete task"
            >
              <XIcon className="w-4 h-4" />
            </button>
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
                <TagPill key={tag} tag={tag} />
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
}) {
  const hasFilters = activeTagFilters.length > 0 || statusFilter !== 'all';

  return (
    <div className="bg-white border border-gray-100 rounded-xl px-3 py-2.5 mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
          Filter
        </span>

        {/* Tag filters */}
        {TAGS.map((tag) => {
          const active = activeTagFilters.includes(tag);
          return (
            <button
              key={tag}
              onClick={() =>
                setActiveTagFilters((f) =>
                  active ? f.filter((t) => t !== tag) : [...f, tag],
                )
              }
              className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-all ${
                active
                  ? `${TAG_STYLES[tag]} ring-2 ring-offset-1 ${TAG_ACTIVE_RING[tag]}`
                  : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100 hover:text-gray-600'
              }`}
            >
              {tag}
            </button>
          );
        })}

        {/* Divider */}
        <span className="text-gray-200">|</span>

        {/* Status filters */}
        {[
          { key: 'all', label: 'All' },
          { key: 'active', label: 'Active' },
          { key: 'done', label: 'Done' },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`text-xs px-2.5 py-1 rounded-full font-medium border transition-all ${
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
            className="text-xs text-indigo-500 hover:text-indigo-700 font-medium ml-1 transition-colors"
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

function ChatPanel({ tasks, apiKeys }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [backend, setBackend] = useState('claude');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [input]);

  const currentKey = backend === 'claude' ? apiKeys.claude : apiKeys.openai;
  const hasKey = Boolean(currentKey);

  function buildSystemPrompt() {
    const taskSummary = tasks.map((t) => ({
      title: t.title,
      priority: t.priority,
      tags: t.tags,
      completed: t.completed,
      dueDate: t.dueDate || null,
    }));
    return (
      `You are a business productivity assistant managing multiple ventures. ` +
      `Businesses: Careific (care management SaaS), Rose (care home facility), ` +
      `Buyflip (separate venture), Care Home (operations), Personal. ` +
      `Current tasks with tags: ${JSON.stringify(taskSummary)}. ` +
      `Help the user prioritize, plan, and delegate across their businesses.`
    );
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    if (!hasKey) {
      setMessages((m) => [
        ...m,
        { role: 'user', content: text },
        {
          role: 'assistant',
          content: `⚠️ No ${backend === 'claude' ? 'Claude' : 'OpenAI'} API key set. Open Settings (gear icon) to add one.`,
        },
      ]);
      setInput('');
      return;
    }

    const userMsg = { role: 'user', content: text };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput('');
    setLoading(true);
    setError('');

    try {
      let reply;
      if (backend === 'claude') {
        reply = await callClaudeChat(history, buildSystemPrompt(), currentKey);
      } else {
        reply = await callOpenAIChat(history, buildSystemPrompt(), currentKey);
      }
      setMessages((m) => [...m, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err.message || 'Request failed');
      setMessages((m) => [
        ...m,
        { role: 'assistant', content: `❌ Error: ${err.message || 'Request failed'}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-indigo-100 rounded-lg flex items-center justify-center">
            <ChatIcon className="w-4 h-4 text-indigo-600" />
          </div>
          <span className="text-sm font-semibold text-gray-900">AI Assistant</span>
        </div>

        {/* Backend Toggle */}
        <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
          {[
            { key: 'claude', label: 'Claude' },
            { key: 'chatgpt', label: 'ChatGPT' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setBackend(key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                backend === key
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* No-key warning */}
      {!hasKey && (
        <div className="bg-amber-50 border-b border-amber-100 px-4 py-2 text-xs text-amber-700 flex items-center gap-1.5 flex-shrink-0">
          <span>⚠️</span>
          <span>
            No {backend === 'claude' ? 'Claude' : 'OpenAI'} API key — add one in
            Settings to enable chat.
          </span>
        </div>
      )}

      {/* Context note */}
      <div className="bg-indigo-50 border-b border-indigo-100 px-4 py-2 text-xs text-indigo-600 flex items-center gap-1.5 flex-shrink-0">
        <span>📋</span>
        <span>
          {tasks.length} task{tasks.length !== 1 ? 's' : ''} injected as context
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50/50">
        {messages.length === 0 && (
          <div className="text-center py-10 text-gray-400">
            <div className="text-4xl mb-3">🤖</div>
            <p className="text-sm font-medium text-gray-500">Ask your AI assistant</p>
            <p className="text-xs text-gray-400 mt-1">
              &ldquo;What should I focus on today?&rdquo;
            </p>
            <p className="text-xs text-gray-400">
              &ldquo;Which Careific tasks are overdue?&rdquo;
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role === 'assistant' && (
              <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center mr-2 mt-0.5 flex-shrink-0 text-xs">
                🤖
              </div>
            )}
            <div
              className={`max-w-[82%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-br-sm'
                  : 'bg-white text-gray-800 border border-gray-200 shadow-sm rounded-bl-sm'
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center text-xs">
              🤖
            </div>
            <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 shadow-sm">
              <div className="flex gap-1 items-center">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.18}s` }}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="bg-white border-t border-gray-200 p-3 flex gap-2 items-end flex-shrink-0">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${backend === 'claude' ? 'Claude' : 'ChatGPT'}… (Enter to send)`}
          rows={1}
          className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition resize-none"
          style={{ overflowY: 'hidden' }}
        />
        <button
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="flex-shrink-0 w-9 h-9 flex items-center justify-center bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
          title="Send (Enter)"
        >
          <SendIcon className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
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
    createdAt: new Date().toISOString(),
  },
];

export default function App() {
  const [tasks, setTasks]                       = useState(SAMPLE_TASKS);
  const [activeView, setActiveView]             = useState('daily');
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
  const firedAlertsRef                          = useRef(new Set());

  // Keep refs current so the 60 s interval always reads fresh values without
  // needing to re-register the effect on every state change.
  const tasksRef         = useRef(tasks);
  const alertRulesRef    = useRef(alertRules);
  const emailSettingsRef = useRef(emailSettings);
  useEffect(() => { tasksRef.current = tasks; },         [tasks]);
  useEffect(() => { alertRulesRef.current = alertRules; }, [alertRules]);
  useEffect(() => { emailSettingsRef.current = emailSettings; }, [emailSettings]);

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

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
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
  }, [tasks, activeView, activeTagFilters, statusFilter]);

  const completedCount    = filteredTasks.filter((t) => t.completed).length;
  const enabledRulesCount = alertRules.filter((r) => r.enabled).length;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* ── Header ── */}
      <header className="bg-white border-b border-gray-200 px-6 py-3.5 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-sm">
            <ChecklistIcon className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold text-gray-900 leading-none">TaskManage</h1>
            <p className="text-[11px] text-gray-400 mt-0.5">Multi-venture productivity</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex text-xs bg-gray-100 text-gray-500 px-3 py-1.5 rounded-full font-medium">
            {tasks.filter((t) => !t.completed).length} active ·{' '}
            {tasks.filter((t) => t.completed).length} done
          </span>

          {/* Bell — alert rules */}
          <button
            onClick={() => setShowAlerts(true)}
            className="relative p-2 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            title="Alert rules"
          >
            <BellIcon className="w-5 h-5" />
            {enabledRulesCount > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-indigo-600 rounded-full" />
            )}
          </button>

          {/* Gear — settings */}
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            title="Settings"
          >
            <GearIcon className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* ── Main layout ── */}
      <main className="flex" style={{ height: 'calc(100vh - 57px)' }}>
        {/* ── Left: Task panel (60%) ── */}
        <section className="flex flex-col border-r border-gray-200 overflow-hidden" style={{ width: '60%' }}>
          {/* View Tabs */}
          <div className="bg-white border-b border-gray-100 px-6 pt-4 pb-0 flex-shrink-0">
            <div className="flex gap-1 w-fit">
              {[
                { key: 'daily', label: 'Daily Tasks' },
                { key: 'priority', label: 'High Priority' },
              ].map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setActiveView(key)}
                  className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-all -mb-px ${
                    activeView === key
                      ? 'border-indigo-600 text-indigo-700'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-200'
                  }`}
                >
                  {label}
                  {key === 'priority' && (
                    <span className="ml-1.5 text-[10px] bg-red-100 text-red-500 font-semibold px-1.5 py-0.5 rounded-full">
                      {tasks.filter((t) => t.priority === 'high' && !t.completed).length}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Scrollable content */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <AddTaskForm onAdd={addTask} claudeKey={apiKeys.claude} />
            <FilterBar
              activeTagFilters={activeTagFilters}
              setActiveTagFilters={setActiveTagFilters}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
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
                  />
                ))
              )}
            </div>
          </div>
        </section>

        {/* ── Right: Chat panel (40%) ── */}
        <section className="flex flex-col overflow-hidden p-4" style={{ width: '40%' }}>
          <ChatPanel tasks={tasks} apiKeys={apiKeys} />
        </section>
      </main>

      {/* ── Modals ── */}
      {showSettings && (
        <SettingsModal
          apiKeys={apiKeys}
          onSave={setApiKeys}
          emailSettings={emailSettings}
          onSaveEmail={setEmailSettings}
          onClose={() => setShowSettings(false)}
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
        />
      )}

      {/* ── Toast notifications ── */}
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
