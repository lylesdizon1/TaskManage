'use strict';

/**
 * server/routes/journal.cjs — Daily Wrap + reflective journal V1.
 *
 * One entry per user per local day (UNIQUE(user_id, entry_date)) backed
 * by db.upsertJournalEntry. Partial writes merge in — posting only
 * `wins` later does not wipe a previously-saved `frustrations`. Setting
 * completed=true stamps completed_at, which is the canonical "already
 * wrapped today" signal for both the cron push and the web login trigger.
 *
 * V1 per-field cap: 10_000 chars. No enrichment in V1 (decision 1).
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { enrichJournalEntry } = require('../lib/journalEnrichment.cjs');

const FIELD_MAX = 10_000;

function todayLocalDateStr(tz) {
  const zone = tz || 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function clampField(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s.length > FIELD_MAX ? s.slice(0, FIELD_MAX) : s;
}

module.exports = function createJournalRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/journal-entries', authenticateToken, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const sinceDate = typeof req.query.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.since)
        ? req.query.since
        : null;
      const entries = await db.listJournalEntries(req.user.id, { limit, offset, sinceDate });
      res.json({ entries });
    } catch (err) {
      logger.error('journal.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/journal-entries/today', authenticateToken, async (req, res) => {
    try {
      const entryDate = todayLocalDateStr(req.user.timezone);
      const entry = await db.getJournalEntryByDate(req.user.id, entryDate);
      res.json({ entry, entry_date: entryDate });
    } catch (err) {
      logger.error('journal.today.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/journal-entries', authenticateToken, async (req, res) => {
    try {
      const entryDate = todayLocalDateStr(req.user.timezone);
      const body = req.body || {};
      const patch = {};
      const wins = clampField(body.wins);
      const frustrations = clampField(body.frustrations);
      const tomorrowFocus = clampField(body.tomorrow_focus);
      const rawFreeform = clampField(body.raw_freeform);
      if (wins !== undefined) patch.wins = wins;
      if (frustrations !== undefined) patch.frustrations = frustrations;
      if (tomorrowFocus !== undefined) patch.tomorrowFocus = tomorrowFocus;
      if (rawFreeform !== undefined) patch.rawFreeform = rawFreeform;
      if (body.completed === true) patch.completed = true;

      const entry = await db.upsertJournalEntry(req.user.id, entryDate, patch);
      // Fire-and-forget enrichment on wrap finalization. Gated inside
      // enrichJournalEntry by content length + structured-field presence,
      // so noisy partial saves never burn Haiku cost.
      if (patch.completed === true && entry?.id) {
        enrichJournalEntry(req.user.id, entry)
          .catch((err) => console.error('[journal] enrich failed:', err.message));
      }
      res.json({ entry });
    } catch (err) {
      logger.error('journal.upsert.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/journal-entries/:id', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
      // Owner-scoped delete. Stolen id from another user → rowCount 0 → 404,
      // never leaks existence of the row.
      const r = await db.pool.query(
        `DELETE FROM journal_entries WHERE id = $1 AND user_id = $2`,
        [id, req.user.id],
      );
      if (r.rowCount === 0) return res.status(404).json({ error: 'Entry not found' });
      res.json({ success: true });
    } catch (err) {
      logger.error('journal.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
