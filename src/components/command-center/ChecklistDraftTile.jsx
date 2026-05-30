import { useEffect, useRef } from 'react';
import { TileFooter } from './TaskDraftTile.jsx';

/**
 * ChecklistDraftTile — batch checklist-item draft. Parent owns the items
 * array; this component renders an editable row per item plus an "Add
 * another item" button. Enter on an item appends a fresh row and focuses
 * it. Backspace on an empty row removes it. Empty rows are stripped at
 * confirm by the parent's executor.
 *
 * Props (mirrors ProjectTaskDraftTile pattern):
 *   payload   — { task_title, project_name, project_task_id, entity_id, items: string[] }
 *   status    — 'draft' | 'executing' | 'success' | 'error'
 *   error     — string when status === 'error'
 *   onChange  — (patch) => void
 *   onConfirm — () => void
 *   onCancel  — () => void
 *   onRetry   — () => void
 */
export default function ChecklistDraftTile({ payload = {}, status = 'draft', error, onChange, onConfirm, onCancel, onRetry }) {
  const disabled = status === 'executing';
  const items = Array.isArray(payload.items) ? payload.items : [];
  const hasTask = !!payload.project_task_id;
  const nonEmpty = items.filter((s) => (s || '').trim().length > 0);
  const rowRefs = useRef([]);
  const lastFocus = useRef(-1);

  useEffect(() => {
    if (lastFocus.current >= 0 && rowRefs.current[lastFocus.current]) {
      try { rowRefs.current[lastFocus.current].focus(); } catch {}
      lastFocus.current = -1;
    }
  }, [items.length]);

  const updateAt = (idx, val) => {
    const next = items.slice();
    next[idx] = val;
    onChange?.({ items: next });
  };
  const removeAt = (idx) => {
    const next = items.slice();
    next.splice(idx, 1);
    onChange?.({ items: next.length ? next : [''] });
    lastFocus.current = Math.max(0, idx - 1);
  };
  const appendAfter = (idx) => {
    const next = items.slice();
    next.splice(idx + 1, 0, '');
    onChange?.({ items: next });
    lastFocus.current = idx + 1;
  };

  return (
    <div
      className="bg-surface-container-lowest border border-outline-variant rounded-xl"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <span className="material-symbols-outlined" style={{ color: 'rgb(var(--accent))', fontSize: '15px' }}>checklist</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-on-surface-variant" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          Checklist draft
        </span>
      </div>

      <div className="px-3 pb-2 space-y-1.5">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-faint mb-0.5" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            Task
          </div>
          <div style={{ fontFamily: 'Manrope, sans-serif', fontSize: '13px', color: hasTask ? 'rgb(var(--text-primary))' : 'rgb(var(--danger))', padding: '4px 6px' }}>
            {payload.task_title || 'No task'}
            {payload.project_name ? <span style={{ color: 'rgb(var(--text-secondary))' }}> · {payload.project_name}</span> : null}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-faint mb-0.5" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            Items
          </div>
          <div className="space-y-1">
            {(items.length ? items : ['']).map((v, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgb(var(--primary-container))', flexShrink: 0 }} />
                <input
                  ref={(el) => { rowRefs.current[i] = el; }}
                  type="text"
                  value={v || ''}
                  onChange={(e) => updateAt(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); appendAfter(i); }
                    else if (e.key === 'Escape') { e.preventDefault(); removeAt(i); }
                    else if (e.key === 'Backspace' && !(v || '').length && items.length > 1) { e.preventDefault(); removeAt(i); }
                  }}
                  placeholder="Checklist item"
                  disabled={disabled}
                  style={{
                    fontFamily: 'Manrope, sans-serif', fontSize: '13px', color: 'rgb(var(--text-primary))',
                    background: 'rgb(var(--surface-container-lowest))', padding: '4px 6px', borderRadius: '6px',
                    border: '1px solid rgb(var(--surface-container-high))', width: '100%', outline: 'none',
                  }}
                />
              </div>
            ))}
          </div>
          <button
            onClick={() => appendAfter((items.length || 1) - 1)}
            disabled={disabled}
            className="mt-1 text-[11px] font-semibold"
            style={{ color: 'rgb(var(--accent))', background: 'none', border: 'none', padding: '2px 0', cursor: disabled ? 'default' : 'pointer' }}
          >
            + Add another item
          </button>
        </div>
      </div>

      <TileFooter
        status={status}
        error={error}
        disabled={disabled || !hasTask || nonEmpty.length === 0}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onRetry={onRetry}
        successLabel={`${nonEmpty.length} item${nonEmpty.length === 1 ? '' : 's'} added`}
      />
    </div>
  );
}
