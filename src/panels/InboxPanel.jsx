import { useState, useEffect, useMemo } from 'react';
import { useToast } from '../contexts/ToastContext';
import SkeletonBlock from '../components/ui/SkeletonBlock.jsx';
import { getTodayLocal } from '../utils/helpers.js';

export default function InboxPanel({ tasks, authToken, currentUser, onToggleTask, onEditTask, addToast, apiFetch }) {
  const [dismissed, setDismissed] = useState(new Set());
  const [editingDue, setEditingDue] = useState(null);
  const [dbItems, setDbItems] = useState([]);
  const [openMenuId, setOpenMenuId] = useState(null);
  const toast = useToast();

  const userTZ = currentUser?.timezone || 'America/Los_Angeles';
  const today = getTodayLocal(userTZ);
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const cutoff = new Intl.DateTimeFormat('en-CA', { timeZone: userTZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(sevenDaysAgo);

  const activeTasks = tasks.filter((t) => !t.completed);

  // Fetch DB-backed inbox items (from gmail scan etc.)
  useEffect(() => {
    async function fetchDbItems() {
      try {
        const res = await apiFetch('/api/inbox/items', { headers: { Authorization: `Bearer ${authToken}` } });
        if (res.ok) {
          const data = await res.json();
          setDbItems(data.filter((d) => !d.action_taken));
        }
      } catch {}
    }
    fetchDbItems();
  }, [authToken]);

  const inboxItems = useMemo(() => {
    const items = [];
    // Task-based items
    activeTasks.forEach((t) => {
      if (dismissed.has(t.id)) return;
      if (t.dueDate && t.dueDate < cutoff) {
        const days = Math.floor((new Date(today) - new Date(t.dueDate)) / 86400000);
        items.push({ ...t, inboxType: 'MISSED', context: `${days} days overdue`, sort: 0, source: 'task' });
      } else if (t.dueDate && t.dueDate < today) {
        const days = Math.floor((new Date(today) - new Date(t.dueDate)) / 86400000);
        items.push({ ...t, inboxType: 'OVERDUE', context: `${days} day${days !== 1 ? 's' : ''} overdue`, sort: 1, source: 'task' });
      } else if (t.priority === 'high' && !t.dueDate) {
        items.push({ ...t, inboxType: 'HIGH PRIORITY', context: 'No due date set', sort: 2, source: 'task' });
      }
    });
    // DB-backed items (gmail scan)
    const sortMap = { VIP: 0, KEYWORD: 1, COMMITMENT: 2 };
    dbItems.forEach((d) => {
      if (dismissed.has(d.id)) return;
      items.push({
        id: d.id,
        title: d.title,
        inboxType: d.type,
        context: d.summary,
        sort: sortMap[d.type] ?? 3,
        source: 'gmail',
        gmailLink: d.gmail_link,
        gmailThreadId: d.gmail_thread_id,
        sender: d.sender || null,
      });
    });
    return items.sort((a, b) => a.sort - b.sort);
  }, [activeTasks, dbItems, dismissed, today, cutoff]);

  // Extract email from "Name <email@domain.com>" or plain "email@domain.com"
  function extractEmail(sender) {
    if (!sender) return null;
    const match = sender.match(/<([^>]+)>/);
    return match ? match[1].toLowerCase() : sender.trim().toLowerCase();
  }

  function extractDomain(sender) {
    const email = extractEmail(sender);
    if (!email) return null;
    const at = email.indexOf('@');
    return at >= 0 ? email.slice(at) : null;
  }

  async function handleDismiss(id, isDbItem) {
    if (isDbItem) {
      try {
        await apiFetch(`/api/inbox/items/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ action: 'dismissed' }),
        });
      } catch {}
    }
    setDismissed((prev) => new Set(prev).add(id));
    setOpenMenuId(null);
    toast.info('Item dismissed from inbox');
  }

  async function handleExcludeSender(item, mode) {
    const value = mode === 'domain' ? extractDomain(item.sender) : extractEmail(item.sender);
    if (!value) return;
    try {
      // Load current config, add exclusion, save
      const cfgRes = await apiFetch('/api/gmail/config', { headers: { Authorization: `Bearer ${authToken}` } });
      const cfg = await cfgRes.json();
      const excluded = cfg.excludedSenders || [];
      if (!excluded.some((e) => e.toLowerCase() === value)) {
        excluded.push(value);
        await apiFetch('/api/gmail/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ config: { ...cfg, excludedSenders: excluded } }),
        });
      }
      // Dismiss the item too
      await handleDismiss(item.id, item.source === 'gmail');
      toast.success(`Excluded ${value}`);
    } catch {
      toast.error('Failed to exclude sender');
    }
  }

  function handleSetDue(id, date) {
    onEditTask(id, { dueDate: date });
    setEditingDue(null);
    toast.success('Due date updated');
  }

  const badgeStyle = {
    'MISSED': 'bg-error/10 text-error',
    'OVERDUE': 'bg-amber-100 text-amber-700',
    'HIGH PRIORITY': 'bg-primary/10 text-primary',
    'VIP': 'bg-purple-100 text-purple-700',
    'KEYWORD': 'bg-amber-100 text-amber-700',
    'COMMITMENT': 'bg-blue-100 text-blue-700',
  };
  const iconMap = {
    'MISSED': 'event_busy',
    'OVERDUE': 'schedule',
    'HIGH PRIORITY': 'priority_high',
    'VIP': 'star',
    'KEYWORD': 'search',
    'COMMITMENT': 'handshake',
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 md:p-10">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-extrabold font-headline text-on-background">Inbox</h1>
            <p className="text-sm text-on-surface-variant mt-1">{inboxItems.length} item{inboxItems.length !== 1 ? 's' : ''} need{inboxItems.length === 1 ? 's' : ''} attention</p>
          </div>
        </div>

        {inboxItems.length === 0 ? (
          <div className="text-center py-16">
            <span className="material-symbols-outlined text-5xl text-primary/30">inbox</span>
            <p className="text-on-surface-variant font-medium mt-3">You're all caught up!</p>
            <p className="text-sm text-outline mt-1">No overdue, missed, or unscheduled high-priority tasks.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {inboxItems.map((item) => (
              <div key={item.id} className="bg-surface-container-lowest rounded-xl p-4 shadow-sm border border-outline-variant/30 flex items-start gap-4 group hover:shadow-md transition-shadow">
                <div className="bg-surface-variant/50 p-2 rounded-full flex-shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-lg text-on-surface-variant">{iconMap[item.inboxType] || 'mail'}</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${badgeStyle[item.inboxType] || 'bg-gray-100 text-gray-600'}`}>{item.inboxType}</span>
                    {item.priority === 'high' && item.inboxType !== 'HIGH PRIORITY' && (
                      <span className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-error/10 text-error">HIGH</span>
                    )}
                  </div>
                  <h3 className="font-bold text-on-surface text-sm">{item.title}</h3>
                  <p className="text-xs text-outline mt-0.5">{item.context}{item.dueDate ? ` · Due ${item.dueDate}` : ''}</p>
                  {editingDue === item.id && item.source === 'task' && (
                    <div className="mt-2 flex items-center gap-2">
                      <input type="date" defaultValue={today} className="text-xs border border-outline-variant rounded-lg px-2 py-1 focus:ring-2 focus:ring-primary/20 outline-none" autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSetDue(item.id, e.target.value); if (e.key === 'Escape') setEditingDue(null); }}
                      />
                      <button onClick={(e) => handleSetDue(item.id, e.target.closest('div').querySelector('input').value)} className="text-xs font-bold text-primary hover:underline">Save</button>
                      <button onClick={() => setEditingDue(null)} className="text-xs text-outline hover:underline">Cancel</button>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  {item.source === 'gmail' && item.gmailLink && (
                    <a href={item.gmailLink} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity" title="View in Gmail">
                      <span className="material-symbols-outlined text-sm">open_in_new</span>
                    </a>
                  )}
                  {item.source === 'task' && (
                    <>
                      <button onClick={() => onToggleTask(item.id)} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity" title="Complete">
                        <span className="material-symbols-outlined text-sm">check</span>
                      </button>
                      <button onClick={() => setEditingDue(editingDue === item.id ? null : item.id)} className="px-3 py-1.5 text-xs font-bold rounded-lg bg-surface-variant text-on-surface-variant hover:bg-surface-variant/70 transition-colors" title="Edit due date">
                        <span className="material-symbols-outlined text-sm">edit_calendar</span>
                      </button>
                    </>
                  )}
                  <div className="relative">
                    <button
                      onClick={() => setOpenMenuId(openMenuId === item.id ? null : item.id)}
                      className="px-2 py-1.5 text-xs font-bold rounded-lg bg-surface-variant text-on-surface-variant hover:bg-surface-variant/70 transition-colors"
                      title="More actions"
                    >
                      <span className="material-symbols-outlined text-sm">more_horiz</span>
                    </button>
                    {openMenuId === item.id && (
                      <div className="absolute right-0 top-full mt-1 w-44 bg-white rounded-lg shadow-lg border border-gray-200 z-50 py-1">
                        <button
                          onClick={() => handleDismiss(item.id, item.source === 'gmail')}
                          className="w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                        >
                          <span className="material-symbols-outlined text-sm">visibility_off</span>
                          Dismiss
                        </button>
                        {item.source === 'gmail' && item.sender && (
                          <>
                            <button
                              onClick={() => handleExcludeSender(item, 'email')}
                              className="w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                            >
                              <span className="material-symbols-outlined text-sm">person_off</span>
                              Exclude Sender
                            </button>
                            {extractDomain(item.sender) && (
                              <button
                                onClick={() => handleExcludeSender(item, 'domain')}
                                className="w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 flex items-center gap-2"
                              >
                                <span className="material-symbols-outlined text-sm">domain_disabled</span>
                                Exclude {extractDomain(item.sender)}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
