import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * FoodPanel — Aria food log + macro estimation.
 *
 * Direct port of the aria_food_log.jsx prototype with backend API
 * integration. Prompts + Anthropic SDK live server-side in
 * server/lib/foodLogTools.cjs; this panel only hits our REST API.
 *
 * V1 limitations (documented + deferred to follow-up):
 *   - Daily goal stored in localStorage (no schema column yet).
 *   - Desktop photo upload disabled (no POST /api/image-blobs endpoint
 *     exists yet; WhatsApp OCR still attaches photos server-side).
 *   - Day rollups in History list fetched on expand, not pre-loaded.
 */

// ── Design tokens (matches docs/design-system.md) ───────────────────────
const T = {
  surface: 'rgb(var(--surface))', sidebar: 'rgb(var(--surface-container-low))', primary: 'rgb(var(--accent))', primaryContainer: 'rgb(var(--primary-container))',
  ink: 'rgb(var(--text-primary))', inkSoft: 'rgb(var(--text-secondary))', inkFaint: 'rgb(var(--text-faint))', line: 'rgb(var(--outline-variant))', card: 'rgb(var(--surface-card))',
  protein: 'rgb(var(--accent))', carbs: 'rgb(var(--primary-container))', fat: 'rgb(var(--tertiary))', good: 'rgb(var(--success))', warn: 'rgb(var(--danger))',
};

const GOAL_STORAGE_KEY = 'aria-food-daily-goal';
const EMPTY_TOTALS = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, sugar: 0, sodium: 0 };
const r = (n) => Math.round(Number(n) || 0);

// ── Date helpers (local tz, never UTC) ──────────────────────────────────
function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftKey(key, days) {
  const [y, m, d] = key.split('-').map(Number);
  return todayKey(new Date(y, m - 1, d + days));
}
function prettyDate(key) {
  // Tolerate both a clean "YYYY-MM-DD" (today/activeKey) and an ISO timestamp
  // ("YYYY-MM-DDT…Z") — the /history endpoint serializes the DATE column to
  // full ISO, so slice to the date portion before parsing.
  const s = String(key || '').slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return 'Unknown date';        // malformed/missing — never "Invalid Date"
  const dt = new Date(y, m - 1, d);                  // LOCAL midnight, no UTC shift
  if (Number.isNaN(dt.getTime())) return 'Unknown date';
  const t = todayKey();
  if (s === t) return 'Today';
  if (s === shiftKey(t, -1)) return 'Yesterday';
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}
function sumTotals(entries) {
  return entries.reduce((a, e) => {
    for (const k in EMPTY_TOTALS) a[k] += Number(e.totals?.[k]) || 0;
    return a;
  }, { ...EMPTY_TOTALS });
}

// ── Backend entry → prototype meal shape ────────────────────────────────
function adaptEntry(e) {
  return {
    id: e.id,
    time: formatTime(e.logged_at || e.loggedAt),
    description: e.description,
    note: e.note || '',
    items: Array.isArray(e.items) ? e.items : [],
    totals: e.totals || { ...EMPTY_TOTALS },
    photos: Array.isArray(e.photos) ? e.photos : [],
  };
}

// ── Macro mini-bar (calorie-share split) ────────────────────────────────
function MacroBar({ totals, height = 7 }) {
  const cals = { protein: (totals.protein || 0) * 4, carbs: (totals.carbs || 0) * 4, fat: (totals.fat || 0) * 9 };
  const tot = cals.protein + cals.carbs + cals.fat || 1;
  const segs = [
    { c: T.protein, w: (cals.protein / tot) * 100 },
    { c: T.carbs, w: (cals.carbs / tot) * 100 },
    { c: T.fat, w: (cals.fat / tot) * 100 },
  ];
  return (
    <div style={{ display: 'flex', height, borderRadius: 99, overflow: 'hidden', background: T.line, width: '100%' }}>
      {segs.map((s, i) => <div key={i} style={{ width: `${s.w}%`, background: s.c, transition: 'width .4s ease' }} />)}
    </div>
  );
}

// ── Single meal card ────────────────────────────────────────────────────
function MealCard({ meal, open, onToggle, onDelete, onSave }) {
  const [editing, setEditing] = useState(false);
  const [desc, setDesc] = useState(meal.description);
  const [note, setNote] = useState(meal.note || '');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const beginEdit = () => {
    setDesc(meal.description);
    setNote(meal.note || '');
    setEditError('');
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditError('');
  };
  const saveEdit = async () => {
    if (saving) return;
    const trimmed = desc.trim();
    if (!trimmed) { setEditError('Description cannot be empty.'); return; }
    setSaving(true); setEditError('');
    try {
      const patch = {};
      if (trimmed !== meal.description) patch.description = trimmed;
      // Always send note — sending null clears it; empty string also clears.
      if ((note || '') !== (meal.note || '')) patch.note = note.trim() || null;
      if (Object.keys(patch).length === 0) { setEditing(false); return; }
      await onSave(meal.id, patch);
      setEditing(false);
    } catch (e) {
      setEditError(e?.message || "Couldn't save edits.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="afl-card" style={{ ...card, padding: 16, marginBottom: 12 }}>
      {!editing ? (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1 }}>
              {meal.time && <div style={{ fontSize: 11, color: T.inkFaint, marginBottom: 2 }}>{meal.time}</div>}
              <div style={{ fontWeight: 600, fontSize: 14.5, lineHeight: 1.35 }}>{meal.description}</div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div className="afl-head" style={{ fontWeight: 800, fontSize: 18, color: T.primary }}>{r(meal.totals.calories)}</div>
              <div style={{ fontSize: 11, color: T.inkFaint }}>kcal</div>
            </div>
          </div>

          {meal.photos.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 11.5, color: T.inkFaint, fontStyle: 'italic' }}>
              {meal.photos.length} photo{meal.photos.length > 1 ? 's' : ''} attached (view from WhatsApp).
            </div>
          )}

          <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 12.5, color: T.inkSoft, alignItems: 'center', flexWrap: 'wrap' }}>
            <span><b style={{ color: T.protein }}>P</b> {r(meal.totals.protein)}g</span>
            <span><b style={{ color: T.carbs }}>C</b> {r(meal.totals.carbs)}g</span>
            <span><b style={{ color: T.fat }}>F</b> {r(meal.totals.fat)}g</span>
            <span style={{ color: T.inkFaint }}>Na {r(meal.totals.sodium)}mg</span>
            <div style={{ flex: 1 }} />
            <button onClick={onToggle} style={linkBtn}>{open ? 'hide' : `${meal.items.length} item${meal.items.length > 1 ? 's' : ''}`}</button>
            <button onClick={beginEdit} style={linkBtn}>edit</button>
            <button onClick={onDelete} style={{ ...linkBtn, color: T.warn }}>delete</button>
          </div>

          {meal.note && <div style={{ marginTop: 8, fontSize: 12, color: T.inkFaint, fontStyle: 'italic' }}>{meal.note}</div>}

          {open && (
            <div style={{ marginTop: 12, borderTop: `1px solid ${T.line}`, paddingTop: 10 }}>
              {meal.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '5px 0', color: T.inkSoft }}>
                  <span style={{ flex: 1 }}>{it.name}</span>
                  <span style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
                    <span style={{ color: T.ink, fontWeight: 600 }}>{r(it.calories)} kcal</span>
                    <span style={{ width: 120, textAlign: 'right' }}>{r(it.protein)}p · {r(it.carbs)}c · {r(it.fat)}f</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div>
          <div style={{ fontSize: 11, color: T.inkFaint, marginBottom: 6 }}>Editing meal{meal.time ? ` · ${meal.time}` : ''}</div>
          <textarea
            autoFocus
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            rows={2}
            placeholder='What did you actually eat?'
            disabled={saving}
            style={{ ...textInput, width: '100%', resize: 'vertical', fontSize: 14 }}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='Optional note (e.g. "post-workout")'
            disabled={saving}
            style={{ ...textInput, width: '100%', marginTop: 8, fontSize: 13.5 }}
          />
          <div style={{ marginTop: 8, fontSize: 11.5, color: T.inkFaint }}>
            If you change the description, Aria re-estimates the macros from scratch.
          </div>
          {editError && <div style={{ color: T.warn, fontSize: 12.5, marginTop: 8 }}>{editError}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
            <button onClick={saveEdit} disabled={saving} style={{ ...smallPrimary, opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={cancelEdit} disabled={saving} style={linkBtn}>cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tiny markdown-ish renderer for insights ─────────────────────────────
function renderInsight(text) {
  if (!text) return null;
  return text.split('\n').filter((l) => l.trim()).map((line, i) => {
    const t = line.trim();
    const bullet = /^[-*•]\s+/.test(t);
    const content = t.replace(/^[-*•]\s+/, '');
    const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') ? <b key={j} style={{ color: T.ink }}>{p.slice(2, -2)}</b> : <span key={j}>{p}</span>);
    return (
      <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 7, fontSize: 13.5, color: T.inkSoft, lineHeight: 1.45 }}>
        {bullet && <span style={{ color: T.primary, flexShrink: 0 }}>•</span>}
        <span>{parts}</span>
      </div>
    );
  });
}

export default function FoodPanel({ apiFetch, authToken }) {
  const [activeKey, setActiveKey] = useState(todayKey());
  const [meals, setMeals] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyEntriesByDate, setHistoryEntriesByDate] = useState({});
  const [goal, setGoal] = useState(() => {
    try {
      const v = localStorage.getItem(GOAL_STORAGE_KEY);
      const n = v ? parseInt(v, 10) : null;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  });
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState({});
  const [histExpanded, setHistExpanded] = useState({});
  const [insight, setInsight] = useState('');
  const [insightBusy, setInsightBusy] = useState(false);
  const inputRef = useRef(null);

  const authHeaders = { Authorization: `Bearer ${authToken}` };

  const loadDay = useCallback(async (dateKey) => {
    try {
      const res = await apiFetch(`/api/food/day/${dateKey}`, { headers: authHeaders });
      const data = await res.json();
      setMeals((data?.entries || []).map(adaptEntry));
    } catch {
      setMeals([]);
    }
  }, [apiFetch, authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiFetch('/api/food/history?limit=30', { headers: authHeaders });
      const data = await res.json();
      setHistory(Array.isArray(data) ? data : []);
    } catch {
      setHistory([]);
    }
  }, [apiFetch, authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadDay(activeKey); }, [activeKey, loadDay]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const totals = sumTotals(meals);

  async function logMeal() {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true); setError('');
    try {
      const res = await apiFetch('/api/food/log', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: text, local_date: activeKey }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.detail || data?.error || 'log_failed');
      }
      const entry = await res.json();
      setMeals((prev) => [adaptEntry(entry), ...prev]);
      setInput('');
      // Refresh history rollups since today's row totals just changed.
      loadHistory();
    } catch (e) {
      setError(`Couldn't read that one — ${e.message === 'log_failed' ? 'try rephrasing the meal.' : e.message}`);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function deleteMeal(dayKey, id) {
    try {
      await apiFetch(`/api/food/entry/${id}`, { method: 'DELETE', headers: authHeaders });
      if (dayKey === activeKey) {
        setMeals((prev) => prev.filter((m) => m.id !== id));
      } else {
        setHistoryEntriesByDate((prev) => ({
          ...prev,
          [dayKey]: (prev[dayKey] || []).filter((m) => m.id !== id),
        }));
      }
      loadHistory();
    } catch {}
  }

  async function saveMealEdits(dayKey, id, patch) {
    const res = await apiFetch(`/api/food/entry/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.detail || data?.error || 'edit failed');
    }
    const updated = adaptEntry(await res.json());
    if (dayKey === activeKey) {
      setMeals((prev) => prev.map((m) => (m.id === id ? updated : m)));
    } else {
      setHistoryEntriesByDate((prev) => ({
        ...prev,
        [dayKey]: (prev[dayKey] || []).map((m) => (m.id === id ? updated : m)),
      }));
    }
    // If the entry moved to a different date, refresh both sides.
    if (patch.localDate || patch.local_date) {
      loadDay(activeKey);
    }
    loadHistory();
  }

  async function expandHistoryDay(dateKey) {
    const next = !histExpanded[dateKey];
    setHistExpanded((p) => ({ ...p, [dateKey]: next }));
    if (next && !historyEntriesByDate[dateKey]) {
      try {
        const res = await apiFetch(`/api/food/day/${dateKey}`, { headers: authHeaders });
        const data = await res.json();
        setHistoryEntriesByDate((p) => ({ ...p, [dateKey]: (data?.entries || []).map(adaptEntry) }));
      } catch {
        setHistoryEntriesByDate((p) => ({ ...p, [dateKey]: [] }));
      }
    }
  }

  function saveGoal() {
    const v = parseInt(goalDraft, 10);
    const next = Number.isFinite(v) && v > 0 ? v : null;
    setGoal(next);
    setEditingGoal(false);
    try {
      if (next == null) localStorage.removeItem(GOAL_STORAGE_KEY);
      else localStorage.setItem(GOAL_STORAGE_KEY, String(next));
    } catch {}
  }

  async function findTrends() {
    if (insightBusy) return;
    setInsightBusy(true); setInsight('');
    try {
      const res = await apiFetch('/api/food/insights?days=14', { headers: authHeaders });
      const data = await res.json();
      setInsight(data?.text || "Couldn't generate insights right now.");
    } catch {
      setInsight("Couldn't reach Aria for insights — try again in a moment.");
    } finally {
      setInsightBusy(false);
    }
  }

  const macroCals = { protein: totals.protein * 4, carbs: totals.carbs * 4, fat: totals.fat * 9 };
  const macroTotal = macroCals.protein + macroCals.carbs + macroCals.fat || 1;
  const ringTarget = goal || 2000;
  const ringPct = Math.min(totals.calories / ringTarget, 1);
  const R = 52, CIRC = 2 * Math.PI * R;
  const macroRow = [
    { key: 'protein', label: 'Protein', val: totals.protein, color: T.protein },
    { key: 'carbs', label: 'Carbs', val: totals.carbs, color: T.carbs },
    { key: 'fat', label: 'Fat', val: totals.fat, color: T.fat },
  ];
  const microChips = [
    { label: 'Fiber', val: `${r(totals.fiber)} g` },
    { label: 'Sugar', val: `${r(totals.sugar)} g` },
    { label: 'Sodium', val: `${r(totals.sodium)} mg` },
  ];
  const historyVisible = history.filter((h) => h.local_date !== activeKey);

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: T.surface, color: T.ink, fontFamily: "Manrope, ui-sans-serif, system-ui, sans-serif", padding: '28px 20px 48px' }}>
      <style>{`
        .afl-head { font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif; }
        .afl-card { transition: box-shadow .18s ease, transform .18s ease; }
        .afl-card:hover { box-shadow: 0 8px 28px rgb(var(--accent) / .10); }
        .afl-btn:active { transform: translateY(1px); }
        .afl-row { cursor: pointer; transition: background .15s ease; }
        .afl-row:hover { background: ${T.sidebar}; }
        @keyframes aflPulse { 0%,100%{opacity:.35} 50%{opacity:1} }
        .afl-dot { animation: aflPulse 1s ease-in-out infinite; }
      `}</style>

      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 22 }}>
          <div style={{ width: 38, height: 38, borderRadius: 12, background: `linear-gradient(135deg, ${T.primary}, ${T.primaryContainer})`, display: 'grid', placeItems: 'center', color: 'rgb(var(--accent-contrast))', fontWeight: 800, fontFamily: "'Plus Jakarta Sans'", fontSize: 18 }}>A</div>
          <div>
            <div className="afl-head" style={{ fontSize: 19, fontWeight: 800, letterSpacing: -0.3 }}>Aria · Food Log</div>
            <div style={{ fontSize: 13, color: T.inkFaint }}>Tell me what you ate — I'll handle the macros.</div>
          </div>
        </div>

        {/* Date nav */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <button className="afl-btn" onClick={() => setActiveKey(shiftKey(activeKey, -1))} style={navBtn}>‹</button>
          <div className="afl-head" style={{ fontWeight: 700, fontSize: 15 }}>
            {prettyDate(activeKey)}
            {activeKey !== todayKey() && <button onClick={() => setActiveKey(todayKey())} style={{ ...linkBtn, marginLeft: 10 }}>jump to today</button>}
          </div>
          <button className="afl-btn" onClick={() => setActiveKey(shiftKey(activeKey, 1))} disabled={activeKey === todayKey()} style={{ ...navBtn, opacity: activeKey === todayKey() ? 0.35 : 1 }}>›</button>
        </div>

        {/* Summary */}
        <div className="afl-card" style={{ ...card, padding: 22, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', width: 124, height: 124, flexShrink: 0 }}>
              <svg width="124" height="124" viewBox="0 0 124 124">
                <circle cx="62" cy="62" r={R} fill="none" stroke={T.line} strokeWidth="11" />
                <circle cx="62" cy="62" r={R} fill="none" stroke={T.primary} strokeWidth="11" strokeLinecap="round" strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - ringPct)} transform="rotate(-90 62 62)" style={{ transition: 'stroke-dashoffset .5s ease' }} />
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
                <div>
                  <div className="afl-head" style={{ fontSize: 26, fontWeight: 800, lineHeight: 1 }}>{r(totals.calories)}</div>
                  <div style={{ fontSize: 11, color: T.inkFaint, marginTop: 2 }}>{goal ? `of ${goal}` : 'kcal'}</div>
                </div>
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              {macroRow.map((m) => {
                const pct = Math.round((macroCals[m.key] / macroTotal) * 100);
                return (
                  <div key={m.key} style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                      <span style={{ fontWeight: 600 }}>{m.label}</span>
                      <span style={{ color: T.inkSoft }}><b style={{ color: T.ink }}>{r(m.val)} g</b> · {pct}%</span>
                    </div>
                    <div style={{ height: 8, borderRadius: 99, background: T.line, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: m.color, borderRadius: 99, transition: 'width .4s ease' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16, alignItems: 'center' }}>
            {microChips.map((c) => (
              <div key={c.label} style={chip}><span style={{ color: T.inkFaint }}>{c.label}</span><b className="afl-head">{c.val}</b></div>
            ))}
            <div style={{ flex: 1 }} />
            {editingGoal ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input autoFocus type="number" value={goalDraft} placeholder="kcal goal" onChange={(e) => setGoalDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveGoal()} style={{ ...textInput, width: 110, padding: '7px 10px' }} />
                <button className="afl-btn" onClick={saveGoal} style={smallPrimary}>Set</button>
              </div>
            ) : (
              <button className="afl-btn" onClick={() => { setGoalDraft(goal || ''); setEditingGoal(true); }} style={linkBtn}>{goal ? 'edit daily goal' : '+ set a daily goal'}</button>
            )}
          </div>
        </div>

        {/* Logger */}
        <div className="afl-card" style={{ ...card, padding: 14, marginBottom: 18, display: 'flex', gap: 10 }}>
          <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && logMeal()} placeholder='e.g. "grilled chicken bowl with rice, avocado, and a diet coke"' disabled={busy} style={{ ...textInput, flex: 1 }} />
          <button className="afl-btn" onClick={logMeal} disabled={busy || !input.trim()} style={{ ...primaryBtn, opacity: busy || !input.trim() ? 0.55 : 1 }}>{busy ? 'Reading…' : 'Log'}</button>
        </div>

        {error && <div style={{ color: T.warn, fontSize: 13, margin: '-6px 4px 14px' }}>{error}</div>}
        {busy && <div style={{ display: 'flex', gap: 6, alignItems: 'center', color: T.inkFaint, fontSize: 13, margin: '-6px 4px 14px' }}><span className="afl-dot">●</span> Aria is estimating macros…</div>}

        {/* Active day meals */}
        {meals.length === 0 && !busy ? (
          <div style={{ textAlign: 'center', color: T.inkFaint, padding: '30px 0', fontSize: 14 }}>No meals logged for {prettyDate(activeKey).toLowerCase()} yet.</div>
        ) : meals.map((meal) => (
          <MealCard key={meal.id} meal={meal} open={expanded[meal.id]}
            onToggle={() => setExpanded((p) => ({ ...p, [meal.id]: !p[meal.id] }))}
            onDelete={() => deleteMeal(activeKey, meal.id)}
            onSave={(id, patch) => saveMealEdits(activeKey, id, patch)} />
        ))}

        {/* Aria Insights */}
        <div className="afl-card" style={{ ...card, padding: 18, marginTop: 22, marginBottom: 14, borderColor: T.primaryContainer + '55', background: 'linear-gradient(180deg,rgb(var(--surface-card)), rgb(var(--surface-container-low)))' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="afl-head" style={{ fontWeight: 800, fontSize: 15 }}>Aria Insights</div>
              <div style={{ fontSize: 12.5, color: T.inkFaint, marginTop: 2 }}>Trends across your logged days, with meal suggestions.</div>
            </div>
            <button className="afl-btn" onClick={findTrends} disabled={insightBusy} style={{ ...primaryBtn, opacity: insightBusy ? 0.6 : 1 }}>{insightBusy ? 'Analyzing…' : 'Find my trends'}</button>
          </div>
          {insight && <div style={{ marginTop: 14, borderTop: `1px solid ${T.line}`, paddingTop: 14 }}>{renderInsight(insight)}</div>}
        </div>

        {/* History */}
        {historyVisible.length > 0 && (
          <div style={{ marginTop: 22 }}>
            <div className="afl-head" style={{ fontWeight: 800, fontSize: 15, marginBottom: 10, padding: '0 4px' }}>History</div>
            <div className="afl-card" style={{ ...card, overflow: 'hidden', padding: 0 }}>
              {historyVisible.map((h, idx) => {
                const k = h.local_date;
                const t = h.totals || EMPTY_TOTALS;
                const isOpen = histExpanded[k];
                const dayEntries = historyEntriesByDate[k] || [];
                return (
                  <div key={k} style={{ borderTop: idx ? `1px solid ${T.line}` : 'none' }}>
                    <div className="afl-row" onClick={() => expandHistoryDay(k)} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px' }}>
                      <div style={{ width: 92, flexShrink: 0 }}>
                        <div className="afl-head" style={{ fontWeight: 700, fontSize: 13.5 }}>{prettyDate(k)}</div>
                        <div style={{ fontSize: 11, color: T.inkFaint }}>{h.entry_count} meal{h.entry_count > 1 ? 's' : ''}</div>
                      </div>
                      <div style={{ flex: 1, minWidth: 80 }}><MacroBar totals={t} /></div>
                      <div style={{ textAlign: 'right', flexShrink: 0, width: 96 }}>
                        <span className="afl-head" style={{ fontWeight: 800, fontSize: 15, color: T.primary }}>{r(t.calories)}</span>
                        <span style={{ fontSize: 11, color: T.inkFaint }}> kcal</span>
                      </div>
                      <span style={{ color: T.inkFaint, transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .2s ease', flexShrink: 0 }}>›</span>
                    </div>
                    {isOpen && (
                      <div style={{ padding: '4px 16px 14px', background: T.surface }}>
                        <div style={{ display: 'flex', gap: 14, fontSize: 12, color: T.inkSoft, padding: '8px 2px 12px' }}>
                          <span><b style={{ color: T.protein }}>P</b> {r(t.protein)}g</span>
                          <span><b style={{ color: T.carbs }}>C</b> {r(t.carbs)}g</span>
                          <span><b style={{ color: T.fat }}>F</b> {r(t.fat)}g</span>
                          <span style={{ color: T.inkFaint }}>Fiber {r(t.fiber)}g · Sugar {r(t.sugar)}g · Na {r(t.sodium)}mg</span>
                        </div>
                        {dayEntries.length === 0 ? (
                          <div style={{ color: T.inkFaint, fontSize: 12.5, padding: '6px 0' }}>Loading…</div>
                        ) : dayEntries.map((meal) => (
                          <MealCard key={meal.id} meal={meal} open={expanded[meal.id]}
                            onToggle={() => setExpanded((p) => ({ ...p, [meal.id]: !p[meal.id] }))}
                            onDelete={() => deleteMeal(k, meal.id)}
                            onSave={(id, patch) => saveMealEdits(k, id, patch)} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div style={{ textAlign: 'center', color: T.inkFaint, fontSize: 11, marginTop: 24 }}>Estimates are approximate — verify for clinical or precise tracking.</div>
      </div>
    </div>
  );
}

const card = { background: T.card, border: `1px solid ${T.line}`, borderRadius: 18, boxShadow: '0 1px 3px rgb(var(--text-primary) / .04)' };
const textInput = { border: `1px solid ${T.line}`, borderRadius: 12, padding: '11px 14px', fontSize: 14, fontFamily: 'inherit', color: T.ink, outline: 'none', background: T.surface };
const primaryBtn = { background: T.primary, color: 'rgb(var(--accent-contrast))', border: 'none', borderRadius: 12, padding: '11px 20px', fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' };
const smallPrimary = { background: T.primary, color: 'rgb(var(--accent-contrast))', border: 'none', borderRadius: 10, padding: '7px 14px', fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' };
const navBtn = { width: 34, height: 34, borderRadius: 10, border: `1px solid ${T.line}`, background: T.card, color: T.inkSoft, fontSize: 18, cursor: 'pointer', lineHeight: 1 };
const linkBtn = { background: 'none', border: 'none', color: T.primary, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 };
const chip = { display: 'flex', gap: 6, alignItems: 'center', background: T.sidebar, borderRadius: 99, padding: '6px 12px', fontSize: 12.5 };
