'use strict';

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { writeAudit } = require('../../guardrails/audit.cjs');
const { emitCloseLoop } = require('../lib/closeLoopEmitter.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');

module.exports = function createTasksRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/tasks', authenticateToken, logger.tool('getTasks'), async (req, res) => {
    try {
      const { completed, entity, dateRange, search, limit } = req.query;

      // Default path: return all tasks (existing behavior)
      if (completed === undefined && !entity && !dateRange && !search) {
        const tasks = await db.getTasksForUser(req.user.id, req.user.entityIds || []);
        return res.json(tasks);
      }

      // Filtered path: build dynamic query
      const conditions = ['owner = $1'];
      const params = [req.user.id];
      let paramIdx = 2;

      if (completed === 'true') {
        conditions.push('completed = true');
      } else if (completed === 'false') {
        conditions.push('completed = false');
      }

      if (entity) {
        conditions.push(`tags @> $${paramIdx}::jsonb`);
        params.push(JSON.stringify([entity]));
        paramIdx++;
      }

      if (dateRange && dateRange !== 'all') {
        const tz = req.user.timezone || DEFAULT_TIMEZONE;
        if (dateRange === 'today') {
          conditions.push(`completed_at >= (NOW() AT TIME ZONE $${paramIdx})::date`);
          params.push(tz);
          paramIdx++;
        } else if (dateRange === 'week') {
          conditions.push(`completed_at >= (NOW() AT TIME ZONE $${paramIdx})::date - INTERVAL '7 days'`);
          params.push(tz);
          paramIdx++;
        } else if (dateRange === 'month') {
          conditions.push(`completed_at >= (NOW() AT TIME ZONE $${paramIdx})::date - INTERVAL '30 days'`);
          params.push(tz);
          paramIdx++;
        }
      }

      if (search) {
        conditions.push(`(title ILIKE $${paramIdx} OR description ILIKE $${paramIdx} OR completion_note ILIKE $${paramIdx})`);
        params.push(`%${search}%`);
        paramIdx++;
      }

      const maxRows = Math.min(parseInt(limit, 10) || 100, 500);
      params.push(maxRows);
      const limitIdx = paramIdx++;

      const sql = `SELECT id, title, description, priority, status, due_date AS "dueDate",
              due_time AS "dueTime", tags, visibility, completed, completed_at AS "completedAt", owner, created_by AS "createdBy",
              google_event_id AS "googleEventId", completion_note AS "completionNote", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM tasks
       WHERE ${conditions.join(' AND ')}
       ORDER BY completed_at DESC NULLS LAST, created_at DESC
       LIMIT $${limitIdx}`;

      const { rows } = await db.pool.query(sql, params);
      return res.json(rows);
    } catch (err) {
      logger.error('tasks.read.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  router.post('/api/tasks', authenticateToken, logger.tool('createTask'), async (req, res) => {
    try {
      const tasks = req.body;
      if (!Array.isArray(tasks)) {
        return res.status(400).json({ error: 'Body must be an array of tasks' });
      }
      const results = await Promise.all(
        tasks.map((task) => db.upsertTask({ ...task, userId: req.user.id }))
      );
      for (const row of results) {
        try { await writeAudit({ userId: req.user.id, entityType: 'task', entityId: row.id, action: 'created', after: row, requestId: req.requestId }); } catch {}
      }
      return res.json({ success: true, count: results.length });
    } catch (err) {
      logger.error('tasks.write.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/tasks/:id', authenticateToken, logger.tool('updateTask'), async (req, res) => {
    try {
      const task = await db.getTaskById(req.params.id, req.user.id);
      if (!task) return res.status(404).json({ error: 'Task not found or access denied' });
      const updated = await db.updateTask(req.params.id, req.user.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      try { await writeAudit({ userId: req.user.id, entityType: 'task', entityId: req.params.id, action: 'updated', before: task, after: updated, requestId: req.requestId }); } catch {}
      if (req.body.completionNote !== undefined) {
        try {
          await db.logMemory({
            userId: req.user.id, tool: 'update_task',
            content: `Added completion note to task: "${task.title}"`,
            metadata: { task_id: req.params.id, completion_note: true },
          });
        } catch (e) { logger.error('memory.log.failed', { requestId: req.requestId, userId: req.user?.id, error: e.message }); }
      }
      // Ambient close-loop: when a task flips completed=true AND no note
      // was attached, surface a "any color on <task>?" tile on next
      // fetchBriefContext. Skip if the user already included a note.
      const justCompleted = req.body.completed === true && !task.completed;
      const hasNote = !!(req.body.completionNote && String(req.body.completionNote).trim());
      if (justCompleted && !hasNote) {
        emitCloseLoop(req.user.id, 'task', req.params.id, updated.title || task.title)
          .catch((err) => console.error('[closeLoop] task hook failed:', err.message));
      }
      return res.json(updated);
    } catch (err) {
      logger.error('tasks.update.failed', { requestId: req.requestId, userId: req.user?.id, taskId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/tasks/:id', authenticateToken, logger.tool('deleteTask'), async (req, res) => {
    try {
      const task = await db.getTaskById(req.params.id, req.user.id);
      if (!task) return res.status(404).json({ error: 'Task not found or access denied' });
      await db.pool.query(
        `DELETE FROM tasks WHERE id = $1 AND owner = $2`,
        [req.params.id, req.user.id],
      );
      try { await writeAudit({ userId: req.user.id, entityType: 'task', entityId: req.params.id, action: 'deleted', before: task, requestId: req.requestId }); } catch {}
      return res.json({ success: true });
    } catch (err) {
      logger.error('tasks.delete.failed', { requestId: req.requestId, userId: req.user?.id, taskId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/tasks/:id/completion-note', authenticateToken, logger.tool('updateCompletionNote'), async (req, res) => {
    try {
      const task = await db.getTaskById(req.params.id, req.user.id);
      if (!task) return res.status(404).json({ error: 'Task not found or access denied' });
      const updated = await db.updateTask(req.params.id, req.user.id, { completionNote: req.body.completion_note });
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      try { await writeAudit({ userId: req.user.id, entityType: 'task', entityId: req.params.id, action: 'updated', before: task, after: updated, requestId: req.requestId }); } catch {}
      try {
        await db.logMemory({
          userId: req.user.id, tool: 'update_task',
          content: `Added completion note to task: "${task.title}"`,
          metadata: { task_id: req.params.id, completion_note: true },
        });
      } catch (e) { logger.error('memory.log.failed', { requestId: req.requestId, userId: req.user?.id, error: e.message }); }
      return res.json(updated);
    } catch (err) {
      logger.error('tasks.completionNote.failed', { requestId: req.requestId, userId: req.user?.id, taskId: req.params.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
