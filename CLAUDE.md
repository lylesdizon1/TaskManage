# CLAUDE.md — Dizon.ai Session Bootstrap
Last updated: April 4, 2026
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
- Backend: Express (proxy-server.cjs)
- Database: PostgreSQL on Railway (db.cjs)
- Auth: JWT (30d expiry, JWT_SECRET env var)
- AI: Anthropic API (claude-sonnet-4-20250514 default)
- Alerts: UltraMsg (WhatsApp), Resend (email), Slack webhook
- Deploy: Railway (auto-deploy on push to dizon/v2-phase0)

## Current Architecture
See /docs/architecture.md for the full four-layer model.

Frontend entry: src/App.jsx (~1,499 lines — routing + shell only)
Backend entry: proxy-server.cjs (2,646 lines — monolith, extraction planned)
DB helpers: db.cjs
Design system: /docs/design-system.md

## Active Branch State
Phase 0 — Feature freeze + hardening
Last commit: hardening: multi-user ownership checks + kill replaceTasks

### Completed
- Multi-channel alerts (WhatsApp/Slack/Email)
- App.jsx monolith extraction (7,577 → 1,499 lines)
- Lazy loading (724kB → 227kB bundle)
- Multi-user hardening (requireOwnership, kill replaceTasks, GCal userId fix)
- CLAUDE.md + /docs structure

### In Progress
- WhatsApp two-way input (Phase 1) — blocked on Aria's number

### Next Up
- Backend extraction (proxy-server.cjs → routes/ middleware/ utils/)
- Phase 1 schema migration (agent_memory, agent_tasks, agent_approvals)

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
- proxy-server.cjs — all backend routes (extraction coming)
- db.cjs — all database helpers
- src/App.jsx — frontend shell and routing
- src/utils/systemPrompt.js — Aria's system prompt + context engine
- src/components/alerts/ — alerts system
- src/panels/ — Dashboard, Notes, Calendar, Inbox
- src/screens/LoginScreen.jsx

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
