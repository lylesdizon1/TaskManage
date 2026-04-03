import { escapeHtml, getRuleScope } from '../../utils/helpers.js';

// ─────────────────────────────────────────────────────────────────────────────
// ALERT RULES CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_ALERT_RULES = [
  {
    id: 'rule-overdue',
    name: 'Overdue Tasks',
    description: 'Alert when tasks are past their due date',
    enabled: true,
    condition: { type: 'overdue' },
    channels: { whatsapp: true, slack: true, sms: false, email: true },
    remindIntervalHours: 24,
    recipientOverride: '',
    isCustom: false,
  },
  {
    id: 'rule-due-24h',
    name: 'Due in 24 Hours',
    description: 'Alert when tasks are due within 24 hours',
    enabled: true,
    condition: { type: 'due-in-hours', hours: 24 },
    channels: { whatsapp: true, slack: true, sms: false, email: true },
    remindIntervalHours: 12,
    recipientOverride: '',
    isCustom: false,
  },
  {
    id: 'rule-high-priority',
    name: 'High Priority Backlog',
    description: 'Alert when incomplete high-priority tasks exist',
    enabled: false,
    condition: { type: 'high-priority' },
    channels: { whatsapp: false, slack: true, sms: false, email: true },
    remindIntervalHours: 24,
    recipientOverride: '',
    isCustom: false,
  },
  {
    id: 'rule-daily-digest',
    name: 'Daily Digest',
    description: 'Session summary of all active tasks on app load',
    enabled: false,
    condition: { type: 'daily-digest' },
    channels: { whatsapp: false, slack: true, sms: false, email: true },
    recipientOverride: '',
    isCustom: false,
  },
  {
    id: 'rule-morning-brief',
    name: 'Morning Brief',
    description: 'Scheduled morning summary at a set time',
    enabled: false,
    condition: { type: 'morning-brief', time: '08:00' },
    channels: { whatsapp: true, slack: true, sms: false, email: false },
    recipientOverride: '',
    isCustom: false,
  },
  {
    id: 'rule-critical-mail',
    name: 'Critical Mail',
    description: 'Alert when VIP sender or trigger keyword email arrives',
    enabled: false,
    condition: { type: 'critical-mail' },
    channels: { whatsapp: true, slack: true, sms: false, email: true },
    recipientOverride: '',
    isCustom: false,
  },
];

export const CONDITION_META = {
  'overdue':        { label: 'Overdue tasks',              hasTag: false, hasHours: false },
  'due-in-hours':   { label: 'Due within N hours',         hasTag: false, hasHours: true  },
  'high-priority':  { label: 'High-priority tasks',        hasTag: false, hasHours: false },
  'tag-match':      { label: 'All active tasks for tag',   hasTag: true,  hasHours: false },
  'tag-overdue':    { label: 'Overdue tasks for tag',      hasTag: true,  hasHours: false },
  'daily-digest':   { label: 'Daily summary (all tasks)',  hasTag: false, hasHours: false },
  'morning-brief':  { label: 'Morning brief (scheduled)',  hasTag: false, hasHours: false, hasTime: true },
  'event-reminder': { label: 'Cal event reminder',         hasTag: false, hasHours: false, hasMinutes: true },
  'critical-mail':  { label: 'Critical mail (VIP/keyword)',hasTag: false, hasHours: false },
};

export const EMPTY_NEW_RULE = {
  name: '',
  condition: { type: 'overdue', hours: 24, tag: '', time: '08:00', minutesBefore: 15 },
  channels: { whatsapp: true, slack: true, sms: false, email: true },
  remindIntervalHours: 24,
  recipientOverride: '',
};

export function evaluateRule(rule, tasks) {
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

/** Build a plain-text alert message for multi-channel delivery. */
export function buildPlainTextAlert(ruleName, tasks) {
  const lines = [`[Dizon.ai] ${ruleName}\n`];
  if (!tasks || tasks.length === 0) {
    lines.push('- No matching tasks');
  } else {
    tasks.forEach((t) => {
      const due = t.dueDate ? ` (due ${t.dueDate})` : '';
      const pri = t.priority === 'high' ? ' [HIGH]' : '';
      lines.push(`- ${t.title}${due}${pri}`);
    });
  }
  lines.push(`\n${tasks?.length || 0} task(s) matched`);
  return lines.join('\n');
}

/** Build a professional HTML alert email for the given tasks. */
export function buildEmailHtml(ruleName, ruleDesc, tasks) {
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
export async function sendAlertEmail(apiFetch, emailSettings, to, subject, html) {
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

export function persistFiredAlerts(firedRef) {
  try {
    localStorage.setItem('dizon_fired_alerts', JSON.stringify([...firedRef.current]));
  } catch (_) {}
}

/**
 * Evaluate all enabled rules and deliver alerts via /api/alerts/fire.
 * firedRef (Set) prevents duplicate sends across page reloads.
 */
export async function runAlertRules(tasks, rules, emailSettings, firedRef, addToast, apiFetch) {
  const { recipientEmail } = emailSettings;
  const todayStr = new Date().toISOString().slice(0, 10);

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const matching = evaluateRule(rule, tasks);
    if (matching.length === 0) continue;

    const to    = rule.recipientOverride || recipientEmail;
    const scope = getRuleScope(rule.condition.type);
    let tasksToSend = [];

    if (scope === 'per-task') {
      const intervalHours = rule.remindIntervalHours || 24;
      const bucket = Math.floor(Date.now() / (intervalHours * 3_600_000));
      tasksToSend = matching.filter((t) => !firedRef.current.has(`${rule.id}::${t.id}::${bucket}`));
      if (tasksToSend.length === 0) continue;
      tasksToSend.forEach((t) => firedRef.current.add(`${rule.id}::${t.id}::${bucket}`));
      persistFiredAlerts(firedRef);
    } else if (scope === 'daily') {
      const key = `${rule.id}::${todayStr}`;
      if (firedRef.current.has(key)) continue;
      firedRef.current.add(key);
      persistFiredAlerts(firedRef);
      tasksToSend = matching;
    } else {
      // session — once per browser load
      if (firedRef.current.has(rule.id)) continue;
      firedRef.current.add(rule.id);
      persistFiredAlerts(firedRef);
      tasksToSend = matching;
    }

    const count   = tasksToSend.length;
    const message = buildPlainTextAlert(rule.name, tasksToSend);
    const channels = rule.channels || { whatsapp: true, slack: true, sms: false, email: true };

    try {
      const res = await apiFetch('/api/alerts/fire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('tm_token')}` },
        body: JSON.stringify({ message, channels, recipientEmail: to }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const via = data.sent?.length ? ` via ${data.sent.join(', ')}` : '';
      addToast({
        type: 'success',
        message: `Alert sent: "${rule.name}" (${count} task${count !== 1 ? 's' : ''})${via}`,
      });
    } catch (err) {
      addToast({ type: 'error', message: `Alert failed: ${err.message}` });
    }
  }
}
