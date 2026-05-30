import { useState, useEffect, useCallback, useMemo, useRef, forwardRef } from 'react';

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

const PRIMARY = 'rgb(var(--accent))';
const SURFACE = 'rgb(var(--surface))';
const SOFT = 'rgb(var(--accent-surface))';
const BORDER = 'rgb(var(--outline-variant))';
const TXT1 = 'rgb(var(--text-primary))';
const TXT2 = 'rgb(var(--text-secondary))';
const TXT3 = 'rgb(var(--text-faint))';

const LABEL_STYLES = {
  work:     { bg: 'rgb(var(--accent-surface))',  fg: 'rgb(var(--primary))' },
  mobile:   { bg: 'rgb(var(--success-surface))', fg: 'rgb(var(--success))' },
  home:     { bg: 'rgb(var(--warning-surface))', fg: 'rgb(var(--warning))' },
  calendar: { bg: SOFT,      fg: PRIMARY },
  other:    { bg: 'rgb(var(--surface-container))', fg: TXT2 },
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
  const listRef = useRef(null);
  const tileRefs = useRef({});
  // Keyboard cursor — a highlight that arrows move; Enter commits it to the
  // detail pane. Distinct from `selectedId` so arrowing doesn't fire a fetch
  // per keypress. Seeded from the current selection when the list gains focus.
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (active >= contacts.length) setActive(contacts.length - 1);
  }, [contacts.length, active]);

  const onKeyDown = (e) => {
    if (!contacts.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => {
        const base = i < 0 ? contacts.findIndex((c) => c.id === selectedId) : i;
        const start = base < 0 ? 0 : base;
        const next = e.key === 'ArrowDown' ? Math.min(contacts.length - 1, start + 1) : Math.max(0, start - 1);
        tileRefs.current[contacts[next]?.id]?.scrollIntoView({ block: 'nearest' });
        return next;
      });
    } else if (e.key === 'Enter' && active >= 0 && contacts[active]) {
      e.preventDefault();
      onSelect(contacts[active].id);
    }
  };

  return (
    <div style={{ width: 340, flexShrink: 0, borderRight: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column', background: 'rgb(var(--surface-container-lowest))' }}>
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
      <div
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(-1)}
        style={{ flex: 1, overflowY: 'auto', padding: '0 10px', outline: 'none' }}
      >
        {!loaded ? (
          <ListSkeleton />
        ) : contacts.length === 0 ? (
          <div style={{ fontSize: 13, color: TXT3, fontStyle: 'italic', padding: '12px 8px', lineHeight: 1.5 }}>
            {total === 0
              ? 'No contacts yet. Add one with “+ New Contact” above — or let Aria pick them up automatically from your mail and calendar.'
              : 'No contacts match that search.'}
          </div>
        ) : (
          contacts.map((c, i) => (
            <ContactTile
              key={c.id}
              ref={(el) => { if (el) tileRefs.current[c.id] = el; else delete tileRefs.current[c.id]; }}
              contact={c}
              selected={c.id === selectedId}
              active={i === active}
              onSelect={() => onSelect(c.id)}
            />
          ))
        )}
      </div>
      <div style={{ padding: '8px 18px', borderTop: `1px solid ${BORDER}`, fontSize: 11, color: TXT3 }}>
        {loaded ? `${contacts.length} of ${total} contacts` : ''}
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div style={{ padding: '4px 0' }}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px' }}>
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: 'rgb(var(--surface-container))', flexShrink: 0 }} />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ height: 11, width: `${55 + (i % 3) * 12}%`, background: 'rgb(var(--surface-container))', borderRadius: 6 }} />
            <div style={{ height: 9, width: `${30 + (i % 2) * 15}%`, background: 'rgb(var(--surface-container))', borderRadius: 6 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

const ContactTile = forwardRef(function ContactTile({ contact, selected, active, onSelect }, ref) {
  const sub = [contact.role, contact.company].filter(Boolean).join(' · ');
  return (
    <div
      ref={ref}
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 10px', borderRadius: 8, cursor: 'pointer',
        marginBottom: 2,
        background: selected ? SOFT : 'transparent',
        border: selected ? `1px solid ${BORDER}` : active ? `1px solid ${PRIMARY}` : '1px solid transparent',
      }}
    >
      <div style={{ width: 34, height: 34, borderRadius: '50%', background: selected ? PRIMARY : 'rgb(var(--accent-surface))', color: selected ? 'rgb(var(--accent-contrast))' : PRIMARY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
        {initials(contact.displayName)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: TXT1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contact.displayName || 'Unknown'}</div>
        {sub && <div style={{ fontSize: 11, color: TXT2, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
      </div>
      {selected && <span className="material-symbols-outlined" style={{ fontSize: 16, color: PRIMARY }}>chevron_right</span>}
    </div>
  );
});

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
        onPhotoChanged={() => { reload(); onChanged?.(); }}
      />
      <div style={{ height: 1, background: BORDER, margin: '20px 0' }} />
      <ContactInfoSection
        emails={emails}
        phones={phones}
        contactId={contactId}
        apiFetch={apiFetch}
        authToken={authToken}
        onChanged={() => { reload(); onChanged?.(); }}
      />
      <FactsSection facts={detail.facts || []} />
      <NotesSection
        notes={detail.notes || []}
        contactId={contactId}
        apiFetch={apiFetch}
        authToken={authToken}
        onAdded={reload}
      />
      <TimelineSection contactId={contactId} apiFetch={apiFetch} authToken={authToken} />
    </div>
  );
}

const PHOTO_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function ContactHeader({ contact, apiFetch, authToken, onEdit, onArchive, onPhotoChanged }) {
  const avatarUrl = useAuthBlobUrl(apiFetch, authToken, contact.imageBlobId);
  const sub = [contact.role, contact.company].filter(Boolean).join(' · ');
  const fileRef = useRef(null);
  const [hover, setHover] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const onPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (!PHOTO_MIME.includes(file.type)) { setError('Use a jpeg, png, gif, or webp image'); return; }
    const localUrl = URL.createObjectURL(file);
    setPreview(localUrl); setUploading(true); setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // No Content-Type header — the browser sets the multipart boundary.
      const up = await apiFetch('/api/image-blobs', { method: 'POST', headers: { Authorization: `Bearer ${authToken}` }, body: fd });
      const upd = await up.json().catch(() => ({}));
      if (!up.ok || !upd.blob_id) throw new Error(upd.error || `HTTP ${up.status}`);
      const pr = await apiFetch(`/api/contacts/${contact.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ image_blob_id: upd.blob_id }),
      });
      if (!pr.ok) throw new Error(`HTTP ${pr.status}`);
      await onPhotoChanged?.();
    } catch (err) {
      setError(err.message || 'Upload failed');
      setPreview(null); // revert to prior avatar
    } finally { setUploading(false); }
  };

  const shown = preview || avatarUrl;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div
          onClick={() => !uploading && fileRef.current?.click()}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          title="Change photo"
          style={{ position: 'relative', width: 52, height: 52, borderRadius: '50%', background: 'rgb(var(--accent-surface))', color: PRIMARY, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, flexShrink: 0, overflow: 'hidden', cursor: uploading ? 'wait' : 'pointer' }}
        >
          {shown ? <img src={shown} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : initials(contact.displayName)}
          {(hover || uploading) && (
            <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'rgb(var(--accent-contrast))' }}>{uploading ? 'hourglass_top' : 'photo_camera'}</span>
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" onChange={onPick} style={{ display: 'none' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 20, fontWeight: 700, color: TXT1 }}>{contact.displayName || 'Unknown'}</div>
          {sub && <div style={{ fontSize: 13, color: TXT2, marginTop: 2 }}>{sub}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onEdit} style={btnGhost}>Edit</button>
          <button onClick={onArchive} style={{ ...btnGhost, color: 'rgb(var(--danger))' }}>Archive</button>
        </div>
      </div>
      {error && <div style={{ fontSize: 12, color: 'rgb(var(--danger))', marginTop: 6 }}>{error}</div>}
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

const LABEL_OPTIONS = ['work', 'mobile', 'home', 'calendar', 'other'];

function ContactInfoSection({ emails, phones, contactId, apiFetch, authToken, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);

  // Optimistic mirror of the identity lists. Edits land here instantly; the
  // server request reconciles on success (via onChanged → parent reload,
  // which refreshes our props) and reverts to props on failure.
  const [optEmails, setOptEmails] = useState(emails);
  const [optPhones, setOptPhones] = useState(phones);
  useEffect(() => { setOptEmails(emails); }, [emails]);
  useEffect(() => { setOptPhones(phones); }, [phones]);

  const mutate = useCallback(async (path, opts) => {
    setBusy(true); setError(null);
    try {
      const r = await apiFetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || `HTTP ${r.status}`); return false; }
      await onChanged?.();
      return true;
    } catch (e) { setError(e.message || 'Network error'); return false; }
    finally { setBusy(false); }
  }, [apiFetch, authToken, onChanged]);

  // Apply the local change, then fire the request; revert both lists to the
  // last server-confirmed props if it fails.
  const runOptimistic = async (applyLocal, path, opts) => {
    applyLocal();
    setBusy(true); setError(null);
    try {
      const r = await apiFetch(path, { ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || `HTTP ${r.status}`); setOptEmails(emails); setOptPhones(phones); return false; }
      await onChanged?.();
      return true;
    } catch (e) { setError(e.message || 'Network error'); setOptEmails(emails); setOptPhones(phones); return false; }
    finally { setBusy(false); }
  };

  const inEmails = (id) => optEmails.some((x) => x.id === id);
  const applyToKind = (id, fn) => (inEmails(id) ? setOptEmails(fn) : setOptPhones(fn));

  const setPrimary = (id) => runOptimistic(
    () => applyToKind(id, (list) => list.map((x) => ({ ...x, isPrimary: x.id === id }))),
    `/api/contacts/${contactId}/identities/${id}`, { method: 'PATCH', body: JSON.stringify({ is_primary: true }) },
  );
  const setLabel = (id, label) => runOptimistic(
    () => applyToKind(id, (list) => list.map((x) => (x.id === id ? { ...x, label } : x))),
    `/api/contacts/${contactId}/identities/${id}`, { method: 'PATCH', body: JSON.stringify({ label }) },
  );
  const remove = (id) => runOptimistic(
    () => applyToKind(id, (list) => list.filter((x) => x.id !== id)),
    `/api/contacts/${contactId}/identities/${id}`, { method: 'DELETE' },
  );
  // Add stays non-optimistic — the server assigns the id we'd need to render.
  const add = (body) => mutate(`/api/contacts/${contactId}/identities`, { method: 'POST', body: JSON.stringify(body) });

  const isEmpty = optEmails.length === 0 && optPhones.length === 0;

  return (
    <div style={{ marginBottom: 24 }}>
      <SectionLabel right={<button onClick={() => { setEditing((v) => !v); setAdding(false); setError(null); }} style={linkBtn}>{editing ? 'Done' : 'Edit'}</button>}>
        Contact info
      </SectionLabel>
      {isEmpty && !editing ? (
        <div style={{ fontSize: 13, color: TXT3, fontStyle: 'italic' }}>No email or phone yet.</div>
      ) : editing ? (
        <>
          {optEmails.map((e) => <IdentityEditRow key={e.id} identity={e} icon="mail" busy={busy} onPrimary={setPrimary} onLabel={setLabel} onRemove={remove} />)}
          {optPhones.map((p) => <IdentityEditRow key={p.id} identity={p} icon="call" busy={busy} onPrimary={setPrimary} onLabel={setLabel} onRemove={remove} />)}
        </>
      ) : (
        <>
          {optEmails.map((e) => <IdentityRow key={e.id} identity={e} icon="mail" />)}
          {optPhones.map((p) => <IdentityRow key={p.id} identity={p} icon="call" />)}
        </>
      )}
      {error && <div style={{ fontSize: 12, color: 'rgb(var(--danger))', marginTop: 6 }}>{error}</div>}
      {editing && (
        adding ? (
          <AddIdentityForm busy={busy} onCancel={() => setAdding(false)} onAdd={async (body) => { const ok = await add(body); if (ok) setAdding(false); }} />
        ) : (
          <button onClick={() => setAdding(true)} style={{ ...linkBtn, marginTop: 8 }}>+ Add email or phone</button>
        )
      )}
    </div>
  );
}

function IdentityEditRow({ identity, icon, busy, onPrimary, onLabel, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' }}>
      <span className="material-symbols-outlined" style={{ fontSize: 17, color: TXT3 }}>{icon}</span>
      <span style={{ fontSize: 13.5, color: TXT1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{identity.value}</span>
      <select value={identity.label || 'other'} disabled={busy} onChange={(e) => onLabel(identity.id, e.target.value)}
        style={{ fontSize: 11, padding: '2px 4px', border: `1px solid ${BORDER}`, borderRadius: 6, color: TXT2, background: 'rgb(var(--surface-container-lowest))', cursor: 'pointer' }}>
        {LABEL_OPTIONS.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
      <button title={identity.isPrimary ? 'Primary' : 'Make primary'} disabled={busy || identity.isPrimary} onClick={() => onPrimary(identity.id)}
        style={{ background: 'transparent', border: 'none', cursor: identity.isPrimary ? 'default' : 'pointer', padding: 0, lineHeight: 0 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 16, color: identity.isPrimary ? PRIMARY : TXT3, fontVariationSettings: identity.isPrimary ? "'FILL' 1" : "'FILL' 0" }}>star</span>
      </button>
      <button title="Remove" disabled={busy} onClick={() => onRemove(identity.id)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 0 }}>
        <span className="material-symbols-outlined" style={{ fontSize: 16, color: TXT3 }}>close</span>
      </button>
    </div>
  );
}

function AddIdentityForm({ busy, onCancel, onAdd }) {
  const [type, setType] = useState('email');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('work');
  const [isPrimary, setIsPrimary] = useState(false);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onAdd({ identity_type: type, identity_value: v, label, is_primary: isPrimary });
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8, padding: 10, border: `1px solid ${BORDER}`, borderRadius: 8, background: 'rgb(var(--surface-container-lowest))' }}>
      <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...inp, padding: '5px 6px' }}>
        <option value="email">Email</option>
        <option value="phone">Phone</option>
      </select>
      <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder={type === 'email' ? 'name@example.com' : 'Phone number'} style={{ ...inp, flex: 1, minWidth: 160 }} />
      <select value={label} onChange={(e) => setLabel(e.target.value)} style={{ ...inp, padding: '5px 6px' }}>
        {LABEL_OPTIONS.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
      <label style={{ fontSize: 12, color: TXT2, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
        <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} /> Primary
      </label>
      <button onClick={onCancel} style={btnGhost}>Cancel</button>
      <button onClick={submit} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>Add</button>
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
          <li key={f.id} style={{ fontSize: 13, color: 'rgb(var(--text-primary))', padding: '3px 0', display: 'flex', gap: 8 }}>
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
          <div key={n.id} style={{ fontSize: 13, color: 'rgb(var(--text-primary))', padding: '6px 0', borderTop: `1px dashed ${BORDER}`, whiteSpace: 'pre-wrap' }}>{n.factText}</div>
        ))
      )}
    </div>
  );
}

// Universal interaction timeline — emails, calendar events, meeting outcomes,
// notes, and linked tasks, merged server-side via getEntityTimeline and matched
// on the contact's email identities (plus clean FK joins for notes/tasks). The
// calendar slice is a rolling window, so this leans recent, not full history.
function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

// type → icon + accent + secondary-line builder. meta shapes come straight from
// getEntityTimeline (db.cjs): email{direction,from,snippet,provider},
// event{endTime,location,accountEmail}, meeting_outcome{status,note,followUpNeeded,followUpBy},
// note{text}, task{status,priority,dueDate,completed}.
const TIMELINE_TYPES = {
  email:           { icon: 'mail',          accent: 'rgb(var(--accent))' },
  event:           { icon: 'event',         accent: 'rgb(var(--primary-container))' },
  meeting_outcome: { icon: 'task_alt',      accent: 'rgb(var(--success))' },
  note:            { icon: 'sticky_note_2', accent: 'rgb(var(--warning))' },
  task:            { icon: 'check_circle',  accent: 'rgb(var(--text-secondary))' },
};

// deep_link.panel → App.jsx activeView name. Tasks live on the dashboard.
const PANEL_TO_VIEW = { inbox: 'inbox', calendar: 'calendar', people: 'people', tasks: 'dashboard' };

function timelineSecondary(e) {
  const m = e.meta || {};
  const when = fmtWhen(e.date_iso);
  switch (e.type) {
    case 'email': {
      const who = m.direction === 'outbound' ? 'You emailed them' : 'They emailed you';
      return { line: `${who} · ${when}`, sub: m.snippet || '' };
    }
    case 'event': {
      const upcoming = e.date_iso && new Date(e.date_iso) > new Date();
      return { line: `${when}${m.location ? ` · ${m.location}` : ''}${upcoming ? ' · upcoming' : ''}`, sub: '' };
    }
    case 'meeting_outcome':
      return { line: `Outcome${m.status ? ` · ${m.status}` : ''} · ${when}`, sub: m.note || '' };
    case 'note':
      return { line: `Note · ${when}`, sub: m.text || '' };
    case 'task': {
      const bits = [m.completed ? 'Done' : (m.status || 'open')];
      if (m.dueDate) bits.push(`due ${fmtWhen(m.dueDate).split(' · ')[0]}`);
      return { line: `Task · ${bits.join(' · ')}`, sub: '' };
    }
    default:
      return { line: when, sub: '' };
  }
}

function TimelineRow({ event }) {
  const cfg = TIMELINE_TYPES[event.type] || { icon: 'circle', accent: TXT3 };
  const { line, sub } = timelineSecondary(event);
  const targetView = PANEL_TO_VIEW[event.deep_link?.panel];
  // 'people' deep-links point back at this same panel — no useful nav.
  const canNav = targetView && targetView !== 'people';
  const go = () => {
    if (!canNav) return;
    try { window.dispatchEvent(new CustomEvent('navigate-app', { detail: { view: targetView } })); } catch {}
  };
  return (
    <div
      onClick={go}
      style={{ display: 'flex', gap: 10, padding: '7px 0', borderTop: `1px dashed ${BORDER}`, cursor: canNav ? 'pointer' : 'default' }}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 17, color: cfg.accent, marginTop: 1 }}>{cfg.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: TXT1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.title || '(No title)'}</div>
        <div style={{ fontSize: 11.5, color: TXT2, marginTop: 1 }}>{line}</div>
        {sub ? (
          <div style={{ fontSize: 11.5, color: TXT3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
        ) : null}
      </div>
    </div>
  );
}

const TIMELINE_FILTERS = [
  { key: 'all',             label: 'All' },
  { key: 'email',           label: 'Emails' },
  { key: 'event',           label: 'Meetings' },
  { key: 'meeting_outcome', label: 'Outcomes' },
  { key: 'note',            label: 'Notes' },
  { key: 'task',            label: 'Tasks' },
];

function TimelineSection({ contactId, apiFetch, authToken }) {
  const [items, setItems] = useState(null); // null = loading
  const [filter, setFilter] = useState('all');
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    (async () => {
      try {
        const qs = filter === 'all' ? '' : `?sources=${filter}`;
        const r = await apiFetch(`/api/contacts/${contactId}/timeline${qs}`, { headers: { Authorization: `Bearer ${authToken}` } });
        const d = await r.json().catch(() => ({}));
        if (!cancelled) setItems(Array.isArray(d?.timeline) ? d.timeline : []);
      } catch { if (!cancelled) setItems([]); }
    })();
    return () => { cancelled = true; };
  }, [contactId, apiFetch, authToken, filter]);

  return (
    <div style={{ marginBottom: 8 }}>
      <SectionLabel subtitle="emails, meetings, notes & tasks">Timeline</SectionLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 8px' }}>
        {TIMELINE_FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                fontSize: 11.5, padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                border: `1px solid ${active ? PRIMARY : BORDER}`,
                background: active ? PRIMARY : 'transparent',
                color: active ? 'rgb(var(--accent-contrast))' : TXT2,
              }}
            >{f.label}</button>
          );
        })}
      </div>
      {items === null ? (
        <div style={{ fontSize: 13, color: TXT3 }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ fontSize: 13, color: TXT3, fontStyle: 'italic' }}>
          {filter === 'all' ? 'No recent activity with this contact.' : 'Nothing here yet.'}
        </div>
      ) : (
        items.map((e) => <TimelineRow key={`${e.source_table}:${e.source_id}`} event={e} />)
      )}
    </div>
  );
}

function DetailSkeleton() {
  const bar = (w) => <div style={{ height: 12, width: w, background: 'rgb(var(--surface-container))', borderRadius: 6 }} />;
  return (
    <div style={{ padding: '28px 32px', maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgb(var(--surface-container))' }} />
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
    <div style={{ background: 'rgb(var(--surface-container-lowest))', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, maxWidth: 520 }}>
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
      {error && <div style={{ fontSize: 12, color: 'rgb(var(--danger))', marginTop: 8 }}>{error}</div>}
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
    <div style={{ background: 'rgb(var(--surface-container-lowest))', border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, maxWidth: 520 }}>
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
      {error && <div style={{ fontSize: 12, color: 'rgb(var(--danger))', marginTop: 6 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6, marginTop: 12, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={btnGhost}>Cancel</button>
        <button onClick={save} disabled={saving} style={{ ...btnPrimary, opacity: saving ? 0.6 : 1 }}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

const inp = { fontSize: 13, padding: '7px 10px', border: `1px solid ${BORDER}`, borderRadius: 6, outline: 'none', fontFamily: 'Manrope, sans-serif' };
const btnGhost = { fontSize: 12, fontWeight: 600, color: PRIMARY, background: 'transparent', border: `1px solid ${BORDER}`, borderRadius: 6, padding: '4px 12px', cursor: 'pointer' };
const btnPrimary = { fontSize: 12, fontWeight: 600, color: 'rgb(var(--accent-contrast))', background: PRIMARY, border: 'none', borderRadius: 6, padding: '5px 14px', cursor: 'pointer' };
const linkBtn = { fontSize: 11, fontWeight: 600, color: PRIMARY, background: 'transparent', border: 'none', cursor: 'pointer' };
