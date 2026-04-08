import { useState, useRef, useEffect, useMemo } from 'react';
import { PILLAR_CONFIG, PILLAR_KEYS, VIEW_TO_PILLAR } from '../../constants/pillars.js';
import { XIcon } from '../icons/Icons.jsx';

const API_BASE = '';

export function CreateEventModal({ currentUser, onClose, onCreated, addToast, apiFetch }) {
  const userTZ = currentUser?.timezone || 'America/Los_Angeles';
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: userTZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [form, setForm] = useState({ title: '', date: todayStr, startTime: '09:00', endTime: '10:00', description: '', syncToGcal: true });
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.date) return;
    setSaving(true);
    try {
      if (form.syncToGcal) {
        const body = {
          userId: currentUser.id,
          summary: form.title,
          description: form.description,
        };
        if (form.startTime) {
          body.start = { dateTime: `${form.date}T${form.startTime}:00`, timeZone: userTZ };
          body.end = { dateTime: `${form.date}T${form.endTime || form.startTime}:00`, timeZone: userTZ };
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

export function QuickCaptureModal({ authToken, categories, activeView, onClose, onSaved, addToast, apiFetch }) {
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

export function QuickCaptureFAB({ authToken, categories, activeView, hideFAB, addToast, onNoteSaved, chatPanelOpen, onToggleChat, apiFetch }) {
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
        apiFetch={apiFetch}
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
