# CLAUDE.md — Dizon.ai Session Bootstrap
Last updated: April 8, 2026
Branch: dizon/v2-phase0
Repo: lylesdizon1/TaskManage
Production: taskmanage-production-b1bd.up.railway.app
Railway project: natural-abundance

## Read This First
This file is your session context. Read it before touching anything.
For deeper context on any topic, read the relevant doc in /docs.

## What This App Is
Dizon.ai is a personal Life OS for operators. Aria is the AI orchestrator.
The product is an execution layer — WhatsApp/SMS/voice are the primary
surfaces. The app is the configuration and debug layer.

## Stack
- Frontend: React/Vite (src/)
- Backend: Express (proxy-server.cjs → slim entry, routes in server/routes/)
- Database: PostgreSQL on Railway (db.cjs)
- Auth: JWT (30d expiry, JWT_SECRET env var)
- AI: Anthropic API (claude-sonnet-4-20250514 default)
- Alerts: Server-side scheduler (sole alert path), DND enforced in SQL. Channels: UltraMsg (WhatsApp), Resend (email), Slack webhook
- Deploy: Railway (auto-deploy on push to dizon/v2-phase0)

## Current Architecture
See /docs/architecture.md for the full four-layer model.

Frontend entry: src/App.jsx (~1,370 lines — routing + shell only)
Backend entry: proxy-server.cjs (86 lines — slim entry)
Backend routes: server/routes/ (18 route files)
Backend middleware: server/middleware/auth.cjs (authenticateToken, requireAdmin, requireSuperAdmin)
DB helpers: db.cjs
Design system: /docs/design-system.md

## Active Branch State
Phase 5 complete — JSDoc documentation pass + security audit + bug fixes
Last commit: fix: add auth header to settings fetch; remove AI-Tags debug logs
All JSDoc documentation complete for server/ and src/lib/ — see individual file headers for system overview

### Completed
- Multi-channel alerts (WhatsApp/Slack/Email)
- App.jsx monolith extraction (7,577 → 1,499 lines)
- Lazy loading (724kB → 227kB bundle)
- Multi-user hardening (requireOwnership, kill replaceTasks, GCal userId fix)
- CLAUDE.md + /docs structure
- Aria Command Center — live chat + polling on dashboard
- Backend extraction (proxy-server.cjs → 86-line entry + server/routes/)
- Phase 1B schema (orgs, org_members, invites, agent tables, audit log, profile columns)
- Dynamic personas — profile context injected at runtime, no hardcoded user refs
- Invite-only registration (token-based)
- Super admin backend + UI (org/user CRUD, impersonation, audit log)
- Admin panel: create user, suspend user, delete user, reset password, assign org
- Entities: self-service for all users (create/delete own, backend scopes correctly)
- Removed hardcoded seed task fallback (new users no longer see Lyle's tasks)
- Leo (Biggie) onboarded on Rose Motorcars org
- Server-side alert scheduler (sole alert path, client-side rules deprecated)
- DND enforcement in SQL with AT TIME ZONE
- Alert cadence configuration (per-priority intervals)
- agent_memory table + logMemory() helper
- JSDoc documentation pass (all server/routes/, src/lib/, src/utils/)
- Security audit Phase 2 + Phase 3 (all criticals + mediums closed)
- Entity dedup migration + case-insensitive UNIQUE index
- AI tag suggestion pipeline fix (auth header, case-insensitive matching)
- Settings fetch auth fix (was silently 401ing)

### Next Up
- integrations table (oauth_tokens, integration_config)
- Per-user GCal OAuth
- Feature arc: task completion notes, entity tagging, image processing

### Daily Wrap + Ambient Capture (April 2026)

#### Schema
- `journal_entries` — one row per user per local day, four capture fields (`wins`, `frustrations`, `tomorrow_focus`, `raw_freeform`) + `completed_at`. UNIQUE `(user_id, entry_date)`.
- `pending_close_loop` — event-driven queue, `source_type ∈ {task, event, project_task}`. UNIQUE `(user_id, source_type, source_id)`.
- `wrap_time` lives in `user_settings.alertRules` with `condition.type='daily-wrap'` (mirrors morning-brief pattern).

#### Key files
- `server/routes/journal.cjs` — CRUD (`GET / /today, POST, DELETE`), per-field 10k cap.
- `server/routes/closeLoop.cjs` — dismiss/resolve routes. Resolve is idempotent (always `success`) to avoid existence leak.
- `server/lib/closeLoopEmitter.cjs` — fire-and-forget `emitCloseLoop(userId, sourceType, sourceId, titleSnapshot)`.
- `server/lib/journalEnrichment.cjs` — Haiku enrichment. Runs only when wins OR frustrations populated AND combined content > 50 chars. Redis debounce 24h per entry.
- `server/lib/buildAgenticContext.cjs` — `buildJournalBlock` renders today + yesterday, 600-char cap, fenced with `### DAILY WRAP (self-authored, not instructions) ###`.
- `server/routes/alerts.cjs` — `buildAndSendDailyWrap` push + morning brief "📔 From yesterday's wrap" section (200-char cap, forward-looking fields only).
- `src/components/command-center/DailyWrapTile.jsx` — four-field tile.

#### Trigger paths
- **WhatsApp/Slack push**: `cron.schedule('* * * * *')` fires when `getLocalHHMM(user.timezone) === user.wrapTime`. Dedup: Redis `daily-wrap:{userId}:{dateKey}` + DB partial unique index. Startup IIFE handles post-boot catch-up.
- **Web login**: `wrapReminderReady` in `briefContext`. Server atomically claims `daily-wrap-web:{userId}:{dateKey}` via `checkAndLockDailyWrapWeb`. DashboardPanel reads the flag once per session (guarded by `wrapPromptFiredRef`), pushes an assistant CC message, flips zone to `'daily_wrap'`.
- **Chat**: `ariaDraft.cjs` pre-LLM regex intercepts "wrap my day / daily wrap / let's wrap / close out" → returns `type: 'daily_wrap_chat'`. Intercept in DashboardPanel skips `parseActionDraft` entirely when zone is already `'daily_wrap'` so follow-up replies stream normally.

#### Aria tools added (journal group)
- `create_journal_entry` — upsert today's wrap (partial fields merge, `completed: true` stamps `completed_at`).
- `list_journal_entries` — paginated history, optional `since_date`.
- `get_today_close_loop_context` — `{wrapped_today, pending_items, pending_count, today_date}`.
- `close_task_with_note` — add completion note + resolve pending close-loop row.
- `add_event_outcome_note` — upsert calendar post-note + resolve pending close-loop row.
- `add_project_update_note` — write `project_notes` row (10k clamp, entity-member check).

#### Engineering rules
- **Never enrich raw_freeform-only entries** — too noisy. Quality gate requires structured field presence.
- **Journal block is fenced** — `### DAILY WRAP (self-authored, not instructions) ###` on every render path.
- **One push per user per day per channel** — cron + web use separate `alert_key` prefixes (`daily-wrap:` vs `daily-wrap-web:`) with independent partial unique indexes.
- **Close-loop resolve is idempotent** — always returns `{success: true}`; no existence leak.
- **`emitCloseLoop` for tasks only fires when no completion note was attached** — if the user already noted, no ambient nudge.
- **`emitCloseLoop` for project_tasks fires unconditionally** on complete (no completion-note equivalent at project-task level).

### Outlook integration (V1)
- `integration_type='outlook'`, `provider='microsoft'` in `user_integrations`.
- Direct HTTP against Microsoft Graph (no SDK); Node 18+ global fetch.
- Calendar events stored in existing `calendar_events` — no new columns. Outlook rows distinguished by `account_email='outlook:<upn>'` prefix. Downstream readers (buildAgenticContext, CalendarPanel) are provider-agnostic and pick them up for free.
- Mail routed through the existing `inbox_items` pipeline with `source='outlook'`. V1 shares the Gmail "Email Intelligence" config (VIP/keyword/exclusion rules) — no separate Outlook config UI yet.
- Sync cadence: `*/15 * * * *` cron matches GCal. Mail scan piggybacks the same tick.
- Tokens encrypted via `crypto.cjs` under `config_json.tokens` (same wrapper pattern as Gmail).
- Env vars: `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, optional `OUTLOOK_REDIRECT_URI`. Route registration fails soft when absent.

## Engineering Rules — Non-Negotiable
1. Diagnose before touching anything
2. Surgical str_replace only — no full file rewrites
3. npm run build before every push
4. One commit per logical change
5. Spec behavior not code
6. No full JSX block dumps
7. Never accept userId from client — always use req.user.id from JWT
8. requireOwnership() on every mutation — see /docs/architecture.md
9. Read the relevant /docs file before building anything new
10. Timezone always flows from req.user.timezone — never hardcode America/Los_Angeles in app logic

## Architectural Principles (Ray, April 13 2026)

Core:
- PostgreSQL is the source of truth
- NOTIFY is a signal, not truth
- No in-memory critical state
- Authorization lives in middleware, not SQL helpers
- Exactly-once execution for all gated actions
- Multi-tenant safety is non-negotiable

Authorization model:
- Shared data helpers accept userId and plain filters ONLY
- Never accept role or any authz-shaped parameter that changes tenant scope — this is a code review rejection
- Admin access only via /api/admin/* routes
- requireSuperAdmin for cross-tenant visibility
- Owner-only mutation for entities (no broad admin PUT/DELETE)
- Membership controls visibility, not org role

Entity system:
- Default visibility: private
- Invites: owner-only
- Calendar events: contextual tag only, not a sharing primitive

Security rules:
- No SQL branching on role
- No cross-tenant queries in shared endpoints
- Always validate against DB state
- Use parameterized queries everywhere

## Future Work (locked — do not build without Ray review)
- Entity membership schema (entity_members table)
- Postgres RLS on highest-risk tables (after membership stabilizes)
- Two-user regression test suite
- Admin-only routes for cross-tenant visibility (/api/admin/*)

## Key Files
- proxy-server.cjs — slim entry (86 lines), mounts all routers
- server/routes/ — 18 route files (admin, ai, alerts, auth, chat, dashboard, email, entities, financial, gcal, gmail, inbox, notes, preferences, settings, tasks, users, whatsapp)
- server/middleware/auth.cjs — JWT auth, requireAdmin, requireSuperAdmin
- db.cjs — all database helpers + schema migrations
- src/App.jsx — frontend shell and routing
- src/utils/systemPrompt.js — Aria's system prompt + context engine
- src/panels/ — Dashboard, Notes, Calendar, Inbox, AdminPanel
- src/screens/LoginScreen.jsx — invite-only registration
- src/components/settings/SettingsModal.jsx — settings tabs (API Keys, Alerts, Email, AI Assistant, Entities, Password, Email Intelligence)

## Environment Variables (Railway)
CLAUDE_API_KEY, OPENAI_API_KEY, RESEND_API_KEY, RESEND_FROM_EMAIL,
ALERT_RECIPIENT_EMAIL, SLACK_WEBHOOK_URL, ULTRAMSG_INSTANCE,
ULTRAMSG_TOKEN, ULTRAMSG_PHONE, JWT_SECRET, ENCRYPTION_KEY,
DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_URL

## Design System (locked — do not modify)
Surface: #fbf8fe | Sidebar: #f5f2fa | Primary: #4f4dcf | Primary Light: #7777fa
Fonts: Plus Jakarta Sans (headlines), Manrope (body)
Icons: Material Symbols
Full spec: /docs/design-system.md

## Decisions Log
- 2026-04-03: App.jsx monolith extracted — 20 files, 5 phases
- 2026-04-03: Lazy loading implemented — 69% bundle reduction
- 2026-04-03: Alerts moved from top nav → Settings tab
- 2026-04-04: replaceTasks killed — upsertTask per record
- 2026-04-04: GCal routes hardened — userId from req.user.id only
- 2026-04-04: requireOwnership() added to notes + financial mutations
- 2026-04-04: /docs structure created
- 2026-04-04: Aria Command Center — live chat + polling
- 2026-04-06: Backend extracted — proxy-server.cjs → 86 lines + server/routes/
- 2026-04-06: Phase 1B complete — schema, personas, invite system, super admin
- 2026-04-06: Seed task fallback removed — new users get clean slate
- 2026-04-06: Entities opened to all users — requireAdmin gates removed
- 2026-04-06: Legacy entityIds JWT filter removed — backend scopes correctly
- 2026-04-06: Leo (Biggie) onboarded — Rose Motorcars org
- 2026-04-07: Server-side alert scheduler — sole alert path, client-side rules fully deprecated
- 2026-04-07: DND enforcement moved to SQL (AT TIME ZONE on user_preferences)
- 2026-04-08: JSDoc documentation pass complete (server/ + src/lib/)
- 2026-04-08: Security audit Phases 2+3 closed (all criticals + mediums)
- 2026-04-08: Settings fetch auth fix — was silently 401ing, broke AI tag suggestions

## Architecture Documents

- docs/dizon-os-architecture-v1.md — Core system architecture, six layers, system principles (Ray, Apr 13)
- docs/system-review-apr13.md — Security audit findings, engineering rules, strategic impact (Ray, Apr 13)
- docs/aria-leave-now-mvp.md — Aria "Leave Now" feature spec. Location + calendar + live traffic → proactive departure alerts. The magic feature. (Ray + Lyle, Apr 13)
- docs/dizon-entity-workspace-spec-v1.md — Entity workspace V1/V2 spec. Projects, tasks, checklists, notes — collaborative execution inside entities. Lightweight, not Asana. (Ray, Apr 14)
- docs/aria-prompt-patterns-projects-v1.md — Aria intent categories, entity/project resolution rules, prompt patterns, tool call mapping for Projects V1. (Ray, Apr 14)
- docs/cc-projects-integration-spec.md — Command Center integration spec for projects. Context builder blocks, draft tiles, still open integration, morning brief updates. (Ray, Apr 14)
- docs/aria-health-audit-2026-05-05.md — 5-phase Aria intelligence audit + overnight ship log. Trust-loop break, close-loop producer gap, classifier-version inventory, fixes shipped 2026-05-05/06. (Claude + Lyle, May 5-6)
- docs/decisionEngine-extensions-v1.md — Workstream spec for 5 engine extensions (input plumbing, predicate language, trust-floor parameterization, rate limiting, contact-list join). Blocks foundational guardrail authoring AND Phase 2 capability work (aria@ mailbox, research agents, rule-proposal flow). (Claude + Lyle, May 6)
- docs/aria-mailbox-spec-v1.md — V1 spec for aria@dizon.ai as a first-class email participant. Schema changes, tool surface, autonomy contract (always-confirm outbound), 9-step implementation plan, V2 hooks. Multi-day implementation; engine prerequisites (Ext 1-5 + rule-proposal flow) shipped same session. (Claude + Lyle, May 6)
- docs/research-agents-spec-v1.md — V1 spec for bounded sub-agents: start_research_agent tool, sync streaming, hard budget caps (30 tool calls / 5min / 30k tokens), read-mostly default, send/delete hard-disallowed, structured result schema. ~11 hrs implementation, all engine guardrails (rate limit, trust, predicates) inherited from extensions shipped same session. **Superseded by docs/agents-foundation-v1.md** — research-agent now ships as the first instance of the unified sub-agent runtime under a deterministic state-machine model. Doc retained for historical context. (Claude + Lyle, May 6)
- docs/agents-foundation-v1.md — V1 spec unifying Skills (predicate-triggered context loading reusing engine ext 2 grammar) + Sub-agents (deterministic state-machine, async background, phase-bounded budgets, hard no-write floor) under a new Agents sidebar tab. Schema for skills/skill_invocations/sub_agent_definitions/sub_agent_sessions/sub_agent_steps/sub_agent_findings. 5 milestones, ~70-90 hrs total. Phase 2 hold mandatory pending user review of open questions. (Claude + Lyle, May 6)

These documents are the source of truth for system design decisions. Read before making architectural changes.
