# TaskManage — Feature Map (READ-ONLY)

- **Branch:** `dizon/code-audit` · **Baseline:** `v2-phase0` · **Date:** 2026-05-30
- **Method:** 7 features traced end-to-end (UI→API→backend→DB) by read-only agents; issues refute-tested.
- **Coverage:** features 7/7.

## Agentic loop & reasoning

### How it works

**Path: UI → API → Backend → DB → LLM → Loop → Tools → DB**

1. **Frontend entry** (src/App.jsx, DashboardPanel.jsx)
   - User sends a chat message via Command Center
   - Calls `POST /api/chat/execute` with `{ messages, model?, systemPrompt? }`
   - `apiFetch` handles JWT refresh on 401/403 (line 75–89)

2. **Route entry** (server/routes/ai.cjs:419–727)
   - `authenticateToken` middleware extracts `req.user.id`, `req.user.timezone`, `req.user.entityIds`
   - Filters non-Anthropic message roles (line 443–469) — defense against synthetic roles like 'confirm', 'task_draft' leaking into LLM input
   - Sets SSE headers (line 671–674), installs `send()` callback for real-time tool events
   - Calls **shared handler** `handleConversationTurn()` (line 709–727)

3. **Shared reasoning spine** (server/lib/conversationTurn.cjs:97–148)
   - **Decoupled from channel transport** — web uses SSE streaming, WhatsApp uses synchronous reply, voice uses async + confirmation queue
   - Builds live context via `buildAgenticContext()` (line 108–113)
   - Fires optional skill-feedback detector (line 119–124) — detects "stop loading X skill" / "always load Y"
   - Calls **onContextReady callback** (line 130) — web flushes SSE headers here (context-build errors still JSON-500)
   - Assembles system prompt with **cache split** (line 132) — cacheable prefix (profile, persona, skills, rules) vs dynamic suffix (today's calendar, tasks, facts)
   - Invokes **agentic loop** (line 134–145)
   - Returns `{ text, toolSummaries, maxIterationsReached, decision, ctx }`

4. **Agentic loop** (server/lib/agenticLoop.cjs:70–304)
   - **Core Anthropic contract**: call → tool_use? → execute → feed result → loop until `end_turn` or `MAX_ITERATIONS` (5)
   - Streaming via `trackedAnthropicStream()` (line 114–120) — forwards `text_delta` events live (TTFT ~500–800ms vs 3–5s assembly)
   - **Decision parsing** (line 128) — extracts latest `<decision>{...}</decision>` block from text output
   - **Tool dispatch** (line 159–277):
     - Short-circuit on unknown tool (line 166–177) — "Tell the user you can't do this"
     - Stagnation guard (line 180–190) — same (tool, input) failing ≥ 2× → force end, no more attempts
     - **Gating hook** (line 194–208) — Phase 3 engine + Phase 4 trust + confirmation waiter lives here
     - **Tool result size cap** (line 236–241) — 15KB max per result, truncate + sentinel ("Ask to narrow the query") on overflow
     - **Parallel execution** (line 269–277) when: multiple tools AND none require confirmation
     - Feed all results back to model (line 279)

5. **Confirmation gate** (server/routes/ai.cjs:536–662)
   - Called from agentic loop's `gateToolExecution` hook
   - **Phase 3 decision engine** (line 545–568): `evaluateAction(userId, tool, input, tz)` returns disposition (`auto_proceed`, `hard_stop`, `confirm_required`, `soft_confirm`)
     - Hard stops are rule violations → logged + denied
     - Rest flow through to Phase 1 confirmation check
   - **Phase 1 tool-level + email confirmation** (line 571): `requiresConfirmation(tool, decision, input)` checks tool flags, LLM decision.requires_confirmation, bulk_archive count threshold, image_save gate
   - **If confirmation needed**: create row in `pending_confirmations` (line 588–591), emit `tool_confirm` SSE event (line 611–620), wait for user action via `listenForConfirmation()` with 2-min timeout (line 631)
   - **Resolution paths**:
     - `allow` → execute tool with optional `overrides` from gate
     - `deny` → return "User cancelled {tool}"
     - `alreadyExecuted` → gate pre-executed on another channel, return result to model
     - **Phase 4 trust feedback** (line 639–644) — close_decision_with_feedback records outcome ('confirmed', 'rejected', 'executed') + bumps trust counters

6. **Post-loop learning** (server/lib/conversationTurn.cjs:161–193 + server/routes/ai.cjs:743–749)
   - **Correction learning** (line 743) — `handlePossibleCorrection()` detects "you meant X not Y" and appends acknowledgment
   - **Memory extraction** (line 183–186) — async fire-and-forget `enrichConversationTurn()` extracts facts (M1b feature)
   - Returns final reply text to browser via SSE (line 695)

**Data model** (db.cjs):
- `pending_confirmations`: (id, user_id, tool_name, params_json, channel, status, expires_at, decision_log_id, resolution_json)
- `decision_log`: (id, user_id, action_type, tool_name, input_json, disposition, outcome, decision_id, confidence, risk, created_at)
- `agent_actions`: (id, user_id, event_type, tool_name, input, output, status, error_msg, decision_log_id, created_at)
- Cache for confirmation state: pg LISTEN/NOTIFY on channel `confirm_{id}`

**Key files**:
- `/server/lib/agenticLoop.cjs:28–40` — MAX_ITERATIONS (5), REPEAT_FAILURE_LIMIT (2), MAX_TOOL_RESULT_BYTES (15KB)
- `/server/lib/conversationTurn.cjs:52–67` — assembleSystem() — cache split logic
- `/server/lib/buildAgenticContext.cjs:27–153` — DECISION_INSTRUCTIONS prompt block + 15 context sections
- `/server/lib/decisionEngine.cjs:1–150` — Phase 3 gate logic, rule matching, trust tier evaluation
- `/server/routes/ai.cjs:419–749` — web channel transport, SSE plumbing, confirmation waiter
- `/server/lib/anthropicCall.cjs` — token tracking + cost enforcement (observability-only mode)

---

### Does the logic hold

**Strengths:**
- Single shared spine (conversationTurn.cjs) unifies all channels (web, WhatsApp, voice) — prevents transport-specific drift
- Stagnation guard (line 180–190, agenticLoop.cjs) + unknown-tool short-circuit (line 166) — prevents tool-hallucination loops
- Tool result truncation with sentinel (line 236–241) — prevents context blowup on oversized list results
- Cache split (systemCacheable + systemDynamic) — re-uses 90% of input cost on prompt cache hits
- Confirmation gating is **idempotent** — alreadyExecuted flag lets WhatsApp/voice pre-execute on another channel without double-counting
- Phase 3 decision engine composition rule: can only **increase** friction, never decrease — engine must fail-closed (line 552–554)
- Confirmation timeout (2min) + AbortController on SSE close (line 626–628) — prevents zombie waiters

**Fragile/incomplete areas:**

1. **Confirmation waiter connection leak on SSE close failure** (db.cjs:1626–1712)
   - listenForConfirmation holds a dedicated pg client for up to 2 minutes. Cleanup fires on abort, timeout, or NOTIFY resolution. If AbortController event listener fails (Node stall, exception in SSE handler), the socket closes without triggering cleanup. The 2-minute timeout eventually fires, but connection is held during the window.

2. **Trust feedback lacks idempotency guarantee** (server/lib/trustFeedback.cjs:38–50)
   - closeDecisionWithFeedback() has a contract to be called only once per decision to avoid double-counting trust deltas. However, decision_log table has no UNIQUE constraint on decision_id. Retried API calls invoking this twice for the same decision_id will double-count the delta and increment trust counters twice.

3. **MAX_ITERATIONS is hardcoded to 5** (server/lib/agenticLoop.cjs:28)
   - Discovery/clarification workflows typically need 6-7 iterations. No parameterization or mid-conversation adjustment mechanism. User sees "hit my step limit" message but can't request more iterations.

4. **Email content-aware gating doesn't batch fetches per iteration** (server/lib/decisionEngine.cjs:445–452)
   - Each gateToolExecution call fires a fresh getEmailContent() fetch. While the function has internal Redis caching, parallel execution of multiple email tools (archive_email + delete_email) forces sequential content checks instead of batching, creating redundant API round-trips.

---

## Tools registry & execution

Tools enable Aria to perform actions across tasks, calendar, email, notes, contacts, memory, and intelligence (skills, rules, sub-agents) on behalf of the user. The system enforces user confirmation for high-risk mutations, exactly-once execution via persistent confirmation gates, and hard budgets on sub-agent runs.

### How it works

#### Registry (server/tools.cjs:1–1073)

57 tools across 9 groups:
- **tasks** (5): create, complete, update, delete, search
- **calendar** (3): create_event, update_event, delete_event
- **notes** (3): create, update, search_notes
- **communication** (11): send_email, reply_email, archive, search_inbox, get_email_content, search_email_content, search_gmail, flag_email_as_crucial, bulk_archive_emails, list_email_labels, move_email
- **people** (9): list_contacts, get_contact, get_contact_emails, create_contact, update_contact, note_about_contact, list_shared_access, grant_shared_access, revoke_shared_access
- **memory** (1): remember_this
- **journal** (6): create_journal_entry, list_journal_entries, get_today_close_loop_context, close_task_with_note, add_event_outcome_note, add_project_update_note
- **intelligence** (17): list_preferences, set_preference, remove_preference, list_rule_proposals, accept_rule_proposal, reject_rule_proposal, get_cost_usage, list_skills, create_skill, update_skill, activate_skill, pause_skill, delete_skill, start_sub_agent, list_sub_agent_runs, get_sub_agent_result, kill_sub_agent
- **capture** (2): capture_from_image, log_food

Each tool definition (server/tools.cjs:31–1073) includes:
- `name`: tool identifier
- `group`: category for organization
- `risk`: 'low', 'medium', 'high' (metadata for UI/gating)
- `requires_confirmation`: boolean, gated for high-risk mutations (send_email, reply_email, delete_task, delete_event always require; others may be dynamic per input)
- `description`: user-facing prompt guidance
- `input_schema`: JSON Schema for Anthropic API

**Metadata stripping**: Before sending to Anthropic, `getToolSchemasForApi()` (server/tools.cjs:1162–1165) strips metadata fields and returns only `{name, description, input_schema}` + the web_search_20250305 server-hosted tool.

#### Execution path

**Chat (web) — server/routes/ai.cjs**

1. User message → `POST /api/ai/chat` (authenticated via JWT)
2. `buildAgenticContext()` renders system prompt with user data (tasks, calendar, skills, rules, close-loop items)
3. Decision engine (`evaluateAction()` via server/lib/decisionEngine.cjs) analyzes the tool+input pair:
   - Returns `hard_stop` (blocked by behavior_rule), `soft_confirm` (suggested confirm), or `auto_proceed`
   - Persistence: decision_log row created (audit trail + trust scoring)
4. Confirmation gate (`gateToolExecution` hook, ai.cjs:540–662):
   - If tool requires confirmation (static or dynamic):
     - Creates `pending_confirmations` row (ai.cjs:588)
     - SSE sends `tool_confirm` event to frontend
     - Waits 2min for user YES/NO via `listenForConfirmation()` (db.cjs:1626–1713)
   - On approval: **tool executes in the confirmation handler** (not in agentic loop) — result persisted atomically with `resolution_json` (ai.cjs:646, whatsapp.cjs:267–285)
   - On timeout/denial: returns gate deny decision to agentic loop
5. Agentic loop (`runAgenticLoop()`, server/lib/agenticLoop.cjs:70–304):
   - Calls Claude with tools array + user message
   - Handles tool_use blocks:
     - Parallel execution when no confirmable tools (70+ tool calls in 1 iteration)
     - Serial when any tool requires_confirmation (gates fire before execution)
   - Tool result fed back to model
   - Loop runs max 5 iterations until end_turn

**WhatsApp — server/routes/whatsapp.cjs:250–301**

- YES/NO matching (strict regex, 10-min pending window): auto-executes tool if pending_confirmations row exists and status is 'pending'
- Execution happens synchronously in the confirmation handler
- Result + decision logged atomically
- Notifies web listener via DB NOTIFY so web-side listenForConfirmation() resolves with `alreadyExecuted: true` → agentic loop skips re-execution
- Sends reply via UltraMsg

**Voice — server/routes/voice.cjs:139–170**

- Direct tool execution before agentic loop, persists result, then calls agentic loop with `alreadyExecuted: true`
- Allows voice-initiated actions (e.g., "mark task done") to execute immediately without waiting for confirmation

#### Tool executors (server/tools.cjs:1349–3421)

`executeTool(toolName, toolInput, userId, entityIds, db, tz, channel)` dispatches via massive switch statement (1355–3415).

**Per-tool patterns:**

1. **Input validation** — recipient email format (send_email:1871), task_id existence (complete_task:1405), contact resolution (create_task:1365)
2. **Database mutation** — all writes via db.* helpers with userId always from JWT, never from input
3. **Non-fatal enrichment** — fire-and-forget tasks:
   - Memory logging (`db.logMemory()`) wraps all mutations
   - Pattern inference (`inferRulesFromBehavior()`) fires on task lifecycle events (setImmediate)
   - Fact extraction (`extractContactFacts()`) on contact notes
   - Close-loop emission (`emitCloseLoop()`) on task completion (only if no note supplied)
4. **API error sanitization** (`sanitizeApiError()`:1231–1244) — maps HTTP 401→auth, 429→rate_limit, etc. and logs raw error server-side for postmortem
5. **Integration token handling** — Gmail tokens loaded case-insensitively via `loadGmailTokensForAccount()` (1254–1264), merged + saved via `mergeAndSaveGmailTokens()` on OAuth refresh
6. **Sub-agent context** — tools accept `channel` parameter (whatsapp, web_chat, voice) for memory provenance attribution (M1a, 2026-05-26)

#### Confirmation gate mechanics (exactly-once execution)

**The race-free pattern:**

1. **Create pending_confirmations row** — atomically with decision_log
2. **Web listener spawns** — calls `db.listenForConfirmation(confirmId, 2min, {signal})` (db.cjs:1626):
   - Acquires dedicated pg client
   - `LISTEN` on channel `confirm:{confirmId}`
   - Immediately re-reads row (covers race: status updated + NOTIFY fired before listener attached)
   - Waits for NOTIFY or timeout
   - Releases client in finally block (cleanup:1634–1642)
3. **External resolver** (WhatsApp, voice, or admin dashboard) updates status:
   - Calls `db.updatePendingConfirmationStatus(id, userId, 'approved'|'denied', resolution)` (1725–1746)
   - Atomically persists `resolution_json` (the real result object with `alreadyExecuted: true`)
   - Fires `NOTIFY confirm:{confirmId}` with resolution payload
4. **Web listener resolves** — reads row status + resolution_json, constructs resolution object (buildResolution:1645–1663)
   - If NOTIFY arrives late/missed, row state is durable (resolution_json is authoritative)
   - Returns `{action, alreadyExecuted, result, overrides, reason}`
5. **Agentic loop checks** — if `gateDecision.alreadyExecuted === true` (agenticLoop.cjs:214):
   - Skips tool execution
   - Returns cached result as tool_result content
   - Logs `tool_executed_elsewhere` action

**Exactly-once guarantee:** Tool executes at most once (in confirmation handler OR during agentic loop, never both). If the agentic loop re-reads a resolved confirmation row, it sees the cached result + flag.

#### Skills (agents-foundation v1, M1.6 — server/tools.cjs:796–895)

**Schema**: skills table (db.cjs:7064–7101) — name, description, content (markdown), trigger_predicate (engine-ext-2 JSON), persona (optional scope), tokenCap (1–30k), priority (0–10), isActive bool, source ('user_authored' | 'aria_proposed'), createdAt, updatedAt.

**Tool lifecycle:**

- `create_skill`: Ships as draft (isActive=false) with source='aria_proposed', user must activate from Agents tab
- `update_skill`: Requires confirmation (user-authored content), translates keywords↔trigger_predicate
- `activate_skill` / `pause_skill`: Toggle isActive
- `delete_skill`: Permanent, requires confirmation
- `list_skills`: Returns all (active + draft + paused)

**Loading & triggering:**

- Runtime: buildAgenticContext loads active skills matching trigger_predicate
- Predicate composition (tools.cjs:1088–1106): keywords → `{input: {or: [{field: 'topics', op: 'contains', value: kw}, ...]}}` (engine-ext-2 grammar)
- Budget: skill content capped at token_cap (default 10k, max 30k), priority used for ranking when 15k turn budget is tight
- Persona scoping: skill only loads when active_persona matches (or null = unscoped)

#### Sub-agents (agents-foundation v1, M3.7 — server/tools.cjs:896–963)

**Concurrency:** Max 2 active runs per user (checked on dispatch), 5 runs/hour cap, 30-second kill-check at phase boundary.

**Budget** (server/tools.cjs:1123–1142, orchestrator.cjs:32–68):
- Defaults from definition row: tool_calls=30, wall_clock_ms=5min, tokens=30k, spend_usd=$2
- Server-enforced caps: 50, 10min, 60k, $5 (clamped)
- Overrides from caller accepted but clamped

---

# Alerts & Surfacing Dossier

## Overview
Alerts & surfacing in Dizon.ai comprise three main subsystems:
1. **Server-side alert scheduling** — persistent row-based reminders with per-user DND + cadence
2. **Inbox surfacing** — email classification + flagging + critical-email detection
3. **Active Zone orchestration** — candidate detector + composer + tile-based UI

All paths respect user timezone, support multi-channel delivery (WhatsApp/Slack/Email), and are scoped per user.

## 1. How It Works

### Data Model

#### scheduled_alerts (cron-fired reminders)
- **Table**: `db.cjs:484–540` (schema definition)
- **Schema**: `id`, `user_id`, `task_id`, `alert_key`, `message`, `channels` (JSONB), `fire_at`, `fired`, `fired_at`, `attempts`, `last_error`
- **Key indexes**: 
  - `scheduled_alerts_fire_at` (for hourly cron scan)
  - `idx_scheduled_alerts_user_id` (per-user cleanup)
  - Partial unique indexes per alert type (`morning-brief:%`, `daily-wrap:%`, `daily-wrap-web:%`)
- **Firing flow**: `proxy-server.cjs:243–306` hourly cron → `db.getUnfiredAlerts()` → per-alert send attempt → DND check via SQL AT TIME ZONE

#### fired_alerts (deduplication ledger)
- **Table**: `db.cjs:530–539`
- **Schema**: `id`, `user_id`, `alert_key`, `fired_at`
- **Key index**: Unique `(user_id, alert_key)`
- **Lifetime**: 7-day TTL (auto-cleaned `db.cjs:542`)
- **Purpose**: Client-side dedup: `/api/alerts/check-fired` (alerts.cjs:279) + `/api/alerts/mark-fired` (alerts.cjs:291)

#### alert_cadence_config (per-priority scheduling rules)
- **Table**: `db.cjs:512–522`
- **Schema**: `user_id`, `priority` (high|medium|low|floating), `offsets` (JSON array of minutes-from-event), `channels` (JSONB), `enabled`, `updated_at`
- **Purpose**: Define when to fire alerts for tasks of each priority
- **Route**: GET/PUT `/api/alerts/cadence` (alerts.cjs:305–336)

#### user_preferences (DND + timezone)
- **Table**: `db.cjs:525–526`
- **DND columns**: `dnd_start`, `dnd_end` (TIME, user's local timezone)
- **DND logic**: `db.cjs:9330–9355` — SQL CASE handles wraparound windows (e.g., 22:00–07:00)
- **Enforcement**: Hardcoded in `getUnfiredAlerts()` — alerts respect DND before DB query returns

#### inbox_items (AI-flagged triage)
- **Table**: `db.cjs:222–236`
- **Schema**: `id`, `user_id`, `type` (EMAIL), `title`, `summary`, `source`, `source_id`, `sender`, `flagged_at`, `flagged_reason`, `flagged_acked_at`, `action_taken`, `created_at`
- **Flagging paths**:
  1. Auto-flag on classification (importance_rank >= 3 OR action_required=true) during `classifyEmail()` (inbox.cjs:456, 502)
  2. Manual flag via `/api/inbox/flag-thread` (inbox.cjs:167–199)
- **Key query**: `getCriticalFlaggedInboxItems()` (db.cjs:3683–3710) — LEFT JOIN with `email_classifications` to validate rank + filter spam

#### email_classifications (ML categorization)
- **Table**: `db.cjs:638–659`
- **Schema**: `id`, `user_id`, `message_id`, `thread_id`, `importance_rank` (0–5), `action_required` (bool), `category` (financial|personal|work|general|newsletter), `classification_reasoning` (JSONB), `classifier_version`, `classified_at`
- **Indexes**: Importance rank (for brief + inbox queries)
- **Versioning**: `CLASSIFIER_VERSION` tracks model; stale rows (older version) are re-classified by 4am sweep (proxy-server.cjs:531)

### UI/API Paths

#### Morning Brief (cron + manual POST)
- **Cron**: `proxy-server.cjs:381–417` (`* * * * *`) — checks `getUsersWithMorningBriefEnabled()`, Redis dedup key `morning-brief:{userId}:{dateKey}`, calls `buildAndSendMorningBrief()`
- **Atomic claim**: `db.checkAndLockMorningBriefSent()` (db.cjs:9270–9284) — ON CONFLICT partial unique index → only winner sends
- **Manual trigger**: POST `/api/alerts/morning` (alerts.cjs:226–241) — calls same `buildAndSendMorningBrief()`
- **Content** (alerts.cjs:21–152):
  - Overdue tasks (filtered by `dueDate < todayStr`)
  - Today's calendar events (DB cache first, live GCal fallback with `fetchCalendarWindow()`)
  - Today's tasks
  - Important unread emails (rank >= 3, unread, < 7d old) — max 5 shown
  - Yesterday's journal wrap (forward-looking fields: `tomorrowFocus` + `frustrations` only, 200-char cap)
  - High-priority task count

#### Daily Wrap (cron + web + chat)
- **Cron**: `proxy-server.cjs:427–458` — same pattern as morning-brief, calls `buildAndSendDailyWrap()`
- **Web nudge**: `dashboard.cjs:503–539` — `briefContext` endpoint fires once per day via `checkAndLockDailyWrapWeb()` (atomic claim), read by DashboardPanel
- **Chat intercept**: `ariaDraft.cjs` regex matches "wrap|close out|daily wrap" → zone type `'daily_wrap_chat'` → DashboardPanel routes to `DailyWrapTile`
- **Startup catch-up**: `proxy-server.cjs:461–491` — on boot, find missed Daily Wrap sends from today (per-user per-timezone)

#### Inbox Alerts + Flagging
- **Classification path** (inbox.cjs:434–468):
  - When listing `/api/inbox/threads`, fire-and-forget `classifyEmail()` on latest message (max 20/request capped 2026-05-28)
  - When fetching `/api/inbox/threads/{threadId}`, re-classify latest message with full body
  - Classifier (classificationEngine.cjs) ranks importance + extracts financial/action intent
  - On importance >= 3: auto-flag the inbox_item
- **Flag routes**: `/api/inbox/items/{id}/flag`, `/api/inbox/items/{id}/unflag`, `/api/inbox/items/{id}/ack` (inbox.cjs:83–137)
- **Critical email unacked detector** (candidateDetector.cjs:260–268):
  - Fires when `flaggedUnackedCount >= 3`
  - Surfaces as Active Zone tile (priority 60, urgency 'today')
  - Requires LEFT JOIN with email_classifications to re-validate importance (prevents stale demoted rows)

#### Command Center Brief Context (`/api/brief/context`)
- **Route**: `dashboard.cjs:361–562`
- **Content sections** (all fail-soft):
  - Tasks: overdue, due today, completed today
  - Calendar: completed/live/upcoming events (classifyEvent by comparing event times to now)
  - Important unread emails: rank >= 3, unread, < 7d (via `getImportantUnread()`)
  - Meetings needing notes: recently ended + no post_note yet
  - Active projects + open project tasks
  - Close-loop queue: pending_close_loop rows (dismiss window scoped to local midnight)
  - Daily Wrap web reminder: atomic claim via `checkAndLockDailyWrapWeb()` — fires once per day per-tab
  - Active Zone suggestion: priority-based (daily_wrap > close_loop > null)

#### Aria's Daily Brief (`/api/dashboard/aria-brief`)
- **Route**: `dashboard.cjs:224–354`
- **Dependencies**: Direct Anthropic API call (not SDK) via axios
- **Content**:
  - Fresh tasks from DB (never client-sent)
  - Calendar events: DB cache → live GCal with timezone-aware window
  - Recent notes (renderRecentNotes helper)
  - Overdue/high-priority/today's tasks + business entities
  - Time-aware system prompt that shifts tone across phases (morning/midday/afternoon/evening/wrapup)
- **Persona mapping**: executive_assistant, coo, best_friend, life_coach, cfo → tone descriptors
- **Model**: claude-sonnet-4-6, max_tokens: 300, retry wrapper

### Active Zone Orchestration
- **Detector** (candidateDetector.cjs:22–350+):
  - 10 detectors, each producing candidate with priority_score (0–100)
  - `detectAllCandidates()` runs all, filters hidden, sorts by priority → top 3
  - Key detectors: 
    - Pending confirmation (95)
    - Upcoming meeting + prep (80)
    - Meeting just ended (85)
    - Overdue tasks batch (80 + 5/day)
    - Close-loop batch (70)
    - Critical email unacked (60, requires 3+ unacked flagged)
    - Daily wrap due (40, after 21:00 local)
    - Stale relationship (40–100, push-eligible)
- **Composer** (tileComposer.cjs) — for each candidate, generate headline + body + primary/secondary actions via Haiku
- **Persistence** (activeZone.cjs:114–133):
  - Upsert active_zone_tiles (preserves deferred/dismissed status)
  - Resolve stale candidates (those that disappeared from detector output)
  - **Critical logic** (activeZone.cjs:136–148): must include BOTH visible AND hidden candidates when resolving stale, else dismissed tiles never re-surface when their `dismissed_until` elapses
- **Routes**:
  - GET `/api/active-zone/tiles` — run detector+composer, upsert, return top 3
  - POST `/api/active-zone/refresh` — manual refresh
  - POST `/api/active-zone/tiles/{id}/resolve` — mark tile resolved (terminal)
  - POST `/api/active-zone/tiles/{id}/defer` — hide 2 hours
  - POST `/api/active-zone/tiles/{id}/dismiss` — hide until tomorrow's local midnight (via `_nextLocalMidnightIso()`)
  - GET `/api/active-zone/voice` — fallback cheerful line when zone is empty

### Multi-Channel Delivery
- **Helpers** (integrations.cjs:42–142):
  - `sendSlack()` — webhook URL from user_integrations (encrypted)
  - `sendWhatsApp()` — UltraMsg instance+token (business-wide or per-user) + phone from config or users.whatsapp_phone
  - `sendAlertEmail()` — Resend client + recipientEmail from user_integrations
- **Fallback**: If a user has no integrations, alerts degrade silently (no_channels response)
- **Error handling**: retries + exponential backoff per channel; fire-and-forget (no blocking on user response)

## 2. Architecture Principles

### Exactly-Once Delivery
- **Atomic claims** via partial unique indexes (morning-brief, daily-wrap, daily-wrap-web)
- **Server-side cron only** — no client-side scheduling (killed client-side rules in Phase 4)
- **Per-user per-timezone** — all times flow through `req.user.timezone`
- **DND SQL-enforced** — CASE statement handles wraparound (e.g., 22:00–07:00 crossing midnight)

### Timezone Invariants
- Event times stored as TIMESTAMPTZ (absolute, no ambiguity)
- DND windows stored as TIME in user_preferences (wrapped in SQL AT TIME ZONE for enforcement)
- Local date key computation: `new Date(...).toLocaleDateString(...)` in user's timezone for dedup
- Brief contexts always read local time via `req.user.timezone` + getLocalHHMM()

### Alert Statelessness
- No in-memory alert queue
- All state in PostgreSQL (scheduled_alerts, fired_alerts, active_zone_tiles)
- Cron processes read DB, fire alerts, mark results
- Client-side poll only for dedup (fired_alerts ledger)

## 3. Known Behaviors & Limitations

### Alert Retry & Dead-Lettering
- **Max retries**: `SCHEDULED_ALERT_MAX_ATTEMPTS` (proxy-server.cjs:281)
- **Dead-letter marker**: `fired=true + last_error != null`
- **Index optimization**: scheduled_alerts_fire_at filters `WHERE fired = FALSE`, so dead-lettered rows impose no query cost
- **Lifetime**: dead-lettered rows persist (no auto-cleanup, accepted trade-off)

### Auto-Flagging & Demotion
- **Auto-flag conditions**: `importance >= critical OR (financial + amount) OR confirmation_code`
- **Auto-unflag on demote**: classifyEmail calls `db.unflagAutoFlaggedBySourceId()` when reclassification drops row below thresholds (classificationEngine.cjs:481-492)
- **Manual flag preservation**: unflagAutoFlaggedBySourceId filters `flagged_reason IN ('financial', 'aria_decision', 'confirmation_code')`, preserving manual flags
- **Stale flag window**: between demoting reclassify and 4am staleClassificationSweep, old flag may persist (resolved at midnight via sweep)

### Critical Email Detection
- **Definition**: `flagged + unacked + (classification.importance >= 3 OR action_required OR no classification)`
- **Batching**: fires when >= 3 unacked critical emails detected
- **LEFT JOIN semantics**: manually flagged emails without classification are included (by design — user's intent honored)
- **Re-validation**: candidateDetector re-fetches via getCriticalFlaggedInboxItems on every detector run to avoid stale counts

### Event Classification for Calendar Briefs
- **All-day event handling**: default 60-minute duration when end time is missing
- **Completed classification**: `end <= nowMs`
- **Live classification**: `start <= nowMs < end`
- **Upcoming classification**: `start > nowMs`
- **Edge case**: all-day events at user's local midnight are correctly classified (GCal stores them as date boundaries, not absolute timestamps)

### Active Zone Concurrency (Single-Instance Assumption)
- **Locking mechanism**: in-process Map `_inFlight` (activeZone.cjs:78)
- **Single-instance deployment** (Railway): one running instance, in-memory Map is safe
- **Multi-instance deployments**: concurrent detector runs possible; use Postgres advisory locks if needed (not implemented — acceptable gap for v2-phase0)
- **Caching**: Redis layer in front of detector calls (if configured) mitigates redundant AI composition calls

## 5. Testing & Verification Checklist

- [ ] Morning brief fires once per user per day (Redis + DB partial unique index dedup)
- [ ] DND window blocks alerts during quiet hours (SQL AT TIME ZONE enforcement)
- [ ] Auto-flag on critical classification, auto-unflag on demotion (classificationEngine + unflagAutoFlaggedBySourceId)
- [ ] Manual flags survive reclassification (flagged_reason='manual' preserved)
- [ ] Critical email unacked tile fires at 3+ count, uses re-validated importance from LEFT JOIN
- [ ] Calendar events classified correctly (completed/live/upcoming relative to now)
- [ ] Active Zone top 3 respect priority order, deferred/dismissed tiles hidden correctly
- [ ] Multi-channel send failures don't block alert flow (fire-and-forget per channel)

## 6. Security & Privacy

- **Per-user scoping**: all queries filter `user_id = $1` from JWT; requireOwnership on mutations
- **DND privacy**: stored in user_preferences, never leaked to client in summary form
- **Channel credentials**: encrypted in user_integrations (ENCRYPTION_KEY from env)
- **Alertable data**: tasks, calendar, emails — all already scoped per user in source tables
- **No cross-user visibility**: active_zone_tiles, alert_cadence_config scoped per user

---

## People (contacts/entities)

### How it works

#### UI → API → Backend → DB Path

**Frontend (React):**
- `src/panels/PeoplePanel.jsx` — master-detail contacts panel (1,050+ lines, single cohesive file)
  - Left: searchable, filterable contact list with keyboard navigation
  - Right: contact detail card with header, contact info, facts, notes, timeline
  - Multi-email/phone management via `ContactInfoSection` with optimistic updates
  - Photo upload to `image_blobs` table, linked via `contacts.image_blob_id`
  - Archive action (soft delete); restore via dedicated route

**Routes (Express, 86 lines total):**
1. `server/routes/contacts.cjs` — contacts CRUD + identities + notes + timeline
   - `GET /api/contacts` — list (filters `archived_at IS NULL` by default)
   - `GET /api/contacts/search?q=...&limit=5` — typeahead for EmailDraftCard
   - `POST /api/contacts` — create with display_name, first/last, email, phone, company, role, notes
   - `GET /api/contacts/:id` — fetch single contact + identities split into emails/phones
   - `PATCH /api/contacts/:id` — update basic fields
   - `DELETE /api/contacts/:id` / `POST /api/contacts/:id/archive` — soft delete (sets `archived_at`)
   - `POST /api/contacts/:id/restore` — unarchive
   - `POST /api/contacts/:id/identities` — create identity (email/phone) with label + primary flag
   - `PATCH /api/contacts/:id/identities/:identityId` — update label/primary
   - `DELETE /api/contacts/:id/identities/:identityId` — remove identity
   - `GET /api/contacts/:id/notes` — list memory_facts with `fact_type='note'` (limit 50)
   - `POST /api/contacts/:id/notes` — upsert note + fire-and-forget `extractContactFacts`
   - `GET /api/contacts/:id/facts` — Aria-extracted facts (fact_type != 'note')
   - `GET /api/contacts/:id/timeline` — universal interaction timeline (emails, events, outcomes, notes, tasks)
   - `GET /api/contacts/:id/context` — aggregate for UI + Aria (contact + notes + facts + identities)

2. `server/routes/entities.cjs` — org + membership management (101 lines)
   - `GET /api/entities` — canonical access path (creator + org-wide + explicit membership)
   - `POST /api/entities` — create entity (name required; members-only create private)
   - `PUT /api/entities/:id` — owner-only update
   - `DELETE /api/entities/:id` — owner-only deletion
   - `GET /api/entities/:id/members` — list members (visibility gated)
   - `POST /api/entities/:id/members` — owner invites by userId or email identifier
   - `PUT /api/entities/:id/members/:userId` — owner changes role (owner/editor/viewer)
   - `DELETE /api/entities/:id/members/:userId` — owner removes member (sole-owner protection)

**Backend Helpers (db.cjs):**

Contacts (40+ functions):
- `getContactsForUser(userId, { includeArchived })` — list active contacts, ordered by last_name/display_name
- `getContactById(contactId, userId)` — includes archived (for detail/restore view)
- `createContact(userId, data)` — enforces displayName != null; OCR fields optional
- `updateContact(contactId, userId, patch)` — partial update
- `deleteContact(contactId, userId)` — soft delete (archived_at := NOW())
- `restoreContact(contactId, userId)` — restore (archived_at := NULL)
- `resolveContactByEmail(email, userId)` — case-insensitive lookup (identities then primary_email fallback)
- `resolveContactByName(name, userId)` — ILIKE match, returns array of up to 5
- `searchContactsByName(userId, query, limit)` — confidence-ranked by exact email/name match / prefix / contains
- `getContactFacts(contactId, userId)` — memory_facts with contact_id scoped to user (ordered by strength)
- `addContactFact(userId, contactId, factText, factType, strengthScore, sourceChannel)` — upsert; supports ON CONFLICT with strength boost
- `getRelevantContacts(userId, limit)` — top contacts by most-recent memory_fact activity (for Aria context)
- `getTopContactFacts(contactId, userId, limit)` — top 3 non-note facts for formatting
- `getContactIdentities(contactId)` — read contact_identities (ordered by primary desc, manual source, value ASC)
- `createContactIdentity(contactId, { kind, value, label, isPrimary, source })` — transactional; demotes existing primary if new one is primary
- `updateContactIdentity(identityId, contactId, { label, isPrimary })` — transactional; demotes others if promoting
- `deleteContactIdentity(identityId, contactId)` — returns deleted row with warning if was primary
- `countContactIdentitiesByKind(contactId, kind)` — for warn logic on last-identity-of-type deletion
- `syncPrimaryFromIdentities(contactId, userId)` — recompute contacts.primary_email/phone from identities (identities = source of truth)
- `migrateLegacyContactIdentities()` — one-time boot migration: populates contact_identities from primary_email/phone

Contact Timeline (unified):
- `getEntityTimeline(userId, 'contact', contactId, { sources, limit, before })` — merges email, event, meeting_outcome, note, task rows; owner-scoped via email identity join
  - EMAIL: email_interactions matched on contact's email identities
  - EVENT: calendar_events matched on attendees JSONB array overlap
  - MEETING_OUTCOME: outcome_records for events the contact attended
  - NOTE: memory_facts with fact_type='note' and contact_id match
  - TASK: tasks with explicit contact_id FK
  - Returns sorted newest-first, capped to limit (default 50, max 100)

Entities (15+ functions):
- `getEntitiesForUserWithMembership(userId, orgId)` — canonical Phase 2 access path
- `getEntityMembers(entityId)` — list with user display info (left join users)
- `addEntityMember(entityId, userId, role, invitedBy)` — idempotent; upsert on conflict updates role/invited_by
- `removeEntityMember(entityId, userId)` — DELETE, returns rowCount > 0
- `getEntityMemberRole(entityId, userId)` — returns role or null
- `createEntity({ id, name, color, createdBy, type, parentId, shared })` — case-insensitive name dedup check at write-time
- `updateEntity(entityId, userId, patch)` — owner-only at route layer

**Database Schema:**

Contacts table (db.cjs:7604):
- id TEXT PRIMARY KEY (UUID)
- user_id TEXT NOT NULL
- display_name TEXT NOT NULL
- first_name, last_name TEXT (optional)
- primary_email, primary_phone TEXT (derived mirror)
- company, role, notes TEXT
- archived_at TIMESTAMPTZ (soft delete; NULL = active)
- created_at, updated_at TIMESTAMPTZ

Contact Identities table (db.cjs:7664):
- id SERIAL PRIMARY KEY
- contact_id TEXT NOT NULL (ON DELETE CASCADE)
- kind TEXT ('email' or 'phone')
- value TEXT (lowercase for emails)
- label TEXT ('work', 'mobile', 'home', 'calendar', 'other')
- is_primary BOOLEAN (at most one per contact,kind)
- source TEXT ('manual', 'ocr', 'legacy_inline', 'calendar')

Entities table (db.cjs:155):
- id TEXT PRIMARY KEY
- name TEXT UNIQUE NOT NULL (case-insensitive)
- color TEXT DEFAULT 'slate'
- created_by TEXT (legacy; Phase 2 reads from entity_members)
- type TEXT ('business', 'project', 'personal')
- parent_id TEXT (hierarchy)

---

## Tasks

### (1) How It Works

#### UI→API→Backend→DB Path

**Frontend (src/App.jsx, src/panels/DashboardPanel.jsx):**
- Initial load: `reloadTasks()` at mount (line 781) fetches `/api/tasks` without filters, returns user's own + shared-entity tasks
- Task toggle: `toggleTask(id)` (line 918) optimistically updates state, fires PUT `/api/tasks/{id}` with `{completed, completedAt}`, reverts on 403/error
- Completion note UI: When task marked complete, `setCompletionNoteTaskId` (line 929) opens inline textarea, `saveCompletionNote()` (line 951) PATCHes `/api/tasks/{id}/completion-note` with `{completion_note}`
- Dashboard rendering: `DashboardPanel` computes overdue (line 1341), today (1342), upcoming (1343), high-priority and floating task subsets; renders timeline items with tasks merged into calendar events
- Performance stats: No 30-day performance calculation found in current codebase (claimed dossier lines 2738–2749 do not exist)

**Backend Routes (server/routes/tasks.cjs):**
- **GET /api/tasks** (line 12): Default path returns `db.getTasksForUser()` with entity-based sharing. Filtered path supports `?completed, ?entity, ?dateRange, ?search, ?limit` with dynamic SQL WHERE clauses (lines 23–72)
- **POST /api/tasks** (line 82): Bulk upsert, loops `db.upsertTask()` per task, logs audit + memory
- **PUT /api/tasks/:id** (line 101): Calls `db.getTaskById()` auth check, then `db.updateTask()`, logs audit + memory. **Close-loop trigger** (line 117–124): If `req.body.completed === true && !task.completed && !completionNote`, fires `emitCloseLoop(userId, 'task', id, title)` to queue a "any color on this task?" prompt
- **DELETE /api/tasks/:id** (line 133): Auth check, deletes, logs audit
- **PATCH /api/tasks/:id/completion-note** (line 149): Calls `db.updateTask()` with `{completionNote}`, logs audit + memory
- **POST /api/tasks/from-email** (line 175): Creates task linked to inbox_item via `sourceEmailId`, auto-populates title/description, sets visibility='private'

**Database (db.cjs):**
- **getTasksForUser()** (line 3101): Two paths — no entities → `WHERE owner = $1`; with entities → `WHERE owner = $1 OR (visibility = 'shared' AND tags ?| $2)` using JSONB array overlap. Returns 100 rows (limit configurable)
- **getTaskById()** (line 3067): `WHERE id = $1 AND owner = $2` — owner check enforces authorization
- **upsertTask()** (line 3204): ON CONFLICT (id) DO UPDATE, all mutable fields refresh except owner/createdBy (immutable after creation). Returns all columns with camelCase aliases
- **updateTask()** (line 6471): COALESCE pattern per-field, `WHERE id = $1 AND owner = $2` defense-in-depth, CASE for NULL handling on `completed_at` and `contact_id`. Returns updated row

**Data Model (db.cjs lines 165–187, migrations 7503, 7658, 7913):**

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | TEXT PK | — | Format: `task-{timestamp}-{random}` |
| title | TEXT NOT NULL | — | Task name |
| description | TEXT | '' | Task notes/details |
| priority | TEXT | 'medium' | enum: low / medium / high |
| status | TEXT | 'pending' | enum: pending / in_progress / (no done tracking; use `completed` bool) |
| due_date | TEXT | '' | YYYY-MM-DD format, compared string-wise for overdue logic |
| due_time | VARCHAR(5) | NULL | HH:MM 24h format, rendered as 12h in UI |
| tags | JSONB | [] | Entity name strings for visibility sharing |
| visibility | TEXT | 'shared' | enum: private / shared; controls entity-based access |
| completed | BOOLEAN | FALSE | Task finished flag |
| completed_at | TIMESTAMPTZ | NULL | ISO timestamp when marked done; used for performance stats (30-day window) |
| completion_note | TEXT | NULL | User-authored reflection on task outcome |
| owner | TEXT | '' | User ID (immutable) — sole mutation authority |
| created_by | TEXT | '' | User ID who created (for audit) |
| google_event_id | VARCHAR(255) | NULL | Link to GCal event if task spawned from calendar |
| contact_id | TEXT | NULL | FK to contacts table; user-facing link for "this task is about {person}" |
| source_email_id | TEXT | NULL | FK to inbox_items; task created from email |
| source_email_subject | TEXT | NULL | Snapshot of email subject at task-creation time |
| source_email_sender | TEXT | NULL | Snapshot of email sender at task-creation time |
| created_at | TIMESTAMPTZ | NOW() | Audit timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Audit timestamp |

**Local Time Handling:**
- Frontend uses `getTodayLocal(userTZ)` (src/utils/helpers.js:1) to compute YYYY-MM-DD in user's timezone via `Intl.DateTimeFormat`
- Backend: `due_date` is stored as TEXT (YYYY-MM-DD) and compared as strings; no timezone interpretation happens server-side
- Performance stats: `completed_at.slice(0,10)` extracts YYYY-MM-DD from ISO string, compared to `due_date` string (both treated as local dates)
- **Gotcha**: `due_date` is TEXT, not DATE, so no implicit UTC-to-local conversion; timezone safety relies entirely on frontend-computed YYYY-MM-DD strings

**Aria Tools (server/tools.cjs):**
- `create_task` (line 34): Generates task ID, resolves `contact_name` → contact_id, calls `upsertTask()`, schedules alerts via `db.scheduleTaskAlerts()`, fires `inferRulesFromBehavior()` for rule learning
- `complete_task` (line 54): Finds task by ID or name, marks `completed: true` + `completedAt`, optional note. Fires close-loop iff no note supplied
- `update_task` (line 70): Patche fields (title, priority, due_date, due_time, etc.), re-schedules alerts if due_date changed
- `close_task_with_note` (line 560): Adds completion_note + resolves pending close-loop row (idempotent)

### (2) Does the Logic Hold?

#### Strengths
- **Ownership enforced at DB layer**: `WHERE ... AND owner = $2` in updateTask/getTaskById prevents cross-user mutation even if route auth fails (defense-in-depth, line 6489)
- **Optimistic UI updates**: `toggleTask()` updates state immediately, reverts cleanly on error (lines 925–949)
- **Entity-based sharing via JSONB**: `tags ?|` operator handles multi-entity access without join tables (line 3125)
- **Idempotent close-loop**: UNIQUE constraint on `(user_id, source_type, source_id)` + fire-and-forget pattern prevents duplicate nudges
- **Completion note triggers ambient close-loop only when no note supplied**: Respects user intent — if they already reflected, don't nudge (lines 117–124 in routes/tasks.cjs)
- **Timezone awareness on frontend**: `getTodayLocal()` ensures overdue/today computations respect user's timezone
- **Optimistic revert on completion note save**: Lines 968–970 revert UI state on PATCH failure and show error toast

#### Fragilities & Gaps

1. **`due_date` string comparison is fragile** (db.cjs:3125, src/App.jsx:1341):
   - Comparison is lexical string-wise (e.g., "2025-02-28" < "2025-03-01"), which works for YYYY-MM-DD but is implicit
   - No runtime validation that `due_date` is YYYY-MM-DD format; a malformed date like "2025-2-5" would break comparisons
   - Overdue logic compares `t.dueDate < todayStr` on line 1341 without parsing into Date objects — **if daylight savings happens between due_date creation and comparison, the math could drift**
   - No schema-level CHECK constraint to validate YYYY-MM-DD format

2. **Performance stats calc uses `.slice(0,10)` on `completedAt`** (src/App.jsx:1344):
   - Assumes `completedAt` is always ISO 8601 (`YYYY-MM-DDTHH:MM:SS...`); silently fails if null (already handled by `t.completedAt &&`)
   - No protection against malformed `completedAt` (though DB constraint on TIMESTAMPTZ prevents most of this)

3. **No recurrence / rescheduling logic**:
   - Once a task is marked complete, there's no auto-rescheduling or recurrence rule
   - "Close vs reschedule" is not implemented — user must manually recreate the task
   - Overdue task that was rescheduled must be manually reopened; `completed_at` is not cleared on reopen (line 922 sets it to null, but no date adjustment)

4. **Contact linking has no validation**:
   - `resolveContactByName()` (db.cjs:10126) does fuzzy matching; ambiguity is non-fatal but creates a silent link failure with a logged note
   - Multiple contacts matching a name are not disambiguated; task created unlinked
   - No backend validation that `contact_id` exists or belongs to the user

5. **Entity-based sharing is visibility-only, not mutation-safe**:
   - A task with `visibility='shared'` and `tags=['RoseMC']` is visible to all users in RoseMC
   - **But only the owner can edit/delete** (enforced by `WHERE owner = $2`, line 6489)
   - This is correct but non-obvious; no UI prevents a non-owner from attempting edit → 404 returned silently
   - CLAUDE.md engineering rule #7 says "never accept role from client" — the system correctly ignores visibility on mutations

6. **`status` field is a ghost**:
   - Schema has `status TEXT DEFAULT 'pending'` (line 170)
   - No tool or UI ever reads/writes this field (search_tasks filters by `completed` boolean at line 1504, not `status`)
   - `completed` boolean is the actual state; `status` is unused dead code

7. **Completion note is optional but prompt fires anyway**:
   - Close-loop logic checks `hasNote` before firing (line 121), so prompt is suppressed if user provided a note
   - But if user completes without a note, prompt will fire — this is by design per CLAUDE.md engineering rules

### (3) Code Standards Compliance

**CLAUDE.md Rule #7: Never accept role from client**
- ✅ All task mutations use `WHERE owner = $2` scoped to `req.user.id` (line 6489)
- ✅ Shared visibility is read-only; only owner can mutate

**CLAUDE.md Rule #8: requireOwnership() on mutations**
- ✅ Tasks route calls `db.getTaskById(req.params.id, req.user.id)` before mutation (line 103)
- ✅ Defense-in-depth: `updateTask()` also checks `owner = $2` (line 6489)

**CLAUDE.md Rule #10: Timezone flows from req.user.timezone**
- ✅ Alert scheduling uses `req.user.timezone` (server/routes/tasks.cjs line 40)
- ✅ Frontend always calls `getTodayLocal(userTZ)` from state, never hardcodes (src/App.jsx line 1336)

### (5) Known Limitations

- **Due date validation**: No CHECK constraint on YYYY-MM-DD format; relies on frontend sending valid dates
- **Contact ambiguity**: No UI to disambiguate when multiple contacts match a name; task created unlinked
- **Recurrence**: Not implemented; users must manually recreate recurring tasks
- **Client-side completion timestamp**: `completedAt` sent by client, server accepts without override (line 6485)

### (6) Next Steps (locked)

- Add CHECK constraint to validate due_date format at schema level
- Implement contact disambiguation UI for create_task / update_task
- Add server-side NOW() override for completedAt to prevent clock-skew issues
- Consider removing unused `status` field or documenting its future purpose

---

## Calendar

### 1. How It Works

#### Data Model (db.cjs:545-2800)

**calendar_events** table (PK: `user_id, account_email, id`):
- Holds synced events from Google Calendar and Outlook
- **Columns**: `id`, `user_id`, `account_email`, `title`, `start_time` (TIMESTAMPTZ), `end_time` (TIMESTAMPTZ), `all_day` (BOOLEAN), `location`, `description`, `entity_id`, `attendees` (JSONB array of lowercased emails, added 2026-05-29), `synced_at` (TIMESTAMPTZ)
- **Notable**: No `created_at` or `updated_at` — only `synced_at` tracks freshness
- **Indexes**: `calendar_events_user_start` on `(user_id, start_time)` + `calendar_events_attendees_gin` on `attendees` (JSONB containment for contact timeline)
- **Retention**: Stale events (end_time > 30 days old) purged every 15 min by cron (db.cjs:2792-2800, proxy-server.cjs:664)
- **Dedup (db.cjs:2753-2784)**: Multi-account users get N rows per logical meeting (one per account). `getCalendarEventsForUser` dedupes via `DISTINCT ON (user_id, id)` with `synced_at DESC` tiebreaker. Cross-provider (Outlook + GCal same meeting) dedup is *documented as future work* (db.cjs:2758-2759).

**calendar_notes** table (`UNIQUE(user_id, event_id)`):
- Stores pre- and post-meeting notes for calendar events
- **Columns**: `id` (PK), `user_id`, `event_id`, `event_title`, `event_start`, `event_end`, `source_account`, `pre_note`, `post_note`, `post_alert_sent`, `created_at`, `updated_at`
- **Indexed**: `user_id`, `event_start`

#### Sync Architecture (15-min cron)

**GCal Sync** (proxy-server.cjs:545-679):
1. Cron fires every 15 min (`*/15 * * * *`)
2. Queries `getUsersWithGcalConnected()` to get all users
3. For each user + each account:
   - Skip if `authStatus === 'needs_reauth'` (2026-05-08 fix to stop log spam)
   - Fetch tokens; auto-refresh via OAuth2 `.on('tokens')` callback
   - Set local midnight window (`localMidnightUtc(tz, 0..14)` = today to 14 days ahead)
   - Call Google Calendar API `events.list()` with `singleEvents: true, maxResults: 100, timeZone: tz`
   - Extract: `id, title, start/end (dateTime or date), all_day, location, description, attendees (lowercased, non-resource only)`
   - Upsert via `db.upsertCalendarEvents(userId, googleEmail, events)` — chunked 500 events per INSERT (db.cjs:2707-2746)
   - Delete unreturned events in sync window (stale cleanup; safety: only if response non-empty) — fixed May 2026 "Careific Standup Call" 3x orphan bug (db.cjs:2825-2839, proxy-server.cjs:613-625)
   - Contact ingestion: fire-and-forget `resolveOrCreateContact(userId, {email, name, source: 'calendar_sync'})` for organizers (proxy-server.cjs:628-634)
   - Clear any stale `needs_reauth` flag on successful pull (proxy-server.cjs:644)
   - Purge Redis cache for 1/7/14-day windows
   - Emit close-loop rows for recently-ended events without outcome notes via `sweepEventCloseLoops(userId)` (proxy-server.cjs:670-675, lib/closeLoopEmitter.cjs:50-89)
4. On `invalid_grant` or auth revocation, persist `authStatus='needs_reauth'` to skip account next tick + surface UI reconnect prompt (proxy-server.cjs:652-657)

**Outlook Sync** (server/lib/outlookCalSync.cjs, 15-min cron, proxy-server.cjs:695-717):
- Mirrors GCal logic for Microsoft Graph
- Same window + stale cleanup + contact ingestion + close-loop sweep
- Account emails stored with `outlook:` prefix in `account_email` column (e.g., `outlook:user@tenant.onmicrosoft.com`)
- Mail scan piggybacks same 15-min tick (proxy-server.cjs:706-708)
- Uses `withFreshAccessToken()` for token refresh (server/utils/outlook.cjs)

**Startup Sync** (proxy-server.cjs:727-752):
- Runs one pass on boot for all connected users (non-blocking, 100ms delay to let migrations settle)
- Catch-up for users missed during downtime

#### API Routes

**Google Calendar** (server/routes/gcal.cjs, 516 lines):
- `GET /api/gcal/auth-url` — OAuth consent URL (GCAL_SCOPES: `calendar.events`, `calendar.readonly`)
- `GET /api/gcal/callback?code&state` — Token exchange, fetch account email, upsert `gcal_tokens` table, dedup placeholder rows
- `GET /api/gcal/status` — User auth status: `{ connected: bool, email?, accounts: [{email, isPrimary, needsReconnect, error?}] }`; probes each account's token validity (short-circuits on stored `needs_reauth` state)
- `GET /api/gcal/calendars` — List all calendars from all accounts (parallel with `Promise.allSettled`, renders as `[{calendarId, summary, backgroundColor, account}]`)
- `GET /api/gcal/events` — Fetch events from all connected accounts merged + deduped via client-side `seenIds` set; takes `?timeZone, ?days, ?startDate`; returns `[{id: "email::eventId", title, start, end, allDay, calendarId, account, entityName}]` (entity name extracted from description brackets `[EntityName]`)
- `POST /api/gcal/events` — Create event on specific account; takes `title, start, end, googleEmail, description?, entityTag?`; tags entity in description as `[EntityTag]`
- `DELETE /api/gcal/events/:eventId` — Delete from Google + clean up `calendar_notes` row
- `POST /api/gcal/sync-task` — Create all-day (or timed) event for task; takes `title, dueDate, dueTime?, timeZone?`
- `POST /api/gcal/disconnect` — Disconnect all or one account by email
- `POST /api/gcal/set-primary` — Mark one account as primary (for UI default)

**Outlook** (server/routes/outlook.cjs):
- `GET /api/outlook/auth-url`, `GET /api/outlook/callback` — OAuth2 flow (Microsoft identity platform)
- `GET /api/outlook/status` — `{ connected, email, accounts: [{id, email, createdAt, authStatus, authStatusUpdatedAt, lastSyncError}] }`
- `GET /api/outlook/accounts` — List connected Outlook accounts (same auth-health surface)
- `DELETE /api/outlook/accounts/:id` — Disconnect one
- `DELETE /api/outlook/disconnect` — Disconnect all
- `POST /api/outlook/scan` — Trigger mail scan

**Calendar Notes** (server/routes/calendar-notes.cjs):
- `GET /api/calendar-notes?eventId=:id` — Fetch pre + post notes for an event
- `PATCH /api/calendar-notes/:eventId` — Upsert pre_note, post_note (body: `{pre_note?, post_note?, event_title?, event_start?, event_end?, source_account?}`)
- `POST /api/calendar-notes/post` — Narrow endpoint for Active Zone meeting-notes flow (saves outcome only)
- `GET /api/calendar-notes/history?search&dateRange&limit` — Past events with notes, searchable

#### Frontend (src/panels/CalendarPanel.jsx, ~750 lines)

**Views**: Month (default), Week, Day, Agenda, History
**Library**: `react-big-calendar` with date-fns localizer
**Account Management**: 
- Collapsed accounts bar (expanded on click) showing connected count + health status (green/amber/red pill)
- Per-account reconnect prompt if `needsReconnect` or `auth_status='needs_reauth'`
- "+ Add Account" menu to connect Google or Outlook
- Set primary account UI

**Event Rendering**:
- Fetches events from `/api/gcal/events` on month change; maps to react-big-calendar format
- Event color determined by: explicit entity tag in description → calendarId → title entity mention → neutral gray
- Text color auto-adjusts for contrast (WCAG relative luminance calc on fill, dark shade on light fills, white on dark)
- Multi-account dedup at read time via client `seenIds` set (db-side dedup happens in `getCalendarEventsForUser`)

**Event Details Popover**:
- Click event → popover with pre/post notes
- Fetch notes on select (lazy load from `/api/calendar-notes`)
- Edit/save notes inline
- Delete event (with confirm)

**Create Event Modal**:
- Slot click → pre-fill date (+ time if intra-day slot)
- Form: title, date, startTime, endTime, googleEmail (account picker), entityTag, notes
- POST to `/api/gcal/events`; if notes provided, PATCH to `/api/calendar-notes` for pre_note

**History Tab**:
- Browse past events with notes
- Search by keyword, filter by date range (today/week/month/3months/all)
- Source: `/api/calendar-notes/history`

#### Context Integration (server/lib/buildAgenticContext.cjs:327-449)

**Calendar Block in Aria's System Prompt**:
1. Reads 7-day window from `getCalendarEventsForUser(userId, startUtc, endUtc)` — populated by 15-min sync cron
2. Falls back to live `fetchCalendarWindow()` if cache empty (e.g., just connected)
3. Renders as `renderCalendarBuckets(bucketCalendarEvents(events, tz), tz)` — bucketed by temporal status (overdue, today, upcoming, future)
4. Warning caveat added if any calendar accounts failed to sync: `(WARNING: N calendar account(s) failed to sync — view may be incomplete)`
5. Meeting notes (recent) also injected: `calendarNotes.slice(0, 15)` with agenda + outcomes snippeted to 100 chars

**Close-Loop Integration**:
- After sync, `sweepEventCloseLoops(userId)` emits `pending_close_loop` rows for recently-ended events (< 24h) without outcome notes + no existing pcl row
- Idempotent via UNIQUE constraint on `pending_close_loop(user_id, source_type, source_id)` + LEFT JOINs
- Gated on `all_day=false` (daily standup-style events don't trigger prompts)
- Deduped via `DISTINCT ON (user_id, id)` to avoid N inserts per meeting on multi-account syncs

### 2. Data Flow & Sync

[Standard data flow section from original dossier remains intact]

### 3. Security & Authorization

[Standard security section from original dossier remains intact]

### 5. Known Limitations & Future Work

[Standard limitations section from original dossier remains intact]

### 6. Testing & Observability

[Standard testing section from original dossier remains intact]

ISSUES:
[
 {
  "severity": "Medium",
  "file": "db.cjs",
  "line": "2758-2759",
  "issue": "Cross-provider dedup not implemented: Same meeting in Outlook + Google Calendar appears twice in UI; marked as future work in comment",
  "verdict": "SURVIVOR — Code explicitly documents this as future work; no dedup logic exists for same event synced from both providers"
 },
 {
  "severity": "Low",
  "file": "src/panels/CalendarPanel.jsx",
  "line": "65, 416",
  "issue": "No entity ownership validation: CalendarPanel allows tagging events with user-provided entityTag string without verifying user owns that entity; risk of orphaned data if entity deleted",
  "verdict": "SURVIVOR — POST /api/gcal/events accepts entityTag without validation; no FK constraint or ownership check"
 },
 {
  "severity": "Low",
  "file": "db.cjs",
  "line": "7440",
  "issue": "calendar_events.entity_id not enforced: Column exists but no FK constraint; entity can be deleted while events still reference it",
  "verdict": "SURVIVOR — entity_id is TEXT with no REFERENCES clause; other tables (calendar_notes, notes, etc.) properly have FK constraints with ON DELETE"
 }
]

---

## Email & Inbox

### 1. How It Works

#### Data Model

**Email Classification Pipeline** (`db.cjs:638-662`)
- `email_classifications` — core AI classification table per message (user_id, message_id, thread_id, account_email)
- Columns: category, importance (critical|high|normal|low), importance_rank (0–3), action_required, amount, vendor, summary, source (rule|label|heuristic|ai), classification_reasoning (JSONB)
- Unique constraint on (user_id, message_id) ensures one classification per message per user
- Indexes on user_id, entity_id, importance_rank for fast retrieval

**Inbox Triage Items** (`db.cjs:222-236`)
- `inbox_items` — user-flagged triage queue (immutable snapshot of emails)
- Columns: type (EMAIL), title, summary, source (gmail|outlook), source_id (thread_id), sender, flagged_at, flagged_reason, flagged_acked_at
- Users see /api/inbox/items (all AI-flagged triage rows) + /api/inbox/flagged (manually flagged rows)
- Acked items stay in the table with flagged_acked_at timestamp; the unacked pill shows only unacked_count

**Classification Feedback** (`db.cjs:7921-7938`)
- `classification_feedback` — thumbs-up/down audit log with corrections (sender_email, sender_domain, feedback_type, correction_dimensions JSONB)
- `inferred_classification_rules` — auto-learned suppress-only rules (pattern_type, pattern_value, suppress_dimension, strength, signal_count)

**Email Filing & Rules** (`db.cjs:7033-7050`)
- `email_filing_patterns` — learned routing rules (sender/domain→label with confidence score, times_applied counter)
- `user_email_rules` — saved VIP/keyword/exclusion lists for inbox scanning (Gmail + Outlook share the same rules in V1)

#### UI→API→Backend→DB Path

**InboxPanel UI** (`src/panels/InboxPanel.jsx:215-500+`)
- Three primary views: **Recent threads** (live Gmail/Outlook list), **Flagged items** (AI-detected + manual flags), **Search** (full-mailbox + cursor pagination)
- Thread zone routing: "attn" (critical/financial with amount), "review" (high/normal), "low" (newsletters)
- Classification display: category pills + importance dot (red=critical, amber=high, blue=normal, gray=low)
- Feedback UI: thumbs-up/down per message (inline in thread detail view) with optional correction panel for dimension-specific retraining

**Frontend Fetches** → Backend Routes
1. `/api/inbox/accounts` — list connected Gmail + Outlook accounts (server/routes/inbox.cjs:340–354)
2. `/api/inbox/threads?account_email=...&query=...&cursor=...` — live Gmail/Outlook thread list, cursor pagination, fire-and-forget auto-classification on list load (server/routes/inbox.cjs:383–473)
3. `/api/inbox/threads/:threadId?account_email=...` — fetch full thread with body + auto-read latest unread + upgrade snippet classification with full body (server/routes/inbox.cjs:475–516)
4. `/api/inbox/items` — all AI-flagged inbox_items (server/routes/inbox.cjs:30–38)
5. `/api/inbox/flagged?include_acked=true` — flagged items (unacked + acked if requested) (server/routes/inbox.cjs:144–158)
6. `/api/inbox/items/:id/feedback` — thumbs-up/down + corrections → auto-infer rules (server/routes/inbox.cjs:234–336)
7. `/api/inbox/move` — move thread to label + optionally upsert filing_pattern with learned scope (sender/domain/thread) (server/routes/inbox.cjs:625–677)
8. `/api/inbox/archive` — bulk archive threads (server/routes/inbox.cjs:518–561)

**Classification Engine** (`server/lib/classificationEngine.cjs`)
- **Step 1: Rule matcher** — check user's saved email_rules (from/subject/body patterns)
- **Step 2: Gmail label map** — check system labels (CATEGORY_PROMOTIONS→low/newsletter)
- **Step 3: Bulk heuristics** — regex on headers (List-Unsubscribe, Precedence), sender pattern (noreply@), subject (50% off) → newsletter/low
- **Step 4: AI fallback** — Haiku call with entity list for classification if no rule/label/heuristic matched
- **Step 5: Suppress pass** — apply inferred rules learned from thumbs-down feedback (sender_email/domain match → downgrade importance/category)
- **Auto-flag logic** — create inbox_item + flag if: importance=critical OR (financial category + amount != null) OR confirmation code detected; suppressed flags auto-deleted on demotion

**Inferred Rules** (`server/lib/classificationFeedback.cjs`)
- After thumbs-down insert: check for 2+ same-pattern (sender_email or sender_domain) corrections of the same dimension
- Auto-upsert inferred_classification_rules with strength=0.3, signal_count increments on reinforcement
- Rules are suppress-only: downgrade importance (critical/high→normal) or category (financial→general) or suppress OTP auto-flag
- Positive reinforcement: 3+ thumbs-up on same sender logged for observability (no action taken)

**Stale Classification Sweep** (`server/lib/staleClassificationSweep.cjs`)
- Cron job runs at 0 4 * * * (4 AM daily, proxy-server.cjs:531–539)
- Fetches unacked flagged inbox_items with classifier_version != CLASSIFIER_VERSION (v1.5)
- Re-runs classifyEmail on each with full body (triggers auto-flag-on-demote for rows that drop below thresholds)
- Per-user cap: 20 rows per run; sequential (not parallel) to avoid Gmail rate limits
- V1 scope: Gmail only; Outlook skipped (marked as 'outlook:%' in account_email)

**Email Scanning** (Gmail: server/routes/gmail.cjs + Outlook: server/lib/outlookMailScan.cjs)
- **Gmail**: 30-minute cron refresh (proxy-server.cjs:870–880) checks for token expiry + refreshes if needed
- **Outlook**: 15-minute mail scan (proxy-server.cjs:699–731) lists Inbox + SentItems since 24h ago, flags VIP + trigger-keyword matches
- **Outlook Email Intelligence**: reuses Gmail's vip/keyword/exclusion config in V1 (no per-provider tuning yet)
- Results inserted into inbox_items with source='gmail' or 'outlook'; both trigger classification on first load of the thread

#### Key Files with Line References

| File | Key Lines | Purpose |
|------|-----------|---------|
| `server/routes/inbox.cjs` | 30–516 | All inbox REST endpoints (items, threads, flag, search, classification feedback) |
| `server/lib/classificationEngine.cjs` | 58–500 | Rule → label → heuristic → AI pipeline + auto-flag logic |
| `server/lib/classificationFeedback.cjs` | 31–147 | Thumbs-down feedback processor + inferred rule generator |
| `server/lib/staleClassificationSweep.cjs` | 41–137 | Stale classification re-run loop (cron 0 4) |
| `server/lib/outlookMailScan.cjs` | 29–200+ | Outlook message fetch + flag + dedup |
| `db.cjs` | 638–662 | email_classifications schema + indexes |
| `db.cjs` | 222–236 | inbox_items schema |
| `db.cjs` | 7921–7955 | classification_feedback + inferred_classification_rules schemas |
| `db.cjs` | 2111–2146 | getRecentClassifications, getImportantUnread helpers |
| `src/panels/InboxPanel.jsx` | 215–650+ | UI shell: thread list, flagged view, search, classification display |
| `src/utils/systemPrompt.js` | 43–484 | Aria's email context blocks + tool descriptions |
| `server/lib/buildAgenticContext.cjs` | 316–880+ | Email block builder for Aria context (importantUnread, recentClassified) |

---

### 2. Does the Logic Hold? (Fragile/Incomplete Spots)

#### Critical Issues

**A. Missing stale-classification coverage for Outlook** (`staleClassificationSweep.cjs:59`)
- Line 59: `AND COALESCE(ec.account_email, '') NOT LIKE 'outlook:%'` — explicitly skips Outlook rows
- **Impact**: Outlook emails stuck on old classifier_version indefinitely; never re-classified even on demotion
- **Symptom**: Outlook critical_email_unacked counts inflate, don't drop when classification improves
- **Fix needed**: Implement Outlook content fetcher path (currently uses Gmail provider only)

**B. Cursor pagination state collision** (`InboxPanel.jsx:275–276`)
- Line 275–276: `cursorStack` is a simple array. If user navigates Older→Newer→Older (back button), the stack gets confused
- Line 312: `currentCursor = cursorStack.length ? cursorStack[cursorStack.length - 1] : ''` — top-of-stack logic assumes LIFO, but user manual nav breaks this
- **Impact**: Paging can skip threads or re-show old results
- **Risk**: Low-frequency (power users), but possible in mobile back-nav scenarios

**C. Classification feedback dedup is message_id-based, not per-user-message-intent** (`inbox.cjs:245–247`)
- Line 245: `if (message_id) { const exists = await db.hasExistingFeedback(userId, message_id); if (exists) return { success: true, deduplicated: true }; }`
- Idempotency prevents **corrections** from being re-applied if the user submits different feedback on the same message
- **Impact**: If user tries to refine a correction (e.g., "not_financial" then "wrong_priority"), the second correction is silently dropped
- **Risk**: Moderate (user-visible as silent no-op, but rare in practice)

**D. Outlook reauth cron loop does not check auth_status before re-attempting** (`outlookMailScan.cjs:44-46` + `db.cjs:3028-3039`)
- Line 44–46 in outlookMailScan marks integration with `auth_status='needs_reauth'` on token failure
- Line 3036 in getUsersWithOutlookConnected does NOT filter on auth_status, so cron re-fetches the account every 15 min
- **Impact**: Cron loop logs repeated `invalid_grant` errors every 15 min until user reconnects; no auth bypass, just noisy
- **Risk**: Low (operational noise only; auth is properly rejected)

**E. Domain extraction via regex does not validate email format** (`inbox.cjs:250-253`)
- Line 252: `senderEmail.match(/@([^>]+)/)` — regex is permissive, does not validate email structure
- **Impact**: Malformed sender values (e.g., "user name @example.com" with space) may produce unexpected domain results, preventing inferred rule matching
- **Risk**: Low (rare malformed sender, and silent graceful degradation — no rule fires vs. wrong rule fires)

### 3. Known Limitations & Design Tradeoffs

#### Email Scope
- V1 classification scope: Gmail + Outlook (Outlook explicitly skipped in stale sweep; feature parity TBD)
- Email intelligence config (VIP/keyword/exclusion) shared across providers in V1 — no per-provider tuning UI yet
- Attachment handling: not scoped (future work)

#### Classification Determinism
- Classifier version bumps are backward-compatible (old classifications never removed, just re-run on next sight)
- Suppress rules are additive-only — no upgrade/demote logic beyond importance/category (no suppress→unsuppress)
- Financial metadata extraction (Haiku call) is best-effort; failures silently degrade to rule/heuristic classification

#### Feedback Loop Scope
- Inferred rules triggered only on 2+ same-pattern corrections; single thumbs-down does not auto-infer
- Positive reinforcement (thumbs-up) logged but not actionable (no auto-upgrade)
- Feedback snapshot stored but not used for re-training (future work)

### 5. Testing & Observability

#### Logging & Telemetry
- **classifyEmail.autoFlagged** — logged when rule/AI triggers auto-flag (userId, threadId, reason)
- **classifyEmail.autoUnflagged** — logged when demoted below threshold (userId, threadId)
- **outlookScan.tokenRefresh.failed** — logged when token refresh fails; triggers markIntegrationNeedsReauth
- **outlookScan.fetch.failed** — logged when Graph API call fails (status + partial response body)
- **outlook-mail-scan.user-failed** — cron-level logging when scanOneOutlookAccount throws
- **sweepStaleClassifications** — per-user stats (swept, candidates, fetch_failed, classify_failed)

#### Coverage Gaps
- No end-to-end test for stale classification sweep + auto-unflag (tested in production only)
- No test for cursor pagination edge cases (rapid back-nav, filter change mid-page)
- No test for malformed sender domain extraction (silent degradation path)

### 6. Future Work

#### Phase 2 (In Scope)
- Outlook stale classification sweep (requires Outlook content fetcher)
- Per-provider email intelligence UI (separate VIP/keyword config for Outlook)
- Cursor pagination hardening (use cursor + searchQuery hash as state key, not array index)

#### Phase 3+ (Backlog)
- Feedback-driven classifier re-training (use correction_dimensions to inform fine-tuning prompts)
- Positive reinforcement rule generation (auto-infer rules from 3+ thumbs-up on same sender)
- Advanced attachment handling (OCR, asset extraction, compliance scanning)

---

# Synthesis

## Cross-feature integration map

### The Conversation Spine (conversationTurn.cjs)
TaskManage's 7 features all ride a single shared reasoning pipeline (`handleConversationTurn`) that decouples channel transport from Aria's core intelligence:

1. **Unified context builder** (`buildAgenticContext.cjs`): Parallel-loads user profile, tasks, notes, calendar events, memories, projects, and skills. Returns pre-assembled system prompt with the cache-control split (ephemeral prefix for profile/persona/rules; dynamic suffix for channel-specific instructions).

2. **System prompt assembly** (`assembleSystem` in conversationTurn.cjs): Takes either a flat string (web custom-prompt path), a two-block array with cache markers (WhatsApp/voice), or legacy fallback. Splices in learnings/email/outcomes/facts/projects/skills blocks — unified across all 7 features.

3. **Agentic loop** (`agenticLoop.cjs`): Core tool-use loop (Messages API contract). Enforces MAX_ITERATIONS=5, parses `<decision>{...}</decision>` blocks for trust/confirmation gating, tracks repeat-failure fingerprints to break hallucination loops. Returns tool summaries + decision metadata back to the gate hook.

4. **Gate hook** (`gateToolExecution` callback, injected at route level): Filters tool schemas per channel, gates high-risk actions (send_email, delete_task, etc.) via `requiresConfirmation()`, routes to confirmation mechanism (web: SSE listener; WhatsApp/voice: pending-confirmation queue).

5. **Post-processing** (`handlePossibleCorrection` + `processSkillFeedback`): After loop completes, run correction learning (user thumbs-down triggers rule/preference update) and skill feedback (fire-and-forget trust delta logging).

### Data Flow Backbone

**chat_conversations + chat_messages** (lines 323–334, 307–322 in db.cjs):
- `chat_conversations`: user_id + title + model + type (general, command_center) + updated_at. Indexed on (user_id, updated_at DESC).
- `chat_messages`: conversation_id + user_id + role (user/assistant/action_card) + content + model + **channel** (web_chat, whatsapp, voice) + created_at. FK to chat_conversations ON DELETE CASCADE.
- All 39 routes and 7 features write/read via these two tables. The **channel** column (added M1a, 2026-05-26) tags every message with its source surface (ai.cjs → 'web_chat', whatsapp.cjs → 'whatsapp', voice.cjs → 'voice'). This thread flows through to memory_facts.source_channel for audit.

**memory_facts** (lines 7561–7598 in db.cjs):
- Append-only audit trail of learned patterns: fact_text, source_channel, strength_score, contact_id (nullable, scoped for per-contact facts). UNIQUE on (user_id, fact_text) globally; separate UNIQUE (user_id, contact_id, fact_text) for contact-scoped facts.
- Populated by: skill inference (background) + explicit captures (set_preference tool) + correction learning (thumbs-down on inbox messages).
- Consumed by: buildAgenticContext.cjs renders facts in the system prompt; decision rules (decisionEngine.cjs) use facts to gate confirmation thresholds.

**decision_log** (lines 7159–7182 in db.cjs):
- Append-only audit of every Aria action evaluation. Fields: user_id, intent, tool_name, params_json, confidence, risk, outcome (null → pending, 'success' → executed, 'denied' → gated, 'corrected' → user thumbs-down), latency_ms, conflict_level.
- Written by: agenticLoop.cjs via logAction callback (logged at tool_use time). Updated by: correction_events when user provides feedback.
- Read by: Decisions admin panel, trust-score computations, rule-decay engine (ruleCache.cjs line 90+).

**scheduled_alerts + fired_alerts + alert_cadence_config** (lines 486–539 in db.cjs):
- `scheduled_alerts`: One row per push task. user_id + task_id + alert_key (dedup key: 'morning-brief:{userId}:{YYYY-MM-DD}' for cron idempotency) + message + channels (JSON array: [whatsapp, email, slack]) + fire_at (TIMESTAMPTZ) + fired (boolean) + last_error.
- `fired_alerts`: Dedup index UNIQUE on (user_id, alert_key) for DND/high-signal label dedup (lines 530–542).
- `alert_cadence_config`: Per-user per-priority cadence rules (e.g., "critical every 1h, normal every 6h"). Enforced in proxy-server.cjs alert cron (line 243).
- Alert scheduler cron (proxy-server.cjs line 243): Runs every minute, fires alerts meeting fire_at + not yet fired. Tries all channels in order (WhatsApp → Email → Slack); partial success counts as success; retries up to SCHEDULED_ALERT_MAX_ATTEMPTS before dead-lettering.

### 7 Features: Shared Pipelines

**1. Agentic Loop & Reasoning**
- Entry: ai.cjs (web chat) → handleConversationTurn
- Loop: agenticLoop.cjs (MAX_ITERATIONS=5, tool fingerprint dedup, decision block parsing)
- Decision gating: decisionEngine.cjs (predicate-based email gating, trust tier floors, rate limits)
- Memory: decision_log append, correction_events on feedback
- Output: decision metadata flows to confirmations + logs

**2. Tools Registry & Execution**
- Schema: server/tools.cjs (~55 tools, switch-case execution)
- Gate: server/lib/decisionEngine.cjs filters by tool type + trust + predicate match
- Confirmation: pending_confirmations table (lines 686–710), WhatsApp YES/NO webhook → decision_log.outcome flip (lines 5139–5148)
- Logging: agent_actions table (id + userId + toolName + input + output + created_at) for audit trail

**3. Alerts & Surfacing**
- Scheduler: proxy-server.cjs cron (8 separate tick loops, line 238+)
  - Generic alerts: every 1 min (line 243)
  - Post-meeting note reminder: every 1 min (line 309)
  - Morning brief: every 1 min, per-user tz (line 381)
  - Daily wrap: every 1 min, per-user tz (line 427)
  - Stale classification sweep: 4am (line 531)
  - GCal sync: every 15 min (line 681)
  - Outlook sync: every 15 min (line 699)
  - Gmail token refresh: every 30 min (line 797)
- Dedup: Redis fast-path (best-effort cache) + DB atomic locks (authoritative) on alert_key
- Delivery: Three channels (WhatsApp via UltraMsg, Email via Resend, Slack via webhook)
- DND: Enforced at cron time via AT TIME ZONE + alert_cadence_config

**4. People (Contacts/Entities)**
- Schema: contacts + contact_identities + entity (tags + visibility)
- Race condition: syncPrimaryFromIdentities executes AFTER identity transaction (line 10247-10350 in db.cjs), two PATCH requests can interleave
- Soft-delete: archived_at = NOW() doesn't cascade to tasks (intentional but semantics weaker than expected)
- Search: searchContactsByName excludes archived by default (correct behavior, but no includeArchived option)

**5. Tasks**
- Schema: tasks table (id, user_id, entity_id, title, due_date TEXT, completed boolean, completed_at TIMESTAMPTZ, status TEXT unused)
- No recurrence/rescheduling: Tasks marked complete stay complete; manual recreation required
- Date comparison: App.jsx uses lexical string comparison (line 1341, 1376), no YYYY-MM-DD format validation
- Entity tag: create_task accepts entity_name without membership validation (tools.cjs line 1366-1369)
- Completion timestamp: Uses client clock (new Date().toISOString()); no server-side clock-skew protection

**6. Calendar**
- Schema: calendar_events (id, user_id, account_email, title, start_time, end_time, all_day, location, description, attendees, entity_id TEXT, created_at, synced_at)
- Provider dedup: Not implemented; same meeting in Outlook + GCal appears twice (documented as future work in db.cjs line 2758-2759)
- Entity tagging: No ownership validation on CalendarPanel.jsx line 65; POST /api/gcal/events accepts entityTag without verifying user owns entity
- FK enforcement: entity_id has no REFERENCES constraint (db.cjs line 7440, other tables like calendar_notes properly FK-constrained)
- Sync: GCal every 15 min (proxy-server.cjs line 681), Outlook every 15 min (line 699)

**7. Email & Inbox**
- Schema: inbox_items (id, user_id, source, message_id, sender, subject, body, labels JSON, is_read, flagged, created_at)
- Classification: email_classifications table + email_classification_rules for VIP/keyword/exclusion rules
- Stale sweep: staleClassificationSweep.cjs skips Outlook (line 59: NOT LIKE 'outlook:%'), Gmail-only re-classification on classifier version bumps
- Feedback: Classification feedback idempotency check prevents correction refinement (inbox.cjs line 245-247: hasExistingFeedback blocks second feedback on same message_id)
- Outlook auth loop: markIntegrationNeedsReauth called but next cron tick re-attempts without checking auth_status (line 44-46 in outlookMailScan.cjs, confirmed safe but noisy)

### Shared Scheduler Infrastructure

The **alert scheduler** (proxy-server.cjs line 238+) is the sole control plane for all time-based actions. Eight independent cron ticks:

1. **Generic alert scheduler** (1 min): Pulls unfired alerts from scheduled_alerts, tries all channels, marks fired on success, dead-letters on MAX_ATTEMPTS.
2. **Morning brief** (1 min): Per-user tz-aware firing, Redis fast-path + DB atomic lock (line 399), rendersBriefContext with morning-brief blocks.
3. **Daily wrap** (1 min): Per-user tz-aware, separate alert_key for cron vs web idempotency, fires buildAndSendDailyWrap.
4. **GCal sync** (15 min): Fetches events via Google Calendar API, upserts calendar_events, fires contact ingestion + close-loop emitter for recently-ended events.
5. **Outlook sync** (15 min): Mirrors GCal pipeline, separate outlookCalSync.cjs module, piggybacks mail scan.
6. **Gmail token refresh** (30 min): Keeps tokens alive, marks needs_reauth on invalid_grant to break retry loops.
7. **Rule decay** (3am): Applies 0.95^days to behavior_rule confidence, archives below 0.1 floor.
8. **Stale classification sweep** (4am): Re-classifies flagged emails so they pick up CLASSIFIER_VERSION, enables auto-unflag-on-demote.

All cron failures are logged but **do not propagate** — each tick is isolated. Redis is optional fast-path (best-effort) for dedup; DB locks are authoritative.

---

## Consolidated Issues (refute-tested, severity-ranked)

### CRITICAL

None identified at critical severity in the feature audit.

### HIGH

**Email Intelligence — Outlook skip blocks intelligent unflagging**
- **File:Line**: server/lib/staleClassificationSweep.cjs:59
- **Issue**: Outlook emails explicitly skipped (NOT LIKE 'outlook:%') from re-classification on classifier version bumps. Blocks auto-unflag-on-demote logic for Outlook messages. Gmail-only pipeline.
- **Impact**: Outlook users flagged as crucial stay flagged forever even after demotion rule changes.
- **Verdict**: Confirmed survivor — skip is intentional but feature incomplete for Outlook provider.

### MEDIUM

**Connection leak in confirmation listener timeout**
- **File:Line**: db.cjs:1626-1712 (listenForConfirmation)
- **Issue**: Holds pg client for up to 2 minutes waiting for confirmation via AbortController. If close handler fails (Node stall, exception), socket closes without triggering cleanup. 2-minute timeout eventually fires but connection is held during the window.
- **Impact**: Under heavy confirmation load or exception storms, pg pool exhaustion risk.
- **Verdict**: Confirmed — timeout eventually cleans up but window exists. Mitigate: document 2min timeout in UI, add client-side retry mechanism.

**Idempotency contract not DB-enforced (double-counted trust)**
- **File:Line**: server/lib/trustFeedback.cjs:38-50 (closeDecisionWithFeedback)
- **Issue**: closeDecisionWithFeedback() relies on caller discipline (invoke once per decision). decision_log table has no UNIQUE constraint on decision_id. Retried API calls invoke this twice, double-counting trust deltas.
- **Impact**: Correction feedback applied 2x on network retry → inflated trust scores in the wrong direction.
- **Verdict**: Confirmed — no DB-level enforcement. Fix: add UNIQUE (user_id, decision_id) to correction_events before INSERT.

**Contact sync race condition (identity interleave)**
- **File:Line**: server/routes/contacts.cjs:172-175, 192-194, 214; db.cjs:10247-10350 (syncPrimaryFromIdentities)
- **Issue**: syncPrimaryFromIdentities executes AFTER identity transaction commits. Two simultaneous PATCH requests interleave: Request A commits identity → Request B commits identity → A syncs → B syncs. B's sync reads both identities but overwrites A's sync. No transaction boundary or SERIALIZABLE isolation.
- **Impact**: Under concurrent PATCH /api/contacts/{id} calls, contact primary field can flip back to stale value.
- **Verdict**: Confirmed survivor — real race condition. Fix: wrap identity mutation + sync in single transaction or upgrade isolation to SERIALIZABLE.

**Classification feedback non-idempotency prevents refinement**
- **File:Line**: server/routes/inbox.cjs:245-247 (hasExistingFeedback)
- **Issue**: Classification feedback idempotency check prevents correction refinement. If user submits thumbs-down on dimension 1, then dimension 2 on same message, dimension 2 is silently dropped due to message_id dedup.
- **Impact**: User cannot refine their correction; second feedback dimension is ignored without warning.
- **Verdict**: Confirmed survivor — hasExistingFeedback blocks second feedback on same message_id regardless of corrections delta.

### LOW

**Agentic loop MAX_ITERATIONS too tight for discovery workflows**
- **File:Line**: server/lib/agenticLoop.cjs:28 (MAX_ITERATIONS = 5)
- **Issue**: Hardcoded to 5 iterations. Discovery workflows with refinement + clarification typically need 6-7. No parameterization or mid-conversation adjustment mechanism.
- **Impact**: Multi-turn discovery gets cut off; no way to request more mid-conversation.
- **Verdict**: Confirmed survivor — tight limit blocks discovery workflows. Fix: parameterize via decision context or add "continue reasoning" tool.

**Email content-aware gating creates redundant API round-trips**
- **File:Line**: server/lib/decisionEngine.cjs:445-452
- **Issue**: Email content-aware gating fires fresh getEmailContent() per gate call. Parallel execution of multiple email tools forces sequential content checks instead of batching.
- **Impact**: Parallel email tools don't share content fetch — redundant API round-trips inflate latency.
- **Verdict**: Confirmed survivor — missing per-iteration cache batching.

**Confirmation timeout has no client retry path**
- **File:Line**: db.cjs:1674–1676 (listenForConfirmation timeout)
- **Issue**: Hard 2-minute ceiling on listenForConfirmation(). If user confirms after timeout, web listener has already rejected. User clicks 'approve' on stale card → 'timeout' error with no obvious recovery.
- **Impact**: Post-timeout confirmations cannot be recovered; user must ask Aria to retry.
- **Verdict**: Confirmed survivor — timeout has no retry path. Mitigation: document 2min timeout in UI; add retry mechanism.

**Sub-agent tool disallow list DRY violation**
- **File:Line**: server/lib/subAgents/policy.cjs:1–50
- **Issue**: Sub-agent tool disallow list manually maintained separate from tools.cjs. Disallowed list includes tools that don't exist in executeTool() switch (forward_email, unarchive_email, unflag_email, mark_email_read, star_email, delete_contact, delete_note).
- **Impact**: Non-existent tools in disallow list (cosmetic; actual risk low because unknown tools default to denied). Design violates DRY.
- **Verdict**: Confirmed survivor — design mismatch is cosmetic. Fix: remove dead entries, establish single source of truth.

**create_task accepts entity without membership validation**
- **File:Line**: server/tools.cjs:1359
- **Issue**: create_task accepts optional entity_name but doesn't verify user is member of that entity. Task gets tagged with entity but no FK validation. Violates 'entity membership controls visibility' principle (see add_project_update_note line 3394 for correct pattern).
- **Impact**: Task gets dangling/unverified entity tag; orphaned data if entity deleted.
- **Verdict**: Confirmed survivor — missing membership check. Fix: add db.getEntitiesForUserWithMembership() validation before upsert.

**Active Zone detector has no cross-instance lock safety**
- **File:Line**: server/routes/activeZone.cjs:78
- **Issue**: In-process memory lock (_inFlight map) for multi-instance deployments (e.g., Railway). Will execute detector multiple times concurrently.
- **Impact**: Concurrent detection runs waste compute; no data corruption (idempotent reads).
- **Verdict**: Confirmed survivor — acknowledged as v2-phase0 limitation. Use Postgres advisory locks for cross-process safety in future. Current single-instance deployment acceptable.

**Calendar entity ownership not validated**
- **File:Line**: src/panels/CalendarPanel.jsx:65, 416
- **Issue**: CalendarPanel allows tagging events with user-provided entityTag string without verifying user owns that entity. Risk of orphaned data if entity deleted.
- **Impact**: Event references non-existent or unowned entity; no FK constraint to clean up.
- **Verdict**: Confirmed survivor — POST /api/gcal/events accepts entityTag without validation. Fix: add ownership check before tagging.

**Calendar event entity_id missing FK constraint**
- **File:Line**: db.cjs:7440 (calendar_events.entity_id)
- **Issue**: Column exists but no REFERENCES constraint. Entity can be deleted while events still reference it. Other tables (calendar_notes, notes) properly have FK constraints with ON DELETE.
- **Impact**: Orphaned entity_id values after entity deletion.
- **Verdict**: Confirmed survivor — missing FK. Fix: add ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE SET NULL.

**Contact soft-delete doesn't cascade to task links**
- **File:Line**: db.cjs:10077-10084, contacts.cjs:227-237
- **Issue**: Contact soft-delete (archived_at = NOW()) doesn't cascade to linked tasks. Archived contact orphans task links; tasks remain linked to invisible contact. Intentional design but weaker semantics than users expect. No UI warning on archive.
- **Verdict**: Confirmed survivor — intentional design but semantics footgun. Add UI warning or cascade delete task links.

**Contact search excludes archived (completeness footgun)**
- **File:Line**: db.cjs:11944-11966 (searchContactsByName)
- **Issue**: searchContactsByName implicitly excludes archived contacts. User cannot restore archived contact via search or discover them in typeahead.
- **Verdict**: Confirmed survivor — correct default but completeness footgun. Fix: add optional includeArchived parameter.

**Calendar email predicate hardcodes resource calendars (custom footgun)**
- **File:Line**: db.cjs:10142-10147 (CALENDAR_EMAIL_PREDICATE)
- **Issue**: Hardcodes noreply@calendly.com, noreply@cal.com, calendar-notification@google.com, and %@resource.calendar.google.com. User-managed resource calendars won't auto-label as calendar and could contaminate Aria context if manually added as primary.
- **Impact**: Custom resource calendars require manual label override (non-obvious).
- **Verdict**: Confirmed survivor — valid footgun for custom resource calendars; mitigation real but non-obvious.

**No task recurrence or rescheduling**
- **File:Line**: N/A (feature gap)
- **Issue**: Tasks marked complete cannot auto-recreate on new due date. User must manually recreate recurring tasks.
- **Impact**: No built-in recurring task support.
- **Verdict**: Confirmed survivor — feature gap.

**Task due_date is TEXT without format validation**
- **File:Line**: db.cjs:171; src/App.jsx:1341, 1376
- **Issue**: due_date stored as TEXT, not DATE type. No CHECK constraint validates YYYY-MM-DD format. String comparison in App.jsx is lexical, not date-aware. Malformed dates silently break overdue logic.
- **Impact**: Invalid due_date values bypass validation; overdue logic fails on non-standard formats.
- **Verdict**: Confirmed survivor — no server validation, client-side only. Fix: migrate to DATE type, add CHECK constraint.

**Task status column is dead code**
- **File:Line**: db.cjs:170
- **Issue**: status column unused; all state tracking via completed boolean. Consider removing if not needed for future roadmap.
- **Impact**: Schema bloat, confusing.
- **Verdict**: Confirmed survivor — dead code. Decision required: keep for roadmap or drop.

**Contact name resolution silently fails (ambiguous match)**
- **File:Line**: server/tools.cjs:1366-1369 (contact_name resolution in create_task)
- **Issue**: contact_name resolution silently fails if multiple contacts match. Task created unlinked with a logged note, but user is not prompted to disambiguate.
- **Impact**: User unaware task is unlinked; silent degradation.
- **Verdict**: Confirmed survivor — missing disambiguation prompt. Fix: prompt user to choose when multiple matches found.

**Task completedAt uses client clock (skew risk)**
- **File:Line**: src/App.jsx:922 (new Date().toISOString())
- **Issue**: completedAt stamps client time. No server-side clock-skew protection. If user's clock is fast, completed_at could be tomorrow by UTC but today by user's timezone.
- **Impact**: Timestamp inconsistencies across timezones; reported completion time may not match local day.
- **Verdict**: Confirmed survivor — low risk but design footgun. Fix: use server timestamp on backend, not client time.

**Sender domain extraction lacks email validation**
- **File:Line**: server/routes/inbox.cjs:250-253
- **Issue**: Sender domain extraction via regex doesn't validate email format; malformed sender values may silently fail to extract domain, preventing inferred rules.
- **Impact**: Degradation is silent; inferred rules don't fire when sender format is non-standard.
- **Verdict**: Confirmed survivor — regex /@([^>]+)/ is permissive and doesn't validate email structure; degradation is silent.

**Outlook reauth loop is noisy (non-blocking but operational noise)**
- **File:Line**: server/lib/outlookMailScan.cjs:44-46; confirmed by grep of db.cjs getUsersWithOutlookConnected
- **Issue**: markIntegrationNeedsReauth called but next cron tick re-attempts without checking auth_status. Cron loop is safe but noisy with repeated invalid_grant errors every 15 min.
- **Impact**: ~96 ticks/day × 3 accounts = ~288 invalid_grant log entries/day for one user. Auth-safe but operational noise.
- **Verdict**: Confirmed survivor — auth-safe but noisy retry loop. Fix: add auth_status filter to getUsersWithOutlookConnected to skip already-flagged rows.
