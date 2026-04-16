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
    name: 'search_inbox',
    group: 'communication',
    risk: 'low',
    requires_confirmation: false,
    description: 'Search classified emails by sender, category, entity, or keyword. Supports date ranges: today, last_week, last_month, last_3_months, last_year, all. Default is last 7 days. Returns has_more=true if more results may exist beyond the limit. When results are sparse or has_more is true, ask the user if they want to search further back.',
    input_schema: {
      type: 'object',
      properties: {
        query:         { type: 'string', description: 'Substring matched against vendor + summary.' },
        sender:        { type: 'string', description: 'Substring matched against vendor + summary (not account_email).' },
        category:      { type: 'string' },
        entity:        { type: 'string' },
        importance:    { type: 'string', enum: ['critical', 'high', 'normal', 'low'] },
        account_email: { type: 'string', description: 'Receiving inbox account.' },
        limit:         { type: 'number' },
        date_from:     { type: 'string', description: "ISO date YYYY-MM-DD or one of: today, last_week, last_month, last_3_months, last_year, all. Default: last 7 days." },
        date_to:       { type: 'string', description: 'ISO date YYYY-MM-DD. Optional upper bound.' },
      },
    },
  },
  // --- PEOPLE / CONTACTS / SHARED ACCESS ---
  {
    name: 'list_contacts',
    group: 'people',
    risk: 'low',
    requires_confirmation: false,
    description: "List the user's contacts. Optionally filter by name/email substring via the query param.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional substring match on display_name or primary_email.' },
      },
    },
  },
  {
    name: 'get_contact',
    group: 'people',
    risk: 'low',
    requires_confirmation: false,
    description: 'Get full context for a contact including facts and notes. At least one of contact_id, email, or name is required.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        email:      { type: 'string' },
        name:       { type: 'string' },
      },
    },
  },
  {
    name: 'create_contact',
    group: 'people',
    risk: 'low',
    requires_confirmation: false,
    description: 'Create a new contact.',
    input_schema: {
      type: 'object',
      properties: {
        display_name:  { type: 'string' },
        primary_email: { type: 'string' },
        primary_phone: { type: 'string' },
        company:       { type: 'string' },
        role:          { type: 'string' },
        notes:         { type: 'string' },
      },
      required: ['display_name'],
    },
  },
  {
    name: 'update_contact',
    group: 'people',
    risk: 'low',
    requires_confirmation: false,
    description: 'Update an existing contact.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id:    { type: 'string' },
        display_name:  { type: 'string' },
        primary_email: { type: 'string' },
        company:       { type: 'string' },
        role:          { type: 'string' },
        notes:         { type: 'string' },
      },
      required: ['contact_id'],
    },
  },
  {
    name: 'note_about_contact',
    group: 'people',
    risk: 'low',
    requires_confirmation: false,
    description: 'Add a note or fact about a contact. Triggers background fact extraction.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string' },
        content:    { type: 'string' },
        note_type:  { type: 'string', description: "Defaults to 'memory' (treated as a note)." },
      },
      required: ['contact_id', 'content'],
    },
  },
  {
    name: 'list_shared_access',
    group: 'people',
    risk: 'low',
    requires_confirmation: false,
    description: 'List active shared access grants given and received.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'grant_shared_access',
    group: 'people',
    risk: 'medium',
    requires_confirmation: true,
    description: 'Grant another user read access to some of your data. Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        grantee_email: { type: 'string' },
        scope:         { type: 'string', enum: ['calendar_read', 'tasks_read', 'inbox_read', 'people_read', 'full_read'] },
        expires_at:    { type: 'string', description: 'Optional ISO timestamp.' },
      },
      required: ['grantee_email', 'scope'],
    },
  },
  {
    name: 'revoke_shared_access',
    group: 'people',
    risk: 'medium',
    requires_confirmation: true,
    description: 'Revoke a shared access grant you previously issued. Requires confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        grant_id: { type: 'string' },
      },
      required: ['grant_id'],
    },
  },
  // --- JOURNAL / DAILY WRAP ---
  {
    name: 'create_journal_entry',
    group: 'journal',
    risk: 'low',
    requires_confirmation: false,
    description: "Save a journal entry or daily wrap. Can include wins, frustrations, tomorrow's focus, or freeform reflection. Set completed=true to stamp the wrap as finished for today.",
    input_schema: {
      type: 'object',
      properties: {
        wins:           { type: 'string' },
        frustrations:   { type: 'string' },
        tomorrow_focus: { type: 'string' },
        raw_freeform:   { type: 'string' },
        completed:      { type: 'boolean' },
      },
    },
  },
  {
    name: 'list_journal_entries',
    group: 'journal',
    risk: 'low',
    requires_confirmation: false,
    description: 'List recent journal entries, newest first.',
    input_schema: {
      type: 'object',
      properties: {
        limit:      { type: 'number' },
        since_date: { type: 'string', description: 'YYYY-MM-DD lower bound.' },
      },
    },
  },
  {
    name: 'get_today_close_loop_context',
    group: 'journal',
    risk: 'low',
    requires_confirmation: false,
    description: 'Get today\'s close-the-loop context — pending items needing notes and whether the user has wrapped their day.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'close_task_with_note',
    group: 'journal',
    risk: 'low',
    requires_confirmation: false,
    description: 'Add a completion note to a task. Use after completing a task to capture what happened. Resolves the pending close-loop queue item for that task.',
    input_schema: {
      type: 'object',
      properties: {
        task_id:         { type: 'string' },
        completion_note: { type: 'string' },
      },
      required: ['task_id', 'completion_note'],
    },
  },
  {
    name: 'add_event_outcome_note',
    group: 'journal',
    risk: 'low',
    requires_confirmation: false,
    description: 'Add an outcome note to a calendar event. Use after a meeting to capture decisions and follow-ups. Resolves the pending close-loop queue item for that event.',
    input_schema: {
      type: 'object',
      properties: {
        event_id: { type: 'string' },
        note:     { type: 'string' },
      },
      required: ['event_id', 'note'],
    },
  },
  {
    name: 'add_project_update_note',
    group: 'journal',
    risk: 'low',
    requires_confirmation: false,
    description: 'Add a progress note to a project. Visible to all members of the project\'s entity.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        note:       { type: 'string' },
      },
      required: ['project_id', 'note'],
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

// ── search_inbox date range resolver ───────────────────────────────────────
// Accepts: ISO 'YYYY-MM-DD', or one of
//   'today' | 'last_week' | 'last_month' | 'last_3_months' | 'last_year' | 'all'
// omitted → 'last_week' (7 days) per spec default.
// Returns { sinceIso, untilIso, label, wide }
function _resolveDateRange(dateFrom, dateTo) {
  const now = new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n) => new Date(todayMid.getTime() - n * 86400000);

  let sinceIso = null;
  let label = 'last 7 days';
  let rangeKey = 'last_week';

  if (!dateFrom || dateFrom === 'last_week') {
    sinceIso = daysAgo(7).toISOString(); label = 'last 7 days'; rangeKey = 'last_week';
  } else if (dateFrom === 'today') {
    sinceIso = todayMid.toISOString(); label = 'today'; rangeKey = 'today';
  } else if (dateFrom === 'last_month') {
    sinceIso = daysAgo(30).toISOString(); label = 'last 30 days'; rangeKey = 'last_month';
  } else if (dateFrom === 'last_3_months') {
    sinceIso = daysAgo(90).toISOString(); label = 'last 3 months'; rangeKey = 'last_3_months';
  } else if (dateFrom === 'last_year') {
    sinceIso = daysAgo(365).toISOString(); label = 'last year'; rangeKey = 'last_year';
  } else if (dateFrom === 'all') {
    sinceIso = null; label = 'all time'; rangeKey = 'all';
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateFrom).trim());
    if (m) {
      const d = new Date(`${dateFrom}T00:00:00`);
      if (!isNaN(d.getTime())) { sinceIso = d.toISOString(); label = `since ${dateFrom}`; rangeKey = 'custom'; }
    }
  }

  let untilIso = null;
  if (dateTo) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateTo).trim());
    if (m) {
      const d = new Date(`${dateTo}T23:59:59`);
      if (!isNaN(d.getTime())) { untilIso = d.toISOString(); }
    }
  }

  const wide = rangeKey === 'last_3_months' || rangeKey === 'last_year' || rangeKey === 'all';
  const fromLabel = sinceIso ? sinceIso.slice(0, 10) : null;
  const toLabel = untilIso ? untilIso.slice(0, 10) : null;
  return { sinceIso, untilIso, label, rangeKey, wide, fromLabel, toLabel };
}

function _gmailDate(iso) {
  return iso ? iso.slice(0, 10).replace(/-/g, '/') : null;
}

function _buildGmailSearchQuery({ query, sender, dateFromIso, dateToIso }) {
  const parts = ['in:inbox'];
  if (sender) parts.push(`from:${sender}`);
  if (query && query.trim()) parts.push(query.trim());
  if (dateFromIso) parts.push(`after:${_gmailDate(dateFromIso)}`);
  if (dateToIso)   parts.push(`before:${_gmailDate(dateToIso)}`);
  return parts.join(' ');
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
        await db.updateTask(task.id, userId, updateFields);
        try {
          await db.logMemory({
            userId, tool: 'complete_task',
            content: `Completed task: "${task.title}"${toolInput.completion_note ? ` — Note: ${toolInput.completion_note}` : ''}`,
            metadata: { task_id: task.id, completion_note: !!toolInput.completion_note },
          });
        } catch (e) { console.error('[memory] log failed:', e.message); }
        // Ambient close-loop: emit only when no note was supplied. Dup
        // emit on a re-complete is idempotent per the unique index.
        if (!toolInput.completion_note) {
          try {
            const { emitCloseLoop } = require('./lib/closeLoopEmitter.cjs');
            emitCloseLoop(userId, 'task', task.id, task.title)
              .catch((err) => console.error('[closeLoop] complete_task hook failed:', err.message));
          } catch (e) { console.error('[closeLoop] require failed:', e.message); }
        }
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
        await db.updateTask(toolInput.task_id, userId, fields);
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
        await db.updateTask(toolInput.task_id, userId, { status: 'deleted', completed: true, completedAt: new Date().toISOString() });
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
        const { title, start_datetime, end_datetime, description: eventDesc, location, attendees, account_email } = toolInput;
        // Optional account_email routes to a specific connected Google
        // account; falls back to the user's default GCal tokens.
        const tokens = account_email
          ? await loadGcalTokens(userId, db, account_email)
          : await loadGcalTokens(userId, db);
        if (!tokens) return { success: false, error: account_email ? `Google Calendar not connected for ${account_email}.` : 'Google Calendar not connected.' };
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
        // Hard guard: refuse sends with a malformed or missing recipient.
        // Feeds back to the model as a tool_result so the loop asks the
        // user for the full address instead of re-attempting the send.
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!to || !emailRegex.test(String(to).trim())) {
          return {
            success: false,
            error: `Invalid recipient address "${to || ''}". Please provide a complete email address (name@domain.com).`,
            requiresInfo: 'recipient_email',
          };
        }
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

      case 'search_inbox': {
        const { query, sender, category, entity, importance, account_email, limit, date_from, date_to } = toolInput || {};
        const cap = Math.min(Math.max(1, parseInt(limit, 10) || 10), 50);
        const range = _resolveDateRange(date_from, date_to);

        const where = ['ec.user_id = $1'];
        const vals = [userId];
        let i = 2;
        const pushLike = (clause, str) => { where.push(clause); vals.push(`%${String(str).toLowerCase()}%`); i++; };
        if (typeof query === 'string' && query.trim()) {
          pushLike(`(LOWER(COALESCE(ec.vendor, '')) LIKE $${i} OR LOWER(COALESCE(ec.summary, '')) LIKE $${i})`, query.trim());
        }
        if (typeof sender === 'string' && sender.trim()) {
          pushLike(`(LOWER(COALESCE(ec.vendor, '')) LIKE $${i} OR LOWER(COALESCE(ec.summary, '')) LIKE $${i})`, sender.trim());
        }
        if (typeof category === 'string' && category.trim()) {
          where.push(`ec.category = $${i}`); vals.push(category.trim()); i++;
        }
        if (typeof entity === 'string' && entity.trim()) {
          pushLike(`LOWER(COALESCE(e.name, '')) LIKE $${i}`, entity.trim());
        }
        if (typeof importance === 'string' && importance.trim()) {
          where.push(`ec.importance = $${i}`); vals.push(importance.trim()); i++;
        }
        if (typeof account_email === 'string' && account_email.trim()) {
          pushLike(`LOWER(ec.account_email) LIKE $${i}`, account_email.trim());
        }
        if (range.sinceIso) { where.push(`ec.classified_at >= $${i}`); vals.push(range.sinceIso); i++; }
        if (range.untilIso) { where.push(`ec.classified_at <= $${i}`); vals.push(range.untilIso); i++; }
        vals.push(cap);

        let dbRows = [];
        try {
          const { rows } = await db.pool.query(
            `SELECT ec.message_id, ec.thread_id, ec.summary, ec.category, ec.importance,
                    e.name AS entity_name, ec.amount, ec.vendor,
                    ec.account_email, ec.action_required, ec.classified_at,
                    ec.source
             FROM email_classifications ec
             LEFT JOIN entities e ON ec.entity_id = e.id
             WHERE ${where.join(' AND ')}
             ORDER BY ec.classified_at DESC
             LIMIT $${i}`,
            vals,
          );
          dbRows = rows;
        } catch (err) {
          return { success: false, error: err.message };
        }

        let results = dbRows.map(r => ({ ...r, source: r.source || 'db' }));
        let hasMore = results.length >= cap;

        // Gmail live fallback for wide ranges when the DB is sparse.
        // email_classifications only covers threads we've lazily loaded,
        // so older mail may not be indexed yet.
        if (results.length < 5 && range.wide) {
          try {
            const knownIds = new Set(results.map(r => r.message_id));
            const accounts = account_email
              ? [{ accountEmail: account_email }]
              : (await db.getUserIntegrationsByType(userId, 'gmail').catch(() => []));
            const q = _buildGmailSearchQuery({ query, sender, dateFromIso: range.sinceIso, dateToIso: range.untilIso });
            const perAccountMax = Math.max(3, Math.floor(10 / Math.max(1, accounts.length)));
            const liveByAccount = await Promise.allSettled(accounts.map(async (a) => {
              const tokens = await loadGmailTokensForAccount(db, userId, a.accountEmail).then(x => x?.tokens).catch(() => null);
              if (!tokens) return [];
              const oauth2 = makeGmailOAuth2Client(); if (!oauth2) return [];
              oauth2.setCredentials(tokens);
              const gmail = google.gmail({ version: 'v1', auth: oauth2 });
              const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: perAccountMax }).catch(() => null);
              const ids = (list?.data?.messages || []).map(m => m.id).filter(id => !knownIds.has(id));
              const metas = await Promise.allSettled(ids.map((id) =>
                gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
                  .then(r => r.data)
              ));
              return metas.filter(m => m.status === 'fulfilled').map(m => {
                const d = m.value;
                const headers = d.payload?.headers || [];
                const h = (n) => headers.find(x => String(x.name || '').toLowerCase() === n.toLowerCase())?.value || '';
                const dateIso = (() => { const t = Date.parse(h('Date')); return Number.isFinite(t) ? new Date(t).toISOString() : null; })();
                return {
                  message_id: d.id,
                  thread_id: d.threadId,
                  summary: h('Subject') || (d.snippet || '').slice(0, 140),
                  category: null,
                  importance: null,
                  entity_name: null,
                  amount: null,
                  vendor: h('From'),
                  account_email: a.accountEmail,
                  action_required: null,
                  classified_at: dateIso,
                  source: 'gmail_live',
                  note: 'not yet classified',
                };
              });
            }));
            const live = [];
            for (const r of liveByAccount) if (r.status === 'fulfilled') live.push(...r.value);
            if (live.length) {
              results = results.concat(live).slice(0, cap);
              hasMore = true; // likely more exist
            }
          } catch { /* Gmail fallback is best-effort; never block. */ }
        }

        return {
          success: true,
          count: results.length,
          results,
          date_range: { from: range.fromLabel, to: range.toLabel, label: range.label },
          has_more: hasMore,
        };
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

      // ── PEOPLE / CONTACTS / SHARED ACCESS ──────────────────────────────
      case 'list_contacts': {
        const all = await db.getContactsForUser(userId);
        const q = String(toolInput.query || '').trim().toLowerCase();
        const filtered = q
          ? all.filter((c) =>
              (c.displayName || '').toLowerCase().includes(q) ||
              (c.primaryEmail || '').toLowerCase().includes(q))
          : all;
        return { success: true, contacts: filtered.slice(0, 50) };
      }

      case 'get_contact': {
        let contact = null;
        if (toolInput.contact_id) {
          contact = await db.getContactById(toolInput.contact_id, userId);
        }
        if (!contact && toolInput.email) {
          contact = await db.resolveContactByEmail(toolInput.email, userId);
        }
        if (!contact && toolInput.name) {
          const matches = await db.resolveContactByName(toolInput.name, userId);
          if (Array.isArray(matches) && matches.length === 1) contact = matches[0];
          else if (Array.isArray(matches) && matches.length > 1) {
            return {
              success: false,
              error: `Multiple contacts match "${toolInput.name}". Which one?`,
              candidates: matches.map((m) => ({ id: m.id, displayName: m.displayName, primaryEmail: m.primaryEmail })),
            };
          }
        }
        if (!contact) return { success: false, error: 'Contact not found. Provide contact_id, email, or name.' };

        const [allFacts, identities] = await Promise.all([
          db.getContactFacts(contact.id, userId),
          db.getContactIdentities(contact.id),
        ]);
        const notes = allFacts.filter((f) => f.factType === 'note').slice(0, 10);
        const facts = allFacts.filter((f) => f.factType !== 'note');
        return { success: true, contact, notes, facts, identities };
      }

      case 'create_contact': {
        if (!toolInput.display_name) {
          return { success: false, error: 'display_name is required' };
        }
        try {
          const contact = await db.createContact(userId, {
            displayName: String(toolInput.display_name).trim(),
            primaryEmail: toolInput.primary_email || null,
            primaryPhone: toolInput.primary_phone || null,
            company: toolInput.company || null,
            role: toolInput.role || null,
            notes: toolInput.notes || null,
            source: 'aria',
          });
          return { success: true, contact_id: contact.id, display_name: contact.displayName };
        } catch (e) {
          if (e.code === '23505') {
            return { success: false, error: 'A contact with this email already exists' };
          }
          return { success: false, error: e.message };
        }
      }

      case 'update_contact': {
        if (!toolInput.contact_id) {
          return { success: false, error: 'contact_id is required' };
        }
        const existing = await db.getContactById(toolInput.contact_id, userId);
        if (!existing) return { success: false, error: 'Contact not found' };
        const patch = {};
        if (toolInput.display_name !== undefined) patch.displayName = toolInput.display_name;
        if (toolInput.primary_email !== undefined) patch.primaryEmail = toolInput.primary_email || null;
        if (toolInput.company !== undefined) patch.company = toolInput.company || null;
        if (toolInput.role !== undefined) patch.role = toolInput.role || null;
        if (toolInput.notes !== undefined) patch.notes = toolInput.notes || null;
        try {
          const contact = await db.updateContact(toolInput.contact_id, userId, patch);
          return { success: true, contact_id: contact.id, display_name: contact.displayName };
        } catch (e) {
          if (e.code === '23505') {
            return { success: false, error: 'A contact with this email already exists' };
          }
          return { success: false, error: e.message };
        }
      }

      case 'note_about_contact': {
        if (!toolInput.contact_id || !toolInput.content) {
          return { success: false, error: 'contact_id and content are required' };
        }
        const existing = await db.getContactById(toolInput.contact_id, userId);
        if (!existing) return { success: false, error: 'Contact not found' };
        const text = String(toolInput.content).trim();
        if (!text) return { success: false, error: 'content is empty' };
        await db.addContactFact(userId, toolInput.contact_id, text, 'note', 0.5);
        // Fire-and-forget fact extraction — never awaited, never blocks.
        try {
          const { extractContactFacts } = require('./lib/contactFactExtractor.cjs');
          extractContactFacts(userId, toolInput.contact_id, existing.displayName, text)
            .catch((err) => console.error('[tools] fact extract:', err.message));
        } catch { /* extractor unavailable → skip silently */ }
        return { success: true, contact_id: toolInput.contact_id };
      }

      case 'list_shared_access': {
        const [given, received] = await Promise.all([
          db.getGrantsForGrantor(userId),
          db.getGrantsForGrantee(userId),
        ]);
        return { success: true, given, received };
      }

      case 'grant_shared_access': {
        if (!toolInput.grantee_email || !toolInput.scope) {
          return { success: false, error: 'grantee_email and scope are required' };
        }
        const VALID = new Set(['calendar_read', 'tasks_read', 'inbox_read', 'people_read', 'full_read']);
        if (!VALID.has(toolInput.scope)) {
          return { success: false, error: `Invalid scope. Allowed: ${[...VALID].join(', ')}` };
        }
        const grantee = await db.getUserByIdentifier(String(toolInput.grantee_email).trim());
        if (!grantee) return { success: false, error: 'User not on platform' };
        if (grantee.id === userId) return { success: false, error: 'Cannot grant access to yourself' };

        const expiresAt = toolInput.expires_at ? new Date(toolInput.expires_at) : null;
        if (toolInput.expires_at && Number.isNaN(expiresAt?.getTime())) {
          return { success: false, error: 'expires_at must be a valid ISO timestamp' };
        }
        try {
          const grant = await db.createGrant(userId, grantee.id, toolInput.scope, null, expiresAt);
          return { success: true, grant_id: grant.id, scope: grant.scope, grantee_email: grantee.email || null };
        } catch (e) {
          if (e.code === '23505') {
            return { success: false, error: 'Grant already exists for this grantee + scope' };
          }
          return { success: false, error: e.message };
        }
      }

      case 'revoke_shared_access': {
        const rawId = toolInput.grant_id;
        const id = typeof rawId === 'number' ? rawId : parseInt(String(rawId || ''), 10);
        if (!Number.isFinite(id)) return { success: false, error: 'grant_id is required' };
        const ok = await db.revokeGrant(id, userId);
        if (!ok) return { success: false, error: 'Grant not found' };
        return { success: true, grant_id: id };
      }

      // ── JOURNAL / DAILY WRAP ─────────────────────────────────────────────
      case 'create_journal_entry': {
        const zone = tz || 'America/Los_Angeles';
        const entryDate = new Intl.DateTimeFormat('en-CA', {
          timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        const patch = {};
        const FIELD_MAX = 10_000;
        const clamp = (v) => (typeof v === 'string' ? (v.length > FIELD_MAX ? v.slice(0, FIELD_MAX) : v) : undefined);
        if (toolInput.wins !== undefined)            patch.wins = clamp(toolInput.wins) ?? '';
        if (toolInput.frustrations !== undefined)    patch.frustrations = clamp(toolInput.frustrations) ?? '';
        if (toolInput.tomorrow_focus !== undefined)  patch.tomorrowFocus = clamp(toolInput.tomorrow_focus) ?? '';
        if (toolInput.raw_freeform !== undefined)    patch.rawFreeform = clamp(toolInput.raw_freeform) ?? '';
        if (toolInput.completed === true)            patch.completed = true;
        try {
          const entry = await db.upsertJournalEntry(userId, entryDate, patch);
          return { success: true, entry_date: entryDate, id: entry?.id || null, completed: !!entry?.completedAt };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'list_journal_entries': {
        const limit = Number.isFinite(toolInput.limit) ? Math.min(Math.max(toolInput.limit, 1), 100) : 20;
        const sinceDate = typeof toolInput.since_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(toolInput.since_date)
          ? toolInput.since_date
          : null;
        try {
          const entries = await db.listJournalEntries(userId, { limit, sinceDate });
          return { success: true, entries };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'get_today_close_loop_context': {
        const zone = tz || 'America/Los_Angeles';
        const todayDateKey = new Intl.DateTimeFormat('en-CA', {
          timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date());
        try {
          const { localMidnightUtc } = require('./lib/buildAgenticContext.cjs');
          const boundary = localMidnightUtc(zone, 0);
          const [pending, wrapped] = await Promise.all([
            db.getOpenCloseLoopItems ? db.getOpenCloseLoopItems(userId, boundary, 10) : Promise.resolve([]),
            db.hasCompletedWrap ? db.hasCompletedWrap(userId, todayDateKey) : Promise.resolve(false),
          ]);
          const pendingItems = (pending || []).map((p) => ({
            source_type: p.sourceType,
            source_id: p.sourceId,
            title: p.titleSnapshot || null,
            triggered_at: p.triggeredAt || null,
          }));
          return {
            success: true,
            wrapped_today: !!wrapped,
            pending_items: pendingItems,
            pending_count: pendingItems.length,
            today_date: todayDateKey,
          };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'close_task_with_note': {
        if (!toolInput.task_id || !toolInput.completion_note) {
          return { success: false, error: 'task_id and completion_note are required' };
        }
        const note = String(toolInput.completion_note).trim();
        if (!note) return { success: false, error: 'completion_note is empty' };
        const task = await db.getTaskById(toolInput.task_id, userId);
        if (!task) return { success: false, error: 'Task not found or access denied' };
        try {
          await db.updateTask(task.id, userId, { completionNote: note });
          // Resolve any pending close-loop row for this task (fire-and-forget
          // — failure here must not surface as a tool error).
          if (db.resolveCloseLoopItem) {
            db.resolveCloseLoopItem(userId, 'task', task.id).catch(() => {});
          }
          return { success: true, task_id: task.id, title: task.title };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'add_event_outcome_note': {
        if (!toolInput.event_id || !toolInput.note) {
          return { success: false, error: 'event_id and note are required' };
        }
        const note = String(toolInput.note).trim();
        if (!note) return { success: false, error: 'note is empty' };
        const eventId = String(toolInput.event_id);
        try {
          // Helper takes (userId, eventId, title, start, end, accountEmail, postNote).
          // Title/times/account are optional metadata — null is fine; the row
          // already exists when the user booked/imported the event.
          await db.upsertCalendarNotePost(userId, eventId, null, null, null, null, note);
          if (db.resolveCloseLoopItem) {
            db.resolveCloseLoopItem(userId, 'event', eventId).catch(() => {});
          }
          return { success: true, event_id: eventId };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'add_project_update_note': {
        if (!toolInput.project_id || !toolInput.note) {
          return { success: false, error: 'project_id and note are required' };
        }
        const note = String(toolInput.note).trim();
        if (!note) return { success: false, error: 'note is empty' };
        const project = await db.getProjectById(toolInput.project_id);
        if (!project) return { success: false, error: 'Project not found' };
        // Canonical entity access check — userId scoped, no role branching.
        try {
          const visible = await db.getEntitiesForUserWithMembership(userId, null);
          if (!visible.some((e) => e.id === project.entityId)) {
            return { success: false, error: 'Not a member of this entity' };
          }
        } catch {
          return { success: false, error: 'Access check failed' };
        }
        try {
          const created = await db.createProjectNote({
            projectId: project.id,
            taskId: null,
            entityId: project.entityId,
            body: note,
            createdBy: userId,
          });
          return { success: true, project_id: project.id, note_id: created?.id || null };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      default:
        return { success: false, error: 'Unknown tool' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { ARIA_TOOLS, executeTool, getToolByName, getToolSchemasForApi, requiresConfirmation, ALWAYS_CONFIRM };
