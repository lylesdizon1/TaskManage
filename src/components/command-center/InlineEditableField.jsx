import { useEffect, useRef, useState } from 'react';

/**
 * InlineEditableField — lightweight click-to-edit primitive used inside
 * dynamic draft tiles. Click or Tab into the field → inline input.
 * Commits on blur or Enter. No modal, no portal.
 *
 * Props:
 *   label       — field caption
 *   value       — string value
 *   onChange    — (next: string) => void
 *   placeholder — shown when value is empty
 *   inputType   — 'text' | 'date' | 'datetime-local' | 'select' | 'number'
 *   options     — for select: [{ value, label }]
 *   disabled    — locks the field
 */
export default function InlineEditableField({
  label,
  value,
  onChange,
  placeholder = '',
  inputType = 'text',
  options,
  disabled = false,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const inputRef = useRef(null);

  useEffect(() => { setDraft(value ?? ''); }, [value]);
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (inputRef.current.select) { try { inputRef.current.select(); } catch {} }
    }
  }, [editing]);

  function commit() {
    const next = inputType === 'number' ? (draft === '' ? '' : Number(draft)) : draft;
    onChange?.(next);
    setEditing(false);
  }
  function cancel() { setDraft(value ?? ''); setEditing(false); }

  const displayStyle = {
    fontFamily: 'Manrope, sans-serif',
    fontSize: '13px',
    color: value ? 'rgb(var(--text-primary))' : 'rgb(var(--text-faint))',
    cursor: disabled ? 'default' : 'text',
    padding: '4px 6px',
    borderRadius: '6px',
    minHeight: '26px',
    border: '1px solid transparent',
  };
  const inputStyle = {
    fontFamily: 'Manrope, sans-serif',
    fontSize: '13px',
    color: 'rgb(var(--text-primary))',
    background: 'rgb(var(--surface-container-lowest))',
    padding: '4px 6px',
    borderRadius: '6px',
    border: '1px solid rgb(var(--surface-container-high))',
    width: '100%',
    outline: 'none',
  };

  const labelEl = (
    <div
      className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-faint mb-0.5"
      style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
    >
      {label}
    </div>
  );

  if (!editing || disabled) {
    const shown = inputType === 'select' && options
      ? (options.find(o => o.value === value)?.label ?? value ?? placeholder)
      : (value || placeholder);
    return (
      <div className="min-w-0">
        {labelEl}
        <div
          role={disabled ? undefined : 'button'}
          tabIndex={disabled ? -1 : 0}
          onClick={() => { if (!disabled) setEditing(true); }}
          onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setEditing(true); } }}
          className={disabled ? '' : 'hover:bg-surface-container-low'}
          style={displayStyle}
        >
          {shown || '—'}
        </div>
      </div>
    );
  }

  if (inputType === 'select') {
    return (
      <div className="min-w-0">
        {labelEl}
        <select
          ref={inputRef}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); onChange?.(e.target.value); setEditing(false); }}
          onBlur={cancel}
          style={{ ...inputStyle, width: 'auto', minWidth: '80px', maxWidth: '220px' }}
        >
          {options?.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
    );
  }

  const htmlType = inputType === 'datetime-local' ? 'datetime-local'
    : inputType === 'date' ? 'date'
    : inputType === 'time' ? 'time'
    : inputType === 'number' ? 'number'
    : 'text';

  return (
    <div className="min-w-0">
      {labelEl}
      <input
        ref={inputRef}
        type={htmlType}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        placeholder={placeholder}
        style={inputStyle}
      />
    </div>
  );
}
