import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * ActiveZone — Aria's orchestration surface.
 *
 * Renders up to 3 tiles fetched from GET /api/active-zone/tiles. Per-tile
 * primary actions invoke the parent's onAction callback (which routes to
 * the existing draft-composition surfaces — daily wrap, close loop, etc).
 * Defer / dismiss / expand are handled inline.
 *
 * Empty state is rendered by ActiveZoneVoice (AZ6) — this component
 * returns null when the queue is empty so the parent can show that
 * panel instead.
 *
 * Refresh triggers come from the parent via a `refreshKey` prop —
 * incrementing it triggers a debounced re-fetch. Internally we also
 * poll every 5 minutes as a fallback. AZ7 wires up the upstream
 * triggers.
 */
// Outcome status chips — full granularity per Q1 directive (no enum
// reduction even on mobile; mobile gets vertical stacking instead).
// Mirrors OUTCOME_STATUS_CONFIG in DashboardPanel.jsx::OutcomePrompt
// (kept locally to avoid a circular import). 5 statuses — 'no_show' is
// available on the server enum but kept off the chip strip for V1
// since it's a niche signal that confuses the binary user.
const CHIPS = [
  { key: 'success',   label: '✓', tooltip: 'Success',    fg: '#3b6d11', bg: '#eaf3de' },
  { key: 'mixed',     label: '~', tooltip: 'Mixed',      fg: '#534ab7', bg: '#eeedfe' },
  { key: 'neutral',   label: '—', tooltip: 'Neutral',    fg: '#534ab7', bg: '#eeedfe' },
  { key: 'failed',    label: '✗', tooltip: 'Failed',     fg: '#a32d2d', bg: '#fcebeb' },
  { key: 'cancelled', label: '⊘', tooltip: 'Cancelled',  fg: '#5f5e5a', bg: '#f1efe8' },
];

// 2026-05-13 close-loop enrichment — universal date formatter for the
// three render blocks in BulkCloseRow. Pure (no Date.now() outside the
// injected `now`), null-safe, locale-light. Format ladder:
//   < 7 days  → relative ("Today" | "Yesterday" | weekday)
//   ≥ 7 days  → absolute ("May 8")
//   includeTime appends " H:MM AM/PM" with a comma after absolute dates.
//   prefix prepends a verb ("Created" | "Queued" | "Closed") with a space.
// Null/undefined input returns null so the renderer can skip the block.
function formatCloseLoopDate(dateInput, opts = {}) {
  if (dateInput === null || dateInput === undefined || dateInput === '') return null;
  const t = new Date(dateInput).getTime();
  if (!Number.isFinite(t)) return null;
  const { prefix = '', includeTime = false, now = Date.now() } = opts;
  const d = new Date(t);
  const nowD = new Date(now);
  // Local-midnight diff in days, not ms diff — "Yesterday at 11pm" should
  // read "Yesterday" even if absolute delta < 24h.
  const startOfLocal = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOfLocal(nowD) - startOfLocal(d)) / 86_400_000);
  const time = includeTime
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : '';
  let datePart;
  if (dayDiff === 0)       datePart = 'Today';
  else if (dayDiff === 1)  datePart = 'Yesterday';
  else if (dayDiff > 1 && dayDiff < 7) datePart = d.toLocaleDateString(undefined, { weekday: 'short' });
  else                     datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  // Absolute dates use a comma separator before time; relative uses a space.
  const isAbsolute = dayDiff >= 7 || dayDiff < 0;
  const dateAndTime = time
    ? (isAbsolute ? `${datePart}, ${time}` : `${datePart} ${time}`)
    : datePart;
  return prefix ? `${prefix} ${dateAndTime}` : dateAndTime;
}

// Smart defaults per Q3 directive. Returns { status?, expandNote? }
// based on what metadata is currently surfaced on the close-loop
// item. Today the items_preview shape carries source_type, source_id,
// title, triggered_at — not yet task.completed_at, event.attendees,
// event.was_cancelled, etc. Implements what's available now; richer
// defaults follow when candidateDetector enriches the preview.
function smartDefaultForCloseLoop(item, now = Date.now()) {
  const triggered = item.triggered_at || item.triggeredAt;
  const ageMs = triggered ? Math.max(0, now - new Date(triggered).getTime()) : 0;
  const ageDays = ageMs / 86_400_000;
  const sourceType = item.source_type || item.sourceType;

  // > 30 days old, never interacted → probable abandonment.
  if (ageDays > 30) return { status: 'cancelled', expandNote: false };

  // Tasks > 14 days old that surfaced as a close-loop → success-by-
  // absence-of-contradiction. User can override with a chip click.
  if (sourceType === 'task' && ageDays > 14) return { status: 'success', expandNote: false };

  // Calendar events default to blank chip + pre-expanded note. Per Q3:
  // "1:1 meetings → leave blank but pre-expand '+ note' affordance."
  // Items_preview doesn't yet expose attendee count, so apply to all
  // events for V1 — refine when detector surfaces attendee metadata.
  if (sourceType === 'event') return { status: null, expandNote: true };

  // Otherwise: blank, no opinion (per Q2 — chip is optional).
  return { status: null, expandNote: false };
}

export default function ActiveZoneOrchestrator({ apiFetch, authToken, refreshKey, onAction, onEmptyChange }) {
  const [tiles, setTiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expandedTileId, setExpandedTileId] = useState(null);
  const [appearedIds, setAppearedIds] = useState(() => new Set()); // tiles that have already played their slide-in
  // 2026-05-08 outcome capture redesign — per-row outcome state for
  // close_the_loops_batch tiles. Map: `${ckey}:${itemId}` → { status, note }.
  // status is one of the 5 CHIPS keys or null (no chip = binary resolve).
  // Smart defaults pre-populate this map when a tile first expands;
  // user clicks override.
  const [closeLoopOutcomes, setCloseLoopOutcomes] = useState(() => new Map());
  const [expandedNoteIds, setExpandedNoteIds] = useState(() => new Set()); // which rows have the textarea expanded
  const initialLoadDoneRef = useRef(false);
  const refreshTimerRef = useRef(null);
  const inFlightRef = useRef(null);

  // Notify parent immediately on mount so the empty-state Voice panel
  // renders before the first fetch resolves. Without this, azIsEmpty
  // stays at its parent default for the duration of the fetch — fine
  // when the default is true (current contract), but spelling it out
  // makes the contract robust against parents that init it false.
  useEffect(() => {
    if (onEmptyChange) onEmptyChange(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchTiles = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    setLoading(true);
    const p = (async () => {
      try {
        const r = await apiFetch('/api/active-zone/tiles', {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const next = Array.isArray(data?.tiles) ? data.tiles : [];
        if (typeof window !== 'undefined') {
          console.log(`[ActiveZoneOrchestrator] fetched ${next.length} tile(s)`, next.map((t) => t.candidateType || t.candidate_type));
        }
        setTiles(next);
        if (onEmptyChange) onEmptyChange(next.length === 0);
      } catch (err) {
        if (typeof window !== 'undefined') {
          console.warn('[ActiveZoneOrchestrator] fetch failed', err?.message);
        }
        setTiles([]);
        if (onEmptyChange) onEmptyChange(true);
      } finally {
        setLoading(false);
        inFlightRef.current = null;
      }
    })();
    inFlightRef.current = p;
    return p;
  }, [apiFetch, authToken, onEmptyChange]);

  // Initial load + refresh on key change. Debounce 2s when key bumps so
  // a burst of state changes (5 tasks completed in 30s) yields ONE
  // detector run rather than five.
  useEffect(() => {
    if (!initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      fetchTiles();
      return;
    }
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => fetchTiles(), 2000);
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [refreshKey, fetchTiles]);

  // 5-min poll fallback in case an event missed.
  useEffect(() => {
    const id = setInterval(() => fetchTiles(), 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [fetchTiles]);

  // Track which tile ids have appeared so the slide-in only animates on
  // the FIRST render of each tile, not on initial page load.
  useEffect(() => {
    setAppearedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      tiles.forEach((t) => { if (!next.has(t.id)) { next.add(t.id); changed = true; } });
      return changed ? next : prev;
    });
  }, [tiles]);

  async function postTileStatus(tileId, action) {
    try {
      const r = await apiFetch(`/api/active-zone/tiles/${encodeURIComponent(tileId)}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      // Swallow — refetch will reconcile state regardless.
    }
    setTiles((prev) => prev.filter((t) => t.id !== tileId));
    if (expandedTileId === tileId) setExpandedTileId(null);
    fetchTiles();
  }

  // Set of tile-id strings whose items list is currently expanded.
  const isExpanded = (tileId) => expandedTileId === tileId;
  // Set of "candidate_key:item_id" strings the user has just checked off
  // in the expanded list. Used for optimistic strikethrough; the real
  // completion fires via apiFetch below.
  const [completedItemIds, setCompletedItemIds] = useState(() => new Set());

  const EXPAND_ACTIONS = new Set([
    'expand_overdue_tasks',
    'expand_close_the_loops',
    'expand_critical_emails',
  ]);

  function handlePrimary(tile) {
    const a = tile.primaryAction || tile.primary_action;
    if (!a) return;
    // Two cases for batch tiles:
    //   collapsed → primary expands the items list (no backend call)
    //   expanded  → primary fires "complete all unchecked items" batch
    if (EXPAND_ACTIONS.has(a.action)) {
      if (!isExpanded(tile.id)) {
        setExpandedTileId(tile.id);
        // Apply smart defaults for close_the_loops_batch on first expand.
        ensureSmartDefaults(tile);
        return;
      }
      // Expanded — batch-complete every item not already checked off.
      handleBatchComplete(tile);
      return;
    }
    // Singleton tile actions hand off to parent (composition surface).
    if (onAction) onAction(a, tile);
    postTileStatus(tile.id, 'resolve');
  }

  // Per-candidate-type item completion. Each fires the appropriate
  // existing API. Returns a promise so the caller can chain.
  //
  // close_the_loops_batch: single-item check goes through the legacy
  // single-resolve endpoint (binary, no chip set). Bulk completion
  // (handleBatchComplete) routes to /api/close-loop/resolve-batch
  // which ALSO writes outcome_records when chips are set.
  async function completeItem(tile, item) {
    const ctype = tile.candidateType || tile.candidate_type;
    try {
      if (ctype === 'overdue_tasks_batch') {
        await apiFetch(`/api/tasks/${encodeURIComponent(item.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ completed: true, completedAt: new Date().toISOString() }),
        });
      } else if (ctype === 'close_the_loops_batch') {
        // Single-item check (no chip) → legacy resolve. The rich path
        // is the batch endpoint fired from handleBatchComplete.
        const ckey = tile.candidate_key || tile.candidateKey || tile.id;
        const outcome = closeLoopOutcomes.get(`${ckey}:${item.id}`);
        if (outcome?.status) {
          // User clicked a chip then the per-row checkbox — fire batch
          // with this single item so the outcome lands.
          await apiFetch('/api/close-loop/resolve-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({
              items: [{
                source_type: item.source_type,
                source_id: item.source_id,
                outcome_status: outcome.status,
                raw_note: outcome.note || null,
                title_snapshot: item.title || null,
              }],
            }),
          });
        } else {
          await apiFetch('/api/close-loop/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
            body: JSON.stringify({ source_type: item.source_type, source_id: item.source_id }),
          });
        }
      } else if (ctype === 'critical_email_unacked') {
        await apiFetch(`/api/inbox/items/${encodeURIComponent(item.id)}/ack`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${authToken}` },
        });
      }
    } catch { /* non-fatal — refetch reconciles */ }
  }

  // Per-row dismiss for close_the_loops_batch. Different semantics from
  // ⊘ Cancelled chip (Q5 directive):
  //   dismiss = "this shouldn't have been surfaced" → no enrichment
  //   ⊘ chip  = "real loop, didn't happen"          → fires enrichment
  // Routes to the existing /api/close-loop/dismiss endpoint.
  async function dismissCloseLoopItem(tile, item) {
    const ckey = tile.candidate_key || tile.candidateKey || tile.id;
    const key = `${ckey}:${item.id}`;
    setCompletedItemIds((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      await apiFetch('/api/close-loop/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ source_type: item.source_type, source_id: item.source_id }),
      });
    } catch { /* fire-and-forget — refetch reconciles */ }
  }

  // Outcome state mutators — surfaced into BulkCloseRow via props.
  function setRowOutcome(ckey, itemId, patch) {
    setCloseLoopOutcomes((prev) => {
      const next = new Map(prev);
      const k = `${ckey}:${itemId}`;
      const merged = { ...(next.get(k) || {}), ...patch };
      // Auto-stamp closed_at on first non-null status; clear when status
      // cleared. Drives the in-session "Closed today HH:MM" caption under
      // a row after the user picks a chip (Phase 1 enrichment).
      if ('status' in patch) {
        if (patch.status && !merged.closed_at) merged.closed_at = Date.now();
        else if (!patch.status) merged.closed_at = null;
      }
      next.set(k, merged);
      return next;
    });
  }
  function getRowOutcome(ckey, itemId) {
    return closeLoopOutcomes.get(`${ckey}:${itemId}`) || {};
  }
  function toggleNoteExpanded(ckey, itemId) {
    const k = `${ckey}:${itemId}`;
    setExpandedNoteIds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }
  // Apply smart defaults the first time a close-loops tile expands.
  function ensureSmartDefaults(tile) {
    if ((tile.candidateType || tile.candidate_type) !== 'close_the_loops_batch') return;
    const ckey = tile.candidate_key || tile.candidateKey || tile.id;
    const items = tile.itemsPreview || tile.items_preview || [];
    const now = Date.now();
    setCloseLoopOutcomes((prevOutcomes) => {
      let mutated = false;
      const next = new Map(prevOutcomes);
      for (const item of items) {
        const k = `${ckey}:${item.id}`;
        if (next.has(k)) continue; // already initialized — user may have clicked
        const def = smartDefaultForCloseLoop(item, now);
        next.set(k, { status: def.status || null, note: '', smartDefault: !!def.status });
        mutated = true;
      }
      return mutated ? next : prevOutcomes;
    });
    setExpandedNoteIds((prevSet) => {
      let mutated = false;
      const next = new Set(prevSet);
      for (const item of items) {
        const def = smartDefaultForCloseLoop(item, now);
        if (def.expandNote) {
          const k = `${ckey}:${item.id}`;
          if (!next.has(k)) { next.add(k); mutated = true; }
        }
      }
      return mutated ? next : prevSet;
    });
  }

  function markItemDone(tile, item) {
    const key = `${tile.candidate_key || tile.candidateKey || tile.id}:${item.id}`;
    setCompletedItemIds((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    completeItem(tile, item);
  }

  async function handleBatchComplete(tile) {
    const items = tile.itemsPreview || tile.items_preview || [];
    const ctype = tile.candidateType || tile.candidate_type;
    const ckey = tile.candidate_key || tile.candidateKey || tile.id;
    const remaining = items.filter((it) => !completedItemIds.has(`${ckey}:${it.id}`));
    if (!remaining.length) {
      // Everything already checked — just resolve the tile.
      postTileStatus(tile.id, 'resolve');
      return;
    }
    // Optimistically mark all as done.
    setCompletedItemIds((prev) => {
      const next = new Set(prev);
      for (const it of remaining) next.add(`${ckey}:${it.id}`);
      return next;
    });

    // 2026-05-08 outcome capture redesign — close_the_loops_batch
    // collapses to a single transactional batch endpoint that writes
    // outcome_records for any chip-set rows in addition to flipping
    // pending_close_loop.resolved_at. Other batch types unchanged.
    if (ctype === 'close_the_loops_batch') {
      const payload = remaining.map((it) => {
        const o = closeLoopOutcomes.get(`${ckey}:${it.id}`) || {};
        return {
          source_type: it.source_type,
          source_id: it.source_id,
          outcome_status: o.status || null,
          raw_note: o.note?.trim() ? o.note.trim() : null,
          title_snapshot: it.title || null,
        };
      });
      try {
        await apiFetch('/api/close-loop/resolve-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ items: payload }),
        });
      } catch { /* non-fatal — refetch reconciles */ }
    } else {
      // Legacy parallel completion — overdue_tasks_batch, critical_email_unacked.
      await Promise.all(remaining.map((it) => completeItem(tile, it)));
    }
    postTileStatus(tile.id, 'resolve');
    // Notify parent so task list / inbox / etc. re-render.
    if (onAction) onAction({ action: `batch_done:${ctype}` }, tile);
  }

  function handleDefer(tile)  { postTileStatus(tile.id, 'defer'); }
  function handleDismiss(tile) { postTileStatus(tile.id, 'dismiss'); }

  // Per-batch-type primary label when expanded.
  function expandedPrimaryLabel(ctype, remainingCount, tile) {
    if (remainingCount === 0) return 'Done';
    switch (ctype) {
      case 'overdue_tasks_batch':    return remainingCount === 1 ? 'Mark done' : `Mark all ${remainingCount} done`;
      case 'close_the_loops_batch': {
        // Surface the rich vs binary split — "Resolve all 7 (3 with notes)".
        // The (X with notes) substring updates live as the user toggles
        // chips so they see what they're committing.
        if (!tile) return remainingCount === 1 ? 'Resolve' : `Resolve all ${remainingCount}`;
        const items = tile.itemsPreview || tile.items_preview || [];
        const ckey = tile.candidate_key || tile.candidateKey || tile.id;
        const richCount = items.reduce((acc, it) => {
          if (completedItemIds.has(`${ckey}:${it.id}`)) return acc;
          const o = closeLoopOutcomes.get(`${ckey}:${it.id}`);
          return o?.status ? acc + 1 : acc;
        }, 0);
        const base = remainingCount === 1 ? 'Resolve' : `Resolve all ${remainingCount}`;
        return richCount > 0 ? `${base} (${richCount} with outcomes)` : base;
      }
      case 'critical_email_unacked': return remainingCount === 1 ? 'Acknowledge' : `Acknowledge all ${remainingCount}`;
      default:                        return 'Mark all done';
    }
  }

  if (!tiles.length) return null;

  return (
    <div className="space-y-2">
      {tiles.map((t) => {
        const wasAlreadyShown = !appearedIds.has(t.id);
        const ckey = t.candidate_key || t.candidateKey || t.id;
        // Per-tile completed-id list for optimistic strikethrough.
        const itemCompleted = (itemId) => completedItemIds.has(`${ckey}:${itemId}`);
        return (
          <ActiveZoneTile
            key={t.id}
            tile={t}
            expanded={isExpanded(t.id)}
            isFresh={!wasAlreadyShown && initialLoadDoneRef.current}
            isItemCompleted={itemCompleted}
            expandedPrimaryLabel={expandedPrimaryLabel}
            onPrimary={() => handlePrimary(t)}
            onItemCheck={(item) => markItemDone(t, item)}
            onShowLess={() => setExpandedTileId(null)}
            onDefer={() => handleDefer(t)}
            onDismiss={() => handleDismiss(t)}
            getRowOutcome={(itemId) => getRowOutcome(ckey, itemId)}
            setRowOutcome={(itemId, patch) => setRowOutcome(ckey, itemId, patch)}
            isNoteExpanded={(itemId) => expandedNoteIds.has(`${ckey}:${itemId}`)}
            toggleNoteExpanded={(itemId) => toggleNoteExpanded(ckey, itemId)}
            onItemDismiss={(item) => dismissCloseLoopItem(t, item)}
          />
        );
      })}
    </div>
  );
}

function ActiveZoneTile({ tile, expanded, isFresh, isItemCompleted, expandedPrimaryLabel, onPrimary, onItemCheck, onShowLess, onDefer, onDismiss, getRowOutcome, setRowOutcome, isNoteExpanded, toggleNoteExpanded, onItemDismiss }) {
  const primary = tile.primaryAction || tile.primary_action || {};
  const secondary = tile.secondaryAction || tile.secondary_action || {};
  const itemsPreview = tile.itemsPreview || tile.items_preview || [];
  const ctype = tile.candidateType || tile.candidate_type;
  const isExpandable = primary.action === 'expand_overdue_tasks'
                    || primary.action === 'expand_close_the_loops'
                    || primary.action === 'expand_critical_emails';

  // When expanded, primary label flips to the BATCH-COMPLETE verb so the
  // user can resolve everything in one tap. The collapsed label stays as
  // composer-supplied (e.g. "See them" / "Close them" / "Open inbox").
  const remainingCount = isExpandable
    ? itemsPreview.filter((it) => !isItemCompleted(it.id)).length
    : 0;
  const primaryLabel = (isExpandable && expanded)
    ? expandedPrimaryLabel(ctype, remainingCount, tile)
    : (primary.label || 'Open');

  return (
    <div
      className="bg-surface-container-lowest border border-surface-container-low rounded-2xl p-4 shadow-sm"
      style={{
        animation: isFresh ? 'azSlideIn 200ms ease-out' : 'none',
      }}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-on-background leading-snug">{tile.headline}</p>
          {tile.body && (
            <p className="text-xs text-on-surface-variant mt-1 whitespace-pre-line">{tile.body}</p>
          )}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss for today"
          title="Hide for today"
          className="text-on-surface-variant/40 hover:text-on-surface-variant transition-colors flex-shrink-0 -mr-1 -mt-1"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
        </button>
      </div>

      {expanded && itemsPreview.length > 0 && (
        <div className={`mt-3 pt-3 border-t border-surface-container-low ${ctype === 'close_the_loops_batch' ? 'space-y-2.5' : 'space-y-1.5'}`}>
          {itemsPreview.map((item, i) => {
            // 2026-05-08 — close_the_loops_batch gets the rich row.
            // Other batch types keep the legacy ItemPreviewRow.
            if (ctype === 'close_the_loops_batch') {
              return (
                <BulkCloseRow
                  key={item.id || i}
                  item={item}
                  completed={!!isItemCompleted(item.id)}
                  outcome={getRowOutcome ? getRowOutcome(item.id) : {}}
                  onCheck={() => onItemCheck(item)}
                  onChipClick={(status) => setRowOutcome?.(item.id, { status })}
                  onNoteChange={(note) => setRowOutcome?.(item.id, { note })}
                  noteExpanded={!!(isNoteExpanded && isNoteExpanded(item.id))}
                  onToggleNote={() => toggleNoteExpanded?.(item.id)}
                  onDismiss={() => onItemDismiss?.(item)}
                />
              );
            }
            return (
              <ItemPreviewRow
                key={item.id || i}
                item={item}
                candidateType={ctype}
                completed={!!isItemCompleted(item.id)}
                onCheck={() => onItemCheck(item)}
              />
            );
          })}
          <button
            onClick={onShowLess}
            className="text-[11px] text-on-surface-variant/60 hover:text-on-surface-variant mt-2 transition-colors"
          >
            Show less
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={onPrimary}
          className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
          disabled={isExpandable && expanded && remainingCount === 0}
        >
          {primaryLabel}
        </button>
        <button
          onClick={onDefer}
          className="px-3 py-1.5 text-xs text-on-surface-variant hover:text-on-background font-medium transition-colors"
        >
          {secondary.label || 'Not now'}
        </button>
      </div>
    </div>
  );
}

// Defensive: any item field that's null/undefined renders as a generic
// label rather than literal "undefined undefined". Belt-and-suspenders so
// the next contributor adding a candidate without proper items_preview
// shape doesn't ship "undefined undefined" rows.
function _safeText(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null && String(c).trim() !== '' && String(c) !== 'undefined') return String(c);
  }
  return 'Item';
}

function ItemPreviewRow({ item, candidateType, completed, onCheck }) {
  const baseRowClass = `flex items-center gap-2 text-xs ${completed ? 'opacity-50' : ''}`;
  const titleClass = `text-on-background truncate flex-1 ${completed ? 'line-through' : ''}`;

  if (candidateType === 'overdue_tasks_batch') {
    return (
      <div className={baseRowClass}>
        <CheckBox checked={completed} onChange={onCheck} />
        <span className={titleClass}>{_safeText(item.title)}</span>
        {item.dueDate && <span className="text-on-surface-variant/60 flex-shrink-0">{item.dueDate}</span>}
      </div>
    );
  }
  if (candidateType === 'close_the_loops_batch') {
    const iconKey = (item.source_type === 'event') ? 'event' : 'task_alt';
    const fallbackLabel = item.source_type && item.source_id
      ? `${item.source_type} ${item.source_id}`
      : 'Loop';
    return (
      <div className={baseRowClass}>
        <CheckBox checked={completed} onChange={onCheck} />
        <span className="material-symbols-outlined text-primary/60 flex-shrink-0" style={{ fontSize: '12px' }}>
          {iconKey}
        </span>
        <span className={titleClass}>{_safeText(item.title, fallbackLabel)}</span>
      </div>
    );
  }
  if (candidateType === 'critical_email_unacked') {
    return (
      <div className={baseRowClass}>
        <CheckBox checked={completed} onChange={onCheck} />
        <span className="material-symbols-outlined text-error/70 flex-shrink-0" style={{ fontSize: '12px' }}>flag</span>
        <span className={titleClass}>{_safeText(item.title, '(no subject)')}</span>
        {item.sender && <span className="text-on-surface-variant/60 truncate max-w-[40%]">{item.sender}</span>}
      </div>
    );
  }
  return null;
}

// 2026-05-08 outcome capture redesign — rich row for close_the_loops_batch.
// Layout (desktop):
//   [☐] [✓ ~ — ✗ ⊘]  Title text                  [+ note]  [✕]
//        ──── chip strip ───                   add note    dismiss
// On mobile: chips wrap below title (Q6 directive — vertical stack).
//
// Optional state per Q2:
//   - No chip selected → batch resolves binary (legacy behavior)
//   - Chip selected     → batch resolves AND writes outcome_records
//   - Note expanded     → optional 2-line textarea, persisted to raw_note
//   - Dismiss (✕)       → removes from list without enrichment
function BulkCloseRow({ item, completed, outcome, onCheck, onChipClick, onNoteChange, noteExpanded, onToggleNote, onDismiss }) {
  const baseRowClass = `flex flex-col gap-1.5 text-xs ${completed ? 'opacity-50' : ''}`;
  const titleClass = `text-on-background flex-1 ${completed ? 'line-through' : ''}`;
  const iconKey = (item.source_type === 'event') ? 'event' : 'task_alt';
  const fallbackLabel = item.source_type && item.source_id
    ? `${item.source_type} ${item.source_id}`
    : 'Loop';
  const selectedStatus = outcome?.status || null;
  const note = outcome?.note ?? '';

  // Block A — primary date. Events lean on the event start (includeTime
  // because hour-of-day is the meaningful signal for a meeting). Tasks
  // and project_tasks prefer the source row's created_at; when the JOIN
  // returns NULL (e.g. detector queued a loop for a source row that has
  // since been deleted), fall back to pcl.triggered_at with a "Queued"
  // prefix so the row never renders dateless.
  let primaryDate = null;
  if (item.source_type === 'event') {
    primaryDate = formatCloseLoopDate(item.sourceStartTime, { includeTime: true });
  } else {
    primaryDate = formatCloseLoopDate(item.sourceCreatedAt, { prefix: 'Created' });
    if (!primaryDate) {
      primaryDate = formatCloseLoopDate(item.triggered_at || item.triggeredAt, { prefix: 'Queued' });
    }
  }

  // Block B — inline description for tasks only. project_task descriptions
  // are intentionally deferred (zero current impact per Phase 1 resolution).
  // Truncate at 120 chars with a literal ellipsis — block doesn't render
  // when description is missing or empty.
  const rawDesc = item.source_type === 'task' ? item.sourceDescription : null;
  const inlineDesc = (typeof rawDesc === 'string' && rawDesc.trim())
    ? (rawDesc.length > 120 ? `${rawDesc.slice(0, 120)}…` : rawDesc)
    : null;

  // Block C — closed timestamp. Only the in-session stamp set by the
  // setRowOutcome auto-stamp (chip click). Historical closed_at for
  // already-resolved rows is Phase 1.5.
  const closedCaption = outcome?.closed_at
    ? formatCloseLoopDate(outcome.closed_at, { prefix: 'Closed', includeTime: true })
    : null;

  return (
    <div className={baseRowClass}>
      <div className="flex items-center gap-2 flex-wrap">
        <CheckBox checked={completed} onChange={onCheck} />
        <span className="material-symbols-outlined text-primary/60 flex-shrink-0" style={{ fontSize: '12px' }}>
          {iconKey}
        </span>
        <span className={titleClass} style={{ minWidth: 0 }}>
          <span className="truncate block">{_safeText(item.title, fallbackLabel)}</span>
        </span>
        {primaryDate && (
          <span className="flex-shrink-0 text-[11px] text-on-surface-variant/70">
            {primaryDate}
          </span>
        )}
        <button
          onClick={onToggleNote}
          aria-label={noteExpanded ? 'Hide note' : 'Add note'}
          title={noteExpanded ? 'Hide note' : 'Add note'}
          className={`flex-shrink-0 text-[10px] font-medium ${noteExpanded ? 'text-primary' : 'text-on-surface-variant/60 hover:text-primary'}`}
        >
          {noteExpanded ? '− note' : '+ note'}
        </button>
        <button
          onClick={onDismiss}
          aria-label="Dismiss this item (not a real loop)"
          title="Dismiss — shouldn't have been surfaced"
          className="flex-shrink-0 text-on-surface-variant/40 hover:text-error transition-colors"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
        </button>
      </div>

      {inlineDesc && (
        <p className="pl-6 text-[11px] text-on-surface-variant/80 leading-snug whitespace-pre-wrap break-words">
          {inlineDesc}
        </p>
      )}

      {/* Chip strip — sits below the title row. On mobile it wraps
          gracefully via flex-wrap; desktop stays single-line. */}
      <div className="flex items-center gap-1 flex-wrap pl-6">
        {CHIPS.map((c) => {
          const active = selectedStatus === c.key;
          const style = active
            ? { background: c.bg, color: c.fg, borderColor: c.bg }
            : {};
          return (
            <button
              key={c.key}
              onClick={() => onChipClick(active ? null : c.key)}
              title={c.tooltip}
              aria-pressed={active}
              aria-label={c.tooltip}
              className="text-[11px] font-semibold px-2 py-0.5 rounded border border-on-surface-variant/30 hover:border-primary/60 transition-colors"
              style={style}
            >
              {c.label}
            </button>
          );
        })}
        {selectedStatus && (
          <span className="text-[10px] text-on-surface-variant/60 ml-1">
            {CHIPS.find((c) => c.key === selectedStatus)?.tooltip}
          </span>
        )}
      </div>

      {noteExpanded && (
        <div className="pl-6">
          <textarea
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            placeholder="Quick note — outcomes, decisions, follow-ups…"
            maxLength={2000}
            className="w-full text-[12px] p-2 border border-on-surface-variant/20 rounded resize-y outline-none focus:border-primary"
            style={{ minHeight: 50, fontFamily: 'Manrope, sans-serif' }}
          />
        </div>
      )}

      {closedCaption && (
        <p className="pl-6 text-[10px] text-on-surface-variant/50">
          {closedCaption}
        </p>
      )}
    </div>
  );
}

function CheckBox({ checked, onChange }) {
  return (
    <button
      type="button"
      onClick={onChange}
      aria-checked={checked}
      role="checkbox"
      className={`w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
        checked
          ? 'bg-primary border-primary'
          : 'border-on-surface-variant/40 hover:border-primary'
      }`}
    >
      {checked && (
        <span className="material-symbols-outlined text-white" style={{ fontSize: '12px', fontVariationSettings: "'FILL' 1, 'wght' 700" }}>check</span>
      )}
    </button>
  );
}
