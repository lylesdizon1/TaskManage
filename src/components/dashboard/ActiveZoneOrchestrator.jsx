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
export default function ActiveZoneOrchestrator({ apiFetch, authToken, refreshKey, onAction, onEmptyChange }) {
  const [tiles, setTiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expandedTileId, setExpandedTileId] = useState(null);
  const [appearedIds, setAppearedIds] = useState(() => new Set()); // tiles that have already played their slide-in
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
        await apiFetch('/api/close-loop/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ source_type: item.source_type, source_id: item.source_id }),
        });
      } else if (ctype === 'critical_email_unacked') {
        await apiFetch(`/api/inbox/items/${encodeURIComponent(item.id)}/ack`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${authToken}` },
        });
      }
    } catch { /* non-fatal — refetch reconciles */ }
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
    const remaining = items.filter((it) => {
      const key = `${tile.candidate_key || tile.candidateKey || tile.id}:${it.id}`;
      return !completedItemIds.has(key);
    });
    if (!remaining.length) {
      // Everything already checked — just resolve the tile.
      postTileStatus(tile.id, 'resolve');
      return;
    }
    // Optimistically mark all as done, fire APIs in parallel.
    setCompletedItemIds((prev) => {
      const next = new Set(prev);
      for (const it of remaining) next.add(`${tile.candidate_key || tile.candidateKey || tile.id}:${it.id}`);
      return next;
    });
    await Promise.all(remaining.map((it) => completeItem(tile, it)));
    postTileStatus(tile.id, 'resolve');
    // Notify parent so task list / inbox / etc. re-render.
    if (onAction) onAction({ action: `batch_done:${ctype}` }, tile);
  }

  function handleDefer(tile)  { postTileStatus(tile.id, 'defer'); }
  function handleDismiss(tile) { postTileStatus(tile.id, 'dismiss'); }

  // Per-batch-type primary label when expanded.
  function expandedPrimaryLabel(ctype, remainingCount) {
    if (remainingCount === 0) return 'Done';
    switch (ctype) {
      case 'overdue_tasks_batch':    return remainingCount === 1 ? 'Mark done' : `Mark all ${remainingCount} done`;
      case 'close_the_loops_batch':  return remainingCount === 1 ? 'Resolve'   : `Resolve all ${remainingCount}`;
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
          />
        );
      })}
    </div>
  );
}

function ActiveZoneTile({ tile, expanded, isFresh, isItemCompleted, expandedPrimaryLabel, onPrimary, onItemCheck, onShowLess, onDefer, onDismiss }) {
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
    ? expandedPrimaryLabel(ctype, remainingCount)
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
        <div className="mt-3 pt-3 border-t border-surface-container-low space-y-1.5">
          {itemsPreview.map((item, i) => (
            <ItemPreviewRow
              key={item.id || i}
              item={item}
              candidateType={ctype}
              completed={!!isItemCompleted(item.id)}
              onCheck={() => onItemCheck(item)}
            />
          ))}
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
