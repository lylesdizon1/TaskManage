import InlineEditableField from './InlineEditableField.jsx';
import { TileFooter } from './TaskDraftTile.jsx';

/**
 * ProjectDraftTile — inline editable draft for a create_project intent.
 * Mirrors TaskDraftTile structure. Entity is resolved by Aria upstream
 * and shown read-only here (entity_id passed through to POST).
 *
 * Props (matches TaskDraftTile pattern):
 *   payload   — { title, entity_id, entity_name, description }
 *   status    — 'draft' | 'executing' | 'success' | 'error'
 *   error     — string when status === 'error'
 *   onChange  — (patch) => void
 *   onConfirm — () => void
 *   onCancel  — () => void
 *   onRetry   — () => void
 */
export default function ProjectDraftTile({ payload = {}, status = 'draft', error, onChange, onConfirm, onCancel, onRetry }) {
  const disabled = status === 'executing';
  const hasEntity = !!payload.entity_id;

  return (
    <div
      className="bg-white border border-gray-200 rounded-xl"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <span className="material-symbols-outlined" style={{ color: '#4f4dcf', fontSize: '15px' }}>folder_open</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          Project draft
        </span>
      </div>

      <div className="px-3 pb-2 space-y-1.5">
        <InlineEditableField
          label="Title"
          value={payload.title || ''}
          onChange={(v) => onChange?.({ title: v })}
          placeholder="Project title"
          disabled={disabled}
        />
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400 mb-0.5" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            Entity
          </div>
          <div style={{ fontFamily: 'Manrope, sans-serif', fontSize: '13px', color: hasEntity ? '#1f2937' : '#dc2626', padding: '4px 6px' }}>
            {payload.entity_name || 'No entity'}
          </div>
        </div>
        <InlineEditableField
          label="Description"
          value={payload.description || ''}
          onChange={(v) => onChange?.({ description: v })}
          placeholder="Optional"
          disabled={disabled}
        />
      </div>

      <TileFooter
        status={status}
        error={error}
        disabled={disabled || !payload.title || !hasEntity}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onRetry={onRetry}
        successLabel="Project created"
      />
    </div>
  );
}
