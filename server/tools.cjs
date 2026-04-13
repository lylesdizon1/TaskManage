'use strict';

/**
 * server/tools.cjs — Aria tool definitions + execution engine.
 *
 * Each tool entry carries metadata the agentic loop uses to gate execution:
 *   { name, group, risk, requires_confirmation, description, input_schema }
 *
 * The schema passed to the Anthropic API is derived from ARIA_TOOLS at
 * load time (getToolSchemasForApi) — metadata fields are stripped before
 * the model sees them.
 *
 * All tools are scoped to the authenticated userId (never from toolInput).
 * Tools call DB helpers / existing utils directly — never HTTP.
 */

const { google } = require('googleapis');
const { loadGcalTokens, loadAllGcalAccounts, makeOAuth2Client, makeGmailOAuth2Client } = require('./utils/google.cjs');
const { encryptTokens, decryptTokens, ENCRYPTION_KEY } = require('./utils/crypto.cjs');

// ── Aria tool registry ─────────────────────────────────────────────────────

const ARIA_TOOLS = [
  // --- TASK TOOLS ---
  {
    name: 'create_task',
    group: 'tasks',
    risk: 'low',
    requires_confirmation: false,
    description: 'Create a new task. Title is the only required field — create immediately with defaults for everything else.',
    input_schema: {
      type: 'object',
      properties: {
        title:       { type: 'string' },
        priority:    { type: 'string', enum: ['low', 'medium', 'high'] },
        due_date:    { type: 'string', description: 'YYYY-MM-DD' },
        due_time:    { type: 'string', description: 'HH:MM 24hr' },
        notes:       { type: 'string' },
        entity_name: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'complete_task',
    group: 'tasks',
    risk: 'low',
    requires_confirmation: false,
    description: 'Mark an existing task as complete. Optionally include a short completion note.',
    input_schema: {
      type: 'object',
      properties: {
        task_id:         { type: 'string' },
        title:           { type: 'string', description: 'Used to find the task if ID is unknown.' },
        completion_note: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'update_task',
    group: 'tasks',
    risk: 'low',
    requires_confirmation: false,
    description: 'Update fields on an existing task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id:  { type: 'string' },
        title:    { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        due_date: { type: 'string' },
        due_time: { type: 'string' },
        notes:    { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'delete_task',
    group: 'tasks',
    risk: 'high',
    requires_confirmation: true,
    description: 'Delete a task permanently. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
  {
    name: 'search_tasks',
    group: 'tasks',
    risk: 'low',
    requires_confirmation: false,
    description: 'Search the user\'s tasks. All filters optional. Returns up to 30 matches.',
    input_schema: {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Substring match on title / description.' },
        status:     { type: 'string', enum: ['active', 'completed', 'all'] },
        entity:     { type: 'string', description: 'Entity/tag name.' },
        due_before: { type: 'string', description: 'YYYY-MM-DD' },
        due_after:  { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: [],
    },
  },

  // --- CALENDAR TOOLS ---
  {
    name: 'create_event',
    group: 'calendar',
    risk: 'low',
    requires_confirmation: false,
    description: 'Create a calendar event in the user\'s primary Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title:          { type: 'string' },
        start_datetime: { type: 'string', description: 'ISO 8601' },
        end_datetime:   { type: 'string' },
        description:    { type: 'string' },
        location:       { type: 'string' },
        attendees:      { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'start_datetime'],
    },
  },
  {
    name: 'update_event',
    group: 'calendar',
    risk: 'medium',
    requires_confirmation: false,
    description: 'Update an existing calendar event. Only scoped to the user\'s own connected calendars.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:    { type: 'string' },
        title:       { type: 'string' },
        start_time:  { type: 'string', description: 'ISO 8601' },
        end_time:    { type: 'string', description: 'ISO 8601' },
        description: { type: 'string' },
        location:    { type: 'string' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_event',
    group: 'calendar',
    risk: 'high',
    requires_confirmation: true,
    description: 'Delete a calendar event permanently. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: { event_id: { type: 'string' } },
      required: ['event_id'],
    },
  },

  // --- NOTE TOOLS ---
  {
    name: 'create_note',
    group: 'notes',
    risk: 'low',
    requires_confirmation: false,
    description: 'Create a new note.',
    input_schema: {
      type: 'object',
      properties: {
        title:   { type: 'string' },
        content: { type: 'string' },
        pillar:  { type: 'string', enum: ['hustle', 'home', 'grow', 'move'] },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'search_notes',
    group: 'notes',
    risk: 'low',
    requires_confirmation: false,
    description: 'Search the user\'s notes by substring or entity. Returns up to 20 matches.',
    input_schema: {
      type: 'object',
      properties: {
        query:  { type: 'string' },
        entity: { type: 'string' },
      },
      required: [],
    },
  },
  {
    name: 'update_note',
    group: 'notes',
    risk: 'low',
    requires_confirmation: false,
    description: 'Update fields on an existing note.',
    input_schema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        title:   { type: 'string' },
        content: { type: 'string' },
        entity:  { type: 'string' },
      },
      required: ['note_id'],
    },
  },

  // --- COMMUNICATION TOOLS ---
  {
    name: 'send_email',
    group: 'communication',
    risk: 'high',
    requires_confirmation: true,
    description: 'Send a new email via the user\'s connected Gmail account. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        to:            { type: 'string' },
        subject:       { type: 'string' },
        body:          { type: 'string' },
        account_email: { type: 'string', description: 'The connected Gmail account to send from.' },
      },
      required: ['to', 'subject', 'body', 'account_email'],
    },
  },
  {
    name: 'reply_email',
    group: 'communication',
    risk: 'high',
    requires_confirmation: true,
    description: 'Reply to an existing Gmail thread. Requires user confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        message_id:    { type: 'string' },
        thread_id:     { type: 'string' },
        body:          { type: 'string' },
        account_email: { type: 'string' },
      },
      required: ['message_id', 'thread_id', 'body', 'account_email'],
    },
  },
  {
    name: 'archive_email',
    group: 'communication',
    risk: 'low',
    requires_confirmation: false,
    description: 'Archive an email (remove INBOX label) via Gmail API.',
    input_schema: {
      type: 'object',
      properties: {
        message_id:    { type: 'string' },
        account_email: { type: 'string' },
      },
      required: ['message_id', 'account_email'],
    },
  },
  {
    name: 'bulk_archive_emails',
    group: 'communication',
    risk: 'high',
    requires_confirmation: true,
    description: 'Archive low-priority emails matching criteria (promotions / newsletters / social) for a single account. Always dry-run first.',
    input_schema: {
      type: 'object',
      properties: {
        account_email: { type: 'string' },
        criteria: {
          type: 'object',
          properties: {
            include_promos:      { type: 'boolean' },
            include_newsletters: { type: 'boolean' },
            include_social:      { type: 'boolean' },
            older_than_hours:    { type: 'number' },
          },
        },
        dry_run: { type: 'boolean' },
      },
      required: ['account_email', 'criteria'],
    },
  },
];

const ALWAYS_CONFIRM = new Set(['send_email', 'reply_email', 'delete_task', 'delete_event']);

function getToolByName(name) {
  return ARIA_TOOLS.find(t => t.name === name) || null;
}

/**
 * Strip metadata fields before sending tools to the Anthropic API. The
 * model should only see { name, description, input_schema }.
 */
function getToolSchemasForApi() {
  return ARIA_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/** Resolve whether a tool requires user confirmation (server-authoritative). */
function requiresConfirmation(toolName, llmDecision) {
  if (ALWAYS_CONFIRM.has(toolName)) return true;
  const tool = getToolByName(toolName);
  if (tool?.requires_confirmation) return true;
  if (llmDecision?.requires_confirmation === true) return true;
  return false;
}

// ── Gmail tokens (via user_integrations) ───────────────────────────────────

/**
 * Load Gmail OAuth tokens for a (user, account_email) pair directly
 * from user_integrations using a case- and whitespace-insensitive
 * lookup. No dependency on the legacy gmail_tokens table or
 * loadGmailTokens helper — those paths are ignored here.
 */
async function loadGmailTokensForAccount(db, userId, accountEmail /* , toolTag */) {
  const row = await db.getGmailIntegrationByEmail(userId, accountEmail);
  const stored = row?.config?.tokens || null;
  const tokens = stored ? (stored._enc ? decryptTokens(stored._enc) : stored) : null;
  return { row, tokens };
}

async function saveGmailTokensForAccount(db, userId, accountEmail, tokens) {
  const wrapped = ENCRYPTION_KEY ? { _enc: encryptTokens(tokens) } : tokens;
  await db.upsertUserIntegration(userId, 'gmail', { tokens: wrapped }, true, accountEmail || '');
}

function buildRawMime({ to, from, subject, body, inReplyTo, references }) {
  const lines = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  const mime = `${lines.join('\r\n')}\r\n\r\n${body || ''}`;
  return Buffer.from(mime).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Tool execution ─────────────────────────────────────────────────────────

async function executeTool(toolName, toolInput, userId, entityIds, db, tz) {
  try {
    switch (toolName) {
      // ── TASKS ──────────────────────────────────────────────────────────
      case 'create_task': {
        const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const tags = toolInput.entity_name ? [toolInput.entity_name] : [];
        await db.upsertTask({
          id,
          title: toolInput.title,
          description: toolInput.notes || '',
          priority: toolInput.priority || 'medium',
          dueDate: toolInput.due_date || '',
          dueTime: toolInput.due_time || null,
          tags,
          visibility: tags.length ? 'shared' : 'private',
          completed: false,
          owner: userId,
          createdBy: userId,
        });
        try {
          await db.logMemory({
            userId, tool: 'create_task',
            content: `Created task: "${toolInput.title}"${toolInput.due_date ? ` due ${toolInput.due_date}` : ''}${toolInput.priority && toolInput.priority !== 'medium' ? `, ${toolInput.priority} priority` : ''}${toolInput.entity_name ? `, tagged ${toolInput.entity_name}` : ''}`,
            metadata: { task_id: id, title: toolInput.title, priority: toolInput.priority, due_date: toolInput.due_date, entity_name: toolInput.entity_name || null },
          });
        } catch (e) { console.error('[memory] log failed:', e.message); }
        if (toolInput.due_date) {
          try {
            await db.scheduleTaskAlerts(userId, id, toolInput.title, toolInput.due_date, toolInput.due_time || null, toolInput.priority || 'medium', tz);
          } catch (e) { console.error('[schedule] alert scheduling failed:', e.message); }
        }
        return { success: true, task_id: id, title: toolInput.title, due_date: toolInput.due_date || null, due_time: toolInput.due_time || null, priority: toolInput.priority || 'medium', entity_name: toolInput.entity_name || null };
      }

      case 'complete_task': {
        let task = null;
        if (toolInput.task_id) {
          task = await db.getTaskById(toolInput.task_id, userId);
        } else if (toolInput.title) {
          const tasks = await db.getTasksForUser(userId, []);
          const titleLower = toolInput.title.toLowerCase();
          const activeTasks = tasks.filter(t => !t.completed);
          task = activeTasks.find(t => t.title.toLowerCase() === titleLower);
          if (!task) {
            const partials = activeTasks.filter(t => t.title.toLowerCase().includes(titleLower));
            if (partials.length === 1) task = partials[0];
            else if (partials.length > 1) {
              const list = partials.map((t, i) => `${i + 1}. ${t.title}${t.dueDate ? ` (due ${t.dueDate})` : ''}`).join('\n');
              return { success: false, error: `I found ${partials.length} tasks matching "${toolInput.title}" — which one?\n${list}` };
            }
          }
        }
        if (!task) return { success: false, error: 'Task not found or access denied' };
        const updateFields = { completed: true, completedAt: new Date().toISOString() };
        if (toolInput.completion_note) updateFields.completionNote = toolInput.completion_note;
        await db.updateTask(task.id, updateFields);
        try {
          await db.logMemory({
            userId, tool: 'complete_task',
            content: `Completed task: "${task.title}"${toolInput.completion_note ? ` — Note: ${toolInput.completion_note}` : ''}`,
            metadata: { task_id: task.id, completion_note: !!toolInput.completion_note },
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

      case 'delete_task': {
        const task = await db.getTaskById(toolInput.task_id, userId);
        if (!task) return { success: false, error: 'Task not found or access denied' };
        await db.updateTask(toolInput.task_id, { status: 'deleted', completed: true, completedAt: new Date().toISOString() });
        try {
          await db.logMemory({ userId, tool: 'delete_task', content: `Deleted task: "${task.title}"`, metadata: { task_id: toolInput.task_id } });
        } catch (e) { console.error('[memory] log failed:', e.message); }
        return { success: true, task_id: toolInput.task_id, title: task.title };
      }

      case 'search_tasks': {
        const all = await db.getTasksForUser(userId, []);
        const { query, status, entity, due_before, due_after } = toolInput || {};
        let results = all;
        if (status === 'active') results = results.filter(t => !t.completed);
        else if (status === 'completed') results = results.filter(t => t.completed);
        if (entity) results = results.filter(t => Array.isArray(t.tags) && t.tags.some(x => String(x).toLowerCase() === String(entity).toLowerCase()));
        if (query) {
          const q = query.toLowerCase();
          results = results.filter(t => (t.title || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
        }
        if (due_before) results = results.filter(t => t.dueDate && t.dueDate <= due_before);
        if (due_after)  results = results.filter(t => t.dueDate && t.dueDate >= due_after);
        return {
          success: true,
          count: Math.min(results.length, 30),
          tasks: results.slice(0, 30).map(t => ({
            id: t.id, title: t.title, priority: t.priority,
            due_date: t.dueDate || null, completed: !!t.completed, tags: t.tags || [],
          })),
        };
      }

      // ── CALENDAR ───────────────────────────────────────────────────────
      case 'create_event': {
        const { title, start_datetime, end_datetime, description: eventDesc, location, attendees } = toolInput;
        const tokens = await loadGcalTokens(userId, db);
        if (!tokens) return { success: false, error: 'Google Calendar not connected.' };
        const oauth2 = makeOAuth2Client();
        if (!oauth2) return { success: false, error: 'Google OAuth not configured on server.' };
        oauth2.setCredentials(tokens);
        const calendar = google.calendar({ version: 'v3', auth: oauth2 });

        const startDt = start_datetime.includes('T') ? start_datetime : `${start_datetime}T00:00:00`;
        const parsedStart = new Date(startDt);
        if (isNaN(parsedStart.getTime())) return { success: false, error: `Invalid start_datetime: "${start_datetime}".` };
        const pad = (n) => String(n).padStart(2, '0');
        const formatLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        let endDt;
        if (end_datetime) {
          endDt = end_datetime.includes('T') ? end_datetime : `${end_datetime}T00:00:00`;
          const parsedEnd = new Date(endDt);
          if (isNaN(parsedEnd.getTime())) return { success: false, error: `Invalid end_datetime: "${end_datetime}".` };
          if (parsedEnd <= parsedStart) return { success: false, error: 'end_datetime must be after start_datetime.' };
        } else {
          const d = new Date(parsedStart.getTime()); d.setHours(d.getHours() + 1);
          endDt = formatLocal(d);
        }
        const { data: created } = await calendar.events.insert({
          calendarId: 'primary',
          requestBody: {
            summary: title,
            start: { dateTime: startDt, timeZone: tz || 'America/Los_Angeles' },
            end:   { dateTime: endDt,   timeZone: tz || 'America/Los_Angeles' },
            ...(eventDesc && { description: eventDesc }),
            ...(location  && { location }),
            ...(attendees?.length && { attendees: attendees.map(email => ({ email })) }),
          },
        });
        try {
          await db.logMemory({ userId, tool: 'create_event', content: `Created event: "${title}" at ${startDt}`, metadata: { event_id: created.id, title, start: startDt } });
        } catch {}
        return { success: true, event_id: created.id, title: created.summary, start: created.start?.dateTime || created.start?.date, link: created.htmlLink };
      }

      case 'update_event': {
        const accounts = (await loadAllGcalAccounts(userId, db)) || [];
        if (!accounts.length) return { success: false, error: 'Google Calendar not connected.' };
        for (const acct of accounts) {
          const oauth2 = makeOAuth2Client(); if (!oauth2) continue;
          oauth2.setCredentials(acct.tokens);
          const calendar = google.calendar({ version: 'v3', auth: oauth2 });
          try {
            const existing = await calendar.events.get({ calendarId: 'primary', eventId: toolInput.event_id });
            if (!existing?.data) continue;
            const patch = {};
            if (toolInput.title !== undefined) patch.summary = toolInput.title;
            if (toolInput.description !== undefined) patch.description = toolInput.description;
            if (toolInput.location !== undefined) patch.location = toolInput.location;
            if (toolInput.start_time) patch.start = { dateTime: toolInput.start_time, timeZone: tz || 'America/Los_Angeles' };
            if (toolInput.end_time)   patch.end   = { dateTime: toolInput.end_time,   timeZone: tz || 'America/Los_Angeles' };
            const { data: updated } = await calendar.events.patch({ calendarId: 'primary', eventId: toolInput.event_id, requestBody: patch });
            try { await db.logMemory({ userId, tool: 'update_event', content: `Updated event: "${updated.summary}"`, metadata: { event_id: updated.id, changes: Object.keys(patch) } }); } catch {}
            return { success: true, event_id: updated.id, title: updated.summary, account_email: acct.googleEmail || null };
          } catch (err) {
            if (err.code === 404 || err.response?.status === 404) continue;
            return { success: false, error: err.message };
          }
        }
        return { success: false, error: 'Event not found in any connected calendar.' };
      }

      case 'delete_event': {
        const accounts = (await loadAllGcalAccounts(userId, db)) || [];
        if (!accounts.length) return { success: false, error: 'Google Calendar not connected.' };
        for (const acct of accounts) {
          const oauth2 = makeOAuth2Client(); if (!oauth2) continue;
          oauth2.setCredentials(acct.tokens);
          const calendar = google.calendar({ version: 'v3', auth: oauth2 });
          try {
            await calendar.events.delete({ calendarId: 'primary', eventId: toolInput.event_id });
            try { await db.logMemory({ userId, tool: 'delete_event', content: `Deleted event ${toolInput.event_id}`, metadata: { event_id: toolInput.event_id } }); } catch {}
            return { success: true, event_id: toolInput.event_id, account_email: acct.googleEmail || null };
          } catch (err) {
            if (err.code === 404 || err.response?.status === 404) continue;
            return { success: false, error: err.message };
          }
        }
        return { success: false, error: 'Event not found in any connected calendar.' };
      }

      // ── NOTES ──────────────────────────────────────────────────────────
      case 'create_note': {
        const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await db.createNote({
          id, userId,
          title: toolInput.title, content: toolInput.content,
          visibility: 'private', type: 'quick',
          pillar: toolInput.pillar || null,
          category: '', subcategory: '', tags: [], entityId: null,
        });
        try { await db.logMemory({ userId, tool: 'create_note', content: `Created note: "${toolInput.title}"`, metadata: { note_id: id } }); } catch {}
        return { success: true, note_id: id, title: toolInput.title };
      }

      case 'search_notes': {
        const all = await db.getNotesForUser(userId);
        const { query, entity } = toolInput || {};
        let results = all;
        if (query) {
          const q = query.toLowerCase();
          results = results.filter(n =>
            (n.title || '').toLowerCase().includes(q) ||
            (n.content || '').toLowerCase().includes(q)
          );
        }
        if (entity) {
          const e = String(entity).toLowerCase();
          results = results.filter(n => Array.isArray(n.tags) && n.tags.some(x => String(x).toLowerCase() === e));
        }
        return {
          success: true,
          count: Math.min(results.length, 20),
          notes: results.slice(0, 20).map(n => ({
            id: n.id, title: n.title, pillar: n.pillar || null,
            updated_at: n.updatedAt || n.createdAt || null,
          })),
        };
      }

      case 'update_note': {
        const note = await db.getNoteById(toolInput.note_id, userId);
        if (!note) return { success: false, error: 'Note not found or access denied' };
        const fields = {};
        if (toolInput.title !== undefined) fields.title = toolInput.title;
        if (toolInput.content !== undefined) fields.content = toolInput.content;
        if (toolInput.entity !== undefined) fields.tags = [toolInput.entity];
        await db.updateNote(toolInput.note_id, userId, fields);
        try { await db.logMemory({ userId, tool: 'update_note', content: `Updated note: "${note.title}"`, metadata: { note_id: toolInput.note_id, changes: Object.keys(fields) } }); } catch {}
        return { success: true, note_id: toolInput.note_id };
      }

      // ── COMMUNICATION ──────────────────────────────────────────────────
      case 'send_email': {
        const { to, subject, body, account_email } = toolInput || {};
        const { tokens } = await loadGmailTokensForAccount(db, userId, account_email, 'send_email');
        if (!tokens) return { success: false, error: `No Gmail tokens for ${account_email}. Reconnect in Settings.` };
        const oauth2 = makeGmailOAuth2Client();
        if (!oauth2) return { success: false, error: 'Google OAuth not configured.' };
        oauth2.setCredentials(tokens);
        oauth2.on('tokens', async (nt) => { await saveGmailTokensForAccount(db, userId, account_email, { ...tokens, ...nt }).catch(() => {}); });
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        const raw = buildRawMime({ to, from: account_email, subject, body });
        try {
          const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
          try { await db.logMemory({ userId, tool: 'send_email', content: `Sent email to ${to}: "${subject}"`, metadata: { message_id: data.id, account_email } }); } catch {}
          return { success: true, message_id: data.id, thread_id: data.threadId, account_email };
        } catch (err) {
          if (err.message?.includes('insufficient') || err.code === 403) {
            return { success: false, error: 'Gmail account is missing send permission. Reconnect in Settings to grant send access.' };
          }
          return { success: false, error: err.message };
        }
      }

      case 'reply_email': {
        const { message_id, thread_id, body, account_email } = toolInput || {};
        const { tokens } = await loadGmailTokensForAccount(db, userId, account_email, 'reply_email');
        if (!tokens) return { success: false, error: `No Gmail tokens for ${account_email}.` };
        const oauth2 = makeGmailOAuth2Client(); if (!oauth2) return { success: false, error: 'Google OAuth not configured.' };
        oauth2.setCredentials(tokens);
        oauth2.on('tokens', async (nt) => { await saveGmailTokensForAccount(db, userId, account_email, { ...tokens, ...nt }).catch(() => {}); });
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        try {
          const orig = await gmail.users.messages.get({ userId: 'me', id: message_id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Message-ID', 'References'] });
          const headers = orig.data.payload?.headers || [];
          const getH = (n) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
          const origFrom = getH('From');
          const origSubject = getH('Subject');
          const origMsgId = getH('Message-ID');
          const origRefs = getH('References');
          const raw = buildRawMime({
            to: origFrom, from: account_email,
            subject: origSubject.toLowerCase().startsWith('re:') ? origSubject : `Re: ${origSubject}`,
            body,
            inReplyTo: origMsgId,
            references: [origRefs, origMsgId].filter(Boolean).join(' '),
          });
          const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId: thread_id } });
          try { await db.logMemory({ userId, tool: 'reply_email', content: `Replied to "${origSubject}"`, metadata: { message_id: data.id, thread_id, account_email } }); } catch {}
          return { success: true, message_id: data.id, thread_id: data.threadId, account_email };
        } catch (err) {
          if (err.code === 403 || err.message?.includes('insufficient')) {
            return { success: false, error: 'Gmail account is missing send permission. Reconnect in Settings.' };
          }
          return { success: false, error: err.message };
        }
      }

      case 'archive_email': {
        const { message_id, account_email } = toolInput || {};
        const { tokens } = await loadGmailTokensForAccount(db, userId, account_email, 'archive_email');
        if (!tokens) return { success: false, error: `No Gmail tokens for ${account_email}.` };
        const oauth2 = makeGmailOAuth2Client(); if (!oauth2) return { success: false, error: 'Google OAuth not configured.' };
        oauth2.setCredentials(tokens);
        oauth2.on('tokens', async (nt) => { await saveGmailTokensForAccount(db, userId, account_email, { ...tokens, ...nt }).catch(() => {}); });
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        try {
          await gmail.users.messages.modify({ userId: 'me', id: message_id, requestBody: { removeLabelIds: ['INBOX'] } });
          try { await db.logMemory({ userId, tool: 'archive_email', content: `Archived email ${message_id}`, metadata: { message_id, account_email } }); } catch {}
          return { success: true, message_id, account_email };
        } catch (err) {
          if (err.code === 403 || err.message?.includes('insufficient')) {
            return { success: false, error: 'Gmail account is missing modify permission. Reconnect in Settings.' };
          }
          return { success: false, error: err.message };
        }
      }

      case 'bulk_archive_emails': {
        const { account_email, criteria, dry_run } = toolInput || {};
        if (!account_email || !criteria) return { success: false, error: 'account_email and criteria required' };
        const row = await db.getGmailIntegrationByEmail(userId, account_email);
        if (!row) return { success: false, error: `No Gmail tokens for ${account_email}. Reconnect in Settings.` };
        const { scanAndArchiveForAccount } = require('./lib/emailCleanRunner.cjs');
        const result = await scanAndArchiveForAccount({
          db, userId, accountEmail: account_email, criteria,
          dryRun: dry_run !== false, // default true
        });
        return { success: true, ...result };
      }

      default:
        return { success: false, error: 'Unknown tool' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { ARIA_TOOLS, executeTool, getToolByName, getToolSchemasForApi, requiresConfirmation, ALWAYS_CONFIRM };
