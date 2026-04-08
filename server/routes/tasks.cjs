'use strict';

const express = require('express');

module.exports = function createTasksRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/tasks', authenticateToken, async (req, res) => {
    try {
      const tasks = await db.getTasksForUser(req.user.id, req.user.entityIds || []);
      return res.json(tasks);
    } catch (err) {
      console.error('[tasks] read failed:', err.message);
      return res.json([]);
    }
  });

  router.post('/api/tasks', authenticateToken, async (req, res) => {
    try {
      const tasks = req.body;
      if (!Array.isArray(tasks)) {
        return res.status(400).json({ error: 'Body must be an array of tasks' });
      }
      const results = await Promise.all(
        tasks.map((task) => db.upsertTask({ ...task, userId: req.user.id }))
      );
      return res.json({ success: true, count: results.length });
    } catch (err) {
      console.error('[tasks] write failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/tasks/:id', authenticateToken, async (req, res) => {
    try {
      const task = await db.getTaskById(req.params.id, req.user.id);
      if (!task) return res.status(404).json({ error: 'Task not found or access denied' });
      const updated = await db.updateTask(req.params.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      if (req.body.completionNote !== undefined) {
        try {
          await db.logMemory({
            userId: req.user.id, tool: 'update_task',
            content: `Added completion note to task: "${task.title}"`,
            metadata: { task_id: req.params.id, completion_note: true },
          });
        } catch (e) { console.error('[memory] log failed:', e.message); }
      }
      return res.json(updated);
    } catch (err) {
      console.error('[tasks] update failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.patch('/api/tasks/:id/completion-note', authenticateToken, async (req, res) => {
    try {
      const task = await db.getTaskById(req.params.id, req.user.id);
      if (!task) return res.status(404).json({ error: 'Task not found or access denied' });
      const updated = await db.updateTask(req.params.id, { completionNote: req.body.completion_note });
      if (!updated) return res.status(404).json({ error: 'Task not found' });
      try {
        await db.logMemory({
          userId: req.user.id, tool: 'update_task',
          content: `Added completion note to task: "${task.title}"`,
          metadata: { task_id: req.params.id, completion_note: true },
        });
      } catch (e) { console.error('[memory] log failed:', e.message); }
      return res.json(updated);
    } catch (err) {
      console.error('[tasks] completion-note update failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
