# TaskManage Architecture

## Current Folder Structure (v1 — Monolith)

```
TaskManage/
├── src/
│   ├── App.jsx              # Monolith — ALL React components, state, AI chat, alerts (~2,237 lines)
│   ├── main.jsx             # React entry point (ReactDOM.createRoot)
│   └── index.css            # Tailwind base + custom scrollbar styles
├── docs/
│   ├── ARCHITECTURE.md      # This file
│   ├── CC_CONTEXT.md        # Claude Code memory / session context
│   └── PERSONAS.md          # AI persona definitions
├── proxy-server.cjs         # Express backend — auth, AI proxy, email, file persistence (~330 lines)
├── index.html               # Vite entry HTML
├── vite.config.js           # Vite dev server + /api proxy to Express :3001
├── tailwind.config.js       # Tailwind config (content: ./src/**)
├── postcss.config.js        # PostCSS (tailwind + autoprefixer)
├── package.json             # Dependencies & scripts
├── .gitignore               # node_modules, dist, settings.json, tasks.json
└── README.md                # Project readme
```

### Runtime-generated files (gitignored)

```
├── tasks.json               # Task persistence (read/written by proxy-server)
├── settings.json            # API keys, email config, alert rules
├── dist/                    # Vite production build output
└── node_modules/
```

## Key Files

### `src/App.jsx` — Frontend Monolith

All UI lives in one file. Major sections:

| Component / Function     | Purpose                                              |
|--------------------------|------------------------------------------------------|
| `LoginScreen`            | Username/password auth (lyle / wife)                 |
| `AddTaskForm`            | New task creation with AI-powered tag suggestions    |
| `TaskCard`               | Individual task display, completion toggle, delete    |
| `FilterBar`              | Filter by tag, status (All/Active/Done)              |
| `ChatPanel`              | AI chat split-panel (Claude + OpenAI backends)       |
| `SettingsModal`          | API keys tab + Email/SMTP tab                        |
| `AlertsModal`            | Alert rules CRUD (overdue, due-in-hours, digest)     |
| `fetchSuggestedTags()`   | Claude-powered auto-tagging on task create           |
| `callClaudeChat()`       | Proxy call to `/api/claude`                          |
| `callOpenAIChat()`       | Proxy call to `/api/openai`                          |
| `runAlertRules()`        | 60-second interval — evaluates rules, sends emails   |

**Current tags/ventures:** Careific, Rose, Buyflip, Care Home, Personal

### `proxy-server.cjs` — Express Backend

| Endpoint              | Method | Purpose                                  |
|-----------------------|--------|------------------------------------------|
| `/api/login`          | POST   | Authenticate (lyle / wife via env vars)  |
| `/api/claude`         | POST   | Proxy to Anthropic Messages API          |
| `/api/openai`         | POST   | Proxy to OpenAI Chat Completions API     |
| `/api/email/test`     | POST   | Test Gmail SMTP credentials              |
| `/api/email/send`     | POST   | Send alert email via nodemailer          |
| `/api/settings`       | GET    | Read settings.json                       |
| `/api/settings`       | POST   | Write settings.json                      |
| `/api/tasks`          | GET    | Read tasks.json                          |
| `/api/tasks`          | POST   | Write tasks.json                         |
| `/health`             | GET    | Health check                             |

**Auth:** Passwords from `LYLE_PASSWORD` / `WIFE_PASSWORD` env vars. No JWT yet in current code — login returns `{ success, user }` and frontend stores user in localStorage.

**Persistence:** JSON files (`tasks.json`, `settings.json`). No database in v1.

### `vite.config.js`

Dev server on `:5173`, proxies `/api/*` and `/health` to Express on `:3001`.

## v2 Target Folder Structure

```
TaskManage/
├── src/
│   ├── components/
│   │   ├── chat/
│   │   │   ├── ChatPanel.jsx        # Main chat container
│   │   │   ├── MessageBubble.jsx    # Individual message rendering
│   │   │   └── StreamingMessage.jsx # SSE streaming display
│   │   ├── tasks/
│   │   │   ├── AddTaskForm.jsx
│   │   │   ├── TaskCard.jsx
│   │   │   └── FilterBar.jsx
│   │   ├── settings/
│   │   │   ├── SettingsModal.jsx
│   │   │   └── AlertsModal.jsx
│   │   ├── auth/
│   │   │   └── LoginScreen.jsx
│   │   └── ui/
│   │       ├── Icons.jsx
│   │       └── Toast.jsx
│   ├── hooks/
│   │   ├── useStream.js             # SSE streaming hook (Phase 1A)
│   │   ├── useTasks.js              # Task state & CRUD
│   │   ├── useChat.js               # Chat state & message history
│   │   └── useAlerts.js             # Alert rule evaluation
│   ├── context/
│   │   ├── AuthContext.jsx          # JWT auth state
│   │   └── PersonaContext.jsx       # Active persona + switching
│   ├── lib/
│   │   ├── api.js                   # Fetch wrappers for all endpoints
│   │   └── personas.js              # Persona definitions & system prompts
│   ├── App.jsx                      # Shell — layout + routing only
│   ├── main.jsx
│   └── index.css
├── docs/
│   ├── ARCHITECTURE.md
│   ├── CC_CONTEXT.md
│   └── PERSONAS.md
├── proxy-server.cjs                 # Keeps existing endpoints
├── db.cjs                           # PostgreSQL connection (future)
├── index.html
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── package.json
└── README.md
```

## Deployment

- **Host:** Railway
- **Build:** `npm run build` (Vite) → `dist/`
- **Start:** `npm start` → runs `proxy-server.cjs` which serves `dist/` in production
- **Dev:** `npm run dev` → Vite (:5173) + Express (:3001) via `concurrently`
- **Env vars:** `CLAUDE_API_KEY`, `OPENAI_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `RECIPIENT_EMAIL`, `LYLE_PASSWORD`, `WIFE_PASSWORD`, `PORT`
