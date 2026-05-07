import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

/**
 * AgentsPanel — Skills + Sub-agents management surface.
 *
 * Spec: docs/agents-foundation-v1.md §5d (D1 landing, D2 edit view).
 *
 * V1: Skills section is fully functional (list / edit / activate / pause
 * / delete). Sub-agents section is a placeholder until M3+M4 land.
 *
 * Single-file panel with two internal views — list and edit — toggled
 * via local state. Same component for blank and populated edit (D3).
 */

const PANEL_BG = '#fbf8fe';
const PRIMARY = '#4f4dcf';
const PRIMARY_LIGHT = '#7777fa';
const BORDER = '#e5e7eb';
const TEXT_PRIMARY = '#31323a';
const TEXT_SECONDARY = '#6b7280';

const PERSONAS = ['CFO', 'COO', 'Best-Friend', 'Operator', 'Personal', 'Brand'];

export default function AgentsPanel({ apiFetch, addToast }) {
  const [view, setView] = useState({ kind: 'list' }); // { kind: 'list' } | { kind: 'edit', id: null|string }
  const [skills, setSkills] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await apiFetch('/api/skills?include_inactive=true');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setSkills(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[agents] failed to load skills', err);
      addToast?.({ message: 'Could not load skills', type: 'error' });
    } finally { setLoaded(true); }
  }, [apiFetch, addToast]);

  useEffect(() => { reload(); }, [reload]);

  const onEdit = (id) => setView({ kind: 'edit', id });
  const onCreateNew = () => setView({ kind: 'edit', id: null });
  const onBackToList = () => { setView({ kind: 'list' }); reload(); };

  if (view.kind === 'edit') {
    return (
      <SkillEditView
        skillId={view.id}
        apiFetch={apiFetch}
        addToast={addToast}
        onClose={onBackToList}
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto w-full" style={{ background: PANEL_BG, fontFamily: 'Manrope, sans-serif' }}>
      <div className="px-8 py-6 max-w-[960px] mx-auto">
        <header style={{ marginBottom: 32 }}>
          <h1 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 28, fontWeight: 700, color: TEXT_PRIMARY, margin: 0 }}>
            Agents
          </h1>
          <p style={{ fontSize: 13, color: TEXT_SECONDARY, marginTop: 6 }}>
            Personalize how Aria knows you and what she works on for you.
          </p>
        </header>

        <SkillsSection
          skills={skills}
          loaded={loaded}
          onEdit={onEdit}
          onCreateNew={onCreateNew}
          apiFetch={apiFetch}
          addToast={addToast}
          onChanged={reload}
        />

        <SubAgentsSectionPlaceholder />
      </div>
    </div>
  );
}

// ── Skills section ─────────────────────────────────────────────────────

function SkillsSection({ skills, loaded, onEdit, onCreateNew, apiFetch, addToast, onChanged }) {
  const activeCount = skills.filter((s) => s.isActive).length;
  const draftCount = skills.length - activeCount;

  // Sort: last_used_at DESC, drafts (no usage) drop to bottom.
  const sorted = useMemo(() => {
    return [...skills].sort((a, b) => {
      const isDraftA = !a.isActive || !a.lastUsedAt;
      const isDraftB = !b.isActive || !b.lastUsedAt;
      if (isDraftA !== isDraftB) return isDraftA ? 1 : -1;
      const ta = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
      const tb = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
      return tb - ta;
    });
  }, [skills]);

  return (
    <section style={{ marginBottom: 40 }}>
      <SectionHeader
        title="Skills"
        subtitle={`Knowledge that loads into Aria's context when triggers match · ${activeCount} active · ${draftCount} draft`}
        ctaLabel="+ Add skill"
        onCta={onCreateNew}
      />

      {loaded && sorted.length === 0 && (
        <EmptyState onCreateNew={onCreateNew} />
      )}

      {sorted.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sorted.map((s) => (
            <SkillTile
              key={s.id}
              skill={s}
              onEdit={() => onEdit(s.id)}
              apiFetch={apiFetch}
              addToast={addToast}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function SectionHeader({ title, subtitle, ctaLabel, onCta }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
      <div>
        <h2 style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 20, fontWeight: 700, color: TEXT_PRIMARY, margin: 0 }}>
          {title}
        </h2>
        <p style={{ fontSize: 12, color: TEXT_SECONDARY, marginTop: 4, margin: 0 }}>{subtitle}</p>
      </div>
      {ctaLabel && (
        <button
          onClick={onCta}
          style={{
            fontSize: 13, fontWeight: 600, color: 'white', background: PRIMARY,
            border: 'none', padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
          }}
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}

function EmptyState({ onCreateNew }) {
  return (
    <div style={{
      padding: 32, textAlign: 'center', background: 'white',
      border: `1px dashed ${BORDER}`, borderRadius: 12,
    }}>
      <div style={{ fontSize: 14, color: TEXT_PRIMARY, fontWeight: 600, marginBottom: 8 }}>
        No skills yet
      </div>
      <div style={{ fontSize: 12, color: TEXT_SECONDARY, marginBottom: 16, maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
        Skills are knowledge bodies that load into Aria's context when triggers match. Try saving your CFO worldview, a vendor playbook, or a meeting prep template.
      </div>
      <button
        onClick={onCreateNew}
        style={{
          fontSize: 13, fontWeight: 600, color: 'white', background: PRIMARY,
          border: 'none', padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
        }}
      >
        Create your first skill
      </button>
    </div>
  );
}

function SkillTile({ skill, onEdit, apiFetch, addToast, onChanged }) {
  const isDraft = !skill.isActive;
  const keywords = useMemo(() => {
    if (!skill.triggerPredicate?.input?.or) return [];
    return skill.triggerPredicate.input.or
      .filter((c) => c.field === 'topics' && c.op === 'contains' && typeof c.value === 'string')
      .map((c) => c.value);
  }, [skill.triggerPredicate]);
  const visibleKeywords = keywords.slice(0, 6);
  const overflowCount = keywords.length - visibleKeywords.length;

  const handleActivate = async () => {
    try {
      const r = await apiFetch(`/api/skills/${skill.id}/activate`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      addToast?.({ message: `${skill.name} activated`, type: 'success' });
      onChanged?.();
    } catch (err) {
      addToast?.({ message: 'Failed to activate', type: 'error' });
    }
  };

  return (
    <div style={{
      padding: '16px 18px', background: 'white', borderRadius: 12,
      border: `1px solid ${BORDER}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ fontSize: 16, fontWeight: 600, color: TEXT_PRIMARY }}>{skill.name}</span>
          <StatusPill kind={isDraft ? 'draft' : 'active'} />
          {skill.persona && <PersonaPill persona={skill.persona} />}
          {skill.source === 'aria_proposed' && (
            <span style={{
              fontSize: 10, fontWeight: 600, color: PRIMARY,
              background: '#eeecff', padding: '2px 6px', borderRadius: 4,
            }}>Aria-proposed</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {isDraft && (
            <button
              onClick={handleActivate}
              style={{
                fontSize: 12, fontWeight: 600, color: 'white', background: PRIMARY,
                border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
              }}
            >
              Activate
            </button>
          )}
          <button
            onClick={onEdit}
            style={{
              fontSize: 12, fontWeight: 600, color: TEXT_PRIMARY, background: 'white',
              border: `1px solid ${BORDER}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
            }}
          >
            Edit
          </button>
        </div>
      </div>
      {skill.description && (
        <div style={{ fontSize: 13, color: TEXT_SECONDARY, marginBottom: 10 }}>
          {skill.description}
        </div>
      )}
      {visibleKeywords.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {visibleKeywords.map((kw) => (
            <KeywordPill key={kw} keyword={kw} />
          ))}
          {overflowCount > 0 && (
            <span style={{
              fontSize: 11, color: TEXT_SECONDARY, padding: '3px 8px',
              background: '#f3f4f6', borderRadius: 4,
            }}>+{overflowCount} more</span>
          )}
        </div>
      )}
      <div style={{
        paddingTop: 10, borderTop: `0.5px solid ${BORDER}`,
        display: 'flex', gap: 16, fontSize: 11, color: TEXT_SECONDARY, flexWrap: 'wrap',
      }}>
        {!isDraft && (
          <>
            <span>Trust {Number(skill.trustScore ?? 0.5).toFixed(2)}</span>
            <span>Last used {fmtRelative(skill.lastUsedAt) || 'never'}</span>
            <span>Invoked {skill.invokedCount || 0}</span>
            <span>{Math.ceil((skill.content?.length || 0) / 4)} tok</span>
          </>
        )}
        {isDraft && (
          <>
            <span>Created {fmtRelative(skill.createdAt) || 'just now'}</span>
            <span>Source {skill.source || 'user'}</span>
          </>
        )}
      </div>
    </div>
  );
}

function StatusPill({ kind }) {
  const styles = {
    active: { bg: '#dcfce7', color: '#166534' },
    draft:  { bg: '#f3f4f6', color: '#374151' },
    paused: { bg: '#fef3c7', color: '#92400e' },
  };
  const s = styles[kind] || styles.draft;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color: s.color, background: s.bg,
      padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase',
    }}>{kind}</span>
  );
}

function PersonaPill({ persona }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, color: PRIMARY, background: '#eeecff',
      padding: '2px 8px', borderRadius: 999,
    }}>{persona}</span>
  );
}

function KeywordPill({ keyword }) {
  return (
    <span style={{
      fontSize: 11, color: TEXT_SECONDARY, padding: '3px 8px',
      background: '#f3f4f6', borderRadius: 4, fontFamily: 'Manrope, sans-serif',
    }}>{keyword}</span>
  );
}

function fmtRelative(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 4) return `${wk}w ago`;
  return new Date(iso).toLocaleDateString();
}

// ── Sub-agents section (V1 placeholder) ────────────────────────────────

function SubAgentsSectionPlaceholder() {
  return (
    <section>
      <SectionHeader
        title="Sub-agents"
        subtitle="Long-running work Aria does in the background · max 2 concurrent"
      />
      <div style={{
        padding: 32, textAlign: 'center', background: 'white',
        border: `1px dashed ${BORDER}`, borderRadius: 12,
      }}>
        <div style={{ fontSize: 14, color: TEXT_PRIMARY, fontWeight: 600, marginBottom: 8 }}>
          Coming soon
        </div>
        <div style={{ fontSize: 12, color: TEXT_SECONDARY, maxWidth: 480, margin: '0 auto' }}>
          Bounded sub-agents (research, monitoring, comparison) ship in M3+M4. The first instance — research-agent — will dispatch async investigations and report back when done.
        </div>
      </div>
    </section>
  );
}

// ── Skill edit view (D2) ───────────────────────────────────────────────

function SkillEditView({ skillId, apiFetch, addToast, onClose }) {
  const isCreate = !skillId;
  const [skill, setSkill] = useState(null);
  const [loading, setLoading] = useState(!isCreate);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Form state.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [keywords, setKeywords] = useState([]);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [predicateJson, setPredicateJson] = useState('');
  const [predicateAdvancedOpen, setPredicateAdvancedOpen] = useState(false);
  const [persona, setPersona] = useState('');
  const [tokenCap, setTokenCap] = useState(10000);
  const [priority, setPriority] = useState(5);
  const [isActive, setIsActive] = useState(true);
  const [previewMode, setPreviewMode] = useState(false);

  // Load existing skill (populated state).
  useEffect(() => {
    if (isCreate) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`/api/skills/${skillId}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        setSkill(data);
        setName(data.name || '');
        setDescription(data.description || '');
        setContent(data.content || '');
        setPersona(data.persona || '');
        setTokenCap(data.tokenCap || 10000);
        setPriority(data.priority ?? 5);
        setIsActive(!!data.isActive);
        // Decode keywords from predicate if shape matches chip-input.
        const kw = extractKeywordsFromPredicate(data.triggerPredicate);
        setKeywords(kw);
        setPredicateJson(data.triggerPredicate ? JSON.stringify(data.triggerPredicate, null, 2) : '');
      } catch (err) {
        addToast?.({ message: 'Could not load skill', type: 'error' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [skillId, isCreate, apiFetch, addToast]);

  // Round-trip: when user edits keywords, regenerate the JSON view.
  // When user edits JSON directly, derive keywords (best-effort).
  const onKeywordsChange = (next) => {
    setKeywords(next);
    if (next.length === 0) {
      setPredicateJson('');
    } else {
      const pred = {
        input: { or: next.map((k) => ({ field: 'topics', op: 'contains', value: k })) },
      };
      setPredicateJson(JSON.stringify(pred, null, 2));
    }
  };

  const onPredicateJsonChange = (next) => {
    setPredicateJson(next);
    // Try to round-trip back to chips if shape matches.
    try {
      const parsed = next.trim() ? JSON.parse(next) : null;
      const kw = extractKeywordsFromPredicate(parsed);
      // Only update chips if the JSON cleanly matches the chip shape.
      if (kw.length > 0 || parsed === null) {
        setKeywords(kw);
      }
    } catch { /* invalid JSON — leave chips alone */ }
  };

  const addKeyword = (raw) => {
    const k = String(raw || '').trim().toLowerCase();
    if (!k) return;
    if (keywords.includes(k)) return;
    onKeywordsChange([...keywords, k]);
    setKeywordDraft('');
  };
  const removeKeyword = (k) => {
    onKeywordsChange(keywords.filter((x) => x !== k));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      addToast?.({ message: 'Name is required', type: 'error' });
      return;
    }
    setSaving(true);
    try {
      // Decide payload shape — if user edited the JSON directly to a
      // non-chip shape, send trigger_predicate. Otherwise send keywords.
      let triggerPredicateOverride;
      if (predicateAdvancedOpen && predicateJson.trim()) {
        try {
          triggerPredicateOverride = JSON.parse(predicateJson);
        } catch {
          addToast?.({ message: 'Advanced predicate JSON is invalid', type: 'error' });
          setSaving(false);
          return;
        }
      }
      const payload = {
        name: name.trim(),
        description: description.trim(),
        content,
        persona: persona || null,
        token_cap: tokenCap,
        priority,
        is_active: isActive,
      };
      if (triggerPredicateOverride !== undefined) {
        payload.trigger_predicate = triggerPredicateOverride;
      } else {
        payload.keywords = keywords;
      }
      const r = await apiFetch(
        isCreate ? '/api/skills' : `/api/skills/${skillId}`,
        {
          method: isCreate ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      addToast?.({ message: isCreate ? 'Skill created' : 'Skill saved', type: 'success' });
      onClose();
    } catch (err) {
      addToast?.({ message: 'Save failed', type: 'error' });
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!skillId) return;
    if (!window.confirm('Delete this skill permanently? This cannot be undone.')) return;
    setDeleting(true);
    try {
      const r = await apiFetch(`/api/skills/${skillId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      addToast?.({ message: 'Skill deleted', type: 'success' });
      onClose();
    } catch (err) {
      addToast?.({ message: 'Delete failed', type: 'error' });
      setDeleting(false);
    }
  };

  const tokensUsed = Math.ceil((content || '').length / 4);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: PANEL_BG, color: TEXT_SECONDARY, fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto w-full" style={{ background: PANEL_BG, fontFamily: 'Manrope, sans-serif' }}>
      {/* Sticky action bar */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10, background: PANEL_BG,
        borderBottom: `1px solid ${BORDER}`, padding: '14px 32px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <button
          onClick={onClose}
          style={{
            fontSize: 13, fontWeight: 500, color: TEXT_SECONDARY, background: 'transparent',
            border: 'none', cursor: 'pointer', padding: 0,
          }}
        >
          ← Agents · Skills
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          {!isCreate && (
            <button
              onClick={handleDelete}
              disabled={deleting || saving}
              style={{
                fontSize: 13, fontWeight: 600, color: '#dc2626', background: 'transparent',
                border: 'none', cursor: 'pointer', padding: '8px 12px',
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY, background: 'white',
              border: `1px solid ${BORDER}`, padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || deleting}
            style={{
              fontSize: 13, fontWeight: 600, color: 'white', background: PRIMARY,
              border: 'none', padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
              opacity: (saving || deleting) ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <div style={{ padding: '24px 32px 80px', maxWidth: 800, margin: '0 auto' }}>
        {/* Section 1 — Identity */}
        <FormCard>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <FieldLabel>Skill name</FieldLabel>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: TEXT_SECONDARY, cursor: 'pointer' }}>
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Wheelworks Vendor Playbook"
            style={{
              width: '100%', fontSize: 18, fontWeight: 500, padding: '10px 12px',
              border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none',
              fontFamily: "'Plus Jakarta Sans', sans-serif", marginBottom: 16,
            }}
          />

          <FieldLabel>Description</FieldLabel>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One-line summary of what this skill knows"
            style={{
              width: '100%', fontSize: 13, padding: '8px 12px',
              border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none',
              marginBottom: 16,
            }}
          />

          <FieldLabel>Persona scope</FieldLabel>
          <select
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            style={{
              width: '100%', fontSize: 13, padding: '8px 12px',
              border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none',
              background: 'white', fontFamily: 'Manrope, sans-serif',
            }}
          >
            <option value="">none (loads regardless)</option>
            {PERSONAS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </FormCard>

        {/* Section 2 — Triggers */}
        <FormCard>
          <SectionTitle title="Triggers" subtitle="When should this skill load into Aria's context?" />
          <FieldLabel>Keywords</FieldLabel>
          <div style={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
            padding: '8px 10px', border: `1px solid ${BORDER}`, borderRadius: 8,
            minHeight: 42,
          }}>
            {keywords.map((kw) => (
              <span key={kw} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: '#eeecff', color: PRIMARY, fontSize: 12, fontWeight: 600,
                padding: '4px 8px', borderRadius: 999,
              }}>
                {kw}
                <button
                  onClick={() => removeKeyword(kw)}
                  aria-label={`remove ${kw}`}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: PRIMARY, padding: 0, fontSize: 14, lineHeight: 1,
                  }}
                >×</button>
              </span>
            ))}
            <input
              value={keywordDraft}
              onChange={(e) => setKeywordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addKeyword(keywordDraft);
                } else if (e.key === 'Backspace' && !keywordDraft && keywords.length) {
                  removeKeyword(keywords[keywords.length - 1]);
                }
              }}
              onBlur={() => keywordDraft && addKeyword(keywordDraft)}
              placeholder={keywords.length ? '' : 'Type a keyword and press Enter'}
              style={{
                flex: 1, minWidth: 120, fontSize: 13, padding: '4px 0',
                border: 'none', outline: 'none', background: 'transparent',
              }}
            />
          </div>
          <p style={{ fontSize: 11, color: TEXT_SECONDARY, marginTop: 6, marginBottom: 14 }}>
            Skill loads when any keyword appears in the conversation topics. Lowercased + deduped automatically.
          </p>

          <details
            open={predicateAdvancedOpen}
            onToggle={(e) => setPredicateAdvancedOpen(e.target.open)}
            style={{ marginTop: 8 }}
          >
            <summary style={{ fontSize: 12, fontWeight: 600, color: TEXT_PRIMARY, cursor: 'pointer', userSelect: 'none' }}>
              Advanced predicate (JSON)
            </summary>
            <div style={{ marginTop: 10 }}>
              <textarea
                value={predicateJson}
                onChange={(e) => onPredicateJsonChange(e.target.value)}
                placeholder='{ "input": { "or": [{ "field": "topics", "op": "contains", "value": "..." }] } }'
                spellCheck={false}
                style={{
                  width: '100%', minHeight: 120, fontSize: 12, padding: '10px 12px',
                  border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none',
                  fontFamily: 'Menlo, Monaco, Consolas, monospace', resize: 'vertical',
                }}
              />
              <p style={{ fontSize: 11, color: TEXT_SECONDARY, marginTop: 6 }}>
                Keywords above auto-translate to predicate JSON. Edit directly for complex triggers (people mentions, calendar context, AND/OR composition).
              </p>
            </div>
          </details>
        </FormCard>

        {/* Section 3 — Content */}
        <FormCard>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <SectionTitle
              title="Content"
              subtitle={`The knowledge body Aria loads. Markdown supported. ${tokensUsed.toLocaleString()} / ${tokenCap.toLocaleString()} tokens`}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              <ToggleButton active={!previewMode} onClick={() => setPreviewMode(false)} label="Edit" />
              <ToggleButton active={previewMode} onClick={() => setPreviewMode(true)} label="Preview" />
            </div>
          </div>
          {!previewMode ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={`# Wheelworks Playbook\n\nContact: Mark — mark@wheelworks.example\nPrefers Tue/Thu 10am\nLast service: 2026-04-12 (Escalade tire rotation)`}
              spellCheck={false}
              style={{
                width: '100%', minHeight: 240, fontSize: 13, padding: '12px',
                border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none',
                fontFamily: 'Menlo, Monaco, Consolas, monospace', resize: 'vertical',
                lineHeight: 1.5,
              }}
            />
          ) : (
            <div style={{
              minHeight: 240, padding: 16, background: '#fafafa', borderRadius: 8,
              fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
              border: `1px solid ${BORDER}`,
            }}>
              {content || <span style={{ color: TEXT_SECONDARY, fontStyle: 'italic' }}>(empty)</span>}
            </div>
          )}
          {tokensUsed > tokenCap && (
            <p style={{ fontSize: 11, color: '#dc2626', marginTop: 6 }}>
              Content exceeds token cap — Aria will truncate at load time.
            </p>
          )}
        </FormCard>

        {/* Section 5 — Advanced settings */}
        <FormCard>
          <SectionTitle title="Advanced settings" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <FieldLabel>Priority</FieldLabel>
              <input
                type="number"
                value={priority}
                min={0}
                max={10}
                onChange={(e) => setPriority(Math.max(0, Math.min(10, parseInt(e.target.value, 10) || 0)))}
                style={{
                  width: '100%', fontSize: 13, padding: '8px 12px',
                  border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none',
                }}
              />
              <p style={{ fontSize: 11, color: TEXT_SECONDARY, marginTop: 4 }}>
                0–10. Higher loads first when token budget is tight.
              </p>
            </div>
            <div>
              <FieldLabel>Max tokens</FieldLabel>
              <input
                type="number"
                value={tokenCap}
                min={1}
                max={30000}
                step={500}
                onChange={(e) => setTokenCap(Math.max(1, Math.min(30000, parseInt(e.target.value, 10) || 10000)))}
                style={{
                  width: '100%', fontSize: 13, padding: '8px 12px',
                  border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none',
                }}
              />
              <p style={{ fontSize: 11, color: TEXT_SECONDARY, marginTop: 4 }}>
                Per-skill content cap. Default 10,000.
              </p>
            </div>
          </div>
        </FormCard>

        {/* Footer telemetry strip — edit mode only */}
        {!isCreate && skill && (
          <div style={{
            display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16,
            fontSize: 11, color: TEXT_SECONDARY, padding: '14px 0', marginTop: 8,
          }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <span>Created {fmtRelative(skill.createdAt) || '—'}</span>
              <span>Edited {fmtRelative(skill.updatedAt) || '—'}</span>
              <span>Source {skill.source || 'user'}</span>
            </div>
            <div style={{ display: 'flex', gap: 16 }}>
              <span>Trust {Number(skill.trustScore ?? 0.5).toFixed(2)}</span>
              <span>Invoked {skill.invokedCount || 0}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FormCard({ children }) {
  return (
    <div style={{
      padding: 22, background: 'white', border: `0.5px solid ${BORDER}`,
      borderRadius: 12, marginBottom: 16,
    }}>{children}</div>
  );
}

function SectionTitle({ title, subtitle }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <h3 style={{
        fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 15, fontWeight: 700,
        color: TEXT_PRIMARY, margin: 0,
      }}>{title}</h3>
      {subtitle && (
        <p style={{ fontSize: 12, color: TEXT_SECONDARY, marginTop: 4, marginBottom: 0 }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

function FieldLabel({ children }) {
  return (
    <label style={{
      display: 'block', fontSize: 11, fontWeight: 600, color: TEXT_SECONDARY,
      letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 6,
    }}>{children}</label>
  );
}

function ToggleButton({ active, onClick, label }) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 12, fontWeight: 600, padding: '4px 10px', borderRadius: 6,
        border: `1px solid ${active ? PRIMARY : BORDER}`,
        background: active ? PRIMARY : 'white',
        color: active ? 'white' : TEXT_PRIMARY,
        cursor: 'pointer',
      }}
    >{label}</button>
  );
}

// Best-effort decode of a chip-input predicate back to a keyword list.
// Returns [] when shape doesn't match (caller leaves chips alone).
function extractKeywordsFromPredicate(pred) {
  if (!pred || typeof pred !== 'object') return [];
  const or = pred.input?.or;
  if (!Array.isArray(or)) return [];
  const kws = [];
  for (const node of or) {
    if (node && node.field === 'topics' && node.op === 'contains' && typeof node.value === 'string') {
      kws.push(node.value);
    } else {
      // Any non-chip node disqualifies — caller treats as advanced JSON.
      return [];
    }
  }
  return kws;
}
