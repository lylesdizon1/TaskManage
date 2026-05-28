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

const crypto = require('crypto');
const { google } = require('googleapis');
const { loadGcalTokens, loadAllGcalAccounts, makeOAuth2Client, makeGmailOAuth2Client } = require('./utils/google.cjs');
const { encryptTokens, decryptTokens, ENCRYPTION_KEY } = require('./utils/crypto.cjs');
const { DEFAULT_TIMEZONE } = require('./utils/timezone.cjs');
const { toLocalIsoNoTz, addHoursLocalIso, compareLocalIso } = require('./utils/date.cjs');
const logger = require('../guardrails/logger.cjs');
const { inferRulesFromBehavior } = require('./lib/ruleEngine.cjs');
const { invalidateRulesCache } = require('./lib/ruleCache.cjs');
const { getEmailContent, searchGmail } = require('./lib/emailContent.cjs');
const { mergeAndSaveGmailTokens } = require('./lib/gmailTokenSaver.cjs');

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
    description: 'Create a calendar event in the user\'s primary Google Calendar. Double-check the date matches the user\'s words against the week map in your context (e.g., if user says "Tuesday 4/21" and your week map shows Tue=Apr 21, send 2026-04-21).',
    input_schema: {
      type: 'object',
      properties: {
        title:          { type: 'string' },
        start_datetime: { type: 'string', description: 'YYYY-MM-DDTHH:MM:SS in the user\'s LOCAL timezone — no Z suffix, no offset. Example: "2026-04-21T15:00:00" for 3pm on April 21 in the user\'s tz.' },
        end_datetime:   { type: 'string', description: 'Same format as start_datetime — bare local YYYY-MM-DDTHH:MM:SS. Optional; defaults to start + 1 hour.' },
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
    description: 'Update an existing calendar event in any of the user\'s connected calendars. Only include the fields you want to change. Double-check any new date matches the user\'s words against the week map in your context.',
    input_schema: {
      type: 'object',
      properties: {
        event_id:    { type: 'string' },
        title:       { type: 'string' },
        start_time:  { type: 'string', description: 'YYYY-MM-DDTHH:MM:SS in the user\'s LOCAL timezone — no Z suffix, no offset. Example: "2026-04-21T15:00:00".' },
        end_time:    { type: 'string', description: 'Same format as start_time — bare local YYYY-MM-DDTHH:MM:SS. Optional; only include if changing the end time.' },
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
    description: 'Create a new note. Pass image_blob_id when creating from a captured photo so the source image attaches to the note (and the call gets gated for user confirmation).',
    input_schema: {
      type: 'object',
      properties: {
        title:         { type: 'string' },
        content:       { type: 'string' },
        pillar:        { type: 'string', enum: ['hustle', 'home', 'grow', 'move'] },
        image_blob_id: { type: 'string', description: 'Optional: id of an image_blob that this note was captured from. Presence triggers user confirmation gate.' },
        source:        { type: 'string', description: 'Optional provenance string, e.g. "photo_whatsapp".' },
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
  {
    name: 'get_email_content',
    group: 'communication',
    risk: 'low',
    requires_confirmation: false,
    description: "Retrieve the full body, headers, and snippet of a single email. Use when you need the actual content of a message — to summarize, extract details, decide on archival, or answer questions about what's in it. Typical latency: 2–5 seconds cached/warm, up to 15 seconds for large emails (AmEx statements, marketing with heavy HTML). If the full body fetch times out the tool falls back to metadata-only and returns body_unavailable: true — tell the user honestly instead of inventing body content. On rate_limit or timeout failure, retry_after_seconds is included in the response; mirror that number to the user. Cached server-side for 5 minutes.",
    input_schema: {
      type: 'object',
      properties: {
        message_id:    { type: 'string', description: 'Gmail message id.' },
        account_email: { type: 'string', description: 'The receiving account; required to scope the Gmail API call.' },
      },
      required: ['message_id', 'account_email'],
    },
  },
  {
    name: 'search_email_content',
    group: 'communication',
    risk: 'low',
    requires_confirmation: false,
    description: "Search within a single email's body text for a substring. Returns matching context windows. Use when the user asks 'does that email mention X' or 'what did Paul say about Y'.",
    input_schema: {
      type: 'object',
      properties: {
        message_id:    { type: 'string' },
        account_email: { type: 'string' },
        query:         { type: 'string', description: 'Substring to find (case-insensitive).' },
      },
      required: ['message_id', 'account_email', 'query'],
    },
  },
  {
    name: 'search_gmail',
    group: 'communication',
    risk: 'low',
    requires_confirmation: false,
    description: "Search the user's Gmail mailbox for messages matching a query. Uses Gmail's native search syntax: scope aggressively with from:<sender> / subject:<text> / newer_than:7d / has:attachment / label:<name> / is:unread to keep results fast and relevant. Typical latency: 5–10 seconds for well-scoped queries (newer_than + from/subject), 10–20 seconds for broader searches. Queue the user with a realistic estimate before you call this ('Searching your Gmail for X from the last 30 days — about 10 seconds'). If multiple accounts are connected, searches run in parallel. Results cached 10 minutes. On timeout/rate_limit failure, retry_after_seconds is included — mirror that number to the user. Returns thread-level matches; follow up with get_email_content for a specific thread id. Use when the user asks to find an email and no message_id is known — this is the wide-mailbox equivalent of search_inbox (which only sees classified/flagged emails).",
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Gmail q= syntax. Examples: 'from:americanexpress.com newer_than:30d', 'subject:invoice has:attachment', 'from:paul railway config'. Prefer scoped queries — unscoped broad text searches are slow and may time out.",
        },
        account_email: {
          type: 'string',
          description: 'Optional — restrict to one connected Gmail account. Omit to search every connected account and merge results.',
        },
        max_results: {
          type: 'number',
          description: 'Max threads to return (default 10, cap 25).',
        },
      },
      required: ['query'],
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
    description: 'Create a new contact. Pass image_blob_id when creating from a captured business card so the source image attaches to the contact (and the call gets gated for user confirmation). Provide first_name + last_name when extractable from OCR; display_name will be derived from them if you omit it.',
    input_schema: {
      type: 'object',
      properties: {
        display_name:    { type: 'string', description: 'Optional if first_name + last_name are provided — derived as "First Last".' },
        first_name:      { type: 'string' },
        last_name:       { type: 'string' },
        primary_email:   { type: 'string' },
        primary_phone:   { type: 'string' },
        company:         { type: 'string' },
        role:            { type: 'string' },
        notes:           { type: 'string' },
        source:          { type: 'string', enum: ['manual', 'aria', 'business_card_ocr', 'calendar_sync'], description: 'Provenance tag. Set "business_card_ocr" when called from a capture_from_image business_card classification.' },
        image_blob_id:   { type: 'string', description: 'Optional: id of an image_blob this contact was captured from. Presence triggers user confirmation gate.' },
        raw_ocr_text:    { type: 'string', description: 'Optional: verbatim OCR text from the source card. Preserved for downstream search.' },
      },
      required: [],
    },
  },
  {
    name: 'update_contact',
    group: 'people',
    risk: 'low',
    requires_confirmation: false,
    description: 'Update an existing contact. Pass only the fields to change.',
    input_schema: {
      type: 'object',
      properties: {
        contact_id:    { type: 'string' },
        display_name:  { type: 'string' },
        first_name:    { type: 'string' },
        last_name:     { type: 'string' },
        primary_email: { type: 'string' },
        primary_phone: { type: 'string' },
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

  // ── MEMORY (M1a — explicit recall) ───────────────────────────────────
  // remember_this lets the user explicitly stamp a fact into long-term
  // memory. Persists at high strength (0.9) so the entry survives the
  // weekly decay floor. Channel-agnostic — works from web chat,
  // WhatsApp, future SMS identically. Non-gated: the user is the one
  // invoking, so no double-confirmation.
  {
    name: 'remember_this',
    group: 'memory',
    risk: 'low',
    requires_confirmation: false,
    description: "Save a fact to long-term memory. Use when the user explicitly asks to remember something (\"remember that I...\", \"don't forget...\", \"keep in mind...\"). If content is omitted, save the previous user message verbatim.",
    input_schema: {
      type: 'object',
      properties: {
        content:      { type: 'string', description: 'The fact text to save. If omitted, use the previous user message verbatim.' },
        contact_name: { type: 'string', description: 'Optional: if the fact is about a specific person, the name to resolve to a contact.' },
      },
      required: [],
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
    name: 'flag_email_as_crucial',
    group: 'communication',
    risk: 'low',
    requires_confirmation: false,
    description: 'Flag an email thread as crucial for later review. Creates a persistent flagged entry in the user\'s inbox. Use when the user says "flag this", "save this for later", "mark as important", or when you detect a high-importance email during conversation.',
    input_schema: {
      type: 'object',
      properties: {
        thread_id:     { type: 'string', description: 'The Gmail/Outlook thread ID' },
        account_email: { type: 'string', description: 'The connected email account' },
        subject:       { type: 'string', description: 'Email subject for display' },
        sender:        { type: 'string', description: 'Email sender for display' },
        reason:        { type: 'string', enum: ['manual', 'vip_sender', 'financial', 'confirmation_code', 'aria_decision'], description: 'Why this email is being flagged' },
      },
      required: ['thread_id', 'account_email', 'reason'],
    },
  },
  {
    name: 'bulk_archive_emails',
    group: 'communication',
    risk: 'high',
    requires_confirmation: false,
    description: 'Archive low-priority emails matching criteria (promotions / newsletters / social) for a single account. ALWAYS dry-run first and tell the user the count. Then call dry_run:false. Server-enforced ceilings: ≤50 emails — autonomous (no confirmation needed) — set expected_count to the dry-run count to prove you checked; 51–250 emails — confirmation required (system gate fires the same WhatsApp YES/NO or chat confirmation card as send_email); >250 emails — REJECTED, server refuses regardless of confirmation; narrow the criteria or run smaller batches. older_than_hours must be ≥24 — recent inbox is never bulk-archived.',
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
            older_than_hours:    { type: 'number', description: 'Minimum age in hours. Server enforces a floor of 24h regardless of value provided.' },
          },
        },
        dry_run: { type: 'boolean', description: 'Defaults true. Set false ONLY after presenting the dry-run count to the user.' },
        expected_count: { type: 'number', description: 'When dry_run:false, set to the count from your preceding dry_run. If ≤50, the call is autonomous; if absent or >50, the system gates with a confirmation card.' },
      },
      required: ['account_email', 'criteria'],
    },
  },
  {
    name: 'list_email_labels',
    group: 'communication',
    risk: 'low',
    requires_confirmation: false,
    description: "List the user's Gmail labels and Outlook folders with semantic categories and message counts. Use to reference labels by name or to suggest where to file an email.",
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_preference',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "Capture a user preference, rule, or constraint when the user explicitly states one. Call this immediately the moment the user says \"I prefer...\", \"Always...\", \"Never...\", \"Don't...\", \"Always ask before...\", or any similar directive. No need to ask permission — just call it.",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['tasks', 'calendar', 'email', 'communication', 'general'],
          description: 'Which surface this preference applies to. Use "general" only when nothing more specific fits.',
        },
        preference_type: {
          type: 'string',
          enum: ['always', 'never', 'ask_first', 'prefer', 'avoid'],
          description: "Polarity. 'never' and 'ask_first' are stored as constraints (hard stops or mandatory confirms). 'always'/'prefer'/'avoid' are preferences.",
        },
        description: {
          type: 'string',
          description: "Human-readable preference statement. Restate the user's words concisely (e.g. \"Ask before deleting tasks\", \"Never archive Rose Motorcars emails\").",
        },
        context: {
          type: 'string',
          description: 'Optional applicability scope (e.g. "weekends", "sender: Rose Motorcars", "between 6pm and 9am").',
        },
        strength: {
          type: 'number',
          description: 'Strength 1–5. 5 = ABSOLUTE (hard stop), 4 = STRONG (confirm first), 3 = NORMAL, 2 = WEAK, 1 = HINT. Default 3 if the user is ambiguous; use 5 for "always" / "never" said with conviction.',
        },
      },
      required: ['category', 'preference_type', 'description'],
    },
  },
  {
    name: 'list_preferences',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "List the user's active preferences and constraints. Use when the user asks \"what rules do I have?\" or before calling remove_preference (so you have the id).",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['tasks', 'calendar', 'email', 'communication', 'general'],
          description: 'Optional category filter.',
        },
        include_inactive: {
          type: 'boolean',
          description: 'Include disabled / removed preferences. Default false.',
        },
      },
    },
  },
  {
    name: 'remove_preference',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "Delete or disable a preference the user no longer wants. Always call list_preferences first to surface the preference_id. Always provide a reason for the audit trail.",
    input_schema: {
      type: 'object',
      properties: {
        preference_id: {
          type: 'number',
          description: 'The id from list_preferences.',
        },
        reason: {
          type: 'string',
          description: "Short audit-trail reason (e.g. \"user changed their mind\", \"superseded by stronger rule\").",
        },
      },
      required: ['preference_id', 'reason'],
    },
  },
  {
    name: 'list_rule_proposals',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "List pending rule proposals — patterns the trust loop has detected (e.g. user rejected an action 2+ times) and is suggesting as new behavior_rules. Show these to the user when they ask 'what's Aria suggested' / 'what rules can I accept' / 'show me proposals' OR when you want to surface a relevant pattern proactively. Each proposal includes a reasoning field explaining why it was suggested. Pair with accept_rule_proposal or reject_rule_proposal to act on one.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'accepted', 'rejected', 'expired', 'all'],
          description: "Filter by status. Default 'pending' (the actionable bucket).",
        },
        limit: {
          type: 'number',
          description: 'Max rows. Default 20, cap 100.',
        },
      },
    },
  },
  {
    name: 'accept_rule_proposal',
    group: 'intelligence',
    risk: 'medium',
    requires_confirmation: false,
    description: "Accept a pending rule proposal — materializes it as an active behavior_rule that gates future actions. ONLY call when the user has explicitly said to accept (e.g. 'yes accept that one', 'go ahead', 'sure, add it'). Never auto-accept. After accepting, the rule is live on the next chat turn — surface this to the user ('Done. From now on, [behavior].'). Reversible: the user can list_preferences then remove_preference if they regret it.",
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'id from list_rule_proposals.' },
      },
      required: ['proposal_id'],
    },
  },
  {
    name: 'reject_rule_proposal',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "Reject (dismiss) a pending rule proposal. Use when the user says 'no thanks', 'skip that', 'reject it', 'not interested'. Captures an optional reason for the audit trail (e.g. 'too aggressive', 'wrong scope', 'user wants different shape'). Doesn't delete the proposal — just flips status so it doesn't keep showing up in pending. The pattern that triggered it stays stamped, so the same pattern won't immediately re-propose.",
    input_schema: {
      type: 'object',
      properties: {
        proposal_id: { type: 'string', description: 'id from list_rule_proposals.' },
        reason: { type: 'string', description: 'Short reason for the audit trail.' },
      },
      required: ['proposal_id'],
    },
  },
  // ── Skills (agents-foundation v1, M1.6) ──────────────────────────────
  {
    name: 'list_skills',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "List the user's skills (active + draft + paused) — knowledge bodies that auto-load into your context when triggers match. Use when the user asks 'what skills do I have', 'show me my skills', or when you want to reference a specific skill they've defined. Skills are user-curated context (not instructions). Each row includes: name, description, status, persona scope, last loaded, invocation count.",
    input_schema: {
      type: 'object',
      properties: {
        include_inactive: { type: 'boolean', description: "Default true — drafts + paused are included so the user can see the full library. Set false to filter to active only." },
      },
    },
  },
  {
    name: 'create_skill',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "Create a NEW skill (a knowledge body the user wants you to load when relevant context comes up). When the user says 'save this as a skill', 'remember this for next time you talk about X', 'turn this into a skill called Y', or similar — extract a clean knowledge body from the conversation and call this. ALWAYS ships as is_active=false (draft) — the user reviews + activates from the Agents tab. Don't auto-activate. Provide either keywords (chip-input shape — auto-translates to topics-contains predicate) OR trigger_predicate (advanced JSON, engine-ext-2 grammar). source defaults to 'aria_proposed' — this is the V2-readiness path; user-authored skills go through the UI, not Aria.",
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: 'Short, distinctive name. Used to identify the skill in lists and in "use my <name> skill" requests.' },
        description: { type: 'string', description: 'One-line summary of what the skill knows.' },
        content:     { type: 'string', description: 'The knowledge body (markdown). What you should know when this skill loads.' },
        keywords:    { type: 'array', items: { type: 'string' }, description: 'Chip-input shape. Auto-translates to: { input: { or: [{ field: "topics", op: "contains", value: <kw> }, ...] } }. Lowercased + deduped. 80% of skills use this; only specify trigger_predicate for complex cases.' },
        trigger_predicate: { type: 'object', description: 'Advanced shape — full engine-ext-2 predicate JSON. Overrides keywords if both given. Use when you need people_mentioned / calendar_context / AND/OR composition.' },
        persona:     { type: 'string', description: "Optional persona scope — 'CFO' / 'COO' / 'Best-Friend' / etc. When set, the skill only loads when active_persona matches. Omit for unscoped (loads regardless of persona)." },
        token_cap:   { type: 'number', description: 'Per-skill content cap (tokens). Default 10000. Hard ceiling 30000.' },
        priority:    { type: 'number', description: 'Load priority 0..10. Default 5. Higher loads first when 15k turn budget is tight.' },
      },
      required: ['name', 'description', 'content'],
    },
  },
  {
    name: 'update_skill',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: true,
    description: "Edit an existing skill. Use when the user asks 'update my <name> skill — add X', 'change the trigger for <name>', or similar. Pass only the fields you're changing — others retain their values. Same field semantics as create_skill (keywords ↔ trigger_predicate translation). Confirmation required because Aria editing user-authored content can surprise — let the user OK the change.",
    input_schema: {
      type: 'object',
      properties: {
        skill_id:    { type: 'string', description: 'id from list_skills.' },
        name:        { type: 'string' },
        description: { type: 'string' },
        content:     { type: 'string' },
        keywords:    { type: 'array', items: { type: 'string' }, description: 'Replaces existing keywords + regenerates the topics-contains predicate. Pass empty array to clear keywords (predicate becomes null = explicit-only).' },
        trigger_predicate: { type: 'object', description: 'Advanced — overrides keywords. Pass null to clear.' },
        persona:     { type: 'string' },
        token_cap:   { type: 'number' },
        priority:    { type: 'number' },
        is_active:   { type: 'boolean', description: "Activate / pause via this field rather than the dedicated tools when you're already updating other fields in the same call." },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'activate_skill',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: true,
    description: "Flip a draft / paused skill to active so it auto-loads when triggers match. Use when the user explicitly says 'activate the X skill' or 'turn on my X skill'. Confirmation required since this changes what context loads on every future turn.",
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'id from list_skills.' },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'pause_skill',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "Pause a skill (sets is_active=false). It stays in the user's library but stops auto-loading. Use when the user says 'pause the X skill', 'don't load X anymore', 'turn off X'.",
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'id from list_skills.' },
      },
      required: ['skill_id'],
    },
  },
  {
    name: 'delete_skill',
    group: 'intelligence',
    risk: 'medium',
    requires_confirmation: true,
    description: "Permanently delete a skill. Irreversible — the user's content is gone. Always require confirmation. Prefer pause_skill for 'turn off' intent. Use only when the user says 'delete the X skill', 'remove X for good'.",
    input_schema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'id from list_skills.' },
      },
      required: ['skill_id'],
    },
  },
  // ── Sub-agents (agents-foundation v1, M3.7) ──────────────────────────
  {
    name: 'start_sub_agent',
    group: 'intelligence',
    risk: 'medium',
    requires_confirmation: false,
    description: "Spin up a bounded sub-agent for multi-step investigation work that would balloon a single chat turn. Best for: meeting prep ('prep me for tomorrow with Bob'), competitive analysis, catch-up summaries, vendor comparison — anything needing 5-30 read-only tool calls. Returns a session_id immediately; the agent runs async in the background and pings via WhatsApp on completion. Don't use for single-tool answers (just call the tool); don't use for write-heavy actions (sub-agents are READ-ONLY in V1). Max 2 concurrent runs per user — check list_sub_agent_runs first if uncertain.",
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to investigate. Be specific — agents are budget-bounded, vague prompts waste budget.' },
        definition_id: { type: 'string', description: "Sub-agent type. Default 'research_agent' (V1 ships only this template)." },
        budget_overrides: {
          type: 'object',
          description: 'Optional per-run budget caps (clamped to server max). Defaults from definition.',
          properties: {
            tool_calls:   { type: 'number', description: 'Max tool calls. Default 30, cap 50.' },
            wall_clock_ms:{ type: 'number', description: 'Max wall-clock ms. Default 300000 (5 min), cap 600000.' },
            tokens:       { type: 'number', description: 'Max LLM tokens across synthesis points. Default 30000, cap 60000.' },
            spend_usd:    { type: 'number', description: 'Max USD spend. Default 2.0, cap 5.0.' },
          },
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_sub_agent_runs',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "List recent sub-agent runs (default last 20). Use when the user asks 'what's running', 'show me my research', or when checking concurrency before dispatch (V1 cap = 2 active runs).",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['queued','running','completed','budget_exhausted','stagnated','failed','killed','active','all'], description: "Filter by status. 'active' = queued+running. 'all' = everything. Default 'all'." },
        limit:  { type: 'number', description: 'Max rows. Default 20, cap 100.' },
      },
    },
  },
  {
    name: 'get_sub_agent_result',
    group: 'intelligence',
    risk: 'low',
    requires_confirmation: false,
    description: "Get the structured result of a completed sub-agent run. Returns summary + key_findings (with sources) + action_items + confidence + budget_used. Use when the user asks 'how did the research go' or 'what did you find on the X investigation'.",
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'id from list_sub_agent_runs.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'kill_sub_agent',
    group: 'intelligence',
    risk: 'medium',
    requires_confirmation: true,
    description: "Cancel a running sub-agent. The orchestrator checks status at every phase boundary — kill takes effect within ~30s. Use when the user explicitly says 'stop the research', 'cancel that run'. Confirmation required (lose in-flight work).",
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'id from list_sub_agent_runs.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'move_email',
    group: 'communication',
    risk: 'low',
    requires_confirmation: true,
    description: "Move an email to a Gmail label or Outlook folder. scope='thread' moves only this email; scope='sender' or 'domain' also records a filing pattern so future emails matching the same predicate can be auto-filed (after user approval).",
    input_schema: {
      type: 'object',
      properties: {
        message_id:        { type: 'string', description: 'Gmail message id to move.' },
        account_email:     { type: 'string', description: 'Receiving inbox account.' },
        target_label_id:   { type: 'string', description: 'Gmail label id to apply.' },
        target_label_name: { type: 'string', description: 'Human-readable label name (for the filing pattern record).' },
        scope:             { type: 'string', enum: ['thread', 'sender', 'domain'], description: 'thread = just this email; sender = future emails from this sender; domain = future emails from this domain.' },
      },
      required: ['message_id', 'account_email', 'target_label_id', 'target_label_name', 'scope'],
    },
  },

  // ── CAPTURE / VISION (Commit A — OCR via WhatsApp) ─────────────────────
  // Called once per image-bearing turn. Aria reads the photo, picks the
  // best classification, extracts structured fields, and reports back.
  // The executor does no user-data writes — it persists the classification
  // result and returns the structured payload so Aria can reason about
  // next steps (call create_note for documents, surface extracted contact
  // fields for business cards until create_contact lands in Commit B,
  // etc).
  //
  // Confidence is the LOWER of (classification confidence, extraction
  // confidence) — a sharp class call with blurry fields should report low.
  // Below 0.5 (or class='unclear'), Aria falls back to describe-and-suggest
  // without saving.
  {
    name: 'capture_from_image',
    group: 'capture',
    risk: 'low',
    requires_confirmation: false,
    description: 'Classify a user-submitted photo and extract structured content. Call exactly once per image, before deciding what to save. For documents you may then call create_note with the extracted title + body. For business_card use create_contact. For food use log_food — pass the description verbatim from your summary, the image_blob_id, and (when the photo arrived via WhatsApp) the inbound message id as source_msg_id.',
    input_schema: {
      type: 'object',
      properties: {
        image_blob_id:   { type: 'string', description: 'The id from the system prompt for the just-arrived image.' },
        classification: { type: 'string', enum: ['business_card', 'food', 'document', 'unclear'] },
        confidence:     { type: 'number', minimum: 0, maximum: 1 },
        raw_text:       { type: 'string', maxLength: 8000, description: 'Verbatim OCR\'d text from the image. Required regardless of class — used for downstream search.' },
        summary:        { type: 'string', maxLength: 200, description: 'One-line human-readable description of the image.' },
        business_card:  {
          type: 'object',
          description: 'Populate when classification = business_card.',
          properties: {
            full_name: { type: 'string' },
            company:   { type: 'string' },
            role:      { type: 'string' },
            email:     { type: 'string' },
            phone:     { type: 'string' },
            website:   { type: 'string' },
            address:   { type: 'string' },
          },
        },
        food: {
          type: 'object',
          description: 'Populate when classification = food.',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name:                { type: 'string' },
                  quantity:            { type: 'string' },
                  estimated_calories:  { type: 'integer' },
                },
              },
            },
            total_estimated_calories: { type: 'integer' },
            meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack', 'unknown'] },
          },
        },
        document: {
          type: 'object',
          description: 'Populate when classification = document.',
          properties: {
            title: { type: 'string', description: 'Inferred title from content; empty if no clear title.' },
            tags:  { type: 'array', items: { type: 'string' }, description: 'Inferred or #hash-extracted tags.' },
          },
        },
      },
      required: ['image_blob_id', 'classification', 'confidence', 'raw_text'],
    },
  },
  {
    name: 'log_food',
    group: 'capture',
    risk: 'low',
    requires_confirmation: false,
    description: 'Persist a food/meal entry to the user\'s food log. Provide a single natural-language `description` (e.g. "2 large eggs, toast, and black coffee" or the food-class summary from capture_from_image). Aria\'s nutrition engine re-estimates per-item macros server-side, so you do NOT need to pass items/calories. Optional: `image_blob_id` to attach a photo, `source_msg_id` for idempotent WhatsApp re-deliveries, `note` for user-provided context. local_date defaults to the user\'s today in their timezone.',
    input_schema: {
      type: 'object',
      properties: {
        description:    { type: 'string', maxLength: 4000, description: 'Plain-language meal description. Required.' },
        local_date:     { type: 'string', description: 'YYYY-MM-DD, user-local. Defaults to today.' },
        source:         { type: 'string', enum: ['chat', 'whatsapp_ocr', 'manual'], description: 'Defaults to whatsapp_ocr when called from WhatsApp, else chat.' },
        image_blob_id:  { type: 'string', description: 'Attach photo from a prior capture_from_image call.' },
        source_msg_id:  { type: 'string', description: 'Inbound message id (UltraMsg id or Twilio MessageSid). Idempotency key.' },
        note:           { type: 'string', maxLength: 500 },
      },
      required: ['description'],
    },
  },
];

const ALWAYS_CONFIRM = new Set(['send_email', 'reply_email', 'delete_task', 'delete_event']);

function getToolByName(name) {
  return ARIA_TOOLS.find(t => t.name === name) || null;
}

// ── Skills tool helpers (agents-foundation v1, M1.6) ──────────────────
//
// Translate the chip-input keyword shape into the engine-ext-2 predicate
// JSON. Spec §5d D2 "Round-trip semantics":
//   { input: { or: [{ field: 'topics', op: 'contains', value: <kw> }, ...] } }
// Empty / null keywords + null trigger_predicate → null predicate
// (skill becomes explicit-only, never auto-loads).
function _composeSkillPredicate({ keywords, trigger_predicate }) {
  if (trigger_predicate !== undefined) {
    return trigger_predicate; // explicit override (incl. null to clear)
  }
  if (Array.isArray(keywords)) {
    const cleaned = Array.from(new Set(
      keywords
        .map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
        .filter((k) => k.length > 0),
    ));
    if (cleaned.length === 0) return null;
    return {
      input: {
        or: cleaned.map((k) => ({ field: 'topics', op: 'contains', value: k })),
      },
    };
  }
  return undefined; // means "don't change" for update_skill
}

function _clampTokenCap(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 10000;
  return Math.max(1, Math.min(30000, Math.round(v)));
}

function _clampPriority(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 5;
  return Math.max(0, Math.min(10, Math.round(v)));
}

// Sub-agent budget composer (M3.7). Server-side caps per spec D4 +
// research-agents-spec-v1.md. Defaults come from the definition row;
// overrides clamped to server max.
const SUB_AGENT_BUDGET_CAPS = {
  tool_calls: 50,
  wall_clock_ms: 10 * 60 * 1000,  // 10 min
  tokens: 60000,
  spend_usd: 5.0,
};
function _composeSubAgentBudget(defaultBudget = {}, overrides = {}) {
  const out = { ...defaultBudget };
  for (const k of Object.keys(SUB_AGENT_BUDGET_CAPS)) {
    if (overrides && overrides[k] !== undefined) {
      const v = Number(overrides[k]);
      if (Number.isFinite(v) && v > 0) {
        out[k] = Math.min(v, SUB_AGENT_BUDGET_CAPS[k]);
      }
    } else if (out[k] !== undefined) {
      out[k] = Math.min(Number(out[k]) || SUB_AGENT_BUDGET_CAPS[k], SUB_AGENT_BUDGET_CAPS[k]);
    }
  }
  return out;
}

/**
 * Anthropic's server-hosted web search tool. Server-side tools have a
 * different shape than function tools — `type` + `name` only, no schema.
 * The API invokes + resolves these internally and the result blocks
 * appear in the same response as the model's text, so our agentic loop
 * doesn't need to dispatch anything for it.
 */
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 5,
};

/**
 * Strip metadata fields before sending tools to the Anthropic API. The
 * model should only see { name, description, input_schema } for custom
 * function tools. Server-hosted web_search is appended as-is.
 */
function getToolSchemasForApi() {
  const functionTools = ARIA_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  return [...functionTools, WEB_SEARCH_TOOL];
}

// Bulk-archive autonomy thresholds — server-authoritative.
// ≤50 emails: autonomous (model self-reports expected_count)
// 51–250:    confirmation required via the existing gate (WhatsApp YES/NO or chat card)
// >250:      hard cap, refused inside the tool body regardless of confirmation
const BULK_ARCHIVE_AUTONOMY_THRESHOLD = 50;
const BULK_ARCHIVE_HARD_CAP = 250;

/**
 * Resolve whether a tool requires user confirmation (server-authoritative).
 *
 * Sources, highest precedence first:
 *  1. ALWAYS_CONFIRM list (send_email, reply_email, delete_task, delete_event)
 *  2. Tool-static `requires_confirmation: true` in ARIA_TOOLS
 *  3. LLM-emitted `<decision>{requires_confirmation: true}</decision>`
 *  4. Tool-specific dynamic gates (bulk_archive_emails count threshold)
 */
function requiresConfirmation(toolName, llmDecision, toolInput) {
  if (ALWAYS_CONFIRM.has(toolName)) return true;
  const tool = getToolByName(toolName);
  if (tool?.requires_confirmation) return true;
  if (llmDecision?.requires_confirmation === true) return true;
  // bulk_archive_emails count gate. dry_run:true is read-only — never gated.
  // dry_run:false with expected_count > threshold OR expected_count missing
  // → require confirmation so a forgotten/lying expected_count fails closed.
  if (toolName === 'bulk_archive_emails' && toolInput?.dry_run === false) {
    const expected = Number.parseInt(toolInput?.expected_count, 10);
    if (!Number.isFinite(expected) || expected > BULK_ARCHIVE_AUTONOMY_THRESHOLD) return true;
  }
  // Capture pipeline (Commit A) — gate SAVE tools called with a source
  // image_blob_id. Photos are easy to send by accident and OCR extraction
  // can mis-classify; always ask before saving. capture_from_image is
  // the classification step, NOT a save — it gets image_blob_id in its
  // schema by design (Aria needs to echo the id back) and must NOT be
  // gated. Bug fix 2026-05-15: the prior "any tool with image_blob_id"
  // rule was over-broad and caught capture_from_image itself, breaking
  // every image-bearing turn after the first.
  if (toolInput?.image_blob_id && IMAGE_SAVE_TOOLS.has(toolName)) return true;
  return false;
}

// Save tools that should always gate when called with image_blob_id.
const IMAGE_SAVE_TOOLS = new Set(['create_note', 'create_contact', 'log_food']);

// ── Tool error sanitisation ────────────────────────────────────────────────
// Shaped reasons we expose to the LLM (and via SSE to the user). Anything
// outside this map gets bucketed to 'unknown'. Keep the set small — every
// new code is a contract Aria's prompt has to be aware of.
const TOOL_ERROR_TEXT = {
  rate_limit: 'API rate limit hit — try again in a moment.',
  auth:       'Authentication expired. Reconnect the account in Settings.',
  not_found:  'Item not found.',
  permission: 'Account is missing the required permission. Reconnect in Settings.',
  network:    'Network error reaching the API.',
  timeout:    'API call timed out.',
  unknown:    'API call failed.',
};

/**
 * Map a googleapis / fetch error to a sanitized { reason, error } pair.
 * Logs the raw err.message + status under the given label so postmortem
 * is one Railway query; only returns the bucketed reason and the safe
 * user-facing string. Use whenever a tool catches an external API failure
 * and needs to return to the agentic loop.
 */
function sanitizeApiError(err, label, ctx = {}) {
  const status = err?.code || err?.response?.status || err?.status || null;
  const raw = String(err?.message || '');
  const lowered = raw.toLowerCase();
  let reason = 'unknown';
  if (status === 401 || /unauthorized|invalid[_ ]?grant|invalid[_ ]?token/i.test(lowered)) reason = 'auth';
  else if (status === 403 || /insufficient|permission/i.test(lowered))                     reason = 'permission';
  else if (status === 404)                                                                  reason = 'not_found';
  else if (status === 429 || /rate.?limit|quota|too many requests/i.test(lowered))         reason = 'rate_limit';
  else if (/timeout|timed[ -]?out|etimedout/i.test(lowered))                                reason = 'timeout';
  else if (/network|enotfound|econnreset|econnrefused|fetch failed/i.test(lowered))         reason = 'network';
  logger.warn(`tools.${label}.apiError`, { ...ctx, status, reason, raw });
  return { reason, error: TOOL_ERROR_TEXT[reason] };
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

// mergeAndSaveGmailTokens lives in server/lib/gmailTokenSaver.cjs so
// this file's call sites and gmail.cjs's scan handler share one lock
// Map. See that module for the rationale.

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

async function executeTool(toolName, toolInput, userId, entityIds, db, tz, channel) {
  // M1a (2026-05-26) — `channel` is the source_channel enum value
  // captured by the route's boundExecuteTool closure ('web_chat' from
  // ai.cjs, 'whatsapp' from whatsapp.cjs). Tools that persist to
  // memory_facts use this for provenance; other tools ignore it.
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
        // Phase 2 — fire-and-forget pattern inference, never blocks return.
        setImmediate(() => {
          inferRulesFromBehavior(userId, 'task_created', { taskId: id, entityName: toolInput.entity_name }, 'success').catch(() => {});
        });
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
        // Phase 2 — fire-and-forget pattern inference.
        setImmediate(() => {
          inferRulesFromBehavior(userId, 'task_completed', { taskId: task.id, hasNote: !!toolInput.completion_note }, 'success').catch(() => {});
        });
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

        const userTz = tz || DEFAULT_TIMEZONE;
        // Normalize start to bare-local YYYY-MM-DDTHH:MM:SS in the user's tz so
        // the (dateTime, timeZone) pair Google receives is unambiguous. If
        // Aria sends a Z- or offset-suffixed string, we re-express it in the
        // user's tz; if bare-local, we treat it as already user-local.
        const startDt = toLocalIsoNoTz(start_datetime, userTz);
        if (!startDt) return { success: false, error: `Invalid start_datetime: "${start_datetime}".` };

        let endDt;
        if (end_datetime) {
          endDt = toLocalIsoNoTz(end_datetime, userTz);
          if (!endDt) return { success: false, error: `Invalid end_datetime: "${end_datetime}".` };
          if (compareLocalIso(endDt, startDt) <= 0) return { success: false, error: 'end_datetime must be after start_datetime.' };
        } else {
          // Wall-clock +1h on the local string — independent of server tz.
          // Old impl used new Date() arithmetic on a UTC server which produced
          // wrong end times when start carried a Z or offset.
          endDt = addHoursLocalIso(startDt, 1);
        }

        // Deterministic event id for idempotency. The agentic loop's 30s
        // tool timeout (Promise.race in agenticLoop.cjs) can fire AFTER
        // Google has already created the event but BEFORE we get the
        // response — a retry would otherwise insert a duplicate. SHA1
        // hex (40 chars, [0-9a-f]) fits Google's id alphabet of [a-v0-9].
        // On the rare 409 (duplicate) we fetch and return the existing
        // event so the LLM sees a clean success.
        const idempotencyKey = crypto.createHash('sha1')
          .update(`${userId}|${title}|${startDt}|${endDt}|${location || ''}`)
          .digest('hex');

        const googlePayload = {
          id: idempotencyKey,
          summary: title,
          start: { dateTime: startDt, timeZone: userTz },
          end:   { dateTime: endDt,   timeZone: userTz },
          ...(eventDesc && { description: eventDesc }),
          ...(location  && { location }),
          ...(attendees?.length && { attendees: attendees.map(email => ({ email })) }),
        };

        // Diagnostic log — captures raw input vs. what we sent. If a future
        // user reports a wrong-day event, this single line shows whether the
        // model picked the wrong date (raw_start mismatch) or the tool
        // mangled it (sent_start mismatch).
        logger.info('tools.create_event.input', {
          userId, tz: userTz,
          raw_start: start_datetime, raw_end: end_datetime || null,
          sent_start: startDt, sent_end: endDt,
          end_defaulted: !end_datetime,
        });

        let created;
        let idempotencyHit = false;
        try {
          const resp = await calendar.events.insert({ calendarId: 'primary', requestBody: googlePayload });
          created = resp.data;
        } catch (err) {
          // 409 = duplicate id. We've been here before (timeout retry).
          // Fetch the original event and return it as the success result.
          if (err.code === 409 || err.response?.status === 409) {
            try {
              const got = await calendar.events.get({ calendarId: 'primary', eventId: idempotencyKey });
              created = got.data;
              idempotencyHit = true;
              logger.info('tools.create_event.idempotent', { userId, event_id: idempotencyKey });
            } catch (getErr) {
              logger.error('tools.create_event.idempotency.fetchFailed', {
                userId, event_id: idempotencyKey, error: getErr.message,
              });
              return { success: false, error: `Calendar API failed: ${err.message}` };
            }
          } else {
            logger.error('tools.create_event.failed', {
              userId, raw_start: start_datetime, sent_start: startDt, error: err.message,
            });
            return { success: false, error: `Calendar API failed: ${err.message}` };
          }
        }

        // Pair-line with the input log: confirms what Google actually stored.
        logger.info('tools.create_event.success', {
          userId, event_id: created.id,
          sent_start: startDt, sent_end: endDt,
          returned_start: created.start?.dateTime || created.start?.date || null,
          returned_end:   created.end?.dateTime   || created.end?.date   || null,
          returned_tz: created.start?.timeZone || null,
        });

        try {
          await db.logMemory({ userId, tool: 'create_event', content: `Created event: "${title}" at ${startDt}`, metadata: { event_id: created.id, title, start: startDt, idempotent: idempotencyHit } });
        } catch {}
        return { success: true, event_id: created.id, title: created.summary, start: created.start?.dateTime || created.start?.date, link: created.htmlLink, ...(idempotencyHit && { already_created: true }) };
      }

      case 'update_event': {
        const accounts = (await loadAllGcalAccounts(userId, db)) || [];
        if (!accounts.length) return { success: false, error: 'Google Calendar not connected.' };

        const userTz = tz || DEFAULT_TIMEZONE;
        // Normalize any TZ-marked input to bare-local in user's tz so the
        // (dateTime, timeZone) Google receives is unambiguous. Same fix as
        // create_event — see commit b579032.
        let sentStart = null;
        let sentEnd = null;
        if (toolInput.start_time) {
          sentStart = toLocalIsoNoTz(toolInput.start_time, userTz);
          if (!sentStart) return { success: false, error: `Invalid start_time: "${toolInput.start_time}".` };
        }
        if (toolInput.end_time) {
          sentEnd = toLocalIsoNoTz(toolInput.end_time, userTz);
          if (!sentEnd) return { success: false, error: `Invalid end_time: "${toolInput.end_time}".` };
        }
        // Only enforce ordering when BOTH are provided — partial updates
        // (e.g. start-only) are valid and Google handles them.
        if (sentStart && sentEnd && compareLocalIso(sentEnd, sentStart) <= 0) {
          return { success: false, error: 'end_time must be after start_time.' };
        }

        // One-shot input log — covers all account-loop iterations so we
        // don't spam Railway with N-account-many lines per call.
        logger.info('tools.update_event.input', {
          userId, tz: userTz, event_id: toolInput.event_id,
          raw_start: toolInput.start_time || null,
          raw_end:   toolInput.end_time   || null,
          sent_start: sentStart, sent_end: sentEnd,
          changed_fields: Object.keys(toolInput).filter((k) => k !== 'event_id' && toolInput[k] !== undefined),
        });

        let lastError = null;
        for (const acct of accounts) {
          const oauth2 = makeOAuth2Client(); if (!oauth2) continue;
          oauth2.setCredentials(acct.tokens);
          const calendar = google.calendar({ version: 'v3', auth: oauth2 });
          try {
            const existing = await calendar.events.get({ calendarId: 'primary', eventId: toolInput.event_id });
            if (!existing?.data) continue;

            // Partial-update ordering check — when only ONE side is being
            // changed, compare against the unchanged side from the existing
            // event so we don't accept e.g. a new start that lands after
            // the existing end (which would create a negative-length event
            // until manual fix). The both-provided case was already checked
            // above; this handles the one-side case.
            if (sentStart && !sentEnd) {
              const existingEndStr = existing.data.end?.dateTime || existing.data.end?.date;
              if (existingEndStr) {
                const existingEndLocal = toLocalIsoNoTz(existingEndStr, userTz);
                if (existingEndLocal && compareLocalIso(existingEndLocal, sentStart) <= 0) {
                  return { success: false, error: 'New start_time would be at or after the existing end_time. Provide end_time too.' };
                }
              }
            }
            if (sentEnd && !sentStart) {
              const existingStartStr = existing.data.start?.dateTime || existing.data.start?.date;
              if (existingStartStr) {
                const existingStartLocal = toLocalIsoNoTz(existingStartStr, userTz);
                if (existingStartLocal && compareLocalIso(sentEnd, existingStartLocal) <= 0) {
                  return { success: false, error: 'New end_time would be at or before the existing start_time. Provide start_time too.' };
                }
              }
            }

            const patch = {};
            if (toolInput.title !== undefined)       patch.summary     = toolInput.title;
            if (toolInput.description !== undefined) patch.description = toolInput.description;
            if (toolInput.location !== undefined)    patch.location    = toolInput.location;
            if (sentStart) patch.start = { dateTime: sentStart, timeZone: userTz };
            if (sentEnd)   patch.end   = { dateTime: sentEnd,   timeZone: userTz };

            const { data: updated } = await calendar.events.patch({
              calendarId: 'primary', eventId: toolInput.event_id, requestBody: patch,
            });

            logger.info('tools.update_event.success', {
              userId, event_id: updated.id, account_email: acct.googleEmail || null,
              sent_start: sentStart, sent_end: sentEnd,
              returned_start: updated.start?.dateTime || updated.start?.date || null,
              returned_end:   updated.end?.dateTime   || updated.end?.date   || null,
              returned_tz: updated.start?.timeZone || null,
              patched_keys: Object.keys(patch),
            });

            try { await db.logMemory({ userId, tool: 'update_event', content: `Updated event: "${updated.summary}"`, metadata: { event_id: updated.id, changes: Object.keys(patch) } }); } catch {}
            return { success: true, event_id: updated.id, title: updated.summary, account_email: acct.googleEmail || null };
          } catch (err) {
            if (err.code === 404 || err.response?.status === 404) continue;
            lastError = err;
            logger.warn('tools.update_event.account_error', {
              userId, event_id: toolInput.event_id, account_email: acct.googleEmail || null,
              error: err.message,
            });
            return { success: false, error: err.message };
          }
        }
        // All accounts returned 404 (or no calendar ever responded). Log the
        // miss so we can spot patterns of stale event_ids being passed in.
        logger.info('tools.update_event.not_found', {
          userId, event_id: toolInput.event_id, accounts_tried: accounts.length,
          last_error: lastError?.message || null,
        });
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
        // Image-attached notes append a footer line so the source-photo
        // provenance is visible inline in the note body. The image_blob_id
        // itself isn't stored on notes today — Commits B/D land the
        // notes.image_blob_id column + image rendering on the detail view.
        // For Commit A the body footer is the audit trail.
        let content = toolInput.content || '';
        if (toolInput.image_blob_id) {
          content = `${content.trim()}\n\n_Captured from photo._`;
        }
        await db.createNote({
          id, userId,
          title: toolInput.title, content,
          visibility: 'private', type: 'quick',
          pillar: toolInput.pillar || null,
          category: '', subcategory: '', tags: [], entityId: null,
        });
        try {
          await db.logMemory({
            userId,
            tool: 'create_note',
            content: `Created note: "${toolInput.title}"`,
            metadata: { note_id: id, image_blob_id: toolInput.image_blob_id || null, source: toolInput.source || null },
          });
        } catch {}
        return { success: true, note_id: id, title: toolInput.title };
      }

      // ── CAPTURE (Commit A — OCR pipeline) ────────────────────────────
      // capture_from_image does no user-data writes itself. It records
      // the classification result against the image_blob (for audit +
      // future re-render) and echoes the structured payload back to
      // Aria. The model then chooses next steps:
      //   - document → call create_note with title + body (gated)
      //   - business_card → describe extracted fields; create_contact
      //     lands in Commit B
      //   - food → describe extracted items; log_food lands in Commit C
      //   - unclear → describe and suggest fallback
      case 'capture_from_image': {
        const ix = toolInput || {};
        try {
          await db.logMemory({
            userId,
            tool: 'capture_from_image',
            content: `Classified image as ${ix.classification} (confidence ${ix.confidence})${ix.summary ? `: ${ix.summary}` : ''}`,
            metadata: {
              image_blob_id: ix.image_blob_id,
              classification: ix.classification,
              confidence: ix.confidence,
              has_business_card: !!ix.business_card,
              has_food: !!ix.food,
              has_document: !!ix.document,
            },
          });
        } catch (e) { console.error('[memory] capture log failed:', e.message); }
        return {
          success: true,
          image_blob_id: ix.image_blob_id,
          classification: ix.classification,
          confidence: ix.confidence,
          summary: ix.summary || null,
          raw_text: ix.raw_text || '',
          extracted: ix.business_card || ix.food || ix.document || null,
        };
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
        const { row: integrationRow, tokens } = await loadGmailTokensForAccount(db, userId, account_email, 'send_email');
        if (!tokens) return { success: false, error: `No Gmail tokens for ${account_email}. Reconnect in Settings.` };
        // Use the integration row's canonical accountEmail as the From
        // address — the LLM-supplied account_email is matched
        // case/whitespace-insensitively in the lookup, but we don't trust
        // it as a header value (could be re-cased, padded, or truncated;
        // the canonical form was captured at OAuth callback).
        const fromAddress = integrationRow?.accountEmail || account_email;
        const oauth2 = makeGmailOAuth2Client();
        if (!oauth2) return { success: false, error: 'Google OAuth not configured.' };
        oauth2.setCredentials(tokens);
        oauth2.on('tokens', async (nt) => { await mergeAndSaveGmailTokens(db, userId, fromAddress, nt).catch(() => {}); });
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        const raw = buildRawMime({ to, from: fromAddress, subject, body });
        try {
          const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
          try { await db.logMemory({ userId, tool: 'send_email', content: `Sent email to ${to}: "${subject}"`, metadata: { message_id: data.id, account_email } }); } catch {}
          return { success: true, message_id: data.id, thread_id: data.threadId, account_email };
        } catch (err) {
          return { success: false, ...sanitizeApiError(err, 'send_email', { userId, account: fromAddress }) };
        }
      }

      case 'reply_email': {
        const { message_id, thread_id, body, account_email } = toolInput || {};
        const { row: integrationRow, tokens } = await loadGmailTokensForAccount(db, userId, account_email, 'reply_email');
        if (!tokens) return { success: false, error: `No Gmail tokens for ${account_email}.` };
        const fromAddress = integrationRow?.accountEmail || account_email;
        const oauth2 = makeGmailOAuth2Client(); if (!oauth2) return { success: false, error: 'Google OAuth not configured.' };
        oauth2.setCredentials(tokens);
        oauth2.on('tokens', async (nt) => { await mergeAndSaveGmailTokens(db, userId, fromAddress, nt).catch(() => {}); });
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
            to: origFrom, from: fromAddress,
            subject: origSubject.toLowerCase().startsWith('re:') ? origSubject : `Re: ${origSubject}`,
            body,
            inReplyTo: origMsgId,
            references: [origRefs, origMsgId].filter(Boolean).join(' '),
          });
          const { data } = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId: thread_id } });
          try { await db.logMemory({ userId, tool: 'reply_email', content: `Replied to "${origSubject}"`, metadata: { message_id: data.id, thread_id, account_email } }); } catch {}
          return { success: true, message_id: data.id, thread_id: data.threadId, account_email };
        } catch (err) {
          return { success: false, ...sanitizeApiError(err, 'reply_email', { userId, account: fromAddress, thread_id }) };
        }
      }

      case 'flag_email_as_crucial': {
        const { thread_id, account_email, subject, sender, reason } = input;
        if (!thread_id) return { success: false, error: 'thread_id required' };

        // Ensure inbox_item exists
        const flagExists = await db.inboxItemExistsBySourceId(userId, thread_id);
        if (!flagExists) {
          const flagId = `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          await db.createInboxItem({
            id: flagId, userId, type: 'EMAIL',
            title: subject || '(no subject)',
            summary: '',
            source: (account_email || '').includes('outlook') ? 'outlook' : 'gmail',
            sourceId: thread_id,
            gmailThreadId: thread_id,
            gmailLink: `https://mail.google.com/mail/u/0/#inbox/${thread_id}`,
            sender: sender || null,
          });
        }

        const { rows: flagRows } = await db.pool.query(
          'SELECT id FROM inbox_items WHERE user_id = $1 AND source_id = $2',
          [userId, thread_id],
        );
        if (flagRows[0]) {
          await db.flagInboxItem(flagRows[0].id, userId, reason || 'aria_decision');
        }

        try { await db.logMemory({ userId, tool: 'flag_email_as_crucial', content: `Flagged email "${subject || thread_id}" as ${reason}`, metadata: { thread_id, reason } }); } catch {}
        return { success: true, flagged: true, reason };
      }

      case 'archive_email': {
        const { message_id, account_email } = toolInput || {};
        const { tokens } = await loadGmailTokensForAccount(db, userId, account_email, 'archive_email');
        if (!tokens) return { success: false, error: `No Gmail tokens for ${account_email}.` };
        const oauth2 = makeGmailOAuth2Client(); if (!oauth2) return { success: false, error: 'Google OAuth not configured.' };
        oauth2.setCredentials(tokens);
        oauth2.on('tokens', async (nt) => { await mergeAndSaveGmailTokens(db, userId, account_email, nt).catch(() => {}); });
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        try {
          await gmail.users.messages.modify({ userId: 'me', id: message_id, requestBody: { removeLabelIds: ['INBOX'] } });
          try { await db.logMemory({ userId, tool: 'archive_email', content: `Archived email ${message_id}`, metadata: { message_id, account_email } }); } catch {}
          // Phase 2 — fire-and-forget pattern inference (frequency_pattern
          // detector is stubbed today; this hook is the data-collection
          // entry point for when it lands).
          setImmediate(() => {
            inferRulesFromBehavior(userId, 'email_archived', { messageId: message_id, accountEmail: account_email }, 'success').catch(() => {});
          });
          return { success: true, message_id, account_email };
        } catch (err) {
          return { success: false, ...sanitizeApiError(err, 'archive_email', { userId, account: account_email, message_id }) };
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

      case 'get_email_content': {
        const { message_id, account_email } = toolInput || {};
        if (!message_id || !account_email) {
          return { success: false, error: 'message_id and account_email are required' };
        }
        try {
          const content = await getEmailContent(userId, message_id, account_email, db);
          if (!content?.hasContent) {
            // Surface the classified failure reason so Aria can explain
            // the outcome to the user (rate limit, timeout, etc.) instead
            // of a generic "couldn't retrieve".
            const reason = content?.reason || 'unknown';
            const userMsg = {
              timeout:    'Gmail is taking too long to respond; try again in a minute.',
              rate_limit: 'Gmail rate limit hit; will retry after a short cooldown.',
              auth:       'Gmail connection needs reconnecting — visit Settings.',
              not_found:  'That email no longer exists or was deleted.',
              unknown:    'Could not retrieve email content.',
              invalid_args: 'Missing message_id or account_email.',
            }[reason] || 'Could not retrieve email content.';
            return { success: false, error: userMsg, reason, retry_after_seconds: (reason === 'timeout' || reason === 'rate_limit' || reason === 'unknown') ? 60 : null };
          }
          // Cap body at 8000 chars so we don't blow the model's token budget
          // on enormous newsletter HTML. The full body is in the cache for
          // any subsequent search_email_content lookups.
          const body = (content.body || '').slice(0, 8000);
          return {
            success: true,
            message_id: content.messageId,
            thread_id: content.threadId,
            subject: content.subject,
            from: content.from,
            to: content.to,
            date: content.date,
            snippet: content.snippet,
            body,
            body_truncated: (content.body || '').length > 8000,
            // When metadata-only fallback kicked in, let the model know
            // so it can tell the user "I can see the subject but the
            // body wasn't available" rather than inventing content.
            body_unavailable: !!content.bodyFallback,
            note: content.bodyFallback ? 'Full body fetch timed out; showing headers + snippet only.' : undefined,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'search_email_content': {
        const { message_id, account_email, query } = toolInput || {};
        if (!message_id || !account_email || !query) {
          return { success: false, error: 'message_id, account_email, and query are required' };
        }
        try {
          const content = await getEmailContent(userId, message_id, account_email, db);
          if (!content?.hasContent) {
            return { success: false, error: 'Could not retrieve email content.' };
          }
          const body = String(content.body || '');
          const needle = String(query).toLowerCase();
          if (!needle) return { success: true, matches: [], match_count: 0 };
          // Find every match position in the lowered body, surface up to 5
          // 200-char context windows around each. Lowercased only for
          // searching — output uses the original casing from the body.
          const lowered = body.toLowerCase();
          const positions = [];
          let from = 0;
          while (positions.length < 5) {
            const idx = lowered.indexOf(needle, from);
            if (idx === -1) break;
            positions.push(idx);
            from = idx + needle.length;
          }
          const matches = positions.map((idx) => {
            const start = Math.max(0, idx - 80);
            const end = Math.min(body.length, idx + needle.length + 80);
            const prefix = start > 0 ? '…' : '';
            const suffix = end < body.length ? '…' : '';
            return prefix + body.slice(start, end) + suffix;
          });
          return {
            success: true,
            message_id: content.messageId,
            subject: content.subject,
            match_count: positions.length,
            matches,
            has_more_matches: lowered.indexOf(needle, from) !== -1,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'search_gmail': {
        const { query, account_email, max_results } = toolInput || {};
        if (!query) return { success: false, error: 'query is required' };
        try {
          const result = await searchGmail(userId, query, db, {
            accountEmail: account_email || null,
            maxResults: max_results || 10,
          });
          if (result.failed) {
            // Map classified failure to a user-friendly hint.
            const userMsg = {
              timeout:        'Gmail search took too long — try a more scoped query (add from:, newer_than:, or subject:).',
              rate_limit:     'Gmail search rate limit hit; will retry after a short cooldown.',
              auth:           'Gmail connection needs reconnecting — visit Settings.',
              no_accounts:    'No matching Gmail account is connected.',
              mixed_failures: 'Some connected accounts failed to search — narrow with account_email or try again.',
              invalid_args:   'query is required.',
              accounts_fetch_failed: 'Could not load Gmail account list.',
            }[result.reason] || `Could not search Gmail (${result.reason || 'unknown'}).`;
            return {
              success: false,
              error: userMsg,
              reason: result.reason,
              retry_after_seconds: (result.reason === 'timeout' || result.reason === 'rate_limit' || result.reason === 'unknown') ? 120 : null,
              failed_accounts: result.failedAccounts || [],
            };
          }
          // Thread projection — trim to fields Aria actually needs so we
          // don't bloat the tool result payload.
          const threads = (result.threads || []).map((t) => ({
            thread_id:  t.id,
            message_id: t.latestMessageId || t.id,
            account_email: t.accountEmail,
            subject:    t.subject,
            from:       t.from,
            date:       t.date,
            snippet:    t.snippet,
            is_read:    !!t.isRead,
            message_count: t.messageCount || 1,
          }));
          return {
            success: true,
            query,
            result_count: threads.length,
            threads,
            total_accounts_searched: result.totalAccountsSearched,
            failed_accounts: result.failedAccounts || [],
            has_more: !!result.hasMore,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'bulk_archive_emails': {
        const { account_email, criteria, dry_run } = toolInput || {};
        if (!account_email || !criteria) return { success: false, error: 'account_email and criteria required' };
        const row = await db.getGmailIntegrationByEmail(userId, account_email);
        if (!row) return { success: false, error: `No Gmail tokens for ${account_email}. Reconnect in Settings.` };

        // Enforce a 24h floor on older_than_hours. Without this, a single
        // bulk_archive_emails call could sweep recent inbox if Aria
        // (or a prompt-injected criteria) passed a very small value. The
        // emailCleanRunner already defaults to 24 when missing/invalid,
        // but a tiny positive number (e.g. 1) bypasses that default.
        const safeCriteria = {
          ...criteria,
          older_than_hours: Math.max(24, parseInt(criteria.older_than_hours, 10) || 24),
        };
        const { scanAndArchiveForAccount } = require('./lib/emailCleanRunner.cjs');
        const isDryRun = dry_run !== false;

        // Hard cap on real archives — even with confirmation, a single
        // call cannot exceed BULK_ARCHIVE_HARD_CAP. Pre-flight a dry-run
        // to know the count before committing. Only applies when actually
        // archiving — explicit dry_run:true returns the count untouched.
        if (!isDryRun) {
          const preflight = await scanAndArchiveForAccount({
            db, userId, accountEmail: account_email, criteria: safeCriteria,
            dryRun: true,
          });
          const wouldArchive = preflight.would_archive || 0;
          if (wouldArchive > BULK_ARCHIVE_HARD_CAP) {
            console.warn('[bulk_archive] hard_cap_exceeded', { userId, requested: wouldArchive, hard_cap: BULK_ARCHIVE_HARD_CAP });
            return {
              success: false,
              error: `Bulk archive would affect ${wouldArchive} emails — exceeds the per-call hard cap of ${BULK_ARCHIVE_HARD_CAP}. Narrow the criteria (older_than_hours, fewer categories) or run in smaller batches.`,
              would_archive: wouldArchive,
              hard_cap: BULK_ARCHIVE_HARD_CAP,
              breakdown: preflight.breakdown,
            };
          }
          if (wouldArchive > BULK_ARCHIVE_AUTONOMY_THRESHOLD) {
            console.info('[bulk_archive] confirmation_required', { userId, requested: wouldArchive, threshold: BULK_ARCHIVE_AUTONOMY_THRESHOLD });
          }
        }

        const result = await scanAndArchiveForAccount({
          db, userId, accountEmail: account_email, criteria: safeCriteria,
          dryRun: isDryRun,
        });
        return { success: true, ...result, older_than_hours_applied: safeCriteria.older_than_hours };
      }

      case 'list_email_labels': {
        const labels = await db.getEmailLabelsForUser(userId);
        // Group by semantic_category for cleaner read at the model layer.
        const grouped = {};
        for (const l of labels) {
          const cat = l.semanticCategory || 'unmapped';
          if (!grouped[cat]) grouped[cat] = [];
          grouped[cat].push({
            label_name: l.labelName,
            label_id: l.labelId,
            account_email: l.accountEmail,
            provider: l.provider,
            message_count: l.messageCount || 0,
          });
        }
        return { success: true, labels, by_category: grouped };
      }

      // ── Aria Intelligence System (Phase 1) — User Preferences ─────────
      case 'set_preference': {
        const { category, preference_type, description, context, strength } = toolInput || {};
        if (!category || !preference_type || !description) {
          return { success: false, error: 'category, preference_type, and description are required' };
        }
        // Length caps — prevent the LLM from ballooning the rule cache by
        // capturing run-on monologues as preferences. Bigger inputs are
        // truncated rather than rejected so calls don't fail mid-flow.
        const safeDescription = String(description).trim().slice(0, 500);
        const safeContext = context ? String(context).trim().slice(0, 200) : null;
        if (!safeDescription) return { success: false, error: 'description is empty after trim' };
        try {
          const row = await db.createUserPreference(
            userId, category, preference_type, safeDescription,
            safeContext, strength || 3,
          );
          if (!row) return { success: false, error: 'Failed to create preference' };
          try { await db.logMemory({ userId, tool: 'set_preference', content: `Captured preference: ${preference_type.toUpperCase()} ${description}`, metadata: { preference_id: row.id, category, preference_type, strength: row.strength } }); } catch {}
          // Phase 2 — drop the rule cache so the next chat turn picks up
          // the new preference immediately (vs waiting out the 5-min TTL).
          invalidateRulesCache(userId).catch(() => {});
          return {
            success: true,
            preference_id: row.id,
            category: row.category,
            preference_type: row.preferenceType,
            description: row.description,
            context: row.context,
            strength: row.strength,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'list_preferences': {
        const { category, include_inactive } = toolInput || {};
        try {
          const prefs = await db.getUserPreferences(userId, category || null, include_inactive === true);
          // Group by category for the model — easier to scan than a flat list.
          const byCategory = {};
          for (const p of prefs) {
            const cat = p.category || 'general';
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push({
              preference_id: p.id,
              preference_type: p.preferenceType,
              description: p.description,
              context: p.context,
              strength: p.strength,
              is_active: p.isActive,
            });
          }
          return { success: true, count: prefs.length, by_category: byCategory };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'remove_preference': {
        const { preference_id, reason } = toolInput || {};
        if (!preference_id) return { success: false, error: 'preference_id is required' };
        if (!reason) return { success: false, error: 'reason is required for the audit trail' };
        try {
          // Snapshot before removal so the memory log captures what was removed.
          const existing = await db.getUserPreferenceById(userId, preference_id);
          if (!existing) return { success: false, error: 'Preference not found' };
          const result = await db.removeUserPreference(userId, preference_id, reason);
          if (!result) return { success: false, error: 'Removal failed' };
          try { await db.logMemory({ userId, tool: 'remove_preference', content: `Removed preference: ${existing.preferenceType?.toUpperCase()} ${existing.description}`, metadata: { preference_id, reason } }); } catch {}
          // Phase 2 — invalidate cache so the removed preference disappears
          // from the next system prompt immediately.
          invalidateRulesCache(userId).catch(() => {});
          return { success: true, preference_id, removed_reason: reason };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      // ── Rule-proposal flow (Phase 2 capability) ─────────────────────────
      case 'list_rule_proposals': {
        const { status, limit } = toolInput || {};
        try {
          const proposals = await db.listRuleProposals(userId, {
            status: status || 'pending',
            limit: Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100),
          });
          // Slim shape for the LLM — full payload would balloon the
          // tool response with redundant predicate JSON.
          const slim = proposals.map((p) => ({
            proposal_id: p.id,
            status: p.status,
            proposed_rule_text: p.proposedRule?.ruleText || '(no text)',
            preference_type: p.proposedRule?.preferenceType || null,
            category: p.proposedRule?.category || null,
            tool_names: p.proposedRule?.predicate?.tool_names || [],
            reasoning: p.reasoning,
            source: p.source,
            created_at: p.createdAt,
            expires_at: p.expiresAt,
          }));
          return {
            success: true,
            count: slim.length,
            status: status || 'pending',
            proposals: slim,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'accept_rule_proposal': {
        const { proposal_id } = toolInput || {};
        if (!proposal_id) return { success: false, error: 'proposal_id is required' };
        try {
          const result = await db.acceptRuleProposal(proposal_id, userId, userId);
          // Drop the rule cache so the new rule shows on the next turn.
          invalidateRulesCache(userId).catch(() => {});
          try {
            await db.logMemory({
              userId, tool: 'accept_rule_proposal',
              content: `Accepted rule proposal — new rule active: "${result.rule?.ruleText?.slice(0, 120) || 'no text'}"`,
              metadata: { proposal_id, applied_rule_id: result.proposal.appliedRuleId },
            });
          } catch {}
          return {
            success: true,
            proposal_id,
            applied_rule_id: result.proposal.appliedRuleId,
            rule_text: result.rule?.ruleText || null,
            preference_type: result.rule?.preferenceType || null,
            strength: result.rule?.strength ?? null,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'reject_rule_proposal': {
        const { proposal_id, reason } = toolInput || {};
        if (!proposal_id) return { success: false, error: 'proposal_id is required' };
        try {
          const ok = await db.rejectRuleProposal(proposal_id, userId, reason || null, userId);
          if (!ok) return { success: false, error: 'proposal not found or not pending' };
          try {
            await db.logMemory({
              userId, tool: 'reject_rule_proposal',
              content: `Rejected rule proposal${reason ? ` — reason: ${reason}` : ''}`,
              metadata: { proposal_id, reason: reason || null },
            });
          } catch {}
          return { success: true, proposal_id, status: 'rejected', reason: reason || null };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      // ── Skills (agents-foundation v1, M1.6) ─────────────────────────────
      case 'list_skills': {
        const includeInactive = toolInput?.include_inactive !== false;
        try {
          const skills = await db.listSkillsForUser(userId, { includeInactive });
          const slim = skills.map((s) => ({
            skill_id: s.id,
            name: s.name,
            description: s.description,
            status: s.isActive ? 'active' : 'paused',
            persona: s.persona,
            priority: s.priority,
            token_cap: s.tokenCap,
            invoked_count: s.invokedCount,
            last_used_at: s.lastUsedAt,
            source: s.source,
            keyword_count: Array.isArray(s.triggerPredicate?.input?.or)
              ? s.triggerPredicate.input.or.length
              : (s.triggerPredicate ? null : 0),
          }));
          return { success: true, count: slim.length, skills: slim };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'create_skill': {
        const { name, description, content, keywords, trigger_predicate,
                persona, token_cap, priority } = toolInput || {};
        if (!name || !description || typeof content !== 'string') {
          return { success: false, error: 'name, description, and content are required' };
        }
        const predicate = _composeSkillPredicate({ keywords, trigger_predicate });
        try {
          const created = await db.createSkill(userId, {
            name: String(name).slice(0, 200),
            description: String(description).slice(0, 1000),
            content,
            triggerPredicate: predicate,
            persona: persona || null,
            tokenCap: _clampTokenCap(token_cap),
            priority: _clampPriority(priority),
            isActive: false, // Aria-creation flow: ship as draft (Q9)
            source: 'aria_proposed',
          });
          try {
            await db.logMemory({
              userId, tool: 'create_skill',
              content: `Created draft skill: "${created.name}" (review + activate from Agents tab)`,
              metadata: { skill_id: created.id, source: 'aria_proposed' },
            });
          } catch {}
          return {
            success: true,
            skill_id: created.id,
            name: created.name,
            status: 'draft',
            note: 'Skill saved as DRAFT. User must review and activate from the Agents tab before it auto-loads.',
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'update_skill': {
        const { skill_id, name, description, content, keywords, trigger_predicate,
                persona, token_cap, priority, is_active } = toolInput || {};
        if (!skill_id) return { success: false, error: 'skill_id is required' };
        const fields = {};
        if (name !== undefined)        fields.name        = String(name).slice(0, 200);
        if (description !== undefined) fields.description = String(description).slice(0, 1000);
        if (content !== undefined)     fields.content     = content;
        if (persona !== undefined)     fields.persona     = persona || null;
        if (token_cap !== undefined)   fields.tokenCap    = _clampTokenCap(token_cap);
        if (priority !== undefined)    fields.priority    = _clampPriority(priority);
        if (is_active !== undefined)   fields.isActive    = !!is_active;
        if (keywords !== undefined || trigger_predicate !== undefined) {
          fields.triggerPredicate = _composeSkillPredicate({ keywords, trigger_predicate });
        }
        try {
          const updated = await db.updateSkill(skill_id, userId, fields);
          if (!updated) return { success: false, error: 'skill not found or not owned by user' };
          return {
            success: true,
            skill_id: updated.id,
            name: updated.name,
            status: updated.isActive ? 'active' : 'paused',
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'activate_skill': {
        const { skill_id } = toolInput || {};
        if (!skill_id) return { success: false, error: 'skill_id is required' };
        try {
          const updated = await db.activateSkill(skill_id, userId);
          if (!updated) return { success: false, error: 'skill not found or not owned by user' };
          return { success: true, skill_id: updated.id, name: updated.name, status: 'active' };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'pause_skill': {
        const { skill_id } = toolInput || {};
        if (!skill_id) return { success: false, error: 'skill_id is required' };
        try {
          const updated = await db.pauseSkill(skill_id, userId);
          if (!updated) return { success: false, error: 'skill not found or not owned by user' };
          return { success: true, skill_id: updated.id, name: updated.name, status: 'paused' };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'delete_skill': {
        const { skill_id } = toolInput || {};
        if (!skill_id) return { success: false, error: 'skill_id is required' };
        try {
          const ok = await db.deleteSkill(skill_id, userId);
          if (!ok) return { success: false, error: 'skill not found or not owned by user' };
          return { success: true, skill_id, deleted: true };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      // ── Sub-agents (agents-foundation v1, M3.7) ─────────────────────────
      case 'start_sub_agent': {
        const { prompt, definition_id, budget_overrides } = toolInput || {};
        if (!prompt || typeof prompt !== 'string') {
          return { success: false, error: 'prompt is required' };
        }
        const definitionId = definition_id || 'research_agent';
        try {
          // Concurrency cap (Q6 = 2 per user, server-enforced).
          const active = await db.countActiveSubAgentSessions(userId);
          if (active >= 2) {
            return {
              success: false,
              error: 'max 2 concurrent runs reached — cancel one or wait',
              active_count: active,
            };
          }
          const definition = await db.getSubAgentDefinition(definitionId);
          if (!definition) {
            return { success: false, error: `unknown definition: ${definitionId}` };
          }
          const budget = _composeSubAgentBudget(definition.defaultBudget, budget_overrides);
          const session = await db.createSubAgentSession({
            userId, definitionId, prompt: prompt.trim(), budget,
          });
          return {
            success: true,
            session_id: session.id,
            definition_id: definitionId,
            status: session.status,
            budget,
            note: 'Sub-agent dispatched. Check progress with list_sub_agent_runs / get_sub_agent_result. WhatsApp ping when done.',
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'list_sub_agent_runs': {
        const { status, limit } = toolInput || {};
        try {
          let sessions;
          if (status === 'active') {
            const queued = await db.listSubAgentSessions(userId, { status: 'queued', limit });
            const running = await db.listSubAgentSessions(userId, { status: 'running', limit });
            sessions = [...queued, ...running];
          } else if (!status || status === 'all') {
            sessions = await db.listSubAgentSessions(userId, { limit });
          } else {
            sessions = await db.listSubAgentSessions(userId, { status, limit });
          }
          const slim = sessions.map((s) => ({
            session_id: s.id,
            definition_id: s.definitionId,
            prompt: (s.prompt || '').slice(0, 200),
            status: s.status,
            current_phase: s.currentPhase,
            started_at: s.startedAt,
            completed_at: s.completedAt,
            budget_used: s.budgetUsed,
            has_result: !!s.result,
          }));
          return { success: true, count: slim.length, sessions: slim };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'get_sub_agent_result': {
        const { session_id } = toolInput || {};
        if (!session_id) return { success: false, error: 'session_id is required' };
        try {
          const session = await db.getSubAgentSession(session_id, userId);
          if (!session) return { success: false, error: 'session not found' };
          return {
            success: true,
            session_id: session.id,
            status: session.status,
            current_phase: session.currentPhase,
            result: session.result,
            error: session.error,
            budget_used: session.budgetUsed,
            started_at: session.startedAt,
            completed_at: session.completedAt,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'kill_sub_agent': {
        const { session_id } = toolInput || {};
        if (!session_id) return { success: false, error: 'session_id is required' };
        try {
          const updated = await db.requestSubAgentKill(session_id, userId);
          if (!updated) return { success: false, error: 'session not found, not owned, or already terminal' };
          return {
            success: true,
            session_id: updated.id,
            status: updated.status,
            note: 'Kill requested. Worker will exit at next phase boundary (≤30s).',
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      }

      case 'move_email': {
        const { message_id, account_email, target_label_id, target_label_name, scope } = toolInput || {};
        if (!message_id || !account_email || !target_label_id || !scope) {
          return { success: false, error: 'message_id, account_email, target_label_id, and scope are required' };
        }
        const validScopes = new Set(['thread', 'sender', 'domain']);
        if (!validScopes.has(scope)) {
          return { success: false, error: `Invalid scope: ${scope}. Must be thread, sender, or domain.` };
        }
        const { tokens } = await loadGmailTokensForAccount(db, userId, account_email, 'move_email');
        if (!tokens) return { success: false, error: `No Gmail tokens for ${account_email}.` };
        const oauth2 = makeGmailOAuth2Client();
        if (!oauth2) return { success: false, error: 'Google OAuth not configured.' };
        oauth2.setCredentials(tokens);
        oauth2.on('tokens', async (nt) => {
          await mergeAndSaveGmailTokens(db, userId, account_email, nt).catch(() => {});
        });
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        try {
          // Apply the target label and remove INBOX so the email leaves the
          // active triage list. Same shape Gmail's "Move to" UI uses.
          await gmail.users.messages.modify({
            userId: 'me',
            id: message_id,
            requestBody: {
              addLabelIds: [target_label_id],
              removeLabelIds: ['INBOX'],
            },
          });

          // Filing pattern: only record when scope extends beyond this thread.
          // Sender / domain scope means "remember this preference". Past
          // matching emails are NOT bulk-moved here — that's Phase 3.
          let pattern = null;
          if (scope === 'sender' || scope === 'domain') {
            try {
              const msg = await gmail.users.messages.get({ userId: 'me', id: message_id, format: 'metadata', metadataHeaders: ['From'] });
              const fromHeader = (msg.data.payload?.headers || []).find(h => h.name?.toLowerCase() === 'from')?.value || '';
              const emailMatch = fromHeader.match(/<([^>]+)>/);
              const senderEmail = (emailMatch ? emailMatch[1] : fromHeader).trim().toLowerCase();
              const matchValue = scope === 'sender'
                ? senderEmail
                : (senderEmail.split('@')[1] || senderEmail);
              if (matchValue) {
                pattern = await db.upsertFilingPattern({
                  userId, accountEmail: account_email,
                  matchType: scope, matchValue,
                  targetLabelId: target_label_id,
                  targetLabelName: target_label_name || target_label_id,
                });
              }
            } catch (err) {
              // Pattern recording is best-effort — the move itself succeeded.
              try { await db.logMemory({ userId, tool: 'move_email', content: `Pattern record failed: ${err.message}`, metadata: { message_id, scope } }); } catch {}
            }
          }

          try { await db.logMemory({ userId, tool: 'move_email', content: `Moved email to ${target_label_name || target_label_id} (scope=${scope})`, metadata: { message_id, account_email, target_label_id, scope } }); } catch {}
          // Phase 2 — pattern inference hook for email-action sequences.
          setImmediate(() => {
            inferRulesFromBehavior(userId, 'email_moved', { messageId: message_id, accountEmail: account_email, targetLabel: target_label_name, scope }, 'success').catch(() => {});
          });
          return {
            success: true,
            moved_to: target_label_name || target_label_id,
            scope,
            pattern_confidence: pattern?.confidence ?? null,
            pattern_times_applied: pattern?.times_applied ?? null,
          };
        } catch (err) {
          if (err.code === 403 || err.message?.includes('insufficient')) {
            return { success: false, error: 'Gmail account is missing modify permission. Reconnect in Settings.' };
          }
          return { success: false, error: err.message };
        }
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
        // Acceptance rule (per Commit B spec): at least one of
        // {first_name, last_name, company, primary_email, display_name}
        // must be populated. The DB layer hard-requires display_name,
        // so derive it from first+last when caller omitted it. Falling
        // back to company is acceptable for "ACME Corp" cards with no
        // person on them.
        const firstName = toolInput.first_name ? String(toolInput.first_name).trim() : null;
        const lastName  = toolInput.last_name  ? String(toolInput.last_name).trim()  : null;
        let displayName = toolInput.display_name ? String(toolInput.display_name).trim() : null;
        if (!displayName) {
          const joined = [firstName, lastName].filter(Boolean).join(' ').trim();
          if (joined) displayName = joined;
          else if (toolInput.company) displayName = String(toolInput.company).trim();
        }
        if (!displayName) {
          return { success: false, error: 'Need at least a display_name, first/last name, or company to save a contact.' };
        }
        try {
          const contact = await db.createContact(userId, {
            displayName,
            firstName,
            lastName,
            primaryEmail: toolInput.primary_email || null,
            primaryPhone: toolInput.primary_phone || null,
            company:      toolInput.company || null,
            role:         toolInput.role || null,
            notes:        toolInput.notes || null,
            // OCR call sets source='business_card_ocr' explicitly. Manual
            // tool-call paths from Aria default to 'aria' for back-compat
            // with the existing tag taxonomy.
            source:       toolInput.source || 'aria',
            sourceImageBlobId: toolInput.image_blob_id || null,
            rawOcrText:        toolInput.raw_ocr_text || null,
          });
          try {
            await db.logMemory({
              userId,
              tool: 'create_contact',
              content: `Created contact: "${contact.displayName}"${contact.company ? ` (${contact.company})` : ''}`,
              metadata: {
                contact_id: contact.id,
                source: contact.source,
                image_blob_id: contact.sourceImageBlobId || null,
              },
            });
          } catch {}
          return {
            success: true,
            contact_id: contact.id,
            display_name: contact.displayName,
            url: `/people`,
          };
        } catch (e) {
          if (e.code === '23505') {
            // Existing partial UNIQUE on (user_id, LOWER(primary_email))
            // produces 23505 when an OCR card matches an existing email.
            // Aria sees this and can offer an update_contact follow-up
            // (Q5 from the OCR Phase 2 spec — "offer update" path).
            return { success: false, error: 'A contact with this email already exists. Use update_contact to add fields instead.', duplicate: true };
          }
          return { success: false, error: e.message };
        }
      }

      case 'log_food': {
        const description = typeof toolInput.description === 'string' ? toolInput.description.trim() : '';
        if (!description) return { success: false, error: 'description is required' };

        const userTz = tz || DEFAULT_TIMEZONE;
        // local_date default = today in user's tz. en-CA locale formats
        // as YYYY-MM-DD which is exactly the column type.
        let localDate = typeof toolInput.local_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(toolInput.local_date)
          ? toolInput.local_date
          : new Intl.DateTimeFormat('en-CA', { timeZone: userTz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

        // Default source from channel — whatsapp_ocr when called from WA,
        // chat otherwise. Caller can override with an explicit toolInput.source.
        const sourceDefault = channel === 'whatsapp' ? 'whatsapp_ocr' : 'chat';
        const source = ['chat', 'whatsapp_ocr', 'manual'].includes(toolInput.source) ? toolInput.source : sourceDefault;

        let estimate;
        try {
          const { estimateNutrition } = require('./lib/foodLogTools.cjs');
          estimate = await estimateNutrition(description);
        } catch (e) {
          return { success: false, error: `Nutrition estimate failed: ${e.message}` };
        }

        const entry = await db.createFoodLogEntry(userId, {
          localDate,
          source,
          description,
          note: toolInput.note || estimate.note || null,
          items: estimate.items,
          sourceMsgId: toolInput.source_msg_id || null,
        });

        // Attach photo if caller provided an image_blob_id. The blob must
        // exist (createFoodLogPhoto has a FK to image_blobs); failure here
        // is non-fatal — the entry still landed.
        let photoAttached = null;
        if (toolInput.image_blob_id) {
          try {
            const p = await db.addFoodLogPhoto({
              entryId: entry.id,
              imageBlobId: toolInput.image_blob_id,
              ocrPayload: null,
            });
            photoAttached = p.id;
          } catch (e) {
            // FK violation or missing blob — surface to Aria but don't fail the log
            return {
              success: true,
              entry_id: entry.id,
              local_date: entry.local_date,
              totals: entry.totals,
              photo_attached: false,
              photo_error: e.message,
            };
          }
        }

        try {
          await db.logMemory({
            userId,
            tool: 'log_food',
            content: `Logged food: ${description.slice(0, 120)}`,
            metadata: {
              entry_id: entry.id,
              local_date: entry.local_date,
              source: entry.source,
              item_count: Array.isArray(entry.items) ? entry.items.length : 0,
              total_calories: entry.totals?.calories || 0,
            },
          });
        } catch {}

        return {
          success: true,
          entry_id: entry.id,
          local_date: entry.local_date,
          items: entry.items,
          totals: entry.totals,
          note: entry.note,
          photo_attached: !!photoAttached,
        };
      }

      case 'update_contact': {
        if (!toolInput.contact_id) {
          return { success: false, error: 'contact_id is required' };
        }
        const existing = await db.getContactById(toolInput.contact_id, userId);
        if (!existing) return { success: false, error: 'Contact not found' };
        const patch = {};
        if (toolInput.display_name !== undefined)  patch.displayName  = toolInput.display_name;
        if (toolInput.first_name !== undefined)    patch.firstName    = toolInput.first_name || null;
        if (toolInput.last_name !== undefined)     patch.lastName     = toolInput.last_name || null;
        if (toolInput.primary_email !== undefined) patch.primaryEmail = toolInput.primary_email || null;
        if (toolInput.primary_phone !== undefined) patch.primaryPhone = toolInput.primary_phone || null;
        if (toolInput.company !== undefined)       patch.company      = toolInput.company || null;
        if (toolInput.role !== undefined)          patch.role         = toolInput.role || null;
        if (toolInput.notes !== undefined)         patch.notes        = toolInput.notes || null;
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
        await db.addContactFact(userId, toolInput.contact_id, text, 'note', 0.5, 'contact_note');
        // Fire-and-forget fact extraction — never awaited, never blocks.
        try {
          const { extractContactFacts } = require('./lib/contactFactExtractor.cjs');
          extractContactFacts(userId, toolInput.contact_id, existing.displayName, text)
            .catch((err) => console.error('[tools] fact extract:', err.message));
        } catch { /* extractor unavailable → skip silently */ }
        return { success: true, contact_id: toolInput.contact_id };
      }

      // M1a (2026-05-26) — explicit user-stamped memory.
      case 'remember_this': {
        const text = String(toolInput?.content || '').trim();
        if (!text) {
          // Tool description tells the LLM to populate content from the
          // previous user message when the user said "remember that".
          // Empty here means the LLM didn't follow instructions; nudge
          // back with a clear error rather than persist nothing.
          return { success: false, error: 'remember_this requires content. If the user said "remember that", pass their statement as content.' };
        }
        // Optional contact resolution. Best-effort: ambiguous matches
        // become a global memory_fact rather than blocking — the user's
        // intent was to remember, not to disambiguate.
        let contactId = null;
        let contactName = null;
        if (toolInput?.contact_name && typeof toolInput.contact_name === 'string') {
          const q = toolInput.contact_name.trim();
          if (q) {
            try {
              const matches = await db.searchContactsByName(userId, q, 5);
              // Exact (case-insensitive) display_name match wins; otherwise
              // fall back to global if 0 or >1 candidates.
              const lc = q.toLowerCase();
              const exact = (matches || []).filter((m) => (m.displayName || '').toLowerCase() === lc);
              const pick = exact.length === 1 ? exact[0] : (matches?.length === 1 ? matches[0] : null);
              if (pick) {
                contactId = pick.id;
                contactName = pick.displayName;
              }
            } catch (e) { console.error('[remember_this] contact resolve failed:', e.message); }
          }
        }
        // 2026-05-28 — auto-resolve fallback. If the LLM didn't pass
        // contact_name but the content mentions a known contact by
        // whole-word name, route to contact-scoped axis. Conservative:
        // only fire when exactly ONE contact's displayName / firstName /
        // lastName appears as a whole word. Multiple matches → stay
        // global (user said "Allen and Sarah" — ambiguous routing).
        // Observation surfaced from May 27 M1b dogfood: Aria was
        // calling remember_this without contact_name even when content
        // clearly referenced a contact, landing as global when it
        // should have been contact-scoped.
        if (!contactId) {
          try {
            const all = await db.getContactsForUser(userId);
            const tokens = (all || [])
              .flatMap((c) => [c.displayName, c.firstName, c.lastName]
                .filter(Boolean)
                .map((n) => ({ token: String(n).trim(), id: c.id, displayName: c.displayName })))
              .filter((t) => t.token.length >= 2);
            const hits = new Map(); // contact_id → entry
            for (const t of tokens) {
              const re = new RegExp(`\\b${t.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
              if (re.test(text)) hits.set(t.id, t);
            }
            if (hits.size === 1) {
              const only = [...hits.values()][0];
              contactId = only.id;
              contactName = only.displayName;
            }
          } catch (e) { console.error('[remember_this] auto-resolve failed:', e.message); }
        }
        try {
          if (contactId) {
            await db.addContactFact(userId, contactId, text, 'explicit_remember', 0.9, 'explicit_remember');
          } else {
            await db.upsertMemoryFact(userId, null, text, 'explicit_remember', 'explicit_remember');
          }
          try {
            await db.logMemory({
              userId,
              tool: 'remember_this',
              content: `Remembered: "${text.length > 120 ? text.slice(0, 120) + '…' : text}"`,
              metadata: { contact_id: contactId, contact_name: contactName, channel: channel || null },
            });
          } catch {}
          return {
            success: true,
            fact_text: text,
            contact_id: contactId,
            contact_name: contactName,
          };
        } catch (e) {
          return { success: false, error: e.message };
        }
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
        const zone = tz || DEFAULT_TIMEZONE;
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
        const zone = tz || DEFAULT_TIMEZONE;
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

        // Verify the event actually exists in one of the user's connected
        // calendars before upserting a note. Without this check, Aria
        // (or a prompt-injected event_id) could pile arbitrary notes
        // against garbage IDs — the calendar_notes row is per-user so it
        // isn't cross-tenant, but it pollutes the user's own data with
        // notes against nonexistent events. Mirrors the entity-membership
        // check in add_project_update_note (tools.cjs:~2008).
        let foundOnAccount = null;
        try {
          const accounts = (await loadAllGcalAccounts(userId, db)) || [];
          for (const acct of accounts) {
            const oauth2 = makeOAuth2Client(); if (!oauth2) continue;
            oauth2.setCredentials(acct.tokens);
            const calendar = google.calendar({ version: 'v3', auth: oauth2 });
            try {
              const existing = await calendar.events.get({ calendarId: 'primary', eventId });
              if (existing?.data?.id) { foundOnAccount = acct.googleEmail || null; break; }
            } catch (err) {
              if (err.code === 404 || err.response?.status === 404) continue;
              // Non-404 error (auth, rate limit) — keep trying other accounts.
            }
          }
        } catch {
          // Calendar lookup failed entirely; treat as not-found rather than
          // accepting the write blind.
        }
        if (!foundOnAccount) return { success: false, error: 'Event not found in any connected calendar.' };

        try {
          await db.upsertCalendarNotePost(userId, eventId, null, null, null, foundOnAccount, note);
          if (db.resolveCloseLoopItem) {
            db.resolveCloseLoopItem(userId, 'event', eventId).catch(() => {});
          }
          return { success: true, event_id: eventId, account_email: foundOnAccount };
        } catch (e) {
          return { success: false, error: e.message };
        }
      }

      case 'add_project_update_note': {
        if (!toolInput.project_id || !toolInput.note) {
          return { success: false, error: 'project_id and note are required' };
        }
        // Clamp at 10k to match journal field hygiene and bound storage
        // in case Aria hallucinates a wall of text (M-2 hardening).
        const raw = String(toolInput.note).trim();
        const note = raw.length > 10000 ? raw.slice(0, 10000) : raw;
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

module.exports = {
  ARIA_TOOLS, executeTool, getToolByName, getToolSchemasForApi, requiresConfirmation, ALWAYS_CONFIRM,
  // Exported for tests (skills foundation v1, M1.6):
  _composeSkillPredicate, _clampTokenCap, _clampPriority,
  // Exported for tests (sub-agents, M3.7):
  _composeSubAgentBudget, SUB_AGENT_BUDGET_CAPS,
};
