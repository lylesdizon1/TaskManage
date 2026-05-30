import { useState, useCallback, useMemo } from 'react';
import ContactPickerInput from './ContactPickerInput.jsx';
import AccountPickerInput from './AccountPickerInput.jsx';

// EmailDraftCard — Commit 1 of the unified draft architecture.
//
// Renders a persisted action_card row (role='action_card') with full
// status lifecycle. Sent_ok renders compact (single-line summary)
// per Phase 3 spec addition A — "default to silence" applied to the
// card itself once it has nothing to do.
//
// Status transitions visible to user:
//   drafted   → user-editable, Cancel + Send & Create buttons
//   executing → fields frozen, spinner + "Sending…"
//   sent_ok   → compact one-liner: ✓ Sent to <to> at <time>
//   failed    → error + retry-with-other-account / Edit / Dismiss
//   cancelled → "Cancelled" stamp, 50% opacity
//   expired   → "Draft expired — restart?" (Restart + Dismiss)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function EmailDraftCard({
  payload,
  apiFetch,
  authToken,
  onConfirm,         // (resolved) => sends POST /api/chat/execute-draft
  onCancel,          // () => marks as cancelled locally
  onDismiss,         // () => removes the card from view (post-failed / post-cancelled)
  onRetryWith,       // (account_email) => one-click retry on a different account
}) {
  // Local edit buffer for the four user-editable fields. Initialized from
  // payload.resolved on mount; user edits override the payload defaults
  // before Confirm. We DON'T mutate payload directly — it's the
  // server's record and changes via SSE card_status_update events.
  const initialResolved = payload?.resolved || {};
  const [to, setTo] = useState(() => initialResolved.to || null);
  const [fromAccount, setFromAccount] = useState(
    () => initialResolved.from?.account_email || ''
  );
  const [subject, setSubject] = useState(() => initialResolved.subject || '');
  const [body, setBody] = useState(() => initialResolved.body || '');

  const status = payload?.status || 'drafted';
  const accounts = payload?.available_accounts || [];
  const noHealthyAccounts = payload?.blocking_reason === 'no_healthy_accounts';
  const candidates = payload?.candidates_for?.to || [];

  const canSend = useMemo(() => {
    if (status !== 'drafted') return false;
    if (!to?.email || !EMAIL_RE.test(to.email)) return false;
    if (!fromAccount) return false;
    if (!subject?.trim()) return false;
    if (!body?.trim()) return false;
    return true;
  }, [status, to, fromAccount, subject, body]);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    onConfirm?.({
      to: to.email,
      from_account: fromAccount,
      subject: subject.trim(),
      body: body.trim(),
    });
  }, [canSend, to, fromAccount, subject, body, onConfirm]);

  // ── Compact sent_ok render (Phase 3 spec addition A) ───────────────
  if (status === 'sent_ok') {
    const sentTo = payload?.result_metadata?.account_email
      ? `${initialResolved.to?.email || ''}`
      : initialResolved.to?.email || '';
    const sentAt = payload?.result_metadata?.sent_at;
    const timeStr = sentAt ? new Date(sentAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return (
      <div
        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-success-surface border border-success rounded-lg"
        style={{ fontFamily: 'Manrope, sans-serif' }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '14px', color: 'rgb(var(--success))' }}>check_circle</span>
        <span className="text-[12px] text-success">
          Sent to <b>{sentTo}</b>{timeStr ? ` at ${timeStr}` : ''}
        </span>
      </div>
    );
  }

  // ── Cancelled — faded stamp ─────────────────────────────────────────
  if (status === 'cancelled') {
    return (
      <div
        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-surface-container-low border border-outline-variant rounded-lg opacity-60"
        style={{ fontFamily: 'Manrope, sans-serif' }}
      >
        <span className="material-symbols-outlined" style={{ fontSize: '14px', color: 'rgb(var(--text-secondary))' }}>block</span>
        <span className="text-[12px] text-on-surface-variant">Email draft cancelled</span>
      </div>
    );
  }

  // ── Expired ─────────────────────────────────────────────────────────
  if (status === 'expired') {
    return (
      <div
        className="px-3 py-2 bg-surface-container-low border border-outline-variant rounded-lg"
        style={{ fontFamily: 'Manrope, sans-serif' }}
      >
        <div className="text-[12px] text-on-surface-variant mb-1.5">Draft expired — no response within 5 minutes.</div>
        <button
          onClick={onDismiss}
          className="px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container rounded-md"
        >
          Dismiss
        </button>
      </div>
    );
  }

  // ── Empty state: no healthy accounts ────────────────────────────────
  if (noHealthyAccounts && status === 'drafted') {
    return (
      <CardShell title="Email Draft" onClose={onCancel}>
        <div className="px-3 py-3 bg-warning-surface border border-warning rounded-md mb-2">
          <div className="flex items-start gap-1.5">
            <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'rgb(var(--warning))', marginTop: 1 }}>warning</span>
            <div>
              <div className="text-[12px] font-semibold text-warning mb-1">
                No connected accounts available
              </div>
              <div className="text-[11px] text-warning">
                All your email accounts need to be reconnected before Aria can send.
              </div>
            </div>
          </div>
          <a
            href="/?view=settings&section=integrations"
            className="inline-block mt-2 text-[12px] font-semibold text-primary hover:underline"
          >
            → Reconnect in Settings
          </a>
        </div>
        <div className="text-[11px] uppercase tracking-wider text-text-faint mb-1">Aria saved your draft</div>
        <div className="px-2 py-2 bg-surface-container-low border border-outline-variant rounded-md text-[12px] text-on-surface space-y-0.5">
          {to?.email && <div><b>To:</b> {to.email}</div>}
          {subject && <div><b>Subject:</b> {subject}</div>}
          {body && <div className="whitespace-pre-wrap mt-1">{body.slice(0, 200)}{body.length > 200 ? '…' : ''}</div>}
        </div>
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-outline-variant">
          <span className="text-[11px] text-on-surface-variant italic">Draft saved for later</span>
          <button
            onClick={onDismiss}
            className="px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container rounded-md"
          >
            Dismiss
          </button>
        </div>
      </CardShell>
    );
  }

  // ── Drafted / executing / failed: full card ─────────────────────────
  const fieldsDisabled = status === 'executing';

  return (
    <CardShell title="Email Draft" onClose={status === 'drafted' ? onCancel : null}>
      {/* From */}
      <FieldRow label="From">
        <AccountPickerInput
          value={fromAccount}
          onChange={setFromAccount}
          accounts={accounts}
          disabled={fieldsDisabled}
        />
      </FieldRow>

      {/* To */}
      <FieldRow label="To">
        <ContactPickerInput
          value={to}
          onChange={setTo}
          apiFetch={apiFetch}
          authToken={authToken}
          candidates={candidates}
          disabled={fieldsDisabled}
        />
      </FieldRow>

      {/* Subject */}
      <FieldRow label="Subject">
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={fieldsDisabled}
          placeholder="Subject"
          className="w-full px-2 py-1.5 text-[13px] border border-outline-variant rounded-md focus:outline-none focus:border-primary disabled:bg-surface-container-low"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        />
      </FieldRow>

      {/* Body */}
      <div className="px-3 pt-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={fieldsDisabled}
          rows={5}
          placeholder="Message body"
          className="w-full px-2 py-1.5 text-[13px] border border-outline-variant rounded-md focus:outline-none focus:border-primary disabled:bg-surface-container-low resize-y"
          style={{ fontFamily: 'Manrope, sans-serif' }}
        />
      </div>

      {/* Failure banner */}
      {status === 'failed' && payload?.error_message && (
        <div className="mx-3 mt-2 px-2 py-1.5 bg-danger-surface border border-danger rounded-md">
          <div className="text-[11px] font-semibold text-danger mb-0.5">
            {payload.error_reason === 'auth' ? 'Account authentication expired' :
             payload.error_reason === 'network' ? 'Network error' :
             payload.error_reason === 'validation' ? 'Invalid input' :
             'Send failed'}
          </div>
          <div className="text-[11px] text-danger truncate">{payload.error_message}</div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 mt-2 border-t border-outline-variant">
        <span className="text-[11px] text-on-surface-variant italic">
          {status === 'drafted' && 'Not yet sent'}
          {status === 'executing' && (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 border-2 border-outline-variant border-t-primary rounded-full animate-spin" />
              Sending…
            </span>
          )}
          {status === 'failed' && 'Send failed'}
        </span>
        <div className="flex items-center gap-2">
          {status === 'drafted' && (
            <>
              <button
                onClick={onCancel}
                className="px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container-low rounded-lg"
              >
                Cancel
              </button>
              <button
                onClick={handleSend}
                disabled={!canSend}
                className="px-3 py-1.5 text-[12px] font-bold rounded-lg disabled:opacity-40 shadow-sm"
                style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--accent-contrast))' }}
              >
                Send Email
              </button>
            </>
          )}
          {status === 'failed' && (
            <>
              {payload?.retry_available_with && (
                <button
                  onClick={() => onRetryWith?.(payload.retry_available_with)}
                  className="px-2.5 py-1 text-[11px] font-semibold rounded-lg shadow-sm"
                  style={{ backgroundColor: 'rgb(var(--accent))', color: 'rgb(var(--accent-contrast))' }}
                >
                  Retry with {payload.retry_available_with}
                </button>
              )}
              <button
                onClick={onDismiss}
                className="px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant hover:bg-surface-container-low rounded-lg"
              >
                Dismiss
              </button>
            </>
          )}
        </div>
      </div>
    </CardShell>
  );
}

function CardShell({ title, onClose, children }) {
  return (
    <div
      className="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-sm w-full"
      style={{ fontFamily: 'Manrope, sans-serif', maxWidth: '480px' }}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant">
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined" style={{ fontSize: '15px', color: 'rgb(var(--accent))' }}>mail</span>
          <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-on-surface-variant" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
            {title}
          </span>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="text-text-faint hover:text-on-surface-variant"
            aria-label="Close"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function FieldRow({ label, children }) {
  return (
    <div className="grid grid-cols-[60px_1fr] items-start gap-2 px-3 pt-2 sm:grid-cols-[60px_1fr]">
      <span className="text-[11px] font-semibold text-on-surface-variant pt-2">{label}</span>
      <div>{children}</div>
    </div>
  );
}
