# Dizon.ai — API Reference
Last updated: April 8, 2026

## Auth
POST /api/auth/login
POST /api/auth/refresh
GET  /api/auth/me
POST /api/auth/change-password

## Users (admin only)
GET/POST     /api/users
PUT/DELETE   /api/users/:id
PUT          /api/users/settings

## Admin (superadmin only)
GET/POST     /api/admin/orgs
PUT          /api/admin/orgs/:id/suspend
GET          /api/admin/users
POST         /api/admin/users
PUT          /api/admin/users/:id/suspend
PUT          /api/admin/users/:id/password
PUT          /api/admin/users/:id/email
PUT          /api/admin/users/:id/org
DELETE       /api/admin/users/:id
POST         /api/admin/invites
POST         /api/admin/impersonate/:userId
GET          /api/admin/audit-log
GET          /api/admin/memory
DELETE       /api/admin/memory/:id

## Entities (any authenticated user)
GET/POST     /api/entities
PUT/DELETE   /api/entities/:id

## Tasks
GET  /api/tasks
POST /api/tasks       — array, upserts per record (no full replace)
PUT  /api/tasks/:id

## Notes
GET/POST             /api/notes
PUT/DELETE           /api/notes/:id
PUT                  /api/notes/:id/pin
GET/POST             /api/notes/categories
POST                 /api/notes/:id/suggest-pillar
GET/POST/DELETE      /api/notes/:id/images
GET                  /api/notes/search
POST                 /api/notes/daily-digest

## Google Calendar
GET  /api/gcal/auth-url
GET  /api/gcal/callback
GET  /api/gcal/status
POST /api/gcal/sync-task
POST /api/gcal/disconnect
GET  /api/gcal/events
POST /api/calendar/events

## Gmail
GET    /api/gmail/auth-url
GET    /api/gmail/callback
GET    /api/gmail/status
DELETE /api/gmail/disconnect
GET/PUT /api/gmail/config
POST   /api/gmail/scan

## Inbox
GET   /api/inbox/items
PATCH /api/inbox/items/:id

## Alerts
POST /api/alerts/fire
POST /api/alerts/morning
POST /api/alerts/check-fired
POST /api/alerts/mark-fired
GET  /api/alerts/cadence           — get alert cadence config per priority
PUT  /api/alerts/cadence/:priority — update cadence for a priority level
GET  /api/config/status

## WhatsApp Inbound (live)
POST /api/whatsapp/inbound    — UltraMsg webhook receiver

## AI + Chat
POST /api/claude               — thin proxy to Anthropic Messages API
POST /api/chat/stream          — SSE streaming proxy to Claude
POST /api/openai               — thin proxy to OpenAI Chat Completions API
POST /api/chat/execute         — Aria's agentic chat with tool use + SSE streaming

## Financial
GET/POST     /api/financial/accounts
PUT/DELETE   /api/financial/accounts/:id
GET/POST     /api/financial/transactions
PUT/DELETE   /api/financial/transactions/:id
POST         /api/financial/import-csv
GET          /api/financial/summary

## Dashboard
POST /api/dashboard/aria-brief
POST /api/dashboard/timeline-summary

## Command Center
GET  /api/dashboard/command-center/session    — get or create today's CC conversation + messages
GET  /api/dashboard/command-center/updates    — poll for new inbox items / overdue tasks since timestamp

## Settings
GET/POST /api/settings

## Preferences
GET/POST /api/preferences
PUT      /api/user/preferences/dnd    — update DND window (dnd_start, dnd_end)

## Chat + Conversations
GET/DELETE           /api/chat/history
POST                 /api/chat/message
GET/POST             /api/conversations
PUT/DELETE           /api/conversations/:id
GET/POST             /api/conversations/:id/messages

## Health
GET /health
