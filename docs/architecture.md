# Dizon.ai — Architecture
Last updated: April 8, 2026

## Four-Layer Model
Inputs (sensor layer) → Agents (brain) → Interruption Engine (nervous system) → UI (control panel)

## Authorization Model (Ray's Spec)
Core principle: Every action is tied to the authenticated user.
Never trust client-provided identity.

### Identity Rule
Always use req.user.id from JWT. Never accept userId from body or query params.

### requireOwnership()
A user can access a record if:
- record.user_id === req.user.id (owner)
- record.entity_id is in req.user.entityIds (entity member)
- req.user.role === 'admin'

Standard pattern (used on every mutation):
```javascript
const record = await db.getX(id)
if (!record) return res.status(404).json({ error: 'Not found' })
if (!requireOwnership(record, req)) return res.status(403).json({ error: 'Access denied' })
```

## Data Ownership Model
- Tasks: user-owned, optional entity
- Notes: user-owned, optional entity sharing
- Inbox: always user-owned
- Financial: user-owned or entity-scoped
- Chat: user-owned
- OAuth tokens: user-scoped (gcal, gmail)
- Alerts: server-side scheduler is sole alert path, DND stored in user_preferences, enforced in SQL with AT TIME ZONE

## Channel Priority
WhatsApp → SMS → Voice → In-App → Email (last resort)

## Backend Structure (complete)
Extraction complete — proxy-server.cjs is an 86-line slim entry that mounts all routers.

```
proxy-server.cjs                (entry, middleware mount, static, start — 86 lines)
server/
├── middleware/
│   └── auth.cjs               (authenticateToken, requireAdmin, requireSuperAdmin, requireOwnership)
├── utils/
│   ├── crypto.cjs
│   ├── google.cjs
│   ├── date.cjs
│   └── email.cjs
├── lib/
│   └── agenticLoop.cjs        (multi-turn AI tool-use loop)
├── tools.cjs                  (ARIA_TOOLS schema + executeTool handler)
└── routes/                    (18 route files)
    ├── admin.cjs, ai.cjs, alerts.cjs, auth.cjs, chat.cjs
    ├── dashboard.cjs, email.cjs, entities.cjs, financial.cjs
    ├── gcal.cjs, gmail.cjs, inbox.cjs, notes.cjs
    ├── preferences.cjs, settings.cjs, tasks.cjs
    ├── users.cjs, whatsapp.cjs
```

## Auth Middleware
authenticateToken enriches req.user with fresh DB context on every request
(via getUserAuthContext) — role, timezone, entityIds always reflect current
DB state, not stale JWT claims. This means role changes and timezone updates
take effect immediately without waiting for the 30-day JWT to expire.

## Timezone Flow
users.timezone column → getUserAuthContext() → req.user.timezone → all routes.
Never hardcode America/Los_Angeles. DND is stored in user_preferences and
enforced in SQL with `AT TIME ZONE req.user.timezone`.

## DND (Do Not Disturb)
Stored in user_preferences table (dnd_start, dnd_end as time-of-day strings).
Enforced in SQL: the alert scheduler skips users whose current local time
falls within their DND window using `AT TIME ZONE` on the user's timezone.
