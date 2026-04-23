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
        setTiles(next);
        if (onEmptyChange) onEmptyChange(next.length === 0);
      } catch {
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

  function handlePrimary(tile) {
    const a = tile.primaryAction || tile.primary_action;
    if (!a) return;
    // Inline-expand actions toggle local state without backend call.
    if (a.action === 'expand_overdue_tasks' || a.action === 'expand_close_the_loops') {
      setExpandedTileId((cur) => (cur === tile.id ? null : tile.id));
      return;
    }
    // All other actions hand off to the parent (which knows how to open
    // composition surfaces, navigate, etc.). Optimistically remove the
    // tile from the local list and mark resolved server-side; on next
    // detector run it'll either re-surface (if situation persists) or
    // stay gone (if user took action that resolved the underlying state).
    if (onAction) onAction(a, tile);
    postTileStatus(tile.id, 'resolve');
  }

  function handleDefer(tile)  { postTileStatus(tile.id, 'defer'); }
  function handleDismiss(tile) { postTileStatus(tile.id, 'dismiss'); }

  if (!tiles.length) return null;

  return (
    <div className="space-y-2">
      {tiles.map((t) => {
        const wasAlreadyShown = !appearedIds.has(t.id);
        // Tiles in the appearedIds set on first render don't animate —
        // see the appearedIds effect above.
        return (
          <ActiveZoneTile
            key={t.id}
            tile={t}
            expanded={expandedTileId === t.id}
            isFresh={!wasAlreadyShown && initialLoadDoneRef.current}
            onPrimary={() => handlePrimary(t)}
            onDefer={() => handleDefer(t)}
            onDismiss={() => handleDismiss(t)}
          />
        );
      })}
    </div>
  );
}

function ActiveZoneTile({ tile, expanded, isFresh, onPrimary, onDefer, onDismiss }) {
  const primary = tile.primaryAction || tile.primary_action || {};
  const secondary = tile.secondaryAction || tile.secondary_action || {};
  const itemsPreview = tile.itemsPreview || tile.items_preview || [];
  const expandAction = primary.action === 'expand_overdue_tasks' || primary.action === 'expand_close_the_loops';

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
            <ItemPreviewRow key={item.id || i} item={item} candidateType={tile.candidateType || tile.candidate_type} />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={onPrimary}
          className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-semibold hover:bg-primary/90 transition-colors"
        >
          {expandAction && expanded ? 'Hide' : (primary.label || 'Open')}
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

function ItemPreviewRow({ item, candidateType }) {
  if (candidateType === 'overdue_tasks_batch') {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="w-1 h-1 rounded-full bg-error flex-shrink-0" />
        <span className="text-on-background truncate flex-1">{item.title}</span>
        {item.dueDate && <span className="text-on-surface-variant/60">{item.dueDate}</span>}
      </div>
    );
  }
  if (candidateType === 'close_the_loops_batch') {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="material-symbols-outlined text-primary/60" style={{ fontSize: '12px' }}>
          {item.source_type === 'event' ? 'event' : 'task_alt'}
        </span>
        <span className="text-on-background truncate flex-1">{item.title || `${item.source_type} ${item.source_id}`}</span>
      </div>
    );
  }
  return null;
}
