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

These documents are the source of truth for system design decisions. Read before making architectural changes.
