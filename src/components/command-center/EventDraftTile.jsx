import { useEffect } from 'react';
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

/** Pick the best default account from the tile title (e.g. "Rose" → rose@...). */
function pickDefaultAccount(accounts, title) {
  if (!accounts?.length) return null;
  const lowerTitle = (title || '').toLowerCase();
  if (lowerTitle) {
    const match = accounts.find(a => {
      const name = (a.account_email || '').split('@')[0].toLowerCase();
      return name && lowerTitle.includes(name.split(/[.+_-]/)[0]);
    });
    if (match) return match.account_email;
  }
  return accounts[0].account_email;
}

/**
 * EventDraftTile — inline editable draft for a create_event intent.
 * Tile fields are start_time + duration_minutes (user-friendlier);
 * the confirm handler maps them to the tool's start_datetime /
 * end_datetime before executing.
 */
export default function EventDraftTile({
  payload = {},
  status = 'draft',
  error,
  onChange,
  onConfirm,
  onCancel,
  onRetry,
  gmailAccounts = [],
}) {
  const disabled = status === 'executing';
  const durationString = String(payload.duration_minutes ?? 60);

  const accounts = Array.isArray(gmailAccounts) ? gmailAccounts.filter(a => a?.account_email) : [];
  const showCalendarField = accounts.length > 0;

  // Initialize calendarId on first render once accounts arrive.
  useEffect(() => {
    if (!showCalendarField) return;
    if (payload.calendarId) return;
    const def = pickDefaultAccount(accounts, payload.title);
    if (def) onChange?.({ calendarId: def });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCalendarField, accounts.length]);

  const calendarOptions = accounts.map(a => ({ value: a.account_email, label: a.account_email }));

  return (
    <div
      className="bg-surface-container-lowest border border-outline-variant rounded-xl"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <span className="material-symbols-outlined" style={{ color: 'rgb(var(--accent))', fontSize: '15px' }}>calendar_month</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-on-surface-variant" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
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
        {showCalendarField && (
          <InlineEditableField
            label="Calendar"
            value={payload.calendarId || (accounts[0]?.account_email ?? '')}
            onChange={(v) => onChange?.({ calendarId: v })}
            inputType="select"
            options={calendarOptions}
            disabled={disabled}
          />
        )}
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
