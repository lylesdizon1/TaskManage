'use strict';

const { google } = require('googleapis');
const { loadGcalTokens, makeOAuth2Client } = require('./utils/google.cjs');

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
    name: 'create_event',
    description: 'Create a calendar event in the user\'s Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start_datetime: { type: 'string', description: 'Start date/time in ISO 8601 format (e.g. 2025-04-08T14:00:00)' },
        end_datetime: { type: 'string', description: 'End date/time in ISO 8601 format. If not provided, default to 1 hour after start.' },
        description: { type: 'string', description: 'Optional event description or notes' },
        location: { type: 'string', description: 'Optional location or address' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Optional list of attendee email addresses' },
      },
      required: ['title', 'start_datetime'],
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

async function executeTool(toolName, toolInput, userId, entityIds, db, tz) {
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
        try {
          await db.logMemory({
            userId, tool: 'create_task',
            content: `Created task: "${toolInput.title}"${toolInput.due_date ? ` due ${toolInput.due_date}` : ''}${toolInput.priority && toolInput.priority !== 'medium' ? `, ${toolInput.priority} priority` : ''}`,
            metadata: { task_id: id, title: toolInput.title, priority: toolInput.priority, due_date: toolInput.due_date },
          });
        } catch (e) { console.error('[memory] log failed:', e.message); }
        // Schedule alerts if task has a due date
        if (toolInput.due_date) {
          try {
            await db.scheduleTaskAlerts(userId, id, toolInput.title, toolInput.due_date, toolInput.due_time || null, toolInput.priority || 'medium', tz);
          } catch (e) { console.error('[schedule] alert scheduling failed:', e.message); }
        }
        return { success: true, task_id: id, title: toolInput.title, due_date: toolInput.due_date || null, due_time: toolInput.due_time || null, priority: toolInput.priority || 'medium' };
      }

      case 'complete_task': {
        let task = null;
        if (toolInput.task_id) {
          task = await db.getTaskById(toolInput.task_id, userId);
        } else if (toolInput.title) {
          // Title search requires loading all tasks for fuzzy matching
          const tasks = await db.getTasksForUser(userId, []);
          const titleLower = toolInput.title.toLowerCase();
          const activeTasks = tasks.filter(t => !t.completed);
          // 1. Exact match (case-insensitive)
          task = activeTasks.find(t => t.title.toLowerCase() === titleLower);
          if (!task) {
            // 2. Partial match — only proceed if exactly one candidate
            const partials = activeTasks.filter(t => t.title.toLowerCase().includes(titleLower));
            if (partials.length === 1) {
              task = partials[0];
            } else if (partials.length > 1) {
              const list = partials.map((t, i) => `${i + 1}. ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ''}`).join('\n');
              return { success: false, error: `I found ${partials.length} tasks matching "${toolInput.title}" — which one?\n${list}` };
            }
          }
        }
        if (!task) return { success: false, error: 'Task not found or access denied' };
        await db.updateTask(task.id, { completed: true, completedAt: new Date().toISOString() });
        try {
          await db.logMemory({
            userId, tool: 'complete_task',
            content: `Completed task: "${task.title}"`,
            metadata: { task_id: task.id },
          });
        } catch (e) { console.error('[memory] log failed:', e.message); }
        return { success: true, task_id: task.id, title: task.title };
      }

      case 'update_task': {
        const task = await db.getTaskById(toolInput.task_id, userId);
        if (!task) return { success: false, error: 'Task not found or access denied' };
        const fields = {};
        if (toolInput.title !== undefined) fields.title = toolInput.title;
        if (toolInput.priority !== undefined) fields.priority = toolInput.priority;
        if (toolInput.due_date !== undefined) fields.dueDate = toolInput.due_date;
        if (toolInput.due_time !== undefined) fields.dueTime = toolInput.due_time;
        if (toolInput.notes !== undefined) fields.description = toolInput.notes;
        await db.updateTask(toolInput.task_id, fields);
        try {
          await db.logMemory({
            userId, tool: 'update_task',
            content: `Updated task: "${task.title}" — changed: ${Object.keys(fields).join(', ')}`,
            metadata: { task_id: toolInput.task_id, changes: fields },
          });
        } catch (e) { console.error('[memory] log failed:', e.message); }
        // Reschedule alerts if due_date or priority changed
        if (fields.dueDate !== undefined || fields.priority !== undefined) {
          try {
            const updatedDueDate = fields.dueDate ?? task.dueDate;
            const updatedDueTime = fields.dueTime ?? task.dueTime ?? null;
            const updatedPriority = fields.priority ?? task.priority;
            if (updatedDueDate) {
              await db.scheduleTaskAlerts(userId, toolInput.task_id, fields.title || task.title, updatedDueDate, updatedDueTime, updatedPriority, tz);
            }
          } catch (e) { console.error('[schedule] alert rescheduling failed:', e.message); }
        }
        return { success: true, task_id: toolInput.task_id, title: fields.title || task.title, due_date: fields.dueDate ?? task.dueDate, due_time: fields.dueTime ?? task.dueTime, priority: fields.priority ?? task.priority };
      }

      case 'create_event': {
        const { title, start_datetime, end_datetime, description: eventDesc, location, attendees } = toolInput;

        // Load + decrypt GCal tokens (same pattern as ai.cjs context loading)
        const tokens = await loadGcalTokens(userId, db);
        if (!tokens) {
          return { success: false, error: 'Google Calendar not connected. Please connect it in Settings.' };
        }

        const oauth2 = makeOAuth2Client();
        if (!oauth2) {
          return { success: false, error: 'Google OAuth not configured on server.' };
        }
        oauth2.setCredentials(tokens);
        const calendar = google.calendar({ version: 'v3', auth: oauth2 });

        const startDt = start_datetime.includes('T') ? start_datetime : `${start_datetime}T00:00:00`;
        const parsedStart = new Date(startDt);
        if (isNaN(parsedStart.getTime())) {
          return { success: false, error: `Invalid start_datetime: "${start_datetime}". Use ISO 8601 format (e.g. 2025-04-08T14:00:00).` };
        }

        const pad = (n) => String(n).padStart(2, '0');
        const formatLocal = (d) =>
          `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

        let endDt;
        if (end_datetime) {
          endDt = end_datetime.includes('T') ? end_datetime : `${end_datetime}T00:00:00`;
          const parsedEnd = new Date(endDt);
          if (isNaN(parsedEnd.getTime())) {
            return { success: false, error: `Invalid end_datetime: "${end_datetime}". Use ISO 8601 format (e.g. 2025-04-08T15:00:00).` };
          }
          if (parsedEnd <= parsedStart) {
            return { success: false, error: 'end_datetime must be after start_datetime.' };
          }
        } else {
          const d = new Date(parsedStart.getTime());
          d.setHours(d.getHours() + 1);
          endDt = formatLocal(d);
        }

        const eventBody = {
          summary: title,
          start: { dateTime: startDt, timeZone: tz || 'America/Los_Angeles' },
          end:   { dateTime: endDt,   timeZone: tz || 'America/Los_Angeles' },
          ...(eventDesc && { description: eventDesc }),
          ...(location  && { location }),
          ...(attendees?.length && { attendees: attendees.map(email => ({ email })) }),
        };

        const { data: created } = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: eventBody,
        });

        try {
          await db.logMemory({
            userId, tool: 'create_event',
            content: `Created calendar event: "${title}" at ${startDt}`,
            metadata: { event_id: created.id, title, start: startDt, end: endDt },
          });
        } catch (e) { console.error('[memory] log failed:', e.message); }

        return {
          success: true,
          event_id: created.id,
          title: created.summary,
          start: created.start?.dateTime || created.start?.date,
          end: created.end?.dateTime || created.end?.date,
          link: created.htmlLink,
        };
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
        try {
          await db.logMemory({
            userId, tool: 'create_note',
            content: `Created note: "${toolInput.title}"${toolInput.pillar ? ` [${toolInput.pillar}]` : ''}`,
            metadata: { note_id: id, title: toolInput.title, pillar: toolInput.pillar },
          });
        } catch (e) { console.error('[memory] log failed:', e.message); }
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
