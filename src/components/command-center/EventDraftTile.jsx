import InlineEditableField from './InlineEditableField.jsx';
import { TileFooter } from './TaskDraftTile.jsx';

const DURATION_OPTIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '1 hour' },
  { value: '90', label: '1.5 hours' },
  { value: '120', label: '2 hours' },
];

/**
 * EventDraftTile — inline editable draft for a create_event intent.
 * Tile fields are start_time + duration_minutes (user-friendlier);
 * the confirm handler maps them to the tool's start_datetime /
 * end_datetime before executing.
 */
export default function EventDraftTile({ payload = {}, status = 'draft', error, onChange, onConfirm, onCancel, onRetry }) {
  const disabled = status === 'executing';
  const durationString = String(payload.duration_minutes ?? 60);

  return (
    <div
      className="bg-white border border-gray-200 rounded-xl"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <span className="material-symbols-outlined" style={{ color: '#4f4dcf', fontSize: '15px' }}>calendar_month</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          Event draft
        </span>
      </div>

      <div className="px-3 pb-2 space-y-1.5">
        <InlineEditableField
          label="Title"
          value={payload.title || ''}
          onChange={(v) => onChange?.({ title: v })}
          placeholder="What's the event?"
          disabled={disabled}
        />
        <div className="grid grid-cols-2 gap-2">
          <InlineEditableField
            label="Start"
            value={payload.start_time || ''}
            onChange={(v) => onChange?.({ start_time: v })}
            inputType="datetime-local"
            placeholder="—"
            disabled={disabled}
          />
          <InlineEditableField
            label="Duration"
            value={durationString}
            onChange={(v) => onChange?.({ duration_minutes: Number(v) || 60 })}
            inputType="select"
            options={DURATION_OPTIONS}
            disabled={disabled}
          />
        </div>
      </div>

      <TileFooter
        status={status}
        error={error}
        disabled={disabled || !payload.title || !payload.start_time}
        onConfirm={onConfirm}
        onCancel={onCancel}
        onRetry={onRetry}
        successLabel="Event created"
      />
    </div>
  );
}
