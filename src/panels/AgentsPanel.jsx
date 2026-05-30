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

const PANEL_BG = 'rgb(var(--surface))';
const PRIMARY = 'rgb(var(--accent))';
const PRIMARY_LIGHT = 'rgb(var(--primary-container))';
const BORDER = 'rgb(var(--surface-container-high))';
const TEXT_PRIMARY = 'rgb(var(--text-primary))';
const TEXT_SECONDARY = 'rgb(var(--text-secondary))';

const PERSONAS = ['CFO', 'COO', 'Best-Friend', 'Operator', 'Personal', 'Brand'];

export default function AgentsPanel({ apiFetch, addToast, authToken }) {
  // view.kind: 'list' | 'edit-skill' | 'run-detail'
  const [view, setView] = useState({ kind: 'list' });
  const [skills, setSkills] = useState([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);

  // ── Production-fire fix (2026-05-07) ─────────────────────────────────
  // Two bugs landed together in M2:
  //
  //   1. apiFetch calls in this panel were missing the Authorization
  //      header → every initial request 401'd. apiFetch self-heals on
  //      401 by refreshing + retrying, so the panel "worked" most of
  //      the time, but every request became 2 requests.
  //
  //   2. App.jsx::addToast is recreated every parent render. The
  //      reloadSkills useCallback depended on it → reloadSkills was
  //      a fresh function on every parent render → useEffect with
  //      [reloadSkills] in its deps fired on every parent render →
  //      tight retry loop that saturated the 100-req/min apiLimiter,
  //      cascaded "Could not load skills" toasts, eventually 429'd
  //      /api/auth/refresh which fired session-expired and logged
  //      the user out 4-5s after opening the tab.
  //
  // Fix shape: capture mutable parent props in refs and wrap them in
  // stable helpers (authFetch + toast). authFetch attaches the current
  // authToken on every call (closes bug #1). toast forwards through
  // the addToast ref without depending on its identity (closes bug #2).
  // reloadSkills/reloadSessions now have stable deps, so the mount
  // useEffect fires once and never spuriously re-fires.
  const apiFetchRef  = useRef(apiFetch);
  const addToastRef  = useRef(addToast);
  const authTokenRef = useRef(authToken);
  apiFetchRef.current  = apiFetch;
  addToastRef.current  = addToast;
  authTokenRef.current = authToken;

  const authFetch = useCallback((url, options = {}) => {
    return apiFetchRef.current(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${authTokenRef.current || ''}`,
      },
    });
  }, []);

  const toast = useCallback((payload) => {
    addToastRef.current?.(payload);
  }, []);

  const reloadSkills = useCallback(async () => {
    try {
      const r = await authFetch('/api/skills?include_inactive=true');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setSkills(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[agents] failed to load skills', err);
      toast({ message: 'Could not load skills', type: 'error' });
    } finally { setSkillsLoaded(true); }
  }, [authFetch, toast]);

  const reloadSessions = useCallback(async () => {
    try {
      const r = await authFetch('/api/sub-agents/sessions');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setSessions(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[agents] failed to load sessions', err);
    } finally { setSessionsLoaded(true); }
  }, [authFetch]);

  useEffect(() => {
    reloadSkills();
    reloadSessions();
  }, [reloadSkills, reloadSessions]);

  // Poll sessions every 5s while at least one is queued/running, so the
  // landing tiles update without manual refresh. Stops polling when all
  // sessions are terminal.
  const hasActive = useMemo(
    () => sessions.some((s) => s.status === 'queued' || s.status === 'running'),
    [sessions],
  );
  useEffect(() => {
    if (view.kind !== 'list') return undefined;
    if (!hasActive) return undefined;
    const id = setInterval(reloadSessions, 5000);
    return () => clearInterval(id);
  }, [view.kind, hasActive, reloadSessions]);

  const onEditSkill = (id) => setView({ kind: 'edit-skill', id });
  const onCreateNewSkill = () => setView({ kind: 'edit-skill', id: null });
  const onOpenRun = (sessionId) => setView({ kind: 'run-detail', id: sessionId });
  const onBackToList = () => {
    setView({ kind: 'list' });
    reloadSkills();
    reloadSessions();
  };

  if (view.kind === 'edit-skill') {
    return (
      <SkillEditView
        skillId={view.id}
        apiFetch={authFetch}
        addToast={toast}
        onClose={onBackToList}
      />
    );
  }
  if (view.kind === 'run-detail') {
    return (
      <RunDetailView
        sessionId={view.id}
        apiFetch={authFetch}
        addToast={toast}
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
          loaded={skillsLoaded}
          onEdit={onEditSkill}
          onCreateNew={onCreateNewSkill}
          apiFetch={authFetch}
          addToast={toast}
          onChanged={reloadSkills}
        />

        <SubAgentsSection
          sessions={sessions}
          loaded={sessionsLoaded}
          onOpenRun={onOpenRun}
          onStartRun={() => setDispatchOpen(true)}
          apiFetch={authFetch}
          addToast={toast}
          onChanged={reloadSessions}
        />

        {dispatchOpen && (
          <DispatchModal
            apiFetch={authFetch}
            addToast={toast}
            existingActiveCount={sessions.filter((s) => s.status === 'queued' || s.status === 'running').length}
            onClose={() => setDispatchOpen(false)}
            onDispatched={(session) => {
              setDispatchOpen(false);
              reloadSessions();
              if (session?.id) onOpenRun(session.id);
            }}
          />
        )}
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
            fontSize: 13, fontWeight: 600, color: 'rgb(var(--accent-contrast))', background: PRIMARY,
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
      padding: 32, textAlign: 'center', background: 'rgb(var(--surface-elevated))',
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
          fontSize: 13, fontWeight: 600, color: 'rgb(var(--accent-contrast))', background: PRIMARY,
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
      padding: '16px 18px', background: 'rgb(var(--surface-elevated))', borderRadius: 12,
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
              background: 'rgb(var(--accent-surface))', padding: '2px 6px', borderRadius: 4,
            }}>Aria-proposed</span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {isDraft && (
            <button
              onClick={handleActivate}
              style={{
                fontSize: 12, fontWeight: 600, color: 'rgb(var(--accent-contrast))', background: PRIMARY,
                border: 'none', padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
              }}
            >
              Activate
            </button>
          )}
          <button
            onClick={onEdit}
            style={{
              fontSize: 12, fontWeight: 600, color: TEXT_PRIMARY, background: 'rgb(var(--surface-elevated))',
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
              background: 'rgb(var(--surface-container))', borderRadius: 4,
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
    active: { bg: 'rgb(var(--success-surface))', color: 'rgb(var(--success))' },
    draft:  { bg: 'rgb(var(--surface-container))', color: 'rgb(var(--text-primary))' },
    paused: { bg: 'rgb(var(--warning-surface))', color: 'rgb(var(--warning))' },
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
      fontSize: 10, fontWeight: 600, color: PRIMARY, background: 'rgb(var(--accent-surface))',
      padding: '2px 8px', borderRadius: 999,
    }}>{persona}</span>
  );
}

function KeywordPill({ keyword }) {
  return (
    <span style={{
      fontSize: 11, color: TEXT_SECONDARY, padding: '3px 8px',
      background: 'rgb(var(--surface-container))', borderRadius: 4, fontFamily: 'Manrope, sans-serif',
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

// ── Sub-agents section (M4.1) ──────────────────────────────────────────

function SubAgentsSection({ sessions, loaded, onOpenRun, onStartRun, apiFetch, addToast, onChanged }) {
  const activeCount = sessions.filter((s) => s.status === 'queued' || s.status === 'running').length;

  // Active runs first (status = queued + running), then completed/failed
  // by started_at desc.
  const sorted = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const aActive = a.status === 'queued' || a.status === 'running';
      const bActive = b.status === 'queued' || b.status === 'running';
      if (aActive !== bActive) return aActive ? -1 : 1;
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return tb - ta;
    });
  }, [sessions]);

  return (
    <section>
      <SectionHeader
        title="Sub-agents"
        subtitle={`Long-running work Aria does in the background · ${activeCount} active · max 2 concurrent`}
        ctaLabel="+ Start run"
        onCta={onStartRun}
      />

      {loaded && sorted.length === 0 && (
        <div style={{
          padding: 32, textAlign: 'center', background: 'rgb(var(--surface-elevated))',
          border: `1px dashed ${BORDER}`, borderRadius: 12,
        }}>
          <div style={{ fontSize: 14, color: TEXT_PRIMARY, fontWeight: 600, marginBottom: 8 }}>
            No runs yet
          </div>
          <div style={{ fontSize: 12, color: TEXT_SECONDARY, maxWidth: 480, margin: '0 auto 16px' }}>
            Sub-agents handle multi-step investigations in the background. Try "prep me for tomorrow's call with Bob" or "catch me up on Carevestment from the last 2 weeks."
          </div>
          <button
            onClick={onStartRun}
            style={{
              fontSize: 13, fontWeight: 600, color: 'rgb(var(--accent-contrast))', background: PRIMARY,
              border: 'none', padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
            }}
          >
            Start your first run
          </button>
        </div>
      )}

      {sorted.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {sorted.map((s) => (
            <RunTile
              key={s.id}
              session={s}
              onOpen={() => onOpenRun(s.id)}
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

function RunTile({ session, onOpen, apiFetch, addToast, onChanged }) {
  const isActive = session.status === 'queued' || session.status === 'running';
  const used = session.budgetUsed || {};
  const budget = session.budget || {};

  const handleCancel = async (e) => {
    e.stopPropagation();
    if (!window.confirm('Cancel this run? In-flight work will be lost.')) return;
    try {
      const r = await apiFetch(`/api/sub-agents/sessions/${session.id}/kill`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      addToast?.({ message: 'Cancel requested — worker will exit at next phase boundary', type: 'info' });
      onChanged?.();
    } catch (err) {
      addToast?.({ message: 'Cancel failed', type: 'error' });
    }
  };

  const statusKind = (() => {
    if (session.status === 'running' || session.status === 'queued') return 'running';
    if (session.status === 'completed') return 'completed';
    if (session.status === 'failed') return 'failed';
    if (session.status === 'budget_exhausted') return 'budget';
    if (session.status === 'killed') return 'killed';
    if (session.status === 'stagnated') return 'stagnated';
    return 'completed';
  })();

  return (
    <div
      onClick={onOpen}
      style={{
        padding: '16px 18px', background: 'rgb(var(--surface-elevated))', borderRadius: 12,
        border: `1px solid ${BORDER}`, cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <RunStatusPill kind={statusKind} />
          <span style={{ fontSize: 12, color: TEXT_SECONDARY }}>
            {session.definitionId}
            {isActive && session.currentPhase && ` · ${session.currentPhase}`}
            {!isActive && session.result?.key_findings && ` · ${session.result.key_findings.length} finding${session.result.key_findings.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {isActive && (
            <button
              onClick={handleCancel}
              style={{
                fontSize: 12, fontWeight: 600, color: 'rgb(var(--danger))', background: 'rgb(var(--surface-elevated))',
                border: `1px solid ${BORDER}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
              }}
            >Cancel</button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            style={{
              fontSize: 12, fontWeight: 600, color: TEXT_PRIMARY, background: 'rgb(var(--surface-elevated))',
              border: `1px solid ${BORDER}`, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
            }}
          >View</button>
        </div>
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: TEXT_PRIMARY, marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
        {session.prompt}
      </div>
      {isActive && (
        <ProgressBar
          used={used.tool_calls || 0}
          total={budget.tool_calls || 30}
          color={PRIMARY}
        />
      )}
      <div style={{
        marginTop: 10, paddingTop: 10, borderTop: `0.5px solid ${BORDER}`,
        display: 'flex', gap: 16, fontSize: 11, color: TEXT_SECONDARY, flexWrap: 'wrap',
      }}>
        {isActive ? (
          <>
            <span>Started {fmtRelative(session.startedAt)}</span>
            <span>Tool calls {used.tool_calls || 0}/{budget.tool_calls || 30}</span>
            <span>Spend ${(used.spend_usd || 0).toFixed(3)}/${(budget.spend_usd || 2).toFixed(2)}</span>
          </>
        ) : (
          <>
            <span>{fmtRelative(session.startedAt)}</span>
            <span>Duration {fmtDuration(session.startedAt, session.completedAt)}</span>
            <span>Spent ${(used.spend_usd || 0).toFixed(3)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function RunStatusPill({ kind }) {
  const styles = {
    running:   { bg: 'rgb(var(--accent-surface))', color: 'rgb(var(--accent))', label: 'RUNNING' },
    completed: { bg: 'rgb(var(--success-surface))', color: 'rgb(var(--success))', label: 'COMPLETED' },
    failed:    { bg: 'rgb(var(--danger-surface))', color: 'rgb(var(--danger))', label: 'FAILED' },
    budget:    { bg: 'rgb(var(--warning-surface))', color: 'rgb(var(--warning))', label: 'BUDGET' },
    killed:    { bg: 'rgb(var(--surface-container))', color: 'rgb(var(--text-primary))', label: 'KILLED' },
    stagnated: { bg: 'rgb(var(--surface-container))', color: 'rgb(var(--text-primary))', label: 'STAGNATED' },
  };
  const s = styles[kind] || styles.completed;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, color: s.color, background: s.bg,
      padding: '2px 8px', borderRadius: 999,
    }}>
      {kind === 'running' && (
        <span style={{
          display: 'inline-block', width: 6, height: 6, borderRadius: 999,
          background: s.color, marginRight: 5, verticalAlign: 'middle',
          animation: 'pulse 1.5s ease-in-out infinite',
        }} />
      )}
      {s.label}
    </span>
  );
}

function ProgressBar({ used, total, color = PRIMARY }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div style={{ width: '100%', height: 5, background: 'rgb(var(--surface-container))', borderRadius: 999, overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 300ms ease' }} />
    </div>
  );
}

function fmtDuration(startIso, endIso) {
  if (!startIso) return '—';
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const ms = end - start;
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

// ── Dispatch modal (M4.4) ──────────────────────────────────────────────

function DispatchModal({ apiFetch, addToast, existingActiveCount, onClose, onDispatched }) {
  const [prompt, setPrompt] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [maxToolCalls, setMaxToolCalls] = useState(30);
  const [maxMinutes, setMaxMinutes] = useState(5);
  const [maxSpend, setMaxSpend] = useState(2.0);
  const [dispatching, setDispatching] = useState(false);

  const atCap = existingActiveCount >= 2;

  const handleDispatch = async () => {
    if (!prompt.trim()) {
      addToast?.({ message: 'Prompt is required', type: 'error' });
      return;
    }
    if (atCap) {
      addToast?.({ message: 'max 2 concurrent runs reached — cancel one or wait', type: 'error' });
      return;
    }
    setDispatching(true);
    try {
      const r = await apiFetch('/api/sub-agents/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          definition_id: 'research_agent',
          budget_overrides: {
            tool_calls: Math.max(1, Math.min(50, maxToolCalls)),
            wall_clock_ms: Math.max(60_000, Math.min(600_000, maxMinutes * 60_000)),
            spend_usd: Math.max(0.1, Math.min(5.0, maxSpend)),
          },
        }),
      });
      if (r.status === 409) {
        const data = await r.json().catch(() => ({}));
        addToast?.({ message: data.error || 'Concurrency cap reached', type: 'error' });
        setDispatching(false);
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const session = await r.json();
      addToast?.({ message: 'Research dispatched — Aria will ping you when done', type: 'success' });
      onDispatched?.(session);
    } catch (err) {
      addToast?.({ message: 'Dispatch failed', type: 'error' });
      setDispatching(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, padding: 16,
    }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'rgb(var(--surface-elevated))', borderRadius: 16, maxWidth: 560, width: '100%',
          padding: 24, fontFamily: 'Manrope, sans-serif',
          boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
        }}
      >
        <h2 style={{
          fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 18, fontWeight: 700,
          color: TEXT_PRIMARY, margin: 0, marginBottom: 6,
        }}>Start research run</h2>
        <p style={{ fontSize: 12, color: TEXT_SECONDARY, marginTop: 0, marginBottom: 16 }}>
          Aria runs in the background and pings via WhatsApp when done.
          {atCap && <span style={{ color: 'rgb(var(--danger))', fontWeight: 600 }}> Max 2 active reached.</span>}
        </p>

        <FieldLabel>What should I investigate?</FieldLabel>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Prep me for tomorrow's call with Bob — recent emails, calendar history, open items"
          autoFocus
          style={{
            width: '100%', minHeight: 100, fontSize: 14, padding: '10px 12px',
            border: `1px solid ${BORDER}`, borderRadius: 8, outline: 'none',
            fontFamily: 'Manrope, sans-serif', resize: 'vertical', marginBottom: 16,
          }}
        />

        <details
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen(e.target.open)}
          style={{ marginBottom: 16 }}
        >
          <summary style={{ fontSize: 12, fontWeight: 600, color: TEXT_PRIMARY, cursor: 'pointer', userSelect: 'none' }}>
            Advanced
          </summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
            <div>
              <FieldLabel>Max tool calls</FieldLabel>
              <input type="number" min={1} max={50} value={maxToolCalls}
                onChange={(e) => setMaxToolCalls(parseInt(e.target.value, 10) || 30)}
                style={{ width: '100%', fontSize: 13, padding: '6px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, outline: 'none' }}
              />
            </div>
            <div>
              <FieldLabel>Max minutes</FieldLabel>
              <input type="number" min={1} max={10} value={maxMinutes}
                onChange={(e) => setMaxMinutes(parseInt(e.target.value, 10) || 5)}
                style={{ width: '100%', fontSize: 13, padding: '6px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, outline: 'none' }}
              />
            </div>
            <div>
              <FieldLabel>Max spend ($)</FieldLabel>
              <input type="number" min={0.1} max={5} step={0.5} value={maxSpend}
                onChange={(e) => setMaxSpend(parseFloat(e.target.value) || 2.0)}
                style={{ width: '100%', fontSize: 13, padding: '6px 8px', border: `1px solid ${BORDER}`, borderRadius: 6, outline: 'none' }}
              />
            </div>
          </div>
        </details>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onClose}
            disabled={dispatching}
            style={{
              fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY, background: 'rgb(var(--surface-elevated))',
              border: `1px solid ${BORDER}`, padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            onClick={handleDispatch}
            disabled={dispatching || atCap || !prompt.trim()}
            style={{
              fontSize: 13, fontWeight: 600, color: 'rgb(var(--accent-contrast))', background: PRIMARY,
              border: 'none', padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
              opacity: (dispatching || atCap || !prompt.trim()) ? 0.6 : 1,
            }}
          >{dispatching ? 'Dispatching…' : 'Start'}</button>
        </div>
      </div>
    </div>
  );
}

// ── Run detail view (M4.3) ─────────────────────────────────────────────

function RunDetailView({ sessionId, apiFetch, addToast, onClose }) {
  const [session, setSession] = useState(null);
  const [steps, setSteps] = useState([]);
  const [findings, setFindings] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [killing, setKilling] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [sR, stR, fR] = await Promise.all([
        apiFetch(`/api/sub-agents/sessions/${sessionId}`),
        apiFetch(`/api/sub-agents/sessions/${sessionId}/steps`),
        apiFetch(`/api/sub-agents/sessions/${sessionId}/findings`),
      ]);
      if (sR.ok) setSession(await sR.json());
      if (stR.ok) setSteps(await stR.json());
      if (fR.ok) setFindings(await fR.json());
    } catch (err) {
      console.error('[run-detail] reload failed', err);
    } finally { setLoaded(true); }
  }, [apiFetch, sessionId]);

  useEffect(() => { reload(); }, [reload]);

  // Poll while active.
  const isActive = session && (session.status === 'queued' || session.status === 'running');
  useEffect(() => {
    if (!isActive) return undefined;
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [isActive, reload]);

  const handleKill = async () => {
    if (!window.confirm('Cancel this run? Worker exits at next phase boundary (~30s).')) return;
    setKilling(true);
    try {
      const r = await apiFetch(`/api/sub-agents/sessions/${sessionId}/kill`, { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      addToast?.({ message: 'Cancel requested', type: 'info' });
      reload();
    } catch (err) {
      addToast?.({ message: 'Cancel failed', type: 'error' });
    } finally { setKilling(false); }
  };

  if (!loaded) {
    return <div className="flex-1 flex items-center justify-center" style={{ background: PANEL_BG, color: TEXT_SECONDARY, fontSize: 13 }}>Loading…</div>;
  }
  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4" style={{ background: PANEL_BG, color: TEXT_SECONDARY }}>
        <div>Run not found.</div>
        <button onClick={onClose} style={{
          fontSize: 13, fontWeight: 600, color: PRIMARY, background: 'transparent',
          border: 'none', cursor: 'pointer',
        }}>← Back to Agents</button>
      </div>
    );
  }

  const used = session.budgetUsed || {};
  const budget = session.budget || {};
  const isTerminal = !isActive;
  const result = session.result;

  return (
    <div className="flex-1 overflow-y-auto w-full" style={{ background: PANEL_BG, fontFamily: 'Manrope, sans-serif' }}>
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
        >← Agents · Sub-agents</button>
        {isActive && (
          <button
            onClick={handleKill}
            disabled={killing}
            style={{
              fontSize: 13, fontWeight: 600, color: 'rgb(var(--danger))', background: 'rgb(var(--surface-elevated))',
              border: `1px solid ${BORDER}`, padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
            }}
          >{killing ? 'Cancelling…' : 'Cancel run'}</button>
        )}
      </div>

      <div style={{ padding: '24px 32px 80px', maxWidth: 880, margin: '0 auto' }}>
        {/* Status header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <RunStatusPill kind={mapStatusKind(session.status)} />
            <span style={{ fontSize: 13, color: TEXT_SECONDARY }}>
              {session.definitionId}
              {isActive && session.currentPhase && ` · ${session.currentPhase}`}
            </span>
          </div>
          <h1 style={{
            fontFamily: "'Plus Jakarta Sans', sans-serif", fontSize: 22, fontWeight: 600,
            color: TEXT_PRIMARY, margin: 0, lineHeight: 1.4,
          }}>{session.prompt}</h1>
          <div style={{
            marginTop: 12, display: 'flex', gap: 16, fontSize: 12, color: TEXT_SECONDARY, flexWrap: 'wrap',
          }}>
            <span>Started {fmtRelative(session.startedAt)}</span>
            {session.completedAt && <span>Completed {fmtRelative(session.completedAt)}</span>}
            <span>Duration {fmtDuration(session.startedAt, session.completedAt)}</span>
            <span>Tool calls {used.tool_calls || 0}/{budget.tool_calls || 30}</span>
            <span>Spend ${(used.spend_usd || 0).toFixed(3)}/${(budget.spend_usd || 2).toFixed(2)}</span>
          </div>
        </div>

        {/* Final result block (terminal-completed only) */}
        {isTerminal && session.status === 'completed' && result && (
          <FormCard>
            <SectionTitle title="Result" subtitle={`Confidence ${Number(result.confidence ?? 0).toFixed(2)}`} />
            <div style={{ fontSize: 14, color: TEXT_PRIMARY, lineHeight: 1.6, marginBottom: 16 }}>
              {result.summary}
            </div>
            {Array.isArray(result.key_findings) && result.key_findings.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <FieldLabel>Findings</FieldLabel>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {result.key_findings.map((f, i) => (
                    <div key={i} style={{
                      padding: 10, background: 'rgb(var(--surface-container-low))', borderRadius: 6,
                      borderLeft: `3px solid ${PRIMARY}`,
                    }}>
                      <div style={{ fontSize: 13, color: TEXT_PRIMARY, marginBottom: 4 }}>{f.point}</div>
                      <div style={{ fontSize: 11, color: TEXT_SECONDARY, fontFamily: 'Menlo, monospace' }}>{f.source}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {Array.isArray(result.action_items) && result.action_items.length > 0 && (
              <div>
                <FieldLabel>Action items</FieldLabel>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: TEXT_PRIMARY }}>
                  {result.action_items.map((a, i) => <li key={i} style={{ marginBottom: 4 }}>{a}</li>)}
                </ul>
              </div>
            )}
          </FormCard>
        )}

        {/* Failed / killed / budget error block */}
        {isTerminal && session.status !== 'completed' && (
          <FormCard>
            <SectionTitle title={`Run ${session.status}`} subtitle={session.error || 'No error message'} />
            {result?.summary && (
              <div style={{ fontSize: 14, color: TEXT_PRIMARY, lineHeight: 1.6, marginBottom: 12 }}>
                {result.summary}
              </div>
            )}
            {Array.isArray(result?.schema_errors) && result.schema_errors.length > 0 && (
              <div style={{ fontSize: 12, color: TEXT_SECONDARY }}>
                Schema errors: <code>{result.schema_errors.join('; ')}</code>
              </div>
            )}
          </FormCard>
        )}

        {/* Findings — always show when present, even mid-run */}
        {findings.length > 0 && session.status !== 'completed' && (
          <FormCard>
            <SectionTitle title={`Findings · ${findings.length}`} subtitle="Accumulating as the run progresses" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {findings.map((f) => (
                <div key={f.id} style={{
                  padding: 10, background: 'rgb(var(--surface-container-low))', borderRadius: 6,
                  borderLeft: `3px solid ${PRIMARY}`,
                }}>
                  <div style={{ fontSize: 13, color: TEXT_PRIMARY, marginBottom: 4 }}>{f.finding?.point || ''}</div>
                  <div style={{ fontSize: 11, color: TEXT_SECONDARY, fontFamily: 'Menlo, monospace' }}>{f.finding?.source || ''}</div>
                </div>
              ))}
            </div>
          </FormCard>
        )}

        {/* Step trace — provenance of every tool call + synthesis */}
        <FormCard>
          <SectionTitle title={`Trace · ${steps.length} step${steps.length === 1 ? '' : 's'}`} subtitle="Every phase transition + tool call + synthesis event" />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {steps.map((step) => <StepRow key={step.id} step={step} />)}
            {steps.length === 0 && (
              <div style={{ fontSize: 12, color: TEXT_SECONDARY, fontStyle: 'italic' }}>(No steps yet)</div>
            )}
          </div>
        </FormCard>
      </div>
    </div>
  );
}

function StepRow({ step }) {
  const [open, setOpen] = useState(false);
  const hasPayload = step.payload && Object.keys(step.payload).length > 0;
  const kindColor = {
    phase_enter: 'rgb(var(--accent))',
    phase_exit:  'rgb(var(--success))',
    tool_call:   TEXT_PRIMARY,
    synthesis:   PRIMARY,
    error:       'rgb(var(--danger))',
    killed:      'rgb(var(--text-primary))',
  }[step.stepKind] || TEXT_PRIMARY;

  const summary = step.stepKind === 'tool_call' && step.payload?.tool
    ? `${step.payload.tool}${step.payload.success === false ? ' (failed)' : ''}`
    : step.stepKind === 'synthesis' && step.payload?.tokens
      ? `${step.payload.tokens} tokens`
      : step.payload?.error || step.payload?.note || '';

  return (
    <div
      onClick={() => hasPayload && setOpen(!open)}
      style={{
        padding: '6px 0', borderBottom: `0.5px solid ${BORDER}`,
        cursor: hasPayload ? 'pointer' : 'default', fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ color: TEXT_SECONDARY, minWidth: 60, fontFamily: 'Menlo, monospace', fontSize: 10 }}>
          {fmtTime(step.createdAt)}
        </span>
        <span style={{ color: kindColor, fontWeight: 600, minWidth: 90 }}>{step.stepKind}</span>
        <span style={{ color: TEXT_SECONDARY, minWidth: 70 }}>{step.phase}</span>
        <span style={{ color: TEXT_PRIMARY, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        {step.durationMs != null && (
          <span style={{ color: TEXT_SECONDARY, fontFamily: 'Menlo, monospace', fontSize: 10 }}>
            {step.durationMs}ms
          </span>
        )}
      </div>
      {open && hasPayload && (
        <pre style={{
          margin: '6px 0 0 72px', fontSize: 11, color: TEXT_SECONDARY,
          fontFamily: 'Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          background: 'rgb(var(--surface-container-low))', padding: 8, borderRadius: 6, maxHeight: 300, overflow: 'auto',
        }}>
          {JSON.stringify(step.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

function fmtTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toTimeString().slice(0, 8);
  } catch { return ''; }
}

function mapStatusKind(status) {
  if (status === 'queued' || status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'budget_exhausted') return 'budget';
  if (status === 'killed') return 'killed';
  if (status === 'stagnated') return 'stagnated';
  return 'completed';
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
                fontSize: 13, fontWeight: 600, color: 'rgb(var(--danger))', background: 'transparent',
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
              fontSize: 13, fontWeight: 600, color: TEXT_PRIMARY, background: 'rgb(var(--surface-elevated))',
              border: `1px solid ${BORDER}`, padding: '8px 14px', borderRadius: 8, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || deleting}
            style={{
              fontSize: 13, fontWeight: 600, color: 'rgb(var(--accent-contrast))', background: PRIMARY,
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
              background: 'rgb(var(--surface-elevated))', fontFamily: 'Manrope, sans-serif',
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
                background: 'rgb(var(--accent-surface))', color: PRIMARY, fontSize: 12, fontWeight: 600,
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
              minHeight: 240, padding: 16, background: 'rgb(var(--surface-container-low))', borderRadius: 8,
              fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap',
              border: `1px solid ${BORDER}`,
            }}>
              {content || <span style={{ color: TEXT_SECONDARY, fontStyle: 'italic' }}>(empty)</span>}
            </div>
          )}
          {tokensUsed > tokenCap && (
            <p style={{ fontSize: 11, color: 'rgb(var(--danger))', marginTop: 6 }}>
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
      padding: 22, background: 'rgb(var(--surface-elevated))', border: `0.5px solid ${BORDER}`,
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
        background: active ? PRIMARY : 'rgb(var(--surface-elevated))',
        color: active ? 'rgb(var(--accent-contrast))' : TEXT_PRIMARY,
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
