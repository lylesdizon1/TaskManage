import { useState } from 'react';
import { buildGroupedEntities } from '../../utils/helpers.js';
import { getEntityStyle, PRIORITY_BORDER, PRIORITY_BADGE } from '../../constants/colors.js';
import { SpinnerIcon, SyncIcon, PencilIcon } from '../icons/Icons.jsx';
import TagPill from '../ui/TagPill.jsx';

export default function TaskCard({ task, onToggle, onDelete, onEdit, onToggleVisibility, onSyncCalendar, currentUser, gcalConnected, entities }) {
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

