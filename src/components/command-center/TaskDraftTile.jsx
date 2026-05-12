import InlineEditableField from './InlineEditableField.jsx';

const PRIORITY_OPTIONS = [
  { value: 'low',    label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high',   label: 'High' },
];

/**
 * TaskDraftTile — inline editable draft shown above Confirm for a
 * create_task intent. Field names match server/tools.cjs create_task
 * (title, due_date, priority).
 *
 * Props:
 *   payload   — { title, due_date, priority }
 *   status    — 'draft' | 'executing' | 'success' | 'error'
 *   error     — string when status === 'error'
 *   onChange  — (patch) => void
 *   onConfirm — () => void
 *   onCancel  — () => void
 *   onRetry   — () => void
 */
export default function TaskDraftTile({ payload = {}, status = 'draft', error, onChange, onConfirm, onCancel, onRetry, entities = [] }) {
  const disabled = status === 'executing';
  const showEntityField = Array.isArray(entities) && entities.length > 0;
  const entityOptions = showEntityField
    ? [{ value: '', label: '—' }, ...entities.map((e) => ({ value: e.name, label: e.name }))]
    : [];

  return (
    <div
      className="bg-white border border-gray-200 rounded-xl"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <span className="material-symbols-outlined" style={{ color: '#4f4dcf', fontSize: '15px' }}>check_circle</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          Task draft
        </span>
      </div>

      <div className="px-3 pb-2 space-y-1.5">
        <InlineEditableField
          label="Title"
          value={payload.title || ''}
          onChange={(v) => onChange?.({ title: v })}
          placeholder="What needs doing?"
          disabled={disabled}
        />
        <div className="grid grid-cols-3 gap-2">
          <InlineEditableField
            label="Due date"
            value={payload.due_date || ''}
            onChange={(v) => onChange?.({ due_date: v || null })}
            inputType="date"
            placeholder="—"
            disabled={disabled}
          />
          <InlineEditableField
            label="Due time"
            value={payload.due_time || ''}
            onChange={(v) => onChange?.({ due_time: v || null })}
            inputType="text"
            placeholder="e.g. 9:00 AM"
            disabled={disabled}
          />
          <InlineEditableField
            label="Priority"
            value={payload.priority || 'medium'}
            onChange={(v) => onChange?.({ priority: v })}
            inputType="select"
            options={PRIORITY_OPTIONS}
            disabled={disabled}
          />
        </div>
        {showEntityField && (
          <InlineEditableField
            label="Entity"
            value={payload.entity_name || ''}
            onChange={(v) => onChange?.({ entity_name: v || null })}
            inputType="select"
            options={entityOptions}
            disabled={disabled}
          />
        )}
      </div>

      <TileFooter
        status={status}
        error={error}
        disabled={disabled || !payload.title}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onRetry={onRetry}
        successLabel="Task created"
      />
    </div>
  );
}

export function TileFooter({ status, error, disabled, onConfirm, onCancel, onRetry, successLabel }) {
  if (status === 'success') {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-gray-100" style={{ color: '#059669' }}>
        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>check_circle</span>
        <span className="text-[12px] font-semibold">{successLabel}</span>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-100">
        <span className="text-[12px] text-red-600 truncate">{error || 'Something went wrong'}</span>
        <button
          onClick={onRetry}
          className="px-2.5 py-1 text-[11px] font-semibold rounded-lg"
          style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
        >
          Retry
        </button>
      </div>
    );
  }
  if (status === 'executing') {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-gray-100 text-[12px] text-gray-500">
        <span className="w-3 h-3 border-2 border-gray-200 border-t-[#4f4dcf] rounded-full animate-spin" />
        Creating…
      </div>
    );
  }
  // draft — bumped Confirm prominence and added a "not yet created" hint so the
  // tile reads as an action-required draft, not a completed result. Users had
  // been walking away from drafts thinking the event/task was already created.
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-100">
      <span className="text-[11px] text-gray-500 italic">Not yet created</span>
      <div className="flex items-center gap-2">
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 rounded-lg"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={disabled}
          className="px-3 py-1.5 text-[12px] font-bold rounded-lg disabled:opacity-40 shadow-sm"
          style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
        >
          Confirm & Create
        </button>
      </div>
    </div>
  );
}
