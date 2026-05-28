'use strict';

/**
 * server/routes/food.cjs — Food log API.
 *
 * 6 endpoints per spec:
 *   POST   /api/food/log                      — estimate + persist (chat path)
 *   GET    /api/food/day/:date                — entries for a local date
 *   GET    /api/food/history?limit=30         — daily rollups
 *   DELETE /api/food/entry/:id                — owner-only
 *   POST   /api/food/entry/:id/photo          — attach an image_blob
 *   GET    /api/food/insights?days=14         — Aria nutrition summary
 *
 * Authorization model:
 *   - Mutations call requireOwnership() on the fetched record (architectural
 *     rule: auth in middleware, never in SQL helpers).
 *   - List/read routes scope by req.user.id directly.
 *
 * Date handling:
 *   - local_date computed via getTodayLocal(tz) — NEVER toISOString().
 *   - User can override local_date on POST /log (e.g., back-dated entry)
 *     but the format is validated as YYYY-MM-DD.
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { getTodayLocal } = require('../utils/date.cjs');
const { estimateNutrition, generateInsights } = require('../lib/foodLogTools.cjs');
const { userRateLimit } = require('../middleware/userRateLimit.cjs');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Per-user rate limits on the two LLM-touching food routes. Sized to
// human-realistic usage: 30 logs/hour covers even snack-heavy days
// without throttling; 10 insights/hour stops "Find my trends" button-
// mash spirals (each click = one Haiku call).
const logLimit = userRateLimit({ key: 'food-log', limit: 30, windowSec: 3600 });
const insightsLimit = userRateLimit({ key: 'food-insights', limit: 10, windowSec: 3600 });

function pickLocalDate(req) {
  const requested = req.body?.local_date || req.body?.localDate;
  if (typeof requested === 'string' && ISO_DATE_RE.test(requested)) return requested;
  // getTodayLocal returns 'Tue, May 28' style — we need YYYY-MM-DD. Use
  // Intl directly with the user's timezone for the canonical date key.
  const tz = req.user?.timezone || 'America/Los_Angeles';
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(new Date()); // en-CA → YYYY-MM-DD
}

module.exports = function createFoodRouter({ authenticateToken, requireOwnership, db }) {
  const router = express.Router();

  // ── POST /api/food/log — chat-driven logging ─────────────────────────
  router.post('/api/food/log', authenticateToken, logLimit, async (req, res) => {
    try {
      const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
      if (!description) return res.status(400).json({ error: 'description is required' });

      const localDate = pickLocalDate(req);
      let estimate;
      try {
        estimate = await estimateNutrition(description, { userId: req.user.id });
      } catch (err) {
        logger.error('food.log.estimateFailed', { requestId: req.requestId, userId: req.user.id, error: err.message });
        return res.status(502).json({ error: 'estimate_failed', detail: err.message });
      }

      const entry = await db.createFoodLogEntry(req.user.id, {
        localDate,
        source: req.body?.source === 'manual' ? 'manual' : 'chat',
        description,
        note: estimate.note || null,
        items: estimate.items,
        sourceMsgId: req.body?.source_msg_id || null,
      });
      return res.json(entry);
    } catch (err) {
      logger.error('food.log.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/food/day/:date ──────────────────────────────────────────
  router.get('/api/food/day/:date', authenticateToken, async (req, res) => {
    try {
      const date = req.params.date;
      if (!ISO_DATE_RE.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      const entries = await db.getFoodLogEntriesForDay(req.user.id, date);
      // Compute day totals from entries so the client never has to add up
      // (and so totals reflect any mid-day deletes).
      const totals = entries.reduce((acc, e) => {
        for (const k of Object.keys(e.totals || {})) {
          acc[k] = (acc[k] || 0) + (Number(e.totals[k]) || 0);
        }
        return acc;
      }, {});
      return res.json({ date, entries, totals });
    } catch (err) {
      logger.error('food.day.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/food/history ────────────────────────────────────────────
  router.get('/api/food/history', authenticateToken, async (req, res) => {
    try {
      const limit = Math.min(180, Math.max(1, parseInt(req.query.limit, 10) || 30));
      const rows = await db.getFoodLogHistory(req.user.id, limit);
      return res.json(rows);
    } catch (err) {
      logger.error('food.history.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  // ── PATCH /api/food/entry/:id — edit description/note/date ──────────
  // Editable fields: description (re-runs nutrition estimate to refresh
  // items + totals), note (text only), local_date (move to a different
  // day). Owner-only via requireOwnership on the fetched record.
  //
  // Re-estimate trigger: provided description differs from stored. If the
  // caller wants to skip re-estimation (rare — e.g. just fixing a typo
  // without macro changes), pass `?skipReestimate=1`.
  router.patch('/api/food/entry/:id', authenticateToken, logLimit, async (req, res) => {
    try {
      const entry = await db.getFoodLogEntryById(req.params.id);
      if (!entry) return res.status(404).json({ error: 'entry not found' });
      if (!requireOwnership(entry, req)) return res.status(403).json({ error: 'forbidden' });

      const patch = {};
      if (typeof req.body?.description === 'string') {
        const desc = req.body.description.trim();
        if (!desc) return res.status(400).json({ error: 'description cannot be empty' });
        patch.description = desc;
      }
      if (req.body?.note !== undefined) {
        patch.note = req.body.note ? String(req.body.note).slice(0, 500) : null;
      }
      if (typeof req.body?.local_date === 'string' || typeof req.body?.localDate === 'string') {
        const d = req.body.local_date || req.body.localDate;
        if (!ISO_DATE_RE.test(d)) return res.status(400).json({ error: 'local_date must be YYYY-MM-DD' });
        patch.localDate = d;
      }

      // Re-estimate macros when description changed and skipReestimate
      // wasn't set. Items the user might have wanted (none in V1 spec)
      // would be passed explicitly; for now items only ever come from
      // the estimator.
      const skipReestimate = req.query?.skipReestimate === '1' || req.query?.skipReestimate === 'true';
      if (patch.description && patch.description !== entry.description && !skipReestimate) {
        try {
          const est = await estimateNutrition(patch.description, { userId: req.user.id });
          patch.items = est.items;
          // If the estimator produced a note and the caller didn't
          // override one, surface the new note. Otherwise preserve the
          // user's note.
          if (patch.note === undefined) patch.note = est.note || entry.note;
        } catch (err) {
          logger.error('food.entry.reestimateFailed', { requestId: req.requestId, userId: req.user.id, error: err.message });
          return res.status(502).json({ error: 'estimate_failed', detail: err.message });
        }
      }

      const updated = await db.updateFoodLogEntry(req.params.id, patch);
      return res.json(updated);
    } catch (err) {
      logger.error('food.entry.updateFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── DELETE /api/food/entry/:id ───────────────────────────────────────
  router.delete('/api/food/entry/:id', authenticateToken, async (req, res) => {
    try {
      const entry = await db.getFoodLogEntryById(req.params.id);
      if (!entry) return res.status(404).json({ error: 'entry not found' });
      if (!requireOwnership(entry, req)) return res.status(403).json({ error: 'forbidden' });
      await db.deleteFoodLogEntryById(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('food.entry.deleteFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/food/entry/:id/photo ───────────────────────────────────
  // Accepts an existing image_blob_id (per Commit A — image_blobs is the
  // canonical storage). The spec called for multipart-to-object-storage;
  // we deviate to image_blobs for consistency with the rest of the OCR
  // pipeline. Clients that want to attach a photo should first POST to
  // /api/image-blobs to land the bytes, then call this with the returned id.
  router.post('/api/food/entry/:id/photo', authenticateToken, async (req, res) => {
    try {
      const entry = await db.getFoodLogEntryById(req.params.id);
      if (!entry) return res.status(404).json({ error: 'entry not found' });
      if (!requireOwnership(entry, req)) return res.status(403).json({ error: 'forbidden' });

      const imageBlobId = req.body?.image_blob_id || req.body?.imageBlobId;
      if (!imageBlobId) return res.status(400).json({ error: 'image_blob_id required' });

      const photo = await db.addFoodLogPhoto({
        entryId: req.params.id,
        imageBlobId,
        ocrPayload: req.body?.ocr_payload || req.body?.ocrPayload || null,
      });
      return res.json(photo);
    } catch (err) {
      logger.error('food.photo.attachFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/food/insights ───────────────────────────────────────────
  router.get('/api/food/insights', authenticateToken, insightsLimit, async (req, res) => {
    try {
      const days = Math.min(60, Math.max(3, parseInt(req.query.days, 10) || 14));
      const rollup = await db.getFoodInsightsContext(req.user.id, days);
      if (rollup.length === 0) {
        return res.json({ text: 'No food log entries yet. Log a few meals and Aria will surface trends.' });
      }

      // Optional user goal — Dizon doesn't have a structured nutrition
      // profile yet, so V1 passes 'none'. Hook is here for when a profile
      // schema lands.
      const payload = {
        goal: 'none',
        days: rollup.map((r) => ({
          date: r.local_date,
          ...r.totals,
          meals: r.meals || [],
        })),
        userId: req.user.id,
      };
      try {
        const text = await generateInsights(payload);
        return res.json({ text });
      } catch (err) {
        logger.error('food.insights.generateFailed', { requestId: req.requestId, userId: req.user.id, error: err.message });
        return res.status(502).json({ error: 'insights_failed' });
      }
    } catch (err) {
      logger.error('food.insights.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
