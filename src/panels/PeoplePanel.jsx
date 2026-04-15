import { useState, useEffect, useCallback, useMemo } from 'react';

/**
 * PeoplePanel — personal contact notebook (V1).
 * Mirrors ProjectsPanel structure. List + expand-to-detail, inline
 * create, inline edit, inline note add. All state local; all mutations
 * hit /api/contacts directly.
 */
export default function PeoplePanel({ apiFetch, authToken }) {
  const [contacts, setContacts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await apiFetch('/api/contacts', { headers: { Authorization: `Bearer ${authToken}` } });
      const d = await r.json();
      setContacts(Array.isArray(d?.contacts) ? d.contacts : []);
    } catch {} finally { setLoaded(true); }
  }, [apiFetch, authToken]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) =>
      (c.displayName || '').toLowerCase().includes(q) ||
      (c.primaryEmail || '').toLowerCase().includes(q) ||
      (c.company || '').toLowerCase().includes(q),
    );
  }, [contacts, query]);

  return (
    <div className="flex-1 overflow-y-auto px-8 py-6 w-full" style={{ minHeight: 0, fontFamily: 'Manrope, sans-serif' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 24, fontWeight: 700, color: '#31323a' }}>People</h1>
        {!adding && (
          <button onClick={() => setAdding(true)} style={{ fontSize: 12, fontWeight: 600, color: '#4f4dcf', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            + New Contact
          </button>
        )}
      </div>

      <div style={{ marginBottom: 14 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email, or company…"
          style={{ width: '100%', fontSize: 13, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, outline: 'none', fontFamily: 'Manrope, sans-serif' }}
        />
      </div>

      {adding && (
        <NewContactForm
          apiFetch={apiFetch}
          authToken={authToken}
          onCancel={() => setAdding(false)}
          onCreated={() => { setAdding(false); reload(); }}
        />
      )}

      {!loaded ? (
        <div style={{ fontSize: 13, color: '#9ca3af' }}>Loading…</div>
      ) : filtered.length === 0 ? (
        <div style={{ fontSize: 13, color: '#9ca3af', fontStyle: 'italic' }}>
          {contacts.length === 0 ? 'No contacts yet — add one above, or let Aria pick them up from your mail + calendar.' : 'No contacts match that search.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((c) => (
            <ContactRow key={c.id} contact={c} apiFetch={apiFetch} authToken={authToken} onChange={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewContactForm({ apiFetch, authToken, onCancel, onCreated }) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    const name = displayName.trim();
    if (!name) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try {
      const r = await apiFetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          display_name: name,
          primary_email: email.trim() || null,
          company: company.trim() || null,
          role: role.trim() || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return; }
      onCreated?.();
    } catch (e) { setError(e.message || 'Network error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginBottom: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <input autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name (required)"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }} />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Primary email"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }} />
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }} />
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }} />
      </div>
      {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ fontSize: 12, color: '#6b7280', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: '#4f4dcf', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ContactRow({ contact, apiFetch, authToken, onChange }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null); // { contact, notes, facts, identities }
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await apiFetch(`/api/contacts/${contact.id}/context`, { headers: { Authorization: `Bearer ${authToken}` } });
      const d = await r.json();
      setDetail(d && d.contact ? d : null);
    } catch {} finally { setLoaded(true); }
  }, [apiFetch, authToken, contact.id]);

  useEffect(() => { if (expanded && !loaded) reload(); }, [expanded, loaded, reload]);

  const refreshFacts = async () => {
    try {
      const r = await apiFetch(`/api/contacts/${contact.id}/facts`, { headers: { Authorization: `Bearer ${authToken}` } });
      const d = await r.json();
      setDetail((prev) => prev ? { ...prev, facts: Array.isArray(d?.facts) ? d.facts : [] } : prev);
    } catch {}
  };

  const addNote = async () => {
    const text = noteText.trim();
    if (!text) return;
    setNoteSaving(true);
    try {
      const r = await apiFetch(`/api/contacts/${contact.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ text }),
      });
      if (r.ok) {
        setNoteText(''); setAddingNote(false);
        reload();
        // Fact extraction runs async server-side — refresh after ~3s.
        setTimeout(refreshFacts, 3000);
      }
    } catch {} finally { setNoteSaving(false); }
  };

  const remove = async () => {
    if (!window.confirm(`Delete contact "${contact.displayName}"?`)) return;
    try {
      await apiFetch(`/api/contacts/${contact.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${authToken}` } });
      onChange?.();
    } catch {}
  };

  const companyRole = [contact.company, contact.role].filter(Boolean).join(' · ');

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }} onClick={() => setExpanded((v) => !v)}>
        <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#6b7280' }}>{expanded ? 'expand_more' : 'chevron_right'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2937', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.displayName}</div>
          {companyRole && (
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{companyRole}</div>
          )}
        </div>
        {contact.primaryEmail && (
          <div style={{ fontSize: 11, color: '#9ca3af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{contact.primaryEmail}</div>
        )}
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid #f3f4f6', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12, background: '#fcfbff' }}>
          {!loaded ? (
            <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading…</div>
          ) : !detail ? (
            <div style={{ fontSize: 12, color: '#9ca3af' }}>Failed to load.</div>
          ) : editing ? (
            <EditContactForm
              contact={detail.contact}
              apiFetch={apiFetch}
              authToken={authToken}
              onCancel={() => setEditing(false)}
              onSaved={() => { setEditing(false); reload(); onChange?.(); }}
            />
          ) : (
            <>
              {/* Facts */}
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Facts</div>
                {detail.facts.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No facts yet — they'll appear here as you add notes or as mail is ingested.</div>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {detail.facts.map((f) => (
                      <li key={f.id} style={{ fontSize: 12, color: '#374151', padding: '3px 0', display: 'flex', gap: 6 }}>
                        <span style={{ color: '#4f4dcf' }}>•</span>
                        <span style={{ flex: 1 }}>{f.factText}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Notes */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Notes</div>
                  {!addingNote && (
                    <button onClick={() => setAddingNote(true)} style={{ fontSize: 11, color: '#4f4dcf', background: 'transparent', border: 'none', cursor: 'pointer' }}>+ Add note</button>
                  )}
                </div>
                {addingNote && (
                  <div style={{ marginBottom: 6 }}>
                    <textarea autoFocus value={noteText} onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Note…"
                      style={{ width: '100%', fontSize: 12, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none', resize: 'vertical', minHeight: 50, fontFamily: 'Manrope, sans-serif' }} />
                    <div style={{ display: 'flex', gap: 6, marginTop: 4, justifyContent: 'flex-end' }}>
                      <button onClick={() => { setAddingNote(false); setNoteText(''); }} style={{ fontSize: 12, color: '#6b7280', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
                      <button onClick={addNote} disabled={noteSaving} style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: '#4f4dcf', border: 'none', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', opacity: noteSaving ? 0.6 : 1 }}>
                        {noteSaving ? 'Saving…' : 'Add'}
                      </button>
                    </div>
                  </div>
                )}
                {detail.notes.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No notes yet</div>
                ) : (
                  detail.notes.map((n) => (
                    <div key={n.id} style={{ fontSize: 12, color: '#374151', padding: '4px 0', borderTop: '1px dashed #e5e7eb', whiteSpace: 'pre-wrap' }}>
                      {n.factText}
                    </div>
                  ))
                )}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid #f3f4f6', paddingTop: 8 }}>
                <button onClick={() => setEditing(true)} style={{ fontSize: 11, color: '#4f4dcf', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>Edit</button>
                <button onClick={remove} style={{ fontSize: 11, color: '#dc2626', background: 'transparent', border: '1px solid #d1d5db', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>Delete</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EditContactForm({ contact, apiFetch, authToken, onCancel, onSaved }) {
  const [displayName, setDisplayName] = useState(contact.displayName || '');
  const [email, setEmail] = useState(contact.primaryEmail || '');
  const [company, setCompany] = useState(contact.company || '');
  const [role, setRole] = useState(contact.role || '');
  const [notes, setNotes] = useState(contact.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    if (!displayName.trim()) { setError('Name is required'); return; }
    setSaving(true); setError(null);
    try {
      const r = await apiFetch(`/api/contacts/${contact.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          display_name: displayName.trim(),
          primary_email: email.trim() || null,
          company: company.trim() || null,
          role: role.trim() || null,
          notes: notes.trim() || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return; }
      onSaved?.();
    } catch (e) { setError(e.message || 'Network error'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }} />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Primary email"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }} />
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }} />
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role"
          style={{ fontSize: 13, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none' }} />
      </div>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (freeform)"
        style={{ width: '100%', marginTop: 8, fontSize: 13, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 6, outline: 'none', resize: 'vertical', minHeight: 50, fontFamily: 'Manrope, sans-serif' }} />
      {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ fontSize: 12, color: '#6b7280', background: 'transparent', border: 'none', cursor: 'pointer' }}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ fontSize: 12, fontWeight: 600, color: '#fff', background: '#4f4dcf', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
