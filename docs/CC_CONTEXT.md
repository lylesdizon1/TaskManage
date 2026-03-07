# CC_CONTEXT — Claude Code Session Memory

> This file is the persistent memory for Claude Code sessions.
> Read this first on every new session.

## Stack

| Layer      | Tech                                          |
|------------|-----------------------------------------------|
| Frontend   | React 18 + Vite 5                             |
| Styling    | Tailwind CSS 3                                |
| Backend    | Express 4 (`proxy-server.cjs`)                |
| Database   | PostgreSQL (via `db.cjs` — planned for v2)    |
| Auth       | JWT + bcrypt (planned); currently localStorage |
| AI         | Claude (Anthropic API) + OpenAI (GPT-4o)      |
| Email      | Nodemailer + Gmail SMTP                       |
| Deploy     | Railway                                       |

## Key Files

| File                 | Role                                                    |
|----------------------|---------------------------------------------------------|
| `src/App.jsx`        | Monolith — all components, state, chat, alerts (~2,237 lines) |
| `proxy-server.cjs`   | Express backend — auth, AI proxy, email, persistence (~330 lines) |
| `settings.json`      | Runtime config (API keys, email, alert rules) — gitignored |
| `tasks.json`         | Task persistence — gitignored                           |

## Users

| User   | Role             | Login     |
|--------|------------------|-----------|
| Lyle   | Primary owner    | `lyle`    |
| Liz    | Secondary/family | `wife`    |

Tasks have an `owner` field: `'lyle'`, `'wife'`, `'shared'`, or `null` (legacy).

## Current Phase

**Phase 0: Foundations** — COMPLETE

- Created `/docs/ARCHITECTURE.md` — current + v2 folder structure
- Created `/docs/CC_CONTEXT.md` — this file
- Created `/docs/PERSONAS.md` — 7 persona definitions

**Next: Phase 1A — Streaming**

## What's Working (v1)

- Task CRUD (create, complete, delete) with multi-user ownership
- AI chat panel (Claude + OpenAI switchable backends)
- AI-powered tag suggestions on task creation
- Alert rules engine (overdue, due-in-hours, high-priority, digest)
- Email alerts via Gmail SMTP with duplicate prevention
- Settings persistence (API keys, email config, alert rules)
- Login auth (lyle / wife) with localStorage persistence
- 4 pillars UI (tasks, chat, settings, alerts)
- Tag/venture filtering (Careific, Rose, Buyflip, Care Home, Personal)
- Vite dev proxy to Express backend

## What's Next — Phase 1A: Streaming

1. Add `POST /api/chat/stream` SSE endpoint in `proxy-server.cjs`
   - Keep existing `/api/claude` and `/api/openai` endpoints untouched
   - New endpoint streams Claude responses via Server-Sent Events
2. Create `src/hooks/useStream.js` custom hook
   - Manages EventSource connection lifecycle
   - Exposes `{ message, isStreaming, error, send }` interface
3. Wire `ChatPanel` to use streaming (keep non-streaming fallback)

## Hard Rules

1. **Short sessions only** — commit after each step, don't batch large changes
2. **Commit after each step** — every meaningful change gets its own commit
3. **Never touch auth logic** — login flow is stable, leave it alone
4. **Keep old endpoints** — `/api/claude` and `/api/openai` must remain alongside new ones
5. **Don't break what works** — test after every change
6. **No unnecessary refactoring** — extract from App.jsx only when a phase requires it

## Environment Variables

```
CLAUDE_API_KEY       # Anthropic API key
OPENAI_API_KEY       # OpenAI API key
GMAIL_USER           # Gmail address for alerts
GMAIL_APP_PASSWORD   # Gmail app password
RECIPIENT_EMAIL      # Alert recipient email
LYLE_PASSWORD        # Login password for lyle
WIFE_PASSWORD        # Login password for wife/liz
PORT                 # Express port (default 3001)
```

## Useful Commands

```bash
npm run dev      # Start Vite (:5173) + Express (:3001)
npm run build    # Production build
npm start        # Start Express (serves dist/ in prod)
npm run proxy    # Start Express only
```
