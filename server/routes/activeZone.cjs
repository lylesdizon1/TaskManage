'use strict';

/**
 * server/routes/activeZone.cjs — HTTP surface for Aria's orchestration zone.
 *
 * Routes:
 *   GET    /api/active-zone/tiles           → runs detector + composer,
 *                                             upserts, returns top-3 active
 *   POST   /api/active-zone/tiles/:id/resolve  → status='resolved' (primary fired)
 *   POST   /api/active-zone/tiles/:id/defer    → dismiss for 2h
 *   POST   /api/active-zone/tiles/:id/dismiss  → dismiss till tomorrow's local midnight
 *   POST   /api/active-zone/refresh          → force re-run (manual refresh button)
 *
 * All routes authenticated + tenant-scoped via req.user.id.
 * Tiles returned never include other tenants' data — getActiveZoneTiles
 * filters by user_id.
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');
const {
  loadUserStateForActiveZone,
  detectAllCandidates,
} = require('../lib/activeZone/candidateDetector.cjs');
const { composeTiles } = require('../lib/activeZone/tileComposer.cjs');
const { gateCandidates } = require('../lib/activeZone/deltaGate.cjs');
const { composeVoice } = require('../lib/activeZone/voice.cjs');

// Compute end of user's local day for the dismiss timeout. Returns an
// ISO-string timestamp corresponding to tomorrow 00:00 IN THE USER'S
// TIMEZONE, expressed as UTC.
//
// Prior version returned tomorrow-00:00-UTC, which for any tz west of
// UTC fell BEFORE user's local midnight. For Lyle in PT this meant
// dismissed_until landed at 5pm PT today — so a tile dismissed after
// 5pm PT immediately resurfaced. Bug FU2 root cause.
function _nextLocalMidnightIso(timezone) {
  const now = new Date();
  try {
    // Find the user's tz offset (minutes ahead of UTC) at THIS moment.
    const fmtParts = (tz) => new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (parts, type) => parseInt(parts.find((p) => p.type === type).value, 10);
    const userP = fmtParts(timezone);
    const utcP  = fmtParts('UTC');
    // Hour 24 means midnight; some locales emit 24 for the start-of-day moment.
    const fixHour = (h) => (h === 24 ? 0 : h);
    const userMs = Date.UTC(get(userP, 'year'), get(userP, 'month') - 1, get(userP, 'day'),
                            fixHour(get(userP, 'hour')), get(userP, 'minute'), get(userP, 'second'));
    const utcMs  = Date.UTC(get(utcP,  'year'), get(utcP,  'month') - 1, get(utcP,  'day'),
                            fixHour(get(utcP,  'hour')), get(utcP,  'minute'), get(utcP,  'second'));
    const offsetMin = (userMs - utcMs) / 60000; // user-local minus UTC

    // Tomorrow's user-local date.
    const userY = get(userP, 'year');
    const userM = get(userP, 'month');
    const userD = get(userP, 'day');
    // Construct "tomorrow 00:00 UTC of the user's date" then subtract the
    // user's offset to land on the actual user-local midnight as UTC.
    const tomorrowAsUtcMidnight = new Date(Date.UTC(userY, userM - 1, userD + 1, 0, 0, 0));
    return new Date(tomorrowAsUtcMidnight.getTime() - offsetMin * 60000).toISOString();
  } catch {
    return new Date(now.getTime() + 24 * 3600 * 1000).toISOString();
  }
}

module.exports = function createActiveZoneRouter({ authenticateToken, db }) {
  const router = express.Router();

  // Locks against concurrent detector runs for the same user, keyed in
  // process memory. Single-instance assumption (Railway) — in a
  // multi-instance setup swap for a Postgres advisory lock. Serializes
  // the GET /tiles path so 10 simultaneous tabs don't burn 10× the
  // Anthropic budget; subsequent callers await the in-flight run.
  const _inFlight = new Map();

  async function runDetectorAndCompose(userId) {
    if (_inFlight.has(userId)) return _inFlight.get(userId);
    const p = (async () => {
      // Step 0: re-pend any deferred/dismissed tiles whose resume time
      // has elapsed. Without this, an upsert preserves the prior
      // non-pending status forever and the tile never re-surfaces.
      try {
        const rependCount = await db.rependElapsedActiveZoneTiles(userId);
        if (rependCount) logger.info('activeZone.repend', { userId, count: rependCount });
      } catch (err) {
        logger.warn('activeZone.repend.failed', { userId, error: err.message });
      }

      const state = await loadUserStateForActiveZone(userId, db);
      const allCandidates = detectAllCandidates(state, { topN: 3 });

      // Filter out candidates the user has actively hidden (defer/dismiss
      // with future resume time). Saves the LLM cost of a tile we'd
      // never show, and avoids confusing the audit metrics.
      let hiddenKeys = new Set();
      try { hiddenKeys = await db.getHiddenActiveZoneCandidateKeys(userId); }
      catch (err) { logger.warn('activeZone.hiddenKeys.failed', { userId, error: err.message }); }
      const candidates = allCandidates.filter((c) => !hiddenKeys.has(c.candidate_key));

      // Delta-gate: surface DELTAS, not snapshots. Show each item once on
      // first appearance and again only when its state_signature ESCALATES
      // (deltaGate.cjs). Steady-state / de-escalations are suppressed so we
      // don't re-compose and re-surface unchanged tiles. Fail-OPEN: on any
      // gate/ledger error, surface everything (prior behaviour) rather than
      // hide real work. Ledger is written ONLY for what we actually surface.
      let surfacedCandidates = candidates;
      try {
        const gateItems = candidates.map((c) => ({ kind: c.candidate_type || c.type, itemKey: c.item_key }));
        const storedSigs = await db.getSurfacedSignatures(userId, gateItems);
        const { surfaced, decisions } = gateCandidates(candidates, storedSigs);
        surfacedCandidates = surfaced;
        if (surfaced.length) {
          await db.markSurfaced(userId, surfaced.map((c) => ({
            kind: c.candidate_type || c.type, itemKey: c.item_key, signature: c.state_signature,
          })));
        }
        logger.info('activeZone.deltaGate', {
          userId, detected: candidates.length, surfaced: surfaced.length,
          decisions: decisions.map((d) => `${d.kind}:${d.decision}`),
        });
      } catch (err) {
        logger.warn('activeZone.deltaGate.failed', { userId, error: err.message });
        surfacedCandidates = candidates; // fail-open
      }

      const user = state.userId ? await db.getUserById(userId).catch(() => null) : null;
      const firstName = (user?.displayName || user?.username || 'there').split(/[\s@]/)[0];
      const localTime = new Intl.DateTimeFormat('en-US', {
        timeZone: state.timezone || DEFAULT_TIMEZONE,
        hour: 'numeric', minute: '2-digit', hour12: true,
      }).format(state.now);

      const tiles = await composeTiles(surfacedCandidates, { userId, firstName, localTime });

      // Persist (upsert by candidate_key preserves deferred/dismissed).
      for (const t of tiles) {
        try {
          await db.upsertActiveZoneTile({
            id: t.tile_id,
            userId,
            candidateType: t.candidate_type,
            candidateKey: t.candidate_key,
            priorityScore: t.priority_score,
            urgency: t.urgency,
            headline: t.headline,
            body: t.body,
            primaryAction: t.primary_action,
            secondaryAction: t.secondary_action,
            itemsPreview: t.items_preview,
            composerSource: t.composer_source,
          });
        } catch (err) {
          logger.warn('activeZone.upsert.failed', { userId, candidate_type: t.candidate_type, error: err.message });
        }
      }

      // Resolve stale — candidate_keys that disappeared from this run.
      // CRITICAL: must include hidden candidate_keys in the active set,
      // otherwise resolveStale would mark currently-hidden tiles as
      // 'resolved' (terminal) and they'd never re-surface when their
      // dismissed_until / deferred_until elapsed.
      try {
        const allActiveKeys = [
          ...candidates.map((c) => c.candidate_key),
          ...allCandidates.filter((c) => hiddenKeys.has(c.candidate_key)).map((c) => c.candidate_key),
        ];
        await db.resolveStaleActiveZoneTiles(userId, allActiveKeys);
      } catch (err) {
        logger.warn('activeZone.resolveStale.failed', { userId, error: err.message });
      }

      return candidates.length;
    })().finally(() => {
      if (_inFlight.get(userId) === p) _inFlight.delete(userId);
    });
    _inFlight.set(userId, p);
    return p;
  }

  router.get('/api/active-zone/tiles', authenticateToken, async (req, res) => {
    try {
      await runDetectorAndCompose(req.user.id);
      const rows = await db.getActiveZoneTiles(req.user.id, 3);
      res.json({ tiles: rows });
    } catch (err) {
      logger.error('activeZone.tiles.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      // Never block the dashboard on zone failure — return empty and let
      // the frontend fall through to empty state.
      res.json({ tiles: [], error: 'detector_failed' });
    }
  });

  router.post('/api/active-zone/refresh', authenticateToken, async (req, res) => {
    try {
      const count = await runDetectorAndCompose(req.user.id);
      const rows = await db.getActiveZoneTiles(req.user.id, 3);
      res.json({ tiles: rows, candidatesDetected: count });
    } catch (err) {
      logger.error('activeZone.refresh.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/active-zone/tiles/:id/resolve', authenticateToken, async (req, res) => {
    try {
      const ok = await db.updateActiveZoneTileStatus(req.params.id, req.user.id, 'resolved');
      if (!ok) return res.status(404).json({ error: 'Tile not found' });
      res.json({ success: true });
    } catch (err) {
      logger.error('activeZone.resolve.failed', { requestId: req.requestId, userId: req.user?.id, tileId: req.params.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/active-zone/tiles/:id/defer', authenticateToken, async (req, res) => {
    try {
      const resumeAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
      const ok = await db.updateActiveZoneTileStatus(req.params.id, req.user.id, 'deferred', resumeAt);
      if (!ok) return res.status(404).json({ error: 'Tile not found' });
      res.json({ success: true, resumesAt: resumeAt });
    } catch (err) {
      logger.error('activeZone.defer.failed', { requestId: req.requestId, userId: req.user?.id, tileId: req.params.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/active-zone/voice — empty-state line.
   * Pulls a small slice of recent context (last 3 completed tasks, today's
   * wrapped meetings) and asks Haiku for a 1-2 sentence Aria voice line.
   * Cached 30 min per user; falls back to a static line on LLM failure.
   * Frontend should only call this when the orchestrator returns 0 tiles.
   */
  router.get('/api/active-zone/voice', authenticateToken, async (req, res) => {
    try {
      const user = await db.getUserById(req.user.id).catch(() => null);
      const firstName = (user?.displayName || user?.username || 'there').split(/[\s@]/)[0];
      const timezone = user?.timezone || DEFAULT_TIMEZONE;

      const [recentTasks, events] = await Promise.all([
        db.getTasksForUser(req.user.id, user?.entityIds || []).catch(() => []),
        db.getCalendarEventsForUser(
          req.user.id,
          new Date(Date.now() - 8 * 3600 * 1000).toISOString(),
          new Date().toISOString(),
        ).catch(() => []),
      ]);

      const recentCompletions = (recentTasks || [])
        .filter((t) => t.completed && t.completedAt)
        .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
        .slice(0, 3);
      const wrappedMeetings = (events || [])
        .filter((e) => {
          const end = Date.parse(e.endTime || e.end_time || e.end || '');
          return Number.isFinite(end) && end < Date.now();
        })
        .slice(0, 3);

      const { line, source } = await composeVoice({
        userId: req.user.id, firstName, timezone, recentCompletions, wrappedMeetings,
      });
      res.json({ line, source });
    } catch (err) {
      logger.warn('activeZone.voice.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.json({ line: "You're all clear. Nice work.", source: 'fallback' });
    }
  });

  router.post('/api/active-zone/tiles/:id/dismiss', authenticateToken, async (req, res) => {
    try {
      const tz = req.user.timezone || DEFAULT_TIMEZONE;
      const resumeAt = _nextLocalMidnightIso(tz);
      const ok = await db.updateActiveZoneTileStatus(req.params.id, req.user.id, 'dismissed', resumeAt);
      if (!ok) return res.status(404).json({ error: 'Tile not found' });
      res.json({ success: true, resumesAt: resumeAt });
    } catch (err) {
      logger.error('activeZone.dismiss.failed', { requestId: req.requestId, userId: req.user?.id, tileId: req.params.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
