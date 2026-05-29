import { useState, useEffect, useCallback, useMemo } from 'react';

/**
 * PeoplePanel — master-detail contacts. Left: searchable contact list.
 * Right: full contact card (header + contact info + facts + notes +
 * timeline). Multi-email/phone with labels + primary designation is read
 * from contact_identities (the source of truth); the legacy primary_email/
 * primary_phone scalars are a derived mirror.
 *
 * Components live in one file (matching the prior PeoplePanel convention
 * and keeping the lazy-loaded chunk cohesive). Timeline is a placeholder —
 * the join requires attendee + recipient ingestion that isn't built yet.
 */

const PRIMARY = '#4f4dcf';
const SURFACE = '#fbf8fe';
const SOFT = '#eeedfe';
const BORDER = '#e8e4f0';
const TXT1 = '#31323a';
const TXT2 = '#6b7280';
const TXT3 = '#9ca3af';

const LABEL_STYLES = {
  work:     { bg: '#e0edff', fg: '#1d4ed8' },
  mobile:   { bg: '#dcfce7', fg: '#15803d' },
  home:     { bg: '#fef3c7', fg: '#b45309' },
  calendar: { bg: SOFT,      fg: PRIMARY },
  other:    { bg: '#f1f1f4', fg: TXT2 },
};

function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}

// Auth'd image fetcher — image_blobs requires a bearer token and <img>
// tags can't send Authorization headers, so fetch the blob, wrap it as an
// object URL, and feed that to <img>. Returns null while loading / on
// failure (caller renders an initials fallback).
function useAuthBlobUrl(apiFetch, authToken, blobId) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!blobId) { setUrl(null); return; }
    let cancelled = false;
    let objectUrl = null;
    (async () => {
      try {
        const r = await apiFetch(`/api/image-blobs/${encodeURIComponent(blobId)}`, { headers: { Authorization: `Bearer ${authToken}` } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch { /* silent — caller renders initials */ }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [apiFetch, authToken, blobId]);
  return url;
}

export default function PeoplePanel({ apiFetch, authToken }) {
  const [contacts, setContacts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const auth = useMemo(() => ({ headers: { Authorization: `Bearer ${authToken}` } }), [authToken]);

  const reloadList = useCallback(async () => {
    try {
      const r = await apiFetch('/api/contacts', auth);
      const d = await r.json();
      setContacts(Array.isArray(d?.contacts) ? d.contacts : []);
    } catch {} finally { setLoaded(true); }
  }, [apiFetch, auth]);

  useEffect(() => { reloadList(); }, [reloadList]);

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
    <div style={{ display: 'flex', height: '100%', minHeight: 0, fontFamily: 'Manrope, sans-serif', background: SURFACE }}>
      <ContactsList
        contacts={filtered}
        total={contacts.length}
        loaded={loaded}
        query={query}
        setQuery={setQuery}
        selectedId={selectedId}
        onSelect={(id) => { setSelectedId(id); setAdding(false); }}
        onNew={() => { setAdding(true); setSelectedId(null); }}
      />
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        {adding ? (
          <div style={{ padding: '28px 32px' }}>
            <NewContactForm
              apiFetch={apiFetch}
              authToken={authToken}
              onCancel={() => setAdding(false)}
              onCreated={async (newId) => { setAdding(false); await reloadList(); if (newId) setSelectedId(newId); }}
            />
          </div>
        ) : selectedId ? (
          <ContactDetail
            key={selectedId}
            contactId={selectedId}
            apiFetch={apiFetch}
            authToken={authToken}
            onArchived={() => { setSelectedId(null); reloadList(); }}
            onChanged={reloadList}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: TXT3, fontSize: 14 }}>
            Select a contact
          </div>
        )}
      </div>
    </div>
  );
}

function ContactsList({ contacts, total, loaded, query, setQuery, selectedId, onSelect, onNew }) {
  return (
    <div style={{ width: 340, flexShrink: 0, borderRight: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', background: '#fff' }}>
      <div style={{ padding: '18px 18px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 20, fontWeight: 700, color: TXT1, margin: 0 }}>People</h1>
          <button onClick={onNew} style={{ fontSize: 12, fontWeight: 600, color: PRIMARY, background: 'transparent', border: 'none', cursor: 'pointer' }}>
            + New Contact
          </button>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email, or company…"
          style={{ width: '100%', fontSize: 13, padding: '8px 12px', border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none', fontFamily: 'Manrope, sans-serif', boxSizing: 'border-box' }}
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 10px' }}>
        {!loaded ? (
          <div style={{ fontSize: 13, color: TXT3, padding: '8px 8px' }}>Loading…</div>
        ) : contacts.length === 0 ? (
          <div style={{ fontSize: 13, color: TXT3, fontStyle: 'italic', padding: '8px 8px' }}>
            {total === 0 ? 'No contacts yet — add one above, or let Aria pick them up from your mail + calendar.' : 'No contacts match that search.'}
          </div>
        ) : (
          contacts.map((c) => (
            <ContactTile key={c.id} contact={c} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
          ))
        )}
      </div>
      <div style={{ padding: '8px 18px', borderTop: `1px solid ${BORDER}`, fontSize: 11, color: TXT3 }}>
        {loaded ? `${contacts.length} of ${total} contacts` : ''}
      </div>
    </div>
  );
}

function ContactTile({ contact, selected, onSelect }) {
  const sub = [contact.role, contact.company].filter(Boolean).join(' · ');
  return (
    <div
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer',
        marginBottom: 2,
        background: selected ? SOFT : 'transparent',
        border: selected ? `1px solid ${BORDER}` : '1px solid transparent',
      }}
    >
      <div style={{ width: 34, height: 34, borderRadius: '50%', background: selected ? PRIMARY : '#e9e7f3', color: selected ? '#fff' : PRIMARY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
        {initials(contact.displayName)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: TXT1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.displayName || 'Unknown'}</div>
        {sub && <div style={{ fontSize: 11, color: TXT2, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
      </div>
      {selected && <span className="material-symbols-outlined" style={{ fontSize: 16, color: PRIMARY }}>chevron_right</span>}
    </div>
  );
}

function SectionLabel({ children, subtitle, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: TXT2, textTransform: 'uppercase', letterSpacing: '0.07em' }}>
        {children}
        {subtitle && <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0, color: TXT3 }}> · {subtitle}</span>}
      </div>
      {right}
    </div>
  );
}

function ContactDetail({ contactId, apiFetch, authToken, onArchived, onChanged }) {
  const [detail, setDetail] = useState(null); // { contact, notes, facts, identities }
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const auth = useMemo(() => ({ headers: { Authorization: `Bearer ${authToken}` } }), [authToken]);

  const reload = useCallback(async () => {
    try {
      const r = await apiFetch(`/api/contacts/${contactId}/context`, auth);
      const d = await r.json();
      setDetail(d && d.contact ? d : null);
    } catch { setDetail(null); } finally { setLoaded(true); }
  }, [apiFetch, auth, contactId]);

  useEffect(() => { setLoaded(false); reload(); }, [reload]);

  const emails = useMemo(() => (detail?.identities || []).filter((i) => i.kind === 'email'), [detail]);
  const phones = useMemo(() => (detail?.identities || []).filter((i) => i.kind === 'phone'), [detail]);

  const archive = async () => {
    if (!detail) return;
    if (!window.confirm(`Archive "${detail.contact.displayName}"? You can restore them later.`)) return;
    try {
      await apiFetch(`/api/contacts/${contactId}/archive`, { method: 'POST', ...auth });
      onArchived?.();
    } catch {}
  };

  if (!loaded) return <DetailSkeleton />;
  if (!detail) return <div style={{ padding: 32, color: TXT3, fontSize: 13 }}>Failed to load contact.</div>;

  if (editing) {
    return (
      <div style={{ padding: '28px 32px' }}>
        <EditContactForm
          contact={detail.contact}
          apiFetch={apiFetch}
          authToken={authToken}
          onCancel={() => setEditing(false)}
          onSaved={async () => { setEditing(false); await reload(); onChanged?.(); }}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 760 }}>
      <ContactHeader
        contact={detail.contact}
        apiFetch={apiFetch}
        authToken={authToken}
        onEdit={() => setEditing(true)}
        onArchive={archive}
      />
      <div style={{ height: 1, background: BORDER, margin: '20px 0' }} />
      <ContactInfoSection emails={emails} phones={phones} />
      <FactsSection facts={detail.facts || []} />
      <NotesSection
        notes={detail.notes || []}
        contactId={contactId}
        apiFetch={apiFetch}
        authToken={authToken}
        onAdded={reload}
      />
      <TimelineSection />
    </div>
  );
}

function ContactHeader({ contact, apiFetch, authToken, onEdit, onArchive }) {
  const avatarUrl = useAuthBlobUrl(apiFetch, authToken, contact.imageBlobId);
  const sub = [contact.role, contact.company].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
      <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#e9e7f3', color: PRIMARY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, flexShrink: 0, overflow: 'hidden' }}>
        {avatarUrl ? <img src={avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(contact.displayName)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 20, fontWeight: 700, color: TXT1 }}>{contact.displayName || 'Unknown'}</div>
        {sub && <div style={{ fontSize: 13, color: TXT2, marginTop: 2 }}>{sub}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onEdit} style={btnGhost}>Edit</button>
        <button onClick={onArchive} style={{ ...btnGhost, color: '#dc2626' }}>Archive</button>
      </div>
    </div>
  );
}

function IdentityRow({ identity, icon }) {
  const ls = LABEL_STYLES[identity.label] || LABEL_STYLES.other;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
      <span className="material-symbols-outlined" style={{ fontSize: 17, color: TXT3 }}>{icon}</span>
      <span style={{ fontSize: 13.5, color: identity.isPrimary ? TXT1 : TXT2, fontWeight: identity.isPrimary ? 600 : 400, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {identity.value}
      </span>
      {identity.label && (
        <span style={{ fontSize: 10.5, fontWeight: 600, padding: '1px 7px', borderRadius: 10, background: ls.bg, color: ls.fg, textTransform: 'capitalize' }}>{identity.label}</span>
      )}
      {identity.isPrimary && (
        <span className="material-symbols-outlined" style={{ fontSize: 15, color: PRIMARY, fontVariationSettings: "'FILL' 1" }} title="Primary">star</span>
      )}
    </div>
  );
}

function ContactInfoSection({ emails, phones }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <SectionLabel>Contact info</SectionLabel>
      {emails.length === 0 && phones.length === 0 ? (
        <div style={{ fontSize: 13, color: TXT3, fontStyle: 'italic' }}>No email or phone yet.</div>
      ) : (
        <>
          {emails.map((e) => <IdentityRow key={e.id} identity={e} icon="mail" />)}
          {phones.map((p) => <IdentityRow key={p.id} identity={p} icon="call" />)}
        </>
      )}
    </div>
  );
}

function FactsSection({ facts }) {
  if (!facts.length) return null;
  return (
    <div style={{ marginBottom: 24 }}>
      <SectionLabel subtitle="Aria-extracted">Facts</SectionLabel>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {facts.map((f) => (
          <li key={f.id} style={{ fontSize: 13, color: '#374151', padding: '3px 0', display: 'flex', gap: 8 }}>
            <span style={{ color: PRIMARY }}>•</span>
            <span style={{ flex: 1 }}>{f.factText}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NotesSection({ notes, contactId, apiFetch, authToken, onAdded }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const t = text.trim();
    if (!t) return;
    setSaving(true);
    try {
      const r = await apiFetch(`/api/contacts/${contactId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ text: t }),
      });
      if (r.ok) { setText(''); setAdding(false); onAdded?.(); }
    } catch {} finally { setSaving(false); }
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <SectionLabel right={!adding && <button onClick={() => setAdding(true)} style={linkBtn}>+ Add note</button>}>Notes</SectionLabel>
      {adding && (
        <div style={{ marginBottom: 8 }}>
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Note…"
            style={{ width: '100%', boxSizing: 'border-box', fontSize: 13, padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none', resize: 'vertical', minHeight: 56, fontFamily: 'Manrope, sans-serif' }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => { setAdding(false); setText(''); }} style={btnGhost}>Cancel</button>
            <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Add'}</button>
          </div>
        </div>
      )}
      {notes.length === 0 ? (
        <div style={{ fontSize: 13, color: TXT3, fontStyle: 'italic' }}>No notes yet</div>
      ) : (
        notes.map((n) => (
          <div key={n.id} style={{ fontSize: 13, color: '#374151', padding: '6px 0', borderTop: `1px dashed ${BORDER}`, whiteSpace: 'pre-wrap' }}>{n.factText}</div>
        ))
      )}
    </div>
  );
}

function TimelineSection() {
  // Placeholder — the calendar+email join requires attendee and recipient
  // ingestion that isn't built yet. Wiring lands once that exists.
  return (
    <div style={{ marginBottom: 8 }}>
      <SectionLabel subtitle="last 90 days">Timeline</SectionLabel>
      <div style={{ fontSize: 13, color: TXT3, fontStyle: 'italic' }}>
        Interaction history (calendar + email) is coming soon.
      </div>
    </div>
  );
}

function DetailSkeleton() {
  const bar = (w) => <div style={{ height: 12, width: w, background: '#eceaf4', borderRadius: 6 }} />;
  return (
    <div style={{ padding: '28px 32px', maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#eceaf4' }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{bar(160)}{bar(110)}</div>
      </div>
      <div style={{ height: 1, background: BORDER, margin: '20px 0' }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{bar(220)}{bar(180)}{bar(200)}</div>
    </div>
  );
}

function NewContactForm({ apiFetch, authToken, onCancel, onCreated }) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [role, setRole] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const save = async () => {
    const fn = firstName.trim(), ln = lastName.trim(), dn = displayName.trim(), co = company.trim();
    if (!dn && !fn && !ln && !co) { setError('Need a name or company'); return; }
    setSaving(true); setError(null);
    try {
      const r = await apiFetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          display_name: dn || null, first_name: fn || null, last_name: ln || null,
          primary_email: email.trim() || null, primary_phone: phone.trim() || null,
          company: co || null, role: role.trim() || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return; }
      onCreated?.(d?.contact?.id || null);
    } catch (e) { setError(e.message || 'Network error'); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, maxWidth: 520 }}>
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 16, fontWeight: 700, color: TXT1, marginBottom: 12 }}>New contact</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <input autoFocus value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" style={inp} />
        <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" style={inp} />
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name (auto if blank)" style={inp} />
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Primary email" style={inp} />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" style={inp} />
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" style={inp} />
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role" style={inp} />
      </div>
      {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 8 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={btnGhost}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

function EditContactForm({ contact, apiFetch, authToken, onCancel, onSaved }) {
  const [firstName, setFirstName] = useState(contact.firstName || '');
  const [lastName, setLastName] = useState(contact.lastName || '');
  const [displayName, setDisplayName] = useState(contact.displayName || '');
  const [company, setCompany] = useState(contact.company || '');
  const [role, setRole] = useState(contact.role || '');
  const [notes, setNotes] = useState(contact.notes || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Auto-derived display name preview (manual override > first+last >
  // single name). Shown as placeholder when display name is blank.
  const derived = [firstName.trim(), lastName.trim()].filter(Boolean).join(' ') || 'Unknown';

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const r = await apiFetch(`/api/contacts/${contact.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({
          display_name: displayName.trim() || derived,
          first_name: firstName.trim() || null,
          last_name: lastName.trim() || null,
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
    <div style={{ background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, maxWidth: 520 }}>
      <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 16, fontWeight: 700, color: TXT1, marginBottom: 12 }}>Edit contact</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="First name" style={inp} />
        <input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Last name" style={inp} />
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={derived} style={inp} />
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company" style={inp} />
        <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role" style={inp} />
      </div>
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (freeform)"
        style={{ ...inp, width: '100%', boxSizing: 'border-box', marginTop: 8, resize: 'vertical', minHeight: 56, fontFamily: 'Manrope, sans-serif' }} />
      <div style={{ fontSize: 11, color: TXT3, marginTop: 8 }}>Email and phone are managed in the contact info section.</div>
      {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={btnGhost}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

const inp = { fontSize: 13, padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, outline: 'none', fontFamily: 'Manrope, sans-serif' };
const btnGhost = { fontSize: 12, fontWeight: 600, color: PRIMARY, background: 'transparent', border: `1px solid ${BORDER}`, borderRadius: 6, padding: '4px 12px', cursor: 'pointer' };
const btnPrimary = { fontSize: 12, fontWeight: 600, color: '#fff', background: PRIMARY, border: 'none', borderRadius: 6, padding: '5px 14px', cursor: 'pointer' };
const linkBtn = { fontSize: 11, fontWeight: 600, color: PRIMARY, background: 'transparent', border: 'none', cursor: 'pointer' };
