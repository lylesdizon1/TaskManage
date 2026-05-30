import { useState, useEffect, useRef, useCallback } from 'react';

// Contact picker for the EmailDraftCard `to` field. Typeahead against
// /api/contacts/search returning name+email matches. Per Phase 3 spec
// Q3: auto-resolve threshold is 0.9 (handled server-side in the
// /api/chat/draft response); below that, the picker renders with the
// top match pre-selected but requires explicit user confirmation.
//
// Also accepts free-text typing of a full email address so users can
// send to recipients they don't have in contacts yet.

export default function ContactPickerInput({
  value,                 // { email, display_name, confidence } | null
  onChange,              // ({email, display_name}) => void
  apiFetch,
  authToken,
  candidates = [],       // server-provided top matches from /api/chat/draft
  disabled = false,
}) {
  const [query, setQuery] = useState(value?.email || '');
  const [open, setOpen] = useState(false);
  const [matches, setMatches] = useState(candidates);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => { setQuery(value?.email || ''); }, [value?.email]);

  // Refresh matches as user types — debounced 200ms so we don't hammer
  // /api/contacts/search on every keystroke.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q || q === value?.email) { setMatches(candidates); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await apiFetch(`/api/contacts/search?q=${encodeURIComponent(q)}&limit=5`, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.ok) {
          const data = await res.json();
          setMatches(Array.isArray(data) ? data : []);
        }
      } catch {}
      finally { setLoading(false); }
    }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open, apiFetch, authToken, candidates, value?.email]);

  // Click outside closes the dropdown.
  useEffect(() => {
    const onDocClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const pickMatch = useCallback((m) => {
    onChange({ email: m.primaryEmail, display_name: m.displayName });
    setQuery(m.primaryEmail);
    setOpen(false);
  }, [onChange]);

  const commitTyped = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    // Accept either a full email address or "name <email>" form
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(q)) {
      onChange({ email: q, display_name: q });
    }
  }, [query, onChange]);

  const isResolved = value?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email);

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={commitTyped}
        placeholder="Name or email address"
        disabled={disabled}
        className="w-full px-2 py-1.5 text-[13px] border border-outline-variant rounded-md focus:outline-none focus:border-primary disabled:bg-surface-container-low"
        style={{ fontFamily: 'Manrope, sans-serif' }}
      />
      {isResolved && !open && value.display_name && value.display_name !== value.email && (
        <div className="text-[11px] text-on-surface-variant mt-0.5 px-1">
          → {value.display_name}
        </div>
      )}
      {open && (matches.length > 0 || loading) && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-surface-container-lowest border border-outline-variant rounded-md shadow-lg max-h-48 overflow-y-auto">
          {loading && (
            <div className="px-2 py-1.5 text-[12px] text-text-faint">Searching…</div>
          )}
          {!loading && matches.map((m, i) => (
            <button
              key={m.id || `${m.primaryEmail}-${i}`}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pickMatch(m)}
              className="w-full text-left px-2 py-1.5 hover:bg-surface-container-low border-b border-outline-variant last:border-0"
            >
              <div className="text-[13px] text-on-surface truncate">{m.displayName}</div>
              {m.displayName !== m.primaryEmail && (
                <div className="text-[11px] text-on-surface-variant truncate">{m.primaryEmail}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
