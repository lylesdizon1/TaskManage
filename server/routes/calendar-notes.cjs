'use strict';

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { writeAudit } = require('../../guardrails/audit.cjs');

module.exports = function createCalendarNotesRouter({ authenticateToken, db }) {
  const router = express.Router();

  /**
   * GET /api/calendar-notes?eventId=:id
   * Returns the note for a specific event, scoped to req.user.id.
   */
  router.get('/api/calendar-notes', authenticateToken, logger.tool('getCalendarNote'), async (req, res) => {
    try {
      const { eventId } = req.query;
      if (!eventId) return res.status(400).json({ error: 'eventId query param required' });
      const note = await db.getCalendarNote(req.user.id, eventId);
      return res.json(note || { preNote: null, postNote: null });
    } catch (err) {
      logger.error('calendarNotes.get.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * PATCH /api/calendar-notes/:eventId
   * Upsert a calendar note for the given event.
   * Body: { pre_note?, post_note?, event_title?, event_start?, event_end?, source_account? }
   */
  router.patch('/api/calendar-notes/:eventId', authenticateToken, logger.tool('upsertCalendarNote'), async (req, res) => {
    try {
      const eventId = req.params.eventId;
      const userId = req.user.id;
      const { pre_note, post_note, event_title, event_start, event_end, source_account } = req.body;

      // Snapshot before for audit
      const before = await db.getCalendarNote(userId, eventId);

      const result = await db.upsertCalendarNote(userId, eventId, {
        eventTitle: event_title,
        eventStart: event_start,
        eventEnd: event_end,
        sourceAccount: source_account,
        preNote: pre_note,
        postNote: post_note,
      });

      try { await writeAudit({ userId, entityType: 'calendar_note', entityId: eventId, action: before ? 'updated' : 'created', before, after: result, requestId: req.requestId }); } catch {}

      // Log to agent memory (best-effort)
      try {
        await db.logMemory({
          userId,
          tool: 'calendar_note',
          content: `${pre_note !== undefined ? 'Updated agenda' : 'Updated outcome'} note for event: "${event_title || result.eventTitle || eventId}"`,
          metadata: { eventId, event_title: event_title || result.eventTitle, had_pre_note: !!result.preNote, had_post_note: !!result.postNote },
        });
      } catch (e) { logger.error('memory.calendarNote.failed', { requestId: req.requestId, userId, error: e.message }); }

      return res.json(result);
    } catch (err) {
      logger.error('calendarNotes.upsert.failed', { requestId: req.requestId, userId: req.user?.id, eventId: req.params.eventId, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/calendar-notes/post
   * Narrow endpoint for the active-zone meeting-notes flow: saves
   * post_note for a completed event. Body: { eventId, eventTitle,
   * eventStart, eventEnd, accountEmail, postNote }.
   */
  router.post('/api/calendar-notes/post', authenticateToken, logger.tool('postCalendarNote'), async (req, res) => {
    try {
      const userId = req.user.id;
      const { eventId, eventTitle, eventStart, eventEnd, accountEmail, postNote } = req.body || {};
      if (!eventId)           return res.status(400).json({ error: 'eventId required' });
      if (!postNote || !String(postNote).trim()) return res.status(400).json({ error: 'postNote required' });

      const note = await db.upsertCalendarNotePost(
        userId, eventId, eventTitle || null, eventStart || null,
        eventEnd || null, accountEmail || null, String(postNote),
      );

      try { await writeAudit({ userId, entityType: 'calendar_note', entityId: eventId, action: 'updated', before: null, after: note, requestId: req.requestId }); } catch {}

      try {
        await db.logMemory({
          userId, tool: 'calendar_note',
          content: `Captured outcome note for event: "${eventTitle || eventId}"`,
          metadata: { eventId, event_title: eventTitle, via: 'active_zone' },
        });
      } catch (e) { logger.error('memory.calendarNote.failed', { requestId: req.requestId, userId, error: e.message }); }

      return res.json({ success: true, note });
    } catch (err) {
      logger.error('calendarNotes.post.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/calendar-notes/history
   * Returns past events with notes for the user.
   * Query: search, dateRange (today/week/month/3months/all), limit
   */
  router.get('/api/calendar-notes/history', authenticateToken, logger.tool('getCalendarNoteHistory'), async (req, res) => {
    try {
      const { search, dateRange, limit } = req.query;
      const notes = await db.getCalendarNotesHistory(req.user.id, { search, dateRange, limit });
      return res.json(notes);
    } catch (err) {
      logger.error('calendarNotes.history.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  return router;
};
