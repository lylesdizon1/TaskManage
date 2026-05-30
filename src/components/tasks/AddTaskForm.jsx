import { useState, useRef, useCallback, useEffect } from 'react';
import { buildGroupedEntities, uid } from '../../utils/helpers.js';
import { getEntityStyle } from '../../constants/colors.js';
import { XIcon, SpinnerIcon } from '../icons/Icons.jsx';
import { fetchSuggestedTags } from '../../utils/aiHelpers.js';

export default function AddTaskForm({ onAdd, currentUser, entities, authToken, gcalConnected, forceOpen, onClose, apiFetch }) {
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
  const [contact, setContact] = useState(null); // { id, name } | null — manual contact link
  const debounceRef = useRef(null);
  const suggestionIdRef = useRef(0);

  const runSuggestion = useCallback(
    async (title, desc) => {
      if (!title.trim()) return;
      const callId = ++suggestionIdRef.current;
      setSuggesting(true);
      const suggested = await fetchSuggestedTags(title, desc, userEntityNames, authToken, apiFetch);
      if (callId !== suggestionIdRef.current) return; // stale — a newer call superseded this one
      setSuggesting(false);
      if (suggested.length > 0) {
        setAiSuggested(suggested);
        setForm((f) => ({
          ...f,
          tags: [...new Set([...f.tags, ...suggested])],
        }));
      }
    },
    [userEntityNames, authToken], // eslint-disable-line react-hooks/exhaustive-deps
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
      contactId: contact?.id || null,
      completed: false,
      owner: currentUser?.id || 'unknown',
      createdAt: new Date().toISOString(),
    });
    setForm(emptyForm);
    setAiSuggested([]);
    setContact(null);
    setIsOpen(false);
    onClose?.();
  }

  return (
    <div className={forceOpen ? '' : 'mb-5'}>
      {!forceOpen && !isOpen ? (
        <button
          onClick={() => setIsOpen(true)}
          className="w-full flex items-center gap-2 px-4 py-3 md:py-3 min-h-[48px] bg-surface-container-lowest border-2 border-dashed border-outline-variant rounded-xl text-text-faint hover:border-primary hover:text-primary hover:bg-accent-surface/30 transition-all text-sm font-medium group"
        >
          <span className="w-6 h-6 md:w-5 md:h-5 rounded-full bg-surface-container group-hover:bg-accent-surface flex items-center justify-center text-base leading-none transition-colors">
            +
          </span>
          Add new task
        </button>
      ) : (
        <div className={forceOpen ? '' : 'fixed inset-0 z-50 bg-surface-container-lowest overflow-y-auto md:static md:inset-auto md:z-auto md:bg-transparent md:overflow-visible'}>
        <form
          onSubmit={handleSubmit}
          className="p-5 md:rounded-xl"
          style={{ fontFamily: "'Plus Jakarta Sans', 'Manrope', sans-serif" }}
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base md:text-sm font-semibold text-on-surface">New Task</h3>
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setForm(emptyForm);
                setAiSuggested([]);
                setContact(null);
                onClose?.();
              }}
              className="text-text-faint hover:text-on-surface-variant transition-colors min-w-[44px] min-h-[44px] md:min-w-0 md:min-h-0 flex items-center justify-center"
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
              className="w-full px-3 py-2.5 md:py-2 bg-surface-container-low border border-outline-variant rounded-lg text-base md:text-sm text-on-surface placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary focus:bg-surface-container-lowest transition"
            />

            {/* Description */}
            <textarea
              placeholder="Description (optional) — helps AI suggest tags"
              value={form.description}
              onChange={handleDescChange}
              onBlur={handleBlur}
              rows={2}
              className="w-full px-3 py-2.5 md:py-2 bg-surface-container-low border border-outline-variant rounded-lg text-base md:text-sm text-on-surface placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary focus:bg-surface-container-lowest transition resize-none"
            />

            {/* Priority + Due Date + Time */}
            <div className="flex gap-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-on-surface-variant mb-1">
                  Priority
                </label>
                <select
                  value={form.priority}
                  onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}
                  className="w-full px-3 py-2.5 md:py-2 bg-surface-container-low border border-outline-variant rounded-lg text-base md:text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary transition min-h-[44px] md:min-h-0"
                >
                  <option value="low">🟢 Low</option>
                  <option value="medium">🟡 Medium</option>
                  <option value="high">🔴 High</option>
                </select>
              </div>

              <div className="flex-1">
                <label className="block text-xs font-medium text-on-surface-variant mb-1">
                  Due Date
                </label>
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))}
                  className="w-full px-3 py-2.5 md:py-2 bg-surface-container-low border border-outline-variant rounded-lg text-base md:text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary transition min-h-[44px] md:min-h-0"
                />
              </div>

              <div style={{ flex: '0 0 100px' }}>
                <label className="block text-xs font-medium text-on-surface-variant mb-1">
                  Time
                </label>
                <input
                  type="time"
                  value={form.dueTime}
                  onChange={(e) => setForm((f) => ({ ...f, dueTime: e.target.value }))}
                  className="w-full px-3 py-2.5 md:py-2 bg-surface-container-low border border-outline-variant rounded-lg text-base md:text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary transition min-h-[44px] md:min-h-0"
                />
              </div>
            </div>

            {/* Tags */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-medium text-on-surface-variant">Tags</span>
                {suggesting && (
                  <span className="text-xs text-primary flex items-center gap-1">
                    <SpinnerIcon className="w-3 h-3 animate-spin" />
                    AI suggesting…
                  </span>
                )}
                {!suggesting && aiSuggested.length > 0 && (
                  <span className="text-xs text-primary flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary inline-block" />
                    AI auto-selected tags
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {buildGroupedEntities(entities).map((ent) => {
                  const tag = ent.name;
                  const isHex = ent.color && ent.color.startsWith('#');
                  const style = getEntityStyle(ent.color);
                  const isSelected = form.tags.includes(tag);
                  const isAiPick = aiSuggested.some((s) => s.toLowerCase() === tag.toLowerCase());
                  // Use inline hex styles when entity has a hex color (from GCal)
                  const inlineStyle = isHex && isSelected
                    ? { backgroundColor: ent.color + '20', color: ent.color, borderColor: ent.color + '60', boxShadow: `0 0 0 2px ${ent.color}40` }
                    : isHex && !isSelected
                    ? { borderLeftColor: ent.color, borderLeftWidth: '3px' }
                    : undefined;
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => toggleTag(tag)}
                      style={inlineStyle}
                      className={`inline-flex items-center gap-1 text-xs px-3 py-2 md:px-2.5 md:py-1 rounded-full font-medium border transition-all min-h-[36px] md:min-h-0 ${
                        isSelected
                          ? isHex ? 'font-bold' : `${style.bg} ${style.text} ${style.border} ring-2 ring-offset-1 ${style.ring}`
                          : 'bg-surface-container-low text-on-surface-variant border-outline-variant hover:bg-surface-container'
                      }`}
                    >
                      {ent._indent ? '\u2514 ' : ''}{tag}{ent.shared ? ' \u{1F517}' : ''}
                      {isAiPick && isSelected && (
                        <span className="text-[9px] leading-none bg-primary text-on-primary px-1 py-0.5 rounded-full">
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
              <span className="text-xs font-medium text-on-surface-variant mb-2 block">Visibility</span>
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
                          ? 'bg-warning-surface text-warning border-warning ring-2 ring-offset-1 ring-warning'
                          : 'bg-accent-surface text-primary border-primary ring-2 ring-offset-1 ring-primary'
                        : 'bg-surface-container-low text-text-faint border-outline-variant hover:bg-surface-container'
                    }`}
                  >
                    {key === 'private' ? '🔒 ' : '👥 '}{label}
                  </button>
                ))}
              </div>
            </div>

            {/* Related contact (optional) — links the task so it surfaces in
                the contact's timeline and Aria can reason over it. */}
            <div>
              <span className="text-xs font-medium text-on-surface-variant mb-1 block">Related contact (optional)</span>
              <ContactLinkPicker value={contact} onChange={setContact} apiFetch={apiFetch} authToken={authToken} />
            </div>

            {/* Google Calendar sync option */}
            {gcalConnected && form.dueDate && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.syncToCalendar}
                  onChange={(e) => setForm((f) => ({ ...f, syncToCalendar: e.target.checked }))}
                  className="w-4 h-4 accent-primary rounded"
                />
                <span className="text-xs font-medium text-on-surface-variant">📅 Add to Google Calendar</span>
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
                className="flex-1 px-4 py-3 md:py-2 border border-outline-variant rounded-lg text-on-surface-variant hover:bg-surface-container-low text-sm font-medium transition-colors min-h-[44px]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 px-4 py-3 md:py-2 bg-primary text-on-primary rounded-lg hover:bg-primary text-sm font-medium transition-colors shadow-sm min-h-[44px]"
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

// Typeahead against /api/contacts/search that captures the contact `id` (not
// just email), since task linkage needs the FK. value = { id, name } | null.
function ContactLinkPicker({ value, onChange, apiFetch, authToken }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) { setMatches([]); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/contacts/search?q=${encodeURIComponent(q)}&limit=6`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setMatches(Array.isArray(data) ? data : []);
        }
      } catch {}
      finally { setLoading(false); }
    }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open, apiFetch, authToken]);

  useEffect(() => {
    const onDocClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  if (value) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 bg-accent-surface border border-primary rounded-lg">
        <span className="material-symbols-outlined text-primary" style={{ fontSize: 16 }}>person</span>
        <span className="text-sm text-primary flex-1 truncate">{value.name}</span>
        <button
          type="button"
          onClick={() => { onChange(null); setQuery(''); }}
          className="text-primary hover:opacity-80 text-xs font-medium"
        >Clear</button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search contacts by name or email"
        className="w-full px-3 py-2.5 md:py-2 bg-surface-container-low border border-outline-variant rounded-lg text-base md:text-sm text-on-surface placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary focus:bg-surface-container-lowest transition"
      />
      {open && (matches.length > 0 || loading) && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {loading && <div className="px-3 py-2 text-xs text-text-faint">Searching…</div>}
          {!loading && matches.map((m, i) => (
            <button
              key={m.id || `${m.primaryEmail}-${i}`}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange({ id: m.id, name: m.displayName || m.primaryEmail }); setOpen(false); }}
              className="w-full text-left px-3 py-2 hover:bg-surface-container-low border-b border-outline-variant last:border-0"
            >
              <div className="text-sm text-on-surface truncate">{m.displayName || m.primaryEmail}</div>
              {m.primaryEmail && m.displayName !== m.primaryEmail && (
                <div className="text-xs text-on-surface-variant truncate">{m.primaryEmail}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
