// AccountPickerInput — dropdown of healthy gmail accounts the user can send
// from. Phase 3 spec C: only auth_status='ok' accounts are passed in.
// Empty-state handling lives in the parent (EmailDraftCard) since the
// "reconnect an account" CTA is card-level, not picker-level.

export default function AccountPickerInput({ value, onChange, accounts = [], disabled = false }) {
  if (accounts.length === 0) return null;

  return (
    <select
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="w-full px-2 py-1.5 text-[13px] border border-outline-variant rounded-md bg-surface-container-lowest focus:outline-none focus:border-[rgb(var(--accent))] disabled:bg-surface-container-low"
      style={{ fontFamily: 'Manrope, sans-serif' }}
    >
      {accounts.map((a) => (
        <option key={a.account_email} value={a.account_email}>
          {a.account_email}
        </option>
      ))}
    </select>
  );
}
