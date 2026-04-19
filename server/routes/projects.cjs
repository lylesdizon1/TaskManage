'use strict';

/**
 * server/routes/projects.cjs — Entity Workspace Projects V1.
 *
 * Lightweight collaborative project management inside entities.
 * All routes enforce membership via canAccessEntity which delegates
 * to the canonical getEntitiesForUserWithMembership query — no
 * role-based SQL branching anywhere.
 *
 * V1 permission rule: any entity member can create/edit/complete/delete
 * any project content within that entity. No per-project roles.
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { emitCloseLoop } = require('../lib/closeLoopEmitter.cjs');

module.exports = function createProjectsRouter({ authenticateToken, db }) {
  const router = express.Router();

  /**
   * Membership gate. Returns true iff the user can see the entity via the
   * canonical access query (creator + entity_members + org-visibility).
   */
  async function canAccessEntity(userId, entityId, orgId) {
    if (!entityId) return false;
    try {
      const visible = await db.getEntitiesForUserWithMembership(userId, orgId || null);
      return visible.some((e) => e.id === entityId);
    } catch { return false; }
  }

  // ── Projects ──────────────────────────────────────────────────────────

  router.get('/api/projects', authenticateToken, async (req, res) => {
    try {
      const entityId = req.query.entity_id;
      if (!entityId) return res.status(400).json({ error: 'entity_id required' });
      if (!(await canAccessEntity(req.user.id, entityId, req.user.orgId))) {
        return res.status(404).json({ error: 'Entity not found' });
      }
      const projects = await db.listProjectsForEntity(entityId);
      return res.json({ projects });
    } catch (err) {
      logger.error('projects.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/projects', authenticateToken, async (req, res) => {
    try {
      const { entity_id: entityId, title, description } = req.body || {};
      if (!entityId || !title) return res.status(400).json({ error: 'entity_id and title required' });
      if (!(await canAccessEntity(req.user.id, entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const project = await db.createProject({ entityId, title, description, createdBy: req.user.id });
      return res.json({ project });
    } catch (err) {
      logger.error('projects.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/projects/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getProjectById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Project not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const { title, description, status } = req.body || {};
      const project = await db.updateProject(req.params.id, { title, description, status });
      return res.json({ project });
    } catch (err) {
      logger.error('projects.update.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/projects/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getProjectById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Project not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      await db.deleteProject(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('projects.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Tasks ─────────────────────────────────────────────────────────────

  router.get('/api/projects/:projectId/tasks', authenticateToken, async (req, res) => {
    try {
      const project = await db.getProjectById(req.params.projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!(await canAccessEntity(req.user.id, project.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const tasks = await db.listTasksForProject(req.params.projectId);
      return res.json({ tasks });
    } catch (err) {
      logger.error('projects.tasks.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/project-tasks', authenticateToken, async (req, res) => {
    try {
      const { project_id: projectId, entity_id: entityId, title, description } = req.body || {};
      if (!projectId || !entityId || !title) return res.status(400).json({ error: 'project_id, entity_id, title required' });
      if (!(await canAccessEntity(req.user.id, entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      // Verify the project belongs to the claimed entity (prevents cross-entity injection).
      const project = await db.getProjectById(projectId);
      if (!project || project.entityId !== entityId) return res.status(400).json({ error: 'project/entity mismatch' });
      const task = await db.createProjectTask({ projectId, entityId, title, description, createdBy: req.user.id });
      return res.json({ task });
    } catch (err) {
      logger.error('projects.tasks.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/project-tasks/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getProjectTaskById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const { title, description, status } = req.body || {};
      const task = await db.updateProjectTask(req.params.id, { title, description, status });
      return res.json({ task });
    } catch (err) {
      logger.error('projects.tasks.update.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/project-tasks/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getProjectTaskById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      await db.deleteProjectTask(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('projects.tasks.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/project-tasks/:id/complete', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getProjectTaskById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const openCount = await db.countOpenChecklistForTask(req.params.id);
      const task = await db.completeProjectTask(req.params.id);
      const out = { success: true, task };
      if (openCount > 0) out.warning = `${openCount} checklist item${openCount === 1 ? '' : 's'} still incomplete`;
      // Ambient close-loop: emit unconditionally on project-task close.
      // Project tasks don't currently carry a completion-note equivalent,
      // so there's nothing to short-circuit against like tasks.cjs does.
      emitCloseLoop(req.user.id, 'project_task', task.id, task.title || existing.title)
        .catch((err) => logger.warn('projects.closeLoop.failed', { userId: req.user?.id, taskId: task.id, error: err.message }));
      return res.json(out);
    } catch (err) {
      logger.error('projects.tasks.complete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Checklist items ──────────────────────────────────────────────────

  router.get('/api/task-checklist-items', authenticateToken, async (req, res) => {
    try {
      const taskId = req.query.task_id;
      if (!taskId) return res.status(400).json({ error: 'task_id required' });
      const task = await db.getProjectTaskById(taskId);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      if (!(await canAccessEntity(req.user.id, task.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const items = await db.listChecklistForTask(taskId);
      return res.json({ items });
    } catch (err) {
      logger.error('projects.checklist.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/task-checklist-items', authenticateToken, async (req, res) => {
    try {
      const { task_id: taskId, entity_id: entityId, text } = req.body || {};
      if (!taskId || !entityId || !text) return res.status(400).json({ error: 'task_id, entity_id, text required' });
      if (!(await canAccessEntity(req.user.id, entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const task = await db.getProjectTaskById(taskId);
      if (!task || task.entityId !== entityId) return res.status(400).json({ error: 'task/entity mismatch' });
      const item = await db.createChecklistItem({ taskId, entityId, text, createdBy: req.user.id });
      return res.json({ item });
    } catch (err) {
      logger.error('projects.checklist.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/task-checklist-items/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getChecklistItemById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Item not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const { text } = req.body || {};
      const item = await db.updateChecklistItem(req.params.id, { text });
      return res.json({ item });
    } catch (err) {
      logger.error('projects.checklist.update.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/task-checklist-items/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getChecklistItemById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Item not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      await db.deleteChecklistItem(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('projects.checklist.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/task-checklist-items/:id/toggle', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getChecklistItemById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Item not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const item = await db.toggleChecklistItem(req.params.id);
      return res.json({ item });
    } catch (err) {
      logger.error('projects.checklist.toggle.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Notes ─────────────────────────────────────────────────────────────

  router.get('/api/project-notes', authenticateToken, async (req, res) => {
    try {
      const { project_id: projectId, task_id: taskId } = req.query;
      if (!projectId && !taskId) return res.status(400).json({ error: 'project_id or task_id required' });
      // Resolve entity_id from the parent and gate.
      let entityId = null;
      if (projectId) {
        const p = await db.getProjectById(projectId);
        if (!p) return res.status(404).json({ error: 'Project not found' });
        entityId = p.entityId;
      } else {
        const t = await db.getProjectTaskById(taskId);
        if (!t) return res.status(404).json({ error: 'Task not found' });
        entityId = t.entityId;
      }
      if (!(await canAccessEntity(req.user.id, entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const notes = projectId ? await db.listNotesForProject(projectId) : await db.listNotesForTask(taskId);
      return res.json({ notes });
    } catch (err) {
      logger.error('projects.notes.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/project-notes', authenticateToken, async (req, res) => {
    try {
      const { project_id: projectId, task_id: taskId, entity_id: entityId, body } = req.body || {};
      if (!entityId || !body) return res.status(400).json({ error: 'entity_id and body required' });
      if (!projectId && !taskId) return res.status(400).json({ error: 'project_id or task_id required' });
      if (!(await canAccessEntity(req.user.id, entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      // Verify parent belongs to entity.
      if (projectId) {
        const p = await db.getProjectById(projectId);
        if (!p || p.entityId !== entityId) return res.status(400).json({ error: 'project/entity mismatch' });
      }
      if (taskId) {
        const t = await db.getProjectTaskById(taskId);
        if (!t || t.entityId !== entityId) return res.status(400).json({ error: 'task/entity mismatch' });
      }
      const note = await db.createProjectNote({ projectId, taskId, entityId, body, createdBy: req.user.id });
      return res.json({ note });
    } catch (err) {
      logger.error('projects.notes.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/api/project-notes/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getProjectNoteById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Note not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      const { body } = req.body || {};
      if (!body) return res.status(400).json({ error: 'body required' });
      const note = await db.updateProjectNote(req.params.id, body);
      return res.json({ note });
    } catch (err) {
      logger.error('projects.notes.update.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/project-notes/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getProjectNoteById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Note not found' });
      if (!(await canAccessEntity(req.user.id, existing.entityId, req.user.orgId))) {
        return res.status(403).json({ error: 'Not a member of this entity' });
      }
      await db.deleteProjectNote(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('projects.notes.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
