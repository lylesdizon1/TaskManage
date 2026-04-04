# Dizon.ai — API Reference
Last updated: April 4, 2026

## Auth
POST /api/auth/login
POST /api/auth/refresh
GET  /api/auth/me
POST /api/auth/change-password

## Users (admin only)
GET/POST     /api/users
PUT/DELETE   /api/users/:id
PUT          /api/users/settings

## Entities (admin only)
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
GET  /api/config/status

## WhatsApp Inbound (planned)
POST /api/whatsapp/inbound    — UltraMsg webhook receiver

## AI Proxy
POST /api/claude
POST /api/chat/stream
POST /api/openai

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

## Chat + Conversations
GET/DELETE           /api/chat/history
POST                 /api/chat/message
POST                 /api/chat/stream
GET/POST             /api/conversations
PUT/DELETE           /api/conversations/:id
GET/POST             /api/conversations/:id/messages

## Health
GET /health
