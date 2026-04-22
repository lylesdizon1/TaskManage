import { escapeHtml, getRuleScope, getTodayLocal } from '../../utils/helpers.js';

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
    description: 'Managed by Flagged inbox — auto-flags VIP/keyword emails via classification engine',
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
  'critical-mail':  { label: 'Critical mail → Flagged inbox', hasTag: false, hasHours: false },
};

export const EMPTY_NEW_RULE = {
  name: '',
  condition: { type: 'overdue', hours: 24, tag: '', time: '08:00', minutesBefore: 15 },
  channels: { whatsapp: true, slack: true, sms: false, email: true },
  remindIntervalHours: 24,
  recipientOverride: '',
};

export function evaluateRule(rule, tasks, tz) {
  const now      = new Date();
  const todayStr = getTodayLocal(tz);
  const active   = tasks.filter((t) => !t.completed);

  switch (rule.condition.type) {
    case 'overdue':
      return active.filter((t) => t.dueDate && t.dueDate < todayStr);

    case 'due-in-hours': {
      const windowMs = (rule.condition.hours || 24) * 3_600_000;
      return active.filter((t) => {
        if (!t.dueDate) return false;
        if (t.dueDate < todayStr) return false; // already overdue — skip
        const dueMs = new Date(t.dueDate + 'T23:59:59').getTime();
        return dueMs > now.getTime() && dueMs - now.getTime() <= windowMs;
      });
    }

    case 'high-priority':
      return active.filter((t) => t.priority === 'high');

    case 'tag-match':
      return active.filter((t) => (t.tags || []).includes(rule.condition.tag));

    case 'tag-overdue':
      return active.filter(
        (t) => t.dueDate && t.dueDate < todayStr && (t.tags || []).includes(rule.condition.tag),
      );

    case 'daily-digest':
      return active;

    case 'critical-mail':
      // Handled by classification engine auto-flag → Flagged inbox.
      // flagged_acked_at is the canonical dismissed state; fired_alerts
      // is no longer used for critical-mail dedup.
      return [];

    default:
      return [];
  }
}

/** Build a conversational Aria-voice alert for a single task. */
export function buildConversationalAlert(firstName, ruleType, task, tz) {
  const name = firstName || 'there';
  const title = task.title;

  switch (ruleType) {
    case 'overdue': {
      const daysOver = task.dueDate
        ? Math.floor((new Date(getTodayLocal(tz)) - new Date(task.dueDate)) / 86400000)
        : 0;
      const daysNote = daysOver > 1 ? ` (${daysOver} days now)` : '';
      return `Hey ${name} — the "${title}" task is overdue${daysNote}.\n\nWorth a quick look when you get a chance.`;
    }
    case 'due-in-hours':
      return `Hey ${name} — "${title}" is due soon.\n\nGood time to get ahead of it.`;
    case 'high-priority':
      return `Hey ${name} — "${title}" is high priority and still open.\n\nThis one's important — worth prioritizing.`;
    case 'tag-match':
      return `Hey ${name} — "${title}" is active and flagged.\n\nJust flagging this for you.`;
    case 'tag-overdue':
      return `Hey ${name} — "${title}" is overdue.\n\nThis one slipped — worth a quick look.`;
    case 'daily-digest':
      return null; // handled separately
    default:
      return `Hey ${name} — "${title}" needs your attention.\n\nJust keeping you in the loop.`;
  }
}

/** Build a conversational daily digest message. */
export function buildDigestAlert(firstName, tasks) {
  const name = firstName || 'there';
  if (!tasks || tasks.length === 0) {
    return `Hey ${name} — you're all clear today. No active tasks.\n\nEnjoy the breathing room.`;
  }
  const count = tasks.length;
  const topTasks = tasks.slice(0, 5).map((t) => `• ${t.title}`).join('\n');
  const more = count > 5 ? `\n...and ${count - 5} more` : '';
  return `Hey ${name} — you've got ${count} active task${count !== 1 ? 's' : ''} today:\n\n${topTasks}${more}\n\nLet's have a great day.`;
}

/** Legacy wrapper — kept for any remaining callers. */
export function buildPlainTextAlert(ruleName, tasks) {
  const lines = [`${ruleName}\n`];
  if (!tasks || tasks.length === 0) {
    lines.push('No matching tasks');
  } else {
    tasks.forEach((t) => {
      const due = t.dueDate ? ` (due ${t.dueDate})` : '';
      const pri = t.priority === 'high' ? ' [HIGH]' : '';
      lines.push(`- ${t.title}${due}${pri}`);
    });
  }
  return lines.join('\n');
}

/**
 * Build a professional HTML alert email for the given tasks.
 *
 * SECURITY-SENSITIVE: All dynamic values MUST be escaped via escapeHtml (h())
 * before insertion into the HTML string. Style attribute values MUST use
 * allowlisted lookups with safe fallbacks — never interpolate user input
 * directly into style/attribute contexts.
 */
export function buildEmailHtml(ruleName, ruleDesc, tasks, tz) {
  const h        = escapeHtml;
  const todayStr = getTodayLocal(tz);
  const pColor   = { high: '#dc2626', medium: '#d97706', low: '#16a34a' };
  const pBg      = { high: '#fef2f2', medium: '#fffbeb', low: '#f0fdf4' };

  const rows = tasks
    .map((t) => {
      const overdue  = t.dueDate && t.dueDate < todayStr;
      const tagPills = (t.tags || [])
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
            <span style="padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:${pBg[t.priority] || '#f3f4f6'};color:${pColor[t.priority] || '#6b7280'};">${h(t.priority)}</span>
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


export function persistFiredAlerts(firedRef) {
  try {
    localStorage.setItem('dizon_fired_alerts', JSON.stringify([...firedRef.current]));
  } catch (_) {}
}

/**
 * Build alert key for a rule+task+date combination.
 * Uses local date (YYYY-MM-DD) instead of UTC epoch bucket.
 */
function buildAlertKey(rule, task, todayStr) {
  const scope = getRuleScope(rule.condition.type);
  if (scope === 'per-task') return `${rule.id}::${task.id}::${todayStr}`;
  if (scope === 'daily') return `${rule.id}::${todayStr}`;
  return rule.id; // session
}

/**
 * Evaluate all enabled rules and deliver alerts via /api/alerts/fire.
 * Server-side dedup via fired_alerts table is source of truth.
 * localStorage firedRef is a fast client-side cache to avoid unnecessary API calls.
 */
export async function runAlertRules(tasks, rules, emailSettings, firedRef, addToast, apiFetch, authToken, currentUser) {
  const { recipientEmail } = emailSettings;
  const userTZ = currentUser?.timezone;
  const todayStr = getTodayLocal(userTZ);
  const firstName = currentUser?.displayName?.split(' ')[0] || currentUser?.username || '';

  // Phase 1: collect all candidate keys across all rules
  const candidates = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    // critical-mail is handled by classification engine → Flagged inbox;
    // flagged_acked_at is the canonical dismiss state, not fired_alerts.
    if (rule.condition.type === 'critical-mail') continue;
    const matching = evaluateRule(rule, tasks, userTZ);
    if (matching.length === 0) continue;
    const scope = getRuleScope(rule.condition.type);
    if (scope === 'per-task') {
      for (const t of matching) {
        const key = buildAlertKey(rule, t, todayStr);
        if (!firedRef.current.has(key)) candidates.push({ rule, task: t, key, scope });
      }
    } else {
      const key = buildAlertKey(rule, null, todayStr);
      if (!firedRef.current.has(key)) candidates.push({ rule, task: null, key, scope });
    }
  }

  if (candidates.length === 0) return;

  // Phase 2: check server for already-fired keys
  const allKeys = candidates.map(c => c.key);
  let serverFired = new Set();
  try {
    const checkRes = await apiFetch('/api/alerts/check-fired', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ keys: allKeys }),
    });
    if (checkRes.ok) {
      const { fired } = await checkRes.json();
      serverFired = new Set(fired);
      fired.forEach(k => firedRef.current.add(k));
      persistFiredAlerts(firedRef);
    }
  } catch (err) {
    console.error('[alerts] check-fired failed:', err.message);
  }

  // Phase 3: filter out already-fired
  const unfired = candidates.filter(c => !serverFired.has(c.key));
  if (unfired.length === 0) return;

  // Phase 4: fire alerts — one message per task (conversational Aria voice)
  for (const { rule, task, key, scope } of unfired) {
    const to = rule.recipientOverride || recipientEmail;
    const channels = rule.channels || { whatsapp: true, slack: true, sms: false, email: true };
    const ruleType = rule.condition.type;

    let message;
    if (scope === 'per-task') {
      message = buildConversationalAlert(firstName, ruleType, task, userTZ);
    } else {
      // daily-digest or other daily/session scope
      const matching = evaluateRule(rule, tasks, userTZ);
      message = buildDigestAlert(firstName, matching);
    }
    if (!message) continue;

    try {
      const res = await apiFetch('/api/alerts/fire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ message, channels, recipientEmail: to }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const via = data.sent?.length ? ` via ${data.sent.join(', ')}` : '';
      const label = task ? `"${task.title}"` : `"${rule.name}"`;
      addToast({
        type: 'success',
        message: `Alert sent: ${label}${via}`,
      });

      // Mark as fired — server + client
      firedRef.current.add(key);
      try {
        await apiFetch('/api/alerts/mark-fired', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ key }),
        });
      } catch (markErr) {
        console.error('[alerts] mark-fired failed:', markErr.message);
      }
      persistFiredAlerts(firedRef);
    } catch (err) {
      addToast({ type: 'error', message: `Alert failed: ${err.message}` });
    }
  }
}
