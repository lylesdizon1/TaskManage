import { useState, useRef, useCallback } from 'react';
import { buildGroupedEntities, uid } from '../../utils/helpers.js';
import { getEntityStyle } from '../../constants/colors.js';
import { XIcon, SpinnerIcon } from '../icons/Icons.jsx';

export default function AddTaskForm({ onAdd, claudeKey, currentUser, entities, authToken, gcalConnected, forceOpen, onClose }) {
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
