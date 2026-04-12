import { useEffect, useMemo, useState, useCallback } from 'react';

const TOOL_LABELS = {
  create_task: 'Created task',
  complete_task: 'Completed task',
  update_task: 'Updated task',
  delete_task: 'Deleted task',
  search_tasks: 'Searched tasks',
  create_event: 'Created event',
  update_event: 'Updated event',
  delete_event: 'Deleted event',
  create_note: 'Created note',
  update_note: 'Updated note',
  search_notes: 'Searched notes',
  send_email: 'Sent email',
  reply_email: 'Replied to email',
  archive_email: 'Archived email',
};

const TOOL_GROUPS = {
  create_task: 'tasks', complete_task: 'tasks', update_task: 'tasks', delete_task: 'tasks', search_tasks: 'tasks',
  create_event: 'calendar', update_event: 'calendar', delete_event: 'calendar',
  create_note: 'notes', update_note: 'notes', search_notes: 'notes',
  send_email: 'communication', reply_email: 'communication', archive_email: 'communication',
};

const GROUP_ICONS = {
  tasks: 'check_circle',
  calendar: 'calendar_month',
  notes: 'sticky_note_2',
  communication: 'mail',
  default: 'smart_toy',
};

function iconFor(toolName) {
  return GROUP_ICONS[TOOL_GROUPS[toolName]] || GROUP_ICONS.default;
}

function toolLabel(toolName) {
  return TOOL_LABELS[toolName] || toolName || 'Action';
}

function summaryLine(toolName, input) {
  const i = input || {};
  if (toolName === 'send_email')   return `To: ${i.to || '?'} — ${i.subject || ''}`.trim();
  if (toolName === 'reply_email')  return `Reply on thread ${i.thread_id || ''}`.trim();
  if (toolName === 'create_task')  return `"${i.title || ''}"${i.due_date ? ` due ${i.due_date}` : ''}`;
  if (toolName === 'create_event') return `"${i.title || ''}"${i.start_datetime ? ` on ${i.start_datetime}` : ''}`;
  if (toolName === 'create_note')  return `"${i.title || ''}"`;
  if (toolName === 'update_task')  return `${i.task_id || ''} updated`;
  if (toolName === 'delete_task')  return `${i.task_id || ''}`;
  if (toolName === 'delete_event') return `${i.event_id || ''}`;
  return `${toolName || 'action'} executed`;
}

function statusBadgeFor(eventType) {
  switch (eventType) {
    case 'tool_executed':          return { label: 'Done',      cls: 'bg-green-50 text-green-700 border-green-200' };
    case 'tool_failed':             return { label: 'Failed',    cls: 'bg-red-50 text-red-700 border-red-200' };
    case 'tool_cancelled':          return { label: 'Cancelled', cls: 'bg-gray-50 text-gray-600 border-gray-200' };
    case 'confirmation_requested':  return { label: 'Waiting',   cls: 'bg-amber-50 text-amber-700 border-amber-200' };
    case 'confirmation_approved':   return { label: 'Approved',  cls: 'bg-green-50 text-green-700 border-green-200' };
    case 'confirmation_rejected':   return { label: 'Rejected',  cls: 'bg-gray-50 text-gray-600 border-gray-200' };
    default:                        return null;
  }
}

function fmtTime(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  } catch { return ''; }
}

function fmtDayHeader(iso, tz) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const toDateStr = (x) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const dStr = toDateStr(d);
  if (dStr === toDateStr(today))     return 'Today';
  if (dStr === toDateStr(yesterday)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric' }).format(d);
}

function formatKV(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).map(([k, v]) => ({
    key: k.replace(/_/g, ' '),
    value: typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? ''),
  }));
}

const RANGES = [
  { key: 'today',  label: 'Today',   params: { date: 'TODAY' } },
  { key: '7days',  label: '7 Days',  params: { days: 7 } },
  { key: '30days', label: '30 Days', params: { days: 30 } },
];

export default function ActivityPanel({ authToken, currentUser, apiFetch }) {
  const tz = currentUser?.timezone || 'America/Los_Angeles';
  const [range, setRange] = useState('7days');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ actions: [], summary: { total: 0, completed: 0, cancelled: 0, failed: 0, pending: 0 } });
  const [expanded, setExpanded] = useState(null);

  const todayStr = useMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), [tz]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (range === 'today')      qs.set('date', todayStr);
      else if (range === '7days')  qs.set('days', '7');
      else if (range === '30days') qs.set('days', '30');
      const res = await apiFetch(`/api/agent-actions?${qs.toString()}`, { headers: { Authorization: `Bearer ${authToken}` } });
      const json = await res.json();
      setData({
        actions: Array.isArray(json?.actions) ? json.actions : [],
        summary: json?.summary || { total: 0, completed: 0, cancelled: 0, failed: 0, pending: 0 },
      });
    } catch {
      setData({ actions: [], summary: { total: 0, completed: 0, cancelled: 0, failed: 0, pending: 0 } });
    } finally {
      setLoading(false);
    }
  }, [range, todayStr, apiFetch, authToken]);

  useEffect(() => { load(); }, [load]);

  // Filter out internal events (decision_created) from the timeline
  const visible = useMemo(() => (data.actions || []).filter(a => a.event_type !== 'decision_created'), [data.actions]);

  // Group by calendar day in the user's timezone
  const grouped = useMemo(() => {
    const groups = new Map();
    for (const a of visible) {
      const dStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(a.created_at));
      if (!groups.has(dStr)) groups.set(dStr, []);
      groups.get(dStr).push(a);
    }
    return Array.from(groups.entries()); // [[dStr, actions], ...]
  }, [visible, tz]);

  const stats = data.summary || { completed: 0, cancelled: 0, failed: 0, pending: 0 };

  return (
    <div className="flex-1 overflow-y-auto" style={{ backgroundColor: '#fbf8fe', fontFamily: 'Manrope, sans-serif' }}>
      <div className="max-w-5xl mx-auto px-6 md:px-8 py-6 md:py-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-6">
          <div>
            <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }} className="text-2xl md:text-3xl font-extrabold text-gray-900">Aria Activity</h1>
            <p className="text-sm text-gray-500 mt-1">Everything Aria has done for you</p>
          </div>
          <div className="flex items-center gap-1 bg-white border border-gray-100 rounded-xl p-1 shadow-sm">
            {RANGES.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setRange(key)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                  range === key ? 'text-white' : 'text-gray-600 hover:text-primary hover:bg-primary/5'
                }`}
                style={range === key ? { backgroundColor: '#4f4dcf' } : {}}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Summary stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-6">
          <StatCard icon="check_circle" tone="green" label="Completed" value={stats.completed} />
          <StatCard icon="cancel"       tone="gray"  label="Cancelled" value={stats.cancelled} />
          <StatCard icon="error"        tone="red"   label="Failed"    value={stats.failed} />
          <StatCard icon="schedule"     tone="amber" label="Pending"   value={stats.pending} />
        </div>

        {/* Timeline */}
        {loading ? (
          <LoadingSkeleton />
        ) : visible.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-6">
            {grouped.map(([dStr, items]) => (
              <div key={dStr}>
                <h3 className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-400 mb-2 px-1"
                    style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
                  {fmtDayHeader(items[0].created_at, tz)}
                </h3>
                <div className="bg-white border border-gray-100 rounded-xl shadow-sm divide-y divide-gray-50 overflow-hidden">
                  {items.map((a) => (
                    <ActionRow
                      key={a.id}
                      action={a}
                      tz={tz}
                      isOpen={expanded === a.id}
                      onToggle={() => setExpanded(expanded === a.id ? null : a.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, tone, label, value }) {
  const toneMap = {
    green: { fg: '#059669', bg: 'rgba(5,150,105,0.08)' },
    red:   { fg: '#dc2626', bg: 'rgba(220,38,38,0.08)' },
    amber: { fg: '#d97706', bg: 'rgba(217,119,6,0.08)' },
    gray:  { fg: '#6b7280', bg: 'rgba(107,114,128,0.08)' },
  };
  const t = toneMap[tone] || toneMap.gray;
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: t.bg }}>
        <span className="material-symbols-outlined" style={{ color: t.fg, fontSize: '20px' }}>{icon}</span>
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{label}</div>
        <div className="text-xl font-extrabold text-gray-900 leading-tight" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{value}</div>
      </div>
    </div>
  );
}

function ActionRow({ action, tz, isOpen, onToggle }) {
  const icon = iconFor(action.tool_name);
  const label = toolLabel(action.tool_name);
  const summary = summaryLine(action.tool_name, action.input_json);
  const time = fmtTime(action.created_at, tz);
  const badge = statusBadgeFor(action.event_type);
  const inputKV = formatKV(action.input_json);
  const outputKV = formatKV(action.output_json);

  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors flex items-start gap-3"
      >
        <div className="w-8 h-8 rounded-lg bg-primary/5 flex items-center justify-center flex-shrink-0 mt-0.5">
          <span className="material-symbols-outlined text-primary" style={{ fontSize: '18px' }}>{icon}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-gray-900 truncate" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{label}</span>
            <span className="text-xs text-gray-400 flex-shrink-0">{time}</span>
          </div>
          <div className="flex items-center justify-between gap-2 mt-0.5">
            <span className="text-xs text-gray-500 truncate">{summary}</span>
            {badge && (
              <span className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full border flex-shrink-0 ${badge.cls}`}>
                {badge.label}
              </span>
            )}
          </div>
          {action.error_msg && !isOpen && (
            <div className="text-[11px] text-red-600 mt-1 truncate">{action.error_msg}</div>
          )}
        </div>
      </button>
      {isOpen && (
        <div className="px-4 pb-4 pt-1 bg-gray-50/60 border-t border-gray-100">
          <KVBlock title="Input" rows={inputKV} />
          {outputKV.length > 0 && <KVBlock title="Output" rows={outputKV} />}
          {action.error_msg && (
            <div className="mt-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400 mb-1">Error</div>
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{action.error_msg}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function KVBlock({ title, rows }) {
  if (!rows?.length) return null;
  return (
    <div className="mt-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-gray-400 mb-1" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>{title}</div>
      <div className="bg-white border border-gray-100 rounded-lg divide-y divide-gray-50">
        {rows.map(({ key, value }) => (
          <div key={key} className="flex items-start gap-3 px-3 py-2">
            <div className="text-xs font-semibold text-gray-500 capitalize w-28 flex-shrink-0">{key}</div>
            <div className="text-xs text-gray-800 break-all flex-1">{value || <span className="text-gray-300">—</span>}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-10 text-center">
      <div className="w-12 h-12 rounded-xl bg-primary/5 flex items-center justify-center mx-auto mb-3">
        <span className="material-symbols-outlined text-primary" style={{ fontSize: '28px' }}>smart_toy</span>
      </div>
      <h3 className="text-base font-bold text-gray-900" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>Aria hasn&rsquo;t taken any actions yet</h3>
      <p className="text-sm text-gray-500 mt-1">Actions will appear here as Aria completes tasks for you.</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      {[0, 1].map((g) => (
        <div key={g}>
          <div className="h-3 w-16 bg-gray-100 rounded mb-2 animate-pulse" />
          <div className="bg-white border border-gray-100 rounded-xl shadow-sm divide-y divide-gray-50 overflow-hidden">
            {[0, 1, 2].map((i) => (
              <div key={i} className="px-4 py-3 flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-gray-100 animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-32 bg-gray-100 rounded animate-pulse" />
                  <div className="h-3 w-56 bg-gray-100 rounded animate-pulse" />
                </div>
                <div className="h-3 w-10 bg-gray-100 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
