import { useEffect, useRef, useState } from 'react';

/**
 * Module-scope LabeledTextarea — MUST live outside the parent render
 * function. Defining it inside DailyWrapTile (the prior shape) created
 * a new component reference on every render, which made React unmount
 * and remount the underlying <textarea> on every keystroke — the input
 * would lose focus after each character. (FU4 root cause.)
 */
function LabeledTextarea({ label, value, onChange, onKeyDown, placeholder, inputRef, minHeight = 44, disabled }) {
  return (
    <div>
      <div
        className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-400 mb-0.5"
        style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}
      >
        {label}
      </div>
      <textarea
        ref={inputRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        style={{
          width: '100%', minHeight, fontSize: 13, padding: '6px 8px',
          border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none',
          resize: 'vertical', fontFamily: 'Manrope, sans-serif',
          background: disabled ? '#f9fafb' : '#fff',
        }}
      />
    </div>
  );
}

/**
 * DailyWrapTile — multi-field end-of-day reflection capture.
 * Mirrors the draft-tile pattern (ProjectDraftTile / ProjectTaskDraftTile):
 * header chip + field stack + footer actions. All four fields are
 * optional but at least one must be non-empty to enable confirm.
 *
 * On confirm, calls onConfirm(formData) where formData is
 *   { wins, frustrations, tomorrow_focus, raw_freeform, completed: true }
 * The parent's executeActiveTile threads this through POST /api/journal-entries.
 *
 * Props:
 *   payload  — { tasksCompleted?, tasksStillOpen?, initialDraft? }
 *   status   — 'draft' | 'executing' | 'error'
 *   error    — string when status === 'error'
 *   onConfirm(data)
 *   onDismiss()
 */
export default function DailyWrapTile({ payload = {}, status = 'draft', error, onConfirm, onDismiss }) {
  const [wins, setWins] = useState(payload?.initialDraft?.wins || '');
  const [frustrations, setFrustrations] = useState(payload?.initialDraft?.frustrations || '');
  const [tomorrowFocus, setTomorrowFocus] = useState(payload?.initialDraft?.tomorrow_focus || '');
  const [rawFreeform, setRawFreeform] = useState(payload?.initialDraft?.raw_freeform || '');
  const firstRef = useRef(null);

  useEffect(() => { firstRef.current?.focus(); }, []);

  const executing = status === 'executing';
  const anyContent = !!(wins.trim() || frustrations.trim() || tomorrowFocus.trim() || rawFreeform.trim());
  const canSubmit = anyContent && !executing;

  const handleSave = () => {
    if (!canSubmit) return;
    onConfirm?.({
      wins: wins.trim(),
      frustrations: frustrations.trim(),
      tomorrow_focus: tomorrowFocus.trim(),
      raw_freeform: rawFreeform.trim(),
      completed: true,
    });
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onDismiss?.(); }
    // Cmd/Ctrl+Enter saves from any field.
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSave(); }
  };

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const statsBits = [];
  if (Number.isFinite(payload.tasksCompleted)) statsBits.push(`${payload.tasksCompleted} task${payload.tasksCompleted === 1 ? '' : 's'} done`);
  if (Number.isFinite(payload.tasksStillOpen) && payload.tasksStillOpen > 0) statsBits.push(`${payload.tasksStillOpen} still open`);
  const statsLine = statsBits.join(' · ');

  return (
    <div
      className="bg-white border border-gray-200 rounded-xl"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
        <span style={{ fontSize: 14, lineHeight: 1 }}>🌙</span>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
          Daily wrap
        </span>
        <span className="text-[10px] text-gray-400 ml-auto">{today}</span>
      </div>
      {statsLine && (
        <div className="px-3 pb-1 text-[11px] text-gray-500">{statsLine}</div>
      )}

      <div className="px-3 pb-2 space-y-2">
        <LabeledTextarea
          label="Wins"
          value={wins}
          onChange={(e) => setWins(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={executing}
          placeholder="What went well today?"
          inputRef={firstRef}
        />
        <LabeledTextarea
          label="Frustrations"
          value={frustrations}
          onChange={(e) => setFrustrations(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={executing}
          placeholder="Any blockers or frustrations?"
        />
        <LabeledTextarea
          label="Tomorrow's focus"
          value={tomorrowFocus}
          onChange={(e) => setTomorrowFocus(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={executing}
          placeholder="What's the priority for tomorrow?"
        />
        <LabeledTextarea
          label="Free reflection"
          value={rawFreeform}
          onChange={(e) => setRawFreeform(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={executing}
          placeholder="Anything else worth capturing?"
          minHeight={36}
        />
      </div>

      {error && (
        <div className="px-3 pb-1 text-[12px] text-red-600">{error}</div>
      )}

      <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-gray-100">
        <button
          onClick={() => onDismiss?.()}
          disabled={executing}
          className="px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 rounded-lg"
        >
          Not now
        </button>
        <button
          onClick={handleSave}
          disabled={!canSubmit}
          className="px-2.5 py-1 text-[11px] font-semibold rounded-lg disabled:opacity-40"
          style={{ backgroundColor: '#4f4dcf', color: '#fff' }}
        >
          {executing ? 'Saving…' : 'Save wrap'}
        </button>
      </div>
    </div>
  );
}
