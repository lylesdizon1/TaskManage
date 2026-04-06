# CLAUDE.md — Dizon.ai Session Bootstrap
Last updated: April 6, 2026
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
- Alerts: UltraMsg (WhatsApp), Resend (email), Slack webhook
- Deploy: Railway (auto-deploy on push to dizon/v2-phase0)

## Current Architecture
See /docs/architecture.md for the full four-layer model.

Frontend entry: src/App.jsx (~1,450 lines — routing + shell only)
Backend entry: proxy-server.cjs (86 lines — slim entry)
Backend routes: server/routes/ (17 route files)
Backend middleware: server/middleware/auth.cjs (authenticateToken, requireAdmin, requireSuperAdmin)
DB helpers: db.cjs
Design system: /docs/design-system.md

## Active Branch State
Phase 1B complete — multi-user hardening + schema foundation + smoke test fixes
Last commit: fix(entities): add 300ms delay before reload to avoid race condition on create

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

### Before Next Feature
1. Fill in Lyle's profile fields → Settings → AI Assistant
2. Delete Wife + Zacharius via Admin panel
3. Smoke test Aria tool use + WhatsApp

### Next Up
- agent_memory table + logMemory() helper
- integrations table (oauth_tokens, integration_config)
- Per-user GCal OAuth

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

## Key Files
- proxy-server.cjs — slim entry (86 lines), mounts all routers
- server/routes/ — 17 route files (admin, ai, auth, dashboard, entities, etc.)
- server/middleware/auth.cjs — JWT auth, requireAdmin, requireSuperAdmin
- db.cjs — all database helpers + schema migrations
- src/App.jsx — frontend shell and routing
- src/utils/systemPrompt.js — Aria's system prompt + context engine
- src/components/alerts/ — alerts system
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
