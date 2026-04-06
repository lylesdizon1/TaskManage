// NOTE: When Phase 1 backend extraction runs, proxy-server.cjs moves into server/ — update require path to ./tools.cjs at that point.

'use strict';

const ARIA_TOOLS = [
  {
    name: 'create_task',
    description: 'Create a new task. Use when the user wants to add a todo, reminder, or action item. Title is the only required field — create immediately with defaults for everything else. Do not ask for missing fields before creating.',
    input_schema: {
      type: 'object',
      properties: {
        title:    { type: 'string', description: 'Task title' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority. Default: medium.' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD. Optional.' },
        due_time: { type: 'string', description: 'Due time HH:MM 24hr. Optional.' },
        notes:    { type: 'string', description: 'Additional description. Optional.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark an existing task as complete.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to complete.' },
        title:   { type: 'string', description: 'Title of the task — used to find it if ID is unknown.' },
      },
      required: [],
    },
  },
  {
    name: 'update_task',
    description: 'Update fields on an existing task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id:  { type: 'string', description: 'Task ID to update.' },
        title:    { type: 'string', description: 'New title. Optional.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'New priority. Optional.' },
        due_date: { type: 'string', description: 'New due date YYYY-MM-DD. Optional.' },
        due_time: { type: 'string', description: 'New due time HH:MM. Optional.' },
        notes:    { type: 'string', description: 'New description. Optional.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'create_note',
    description: 'Create a new note. Use for braindumps, information to save, or anything the user wants to jot down.',
    input_schema: {
      type: 'object',
      properties: {
        title:   { type: 'string', description: 'Note title.' },
        content: { type: 'string', description: 'Note body.' },
        pillar:  { type: 'string', enum: ['hustle', 'home', 'grow', 'move'], description: 'Life pillar. Optional.' },
      },
      required: ['title', 'content'],
    },
  },
];

async function executeTool(toolName, toolInput, userId, entityIds, db) {
  try {
    switch (toolName) {
      case 'create_task': {
        const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await db.upsertTask({
          id,
          title: toolInput.title,
          description: toolInput.notes || '',
          priority: toolInput.priority || 'medium',
          dueDate: toolInput.due_date || '',
          dueTime: toolInput.due_time || null,
          tags: [],
          visibility: 'private',
          completed: false,
          owner: userId,
          createdBy: userId,
        });
        return { success: true, task_id: id, title: toolInput.title };
      }

      case 'complete_task': {
        const tasks = await db.getTasksForUser(userId, entityIds || []);
        let task = null;
        if (toolInput.task_id) {
          task = tasks.find(t => t.id === toolInput.task_id);
        } else if (toolInput.title) {
          const titleLower = toolInput.title.toLowerCase();
          task = tasks.find(t => t.title.toLowerCase() === titleLower)
            || tasks.find(t => t.title.toLowerCase().includes(titleLower));
        }
        if (!task) return { success: false, error: 'Task not found or access denied' };
        await db.updateTask(task.id, { completed: true, completedAt: new Date().toISOString() });
        return { success: true, task_id: task.id, title: task.title };
      }

      case 'update_task': {
        const tasks = await db.getTasksForUser(userId, entityIds || []);
        const task = tasks.find(t => t.id === toolInput.task_id);
        if (!task) return { success: false, error: 'Task not found or access denied' };
        const fields = {};
        if (toolInput.title !== undefined) fields.title = toolInput.title;
        if (toolInput.priority !== undefined) fields.priority = toolInput.priority;
        if (toolInput.due_date !== undefined) fields.dueDate = toolInput.due_date;
        if (toolInput.due_time !== undefined) fields.dueTime = toolInput.due_time;
        if (toolInput.notes !== undefined) fields.description = toolInput.notes;
        await db.updateTask(toolInput.task_id, fields);
        return { success: true, task_id: toolInput.task_id };
      }

      case 'create_note': {
        const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await db.createNote({
          id,
          userId,
          title: toolInput.title,
          content: toolInput.content,
          visibility: 'private',
          type: 'quick',
          pillar: toolInput.pillar || null,
          category: '',
          subcategory: '',
          tags: [],
          entityId: null,
        });
        return { success: true, note_id: id, title: toolInput.title };
      }

      default:
        return { success: false, error: 'Unknown tool' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { ARIA_TOOLS, executeTool };
