# TaskManage

AI-powered single-page task manager for multi-venture productivity.

## Features

- **Task list** with Daily Tasks and High Priority views
- **Tagging system** — Careific, Rose, Buyflip, Care Home, Personal
- **Filter bar** — combinable tag + status filters
- **AI tag suggestion** — Claude auto-suggests tags as you type the task title/description
- **AI chat panel** — split layout, switchable between Claude and ChatGPT
- **Context injection** — all current tasks are injected as context with every chat message
- **Settings panel** — API keys stored in memory only, never persisted

## Quick Start

### 1. Install dependencies

```bash
# React/Vite frontend
npm install

# Proxy server (Express)
npm install express cors axios
```

### 2. Start both servers

**Terminal 1 — proxy (port 3001):**
```bash
node proxy-server.cjs
```

**Terminal 2 — Vite dev server (port 5173):**
```bash
npm run dev
```

Or run both at once (requires `concurrently` installed):
```bash
npm start
```

### 3. Open the app

Visit [http://localhost:5173](http://localhost:5173)

Click the **gear icon** (top right) to enter your API keys:
- **Claude API key** — for AI tag suggestions + Claude chat
- **OpenAI API key** — for ChatGPT chat

Keys are stored in React state only and never logged or persisted.

## Architecture

```
Browser (port 5173)
  ↕  Vite proxy → localhost:3001

proxy-server.cjs (port 3001)
  ├── POST /api/claude  → api.anthropic.com/v1/messages
  └── POST /api/openai  → api.openai.com/v1/chat/completions
```

The Vite dev server is configured to proxy `/api/*` requests to the Express
server, so the React app calls `/api/claude` and `/api/openai` — no hardcoded
ports or CORS issues.

## File Structure

```
TaskManage/
├── src/
│   ├── App.jsx        ← all components in one file
│   ├── main.jsx       ← React entry point
│   └── index.css      ← Tailwind directives + scrollbar styles
├── proxy-server.cjs   ← Express proxy for Claude & OpenAI APIs
├── index.html
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── package.json
```

## Tag Colors

| Tag | Color |
|---|---|
| Careific | Indigo / purple |
| Rose | Pink / rose |
| Buyflip | Amber / orange |
| Care Home | Teal / green |
| Personal | Slate / gray |
