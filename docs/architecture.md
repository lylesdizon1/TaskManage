# Dizon.ai — Architecture
Last updated: April 4, 2026

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
- Alerts config: moving to per-user (integration_config table — Phase 1)

## Channel Priority
WhatsApp → SMS → Voice → In-App → Email (last resort)

## Backend Structure (current)
proxy-server.cjs — monolith, extraction planned for Phase 1

## Backend Structure (target)
```
server/
├── proxy-server.cjs        (entry, middleware mount, static, start)
├── middleware/
│   ├── auth.cjs            (authenticateToken, requireAdmin, requireOwnership)
│   └── rateLimit.cjs
├── utils/
│   ├── crypto.cjs
│   ├── google.cjs
│   └── email.cjs
└── routes/
    ├── auth.cjs, users.cjs, entities.cjs, ai.cjs
    ├── email.cjs, settings.cjs, gcal.cjs, gmail.cjs
    ├── tasks.cjs, preferences.cjs, chat.cjs
    ├── financial.cjs, notes.cjs, alerts.cjs
    └── whatsapp.cjs
```
