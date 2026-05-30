import { useState, useEffect, useCallback } from 'react';

const SCOPES = [
  { value: 'calendar_read', label: 'Calendar (read)' },
  { value: 'tasks_read',    label: 'Tasks (read)' },
  { value: 'inbox_read',    label: 'Inbox (read)' },
  { value: 'people_read',   label: 'People (read)' },
  { value: 'full_read',     label: 'Full read' },
];

/**
 * SharedAccessPanel — manage cross-user read grants (V1).
 * Section 1: grants I gave (revocable). Section 2: grants given to me
 * (read-only). Invite-by-email only; server resolves the grantee.
 */
export default function SharedAccessPanel({ apiFetch, authToken }) {
  const [given, setGiven] = useState([]);
  const [received, setReceived] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [gr, rr] = await Promise.all([
        apiFetch('/api/shared-access/grants', { headers: { Authorization: `Bearer ${authToken}` } }),
        apiFetch('/api/shared-access/granted-to-me', { headers: { Authorization: `Bearer ${authToken}` } }),
      ]);
      const gd = await gr.json().catch(() => ({}));
      const rd = await rr.json().catch(() => ({}));
      setGiven(Array.isArray(gd?.grants) ? gd.grants : []);
      setReceived(Array.isArray(rd?.grants) ? rd.grants : []);
    } catch {} finally { setLoaded(true); }
  }, [apiFetch, authToken]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6 w-full" style={{ minHeight: 0, fontFamily: 'Manrope, sans-serif' }}>
      <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 24, fontWeight: 700, color: 'rgb(var(--text-primary))', marginBottom: 20 }}>Sharing</h1>

      {/* Section 1 — Access I've Given */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <h2 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 14, fontWeight: 700, color: 'rgb(var(--text-primary))', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Access you've given
          </h2>
          {!adding && (
            <button onClick={() => setAdding(true)} style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--accent))', background: 'transparent', border: 'none', cursor: 'pointer' }}>
              + Grant Access
            </button>
          )}
        </div>

        {adding && (
          <NewGrantForm
            apiFetch={apiFetch}
            authToken={authToken}
            onCancel={() => setAdding(false)}
            onCreated={() => { setAdding(false); reload(); }}
          />
        )}

        {!loaded ? (
          <div style={{ fontSize: 13, color: 'rgb(var(--text-faint))' }}>Loading…</div>
        ) : given.filter((g) => !g.revokedAt).length === 0 ? (
          <div style={{ fontSize: 13, color: 'rgb(var(--text-faint))', fontStyle: 'italic' }}>You haven't granted anyone access yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {given.filter((g) => !g.revokedAt).map((g) => (
              <GrantRow key={g.id} grant={g} mine apiFetch={apiFetch} authToken={authToken} onChange={reload} />
            ))}
          </div>
        )}
      </section>

      {/* Section 2 — Access Given To Me */}
      <section>
        <h2 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 14, fontWeight: 700, color: 'rgb(var(--text-primary))', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
          Access granted to you
        </h2>
        {!loaded ? (
          <div style={{ fontSize: 13, color: 'rgb(var(--text-faint))' }}>Loading…</div>
        ) : received.length === 0 ? (
          <div style={{ fontSize: 13, color: 'rgb(var(--text-faint))', fontStyle: 'italic' }}>Nobody has granted you access yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {received.map((g) => (
              <GrantRow key={g.id} grant={g} mine={false} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function NewGrantForm({ apiFetch, authToken, onCancel, onCreated }) {
  const [email, setEmail] = useState('');
  const [scope, setScope] = useState('calendar_read');
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    if (!email.trim()) { setError('Email is required'); return; }
    setSaving(true); setError(null);
    try {
      const body = { grantee_email: email.trim(), scope };
      if (expiresAt) body.expires_at = new Date(`${expiresAt}T23:59:59`).toISOString();
      const r = await apiFetch('/api/shared-access/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return; }
      onCreated?.();
    } catch (e) { setError(e.message || 'Network error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ background: 'rgb(var(--surface-container-lowest))', border: '1px solid rgb(var(--surface-container-high))', borderRadius: 10, padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
        <input autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Grantee email"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid rgb(var(--surface-container-high))', borderRadius: 6, outline: 'none' }} />
        <select value={scope} onChange={(e) => setScope(e.target.value)}
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid rgb(var(--surface-container-high))', borderRadius: 6, outline: 'none', background: 'rgb(var(--surface-container-lowest))' }}>
          {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid rgb(var(--surface-container-high))', borderRadius: 6, outline: 'none' }} />
      </div>
      {error && <div style={{ fontSize: 12, color: 'rgb(var(--danger))', marginTop: 6 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ fontSize: 12, color: 'rgb(var(--text-secondary))', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--accent-contrast))', background: 'rgb(var(--accent))', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Grant'}
        </button>
      </div>
    </div>
  );
}

function GrantRow({ grant, mine, apiFetch, authToken, onChange }) {
  const [revoking, setRevoking] = useState(false);

  const revoke = async () => {
    if (!window.confirm('Revoke this grant?')) return;
    setRevoking(true);
    try {
      await apiFetch(`/api/shared-access/grants/${grant.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      onChange?.();
    } catch {} finally { setRevoking(false); }
  };

  const scopeLabel = SCOPES.find((s) => s.value === grant.scope)?.label || grant.scope;
  const whoLabel = mine ? grant.granteeUserId : grant.grantorUserId;
  const fmtDate = (d) => {
    if (!d) return null;
    try { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
    catch { return null; }
  };
  const expires = fmtDate(grant.expiresAt);

  return (
    <div style={{ background: 'rgb(var(--surface-container-lowest))', border: '1px solid rgb(var(--surface-container-high))', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'rgb(var(--accent))' }}>{mine ? 'share' : 'visibility'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'rgb(var(--text-primary))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {mine ? 'To: ' : 'From: '}{whoLabel}
        </div>
        <div style={{ fontSize: 11, color: 'rgb(var(--text-secondary))', marginTop: 1 }}>
          {scopeLabel}{expires ? ` · expires ${expires}` : ' · no expiry'}
        </div>
      </div>
      {mine && (
        <button onClick={revoke} disabled={revoking} style={{ fontSize: 11, color: 'rgb(var(--danger))', background: 'transparent', border: '1px solid rgb(var(--surface-container-high))', borderRadius: 6, padding: '2px 8px', cursor: 'pointer', opacity: revoking ? 0.6 : 1 }}>
          {revoking ? 'Revoking…' : 'Revoke'}
        </button>
      )}
    </div>
  );
}
