# Phase 1 Code Audit — April 8, 2026

**Branch**: `dizon/v2-phase0`
**Scope**: Full codebase — server routes, middleware, db.cjs, frontend components, architecture alignment
**Status**: Read-only audit. No changes made.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 6 (1 resolved) |
| Medium   | 28 |
| Low      | 18 |

---

## Critical

### C1. Unauthed Gmail endpoints accept userId from query param
- **File**: `server/routes/gmail.cjs` lines 57–82, 88–95, 101–120
- **Issue**: `GET /api/gmail/status`, `DELETE /api/gmail/disconnect`, `GET/PUT /api/gmail/config` accept `userId` from query params with NO `authenticateToken` middleware. Any unauthenticated request can read/write/revoke Gmail config for any user.
- **Why**: Complete auth bypass — allows account lockout, config tampering, user enumeration.
- **Fix**: Add `authenticateToken` middleware to all four endpoints. Replace `req.query.userId` with `req.user.id`.

### C2. GCal OAuth auth-url accepts userId from query param
- **File**: `server/routes/gcal.cjs` lines 14–28
- **Issue**: `GET /api/gcal/auth-url?userId=...` takes userId from query param and encodes it into OAuth state. An attacker can initiate OAuth flow for any user and intercept the callback to steal tokens.
- **Why**: OAuth token hijacking for arbitrary users.
- **Fix**: Require `authenticateToken`. Use `req.user.id` from JWT, not query param.

### ~~C3. OAuth tokens stored plaintext in database~~ ✅ RESOLVED (false positive)
- **Status**: Already encrypted. `server/utils/google.cjs` wraps all token read/write with `encryptTokens()`/`decryptTokens()` via `{ _enc: encrypted }` pattern. Both GCal and Gmail tokens use this path. The audit flagged the raw `db.cjs` storage functions (lines 785, 808) but those are only called through the encrypting wrapper. Legacy plaintext tokens handled gracefully via `_enc` check. `gmail_config` (VIP senders, keywords) is not encrypted but contains no OAuth credentials.

### C4. Duplicate apiFetch — apiClient.js uses wrong token key
- **File**: `src/lib/apiClient.js` lines 3–4
- **Issue**: `apiClient.js` reads `localStorage.getItem('token')` but the app stores the JWT under `'tm_token'`. This module will never find the auth token. Meanwhile, `App.jsx` (line 60–77) defines its own `apiFetch` with token refresh — the one actually used everywhere.
- **Why**: Dead auth path. If any component accidentally imports apiClient instead of using the prop-passed apiFetch, requests will be unauthenticated.
- **Fix**: Delete `src/lib/apiClient.js`. Confirm no imports remain.

### C5. Direct localStorage token read in AlertsModal and SettingsModal
- **File**: `src/components/alerts/AlertsModal.jsx` line 263; `src/components/settings/SettingsModal.jsx` line 147
- **Issue**: Both files call `localStorage.getItem('tm_token')` directly to build Authorization headers instead of using the `authToken` prop already available.
- **Why**: Bypasses centralized auth handling. If token rotation or refresh logic changes, these paths break silently.
- **Fix**: Use `authToken` prop (already passed to both components).

### C6. Hardcoded timezone across entire stack
- **File**: `src/utils/systemPrompt.js` line 4; `db.cjs` line 1969; `server/routes/notes.cjs` lines 51–52; `server/routes/dashboard.cjs` line 85; multiple frontend files
- **Issue**: `'America/Los_Angeles'` is hardcoded in 15+ locations across backend and frontend. `getTodayLocal()` accepts a timezone parameter but callers almost never pass one. Users in other timezones get wrong dates, wrong DND enforcement, wrong overdue detection, wrong greetings.
- **Why**: Multi-user system with hardcoded single-user timezone. Every date boundary, DND check, and greeting will be wrong for non-Pacific users.
- **Fix**: Store timezone in user profile (column exists: `profileTimezone`). Pass it through to all `getTodayLocal()`, `getTimezoneOffset()`, and `Intl.DateTimeFormat` calls. Server-side: read from user record. Client-side: read from user profile context.

### C7. requireOwnership() relies on JWT entityIds without DB verification
- **File**: `server/middleware/auth.cjs` lines 30–40
- **Issue**: `requireOwnership()` checks `req.user.entityIds` from the JWT payload. If a JWT is issued with stale entityIds (user removed from entity after token was created), the user retains access for up to 30 days (JWT expiry).
- **Why**: Entity membership changes don't revoke access until JWT expires. User removed from org can still mutate data.
- **Fix**: Re-verify entity membership against `org_members` table on each mutation, or use shorter JWT expiry + refresh pattern that re-fetches entityIds.

---

## Medium

### M1. Financial queries use role-based branching instead of ownership scoping
- **File**: `db.cjs` lines 1416–1430, 1471–1512
- **Issue**: `getFinancialAccounts()` and `getTransactions()` check `role === 'admin'` to decide scoping. Function accepts `userId` as parameter — caller must ensure it matches authenticated user. No DB-level enforcement.
- **Fix**: Always scope by `user_id` from caller; admin override should be explicit and logged.

### M2. Raw DB pool.query() calls bypass helpers
- **File**: `server/routes/financial.cjs` lines 331–335, 351–354, 406–409, 423–426; `server/routes/dashboard.cjs` lines 39–44, 53–59; `server/routes/admin.cjs` lines 129–132
- **Issue**: Direct `db.pool.query()` calls instead of using db.cjs helper functions. Bypasses audit trail and encapsulation.
- **Fix**: Create db.cjs helpers for each mutation. Route through single abstraction layer.

### M3. N+1 query patterns in task/inbox lookups
- **File**: `server/routes/tasks.cjs` lines 34–46; `server/routes/inbox.cjs` lines 32–34; `server/tools.cjs` lines 117, 140
- **Issue**: Load ALL user tasks via `getTasksForUser()` then linear search for one record. Should use direct DB lookup with ownership check.
- **Fix**: Add `getTaskById(taskId, userId)` helper that does `WHERE id = $1 AND owner = $2` in a single query.

### M4. getUnfiredAlerts() hardcodes America/Los_Angeles for DND
- **File**: `db.cjs` line 1969
- **Issue**: DND check uses hardcoded `'America/Los_Angeles'` timezone. Users in other timezones will have DND enforced at wrong hours.
- **Fix**: Join user profile to get timezone, or accept timezone as parameter.

### M5. upsertTask uses raw new Date().toISOString()
- **File**: `db.cjs` lines 678, 723
- **Issue**: Task creation/update timestamps use UTC (`new Date().toISOString()`) instead of timezone-aware helper. Inconsistent with `getTodayLocal()` used elsewhere.
- **Fix**: Use consistent timestamp strategy — either always UTC (acceptable for storage) or always local. Document the choice.

### M6. Schema migrations fragmented across initTables and runMigrations
- **File**: `db.cjs` lines 1313–1410
- **Issue**: Initial CREATE TABLE statements are incomplete. Columns and constraints added later via ALTER TABLE in `runMigrations()`. Schema cannot be understood from CREATE statements alone.
- **Fix**: Consolidate column definitions into CREATE TABLE. Use ALTER only for truly new additions post-deploy.

### M7. getOrCreateCommandCenterConversation references unguaranteed columns
- **File**: `db.cjs` lines 1187, 1205
- **Issue**: Uses `type = 'command_center'` column that's only added in `runMigrations()`. If migrations haven't run, INSERT/SELECT fail.
- **Fix**: Ensure migration runs before any conversation queries, or add column to CREATE TABLE.

### M8. getUserByWhatsAppPhone — no empty result validation
- **File**: `db.cjs` line 1274
- **Issue**: `REGEXP_REPLACE()` normalizes phone but doesn't validate the result is non-empty. If phone is all non-digits, normalized to empty string.
- **Fix**: Add `WHERE LENGTH(normalized) > 6` guard or similar.

### M9. updateTask uses '__null__' sentinel string
- **File**: `db.cjs` line 1227
- **Issue**: Special string `'__null__'` used to distinguish NULL from undefined in SQL CASE statements. If a user title is literally `'__null__'`, logic breaks.
- **Fix**: Use separate boolean parameters or COALESCE pattern instead of magic strings.

### M10. getInboxItemsForUser has no LIMIT
- **File**: `db.cjs` line 837
- **Issue**: `SELECT *` with no LIMIT. Users with large inbox history get all records loaded.
- **Fix**: Add LIMIT/offset pagination. Default to last 100.

### M11. getConversations has N+1 subquery
- **File**: `db.cjs` lines 1100–1111
- **Issue**: Subquery `(SELECT content FROM chat_messages m WHERE ...)` runs per conversation row. Full message loaded, then truncated in app code.
- **Fix**: Use `LEFT JOIN LATERAL` or `ROW_NUMBER()` window function. Truncate in SQL with `LEFT(content, 100)`.

### M12. getTasks() returns all tasks globally
- **File**: `db.cjs` lines 605–612
- **Issue**: Function returns all tasks in DB without user scoping. Exported but no frontend uses it (`getTasksForUser()` is used instead).
- **Fix**: Remove function and export. If needed for admin, add explicit admin guard.

### M13. Missing indexes on frequently queried columns
- **File**: `db.cjs` — tables: `financial_accounts`, `transactions`, `inbox_items`, `scheduled_alerts`
- **Issue**: No indexes on `user_id`, `entity_id`, `type` columns used in WHERE clauses. Only `scheduled_alerts` has a partial index on `fire_at`.
- **Fix**: Add `CREATE INDEX IF NOT EXISTS` for: `transactions(user_id)`, `financial_accounts(user_id)`, `inbox_items(user_id)`.

### M14. Operator precedence bug in getTasksForUser WHERE clause
- **File**: `db.cjs` line 623
- **Issue**: `owner = $1 OR visibility = 'private' AND owner = $1` — AND binds tighter, making the condition `owner = $1 OR (visibility = 'private' AND owner = $1)` which simplifies to just `owner = $1`. Misleading intent.
- **Fix**: Add parentheses to clarify intent or simplify the WHERE clause.

### M15. Settings endpoint has no authentication
- **File**: `server/routes/settings.cjs` lines 25–69
- **Issue**: `GET /api/settings` returns `envConfigured` boolean map (which integrations are active) with no auth.
- **Fix**: Add `authenticateToken` middleware.

### M16. Email test endpoint is unauthenticated
- **File**: `server/routes/email.cjs` lines 15–26
- **Issue**: Test route logs RESEND_API_KEY presence, key length, and recipient email.
- **Fix**: Add `authenticateToken`. Remove key metadata from logs.

### M17. Impersonation audit gap
- **File**: `server/routes/admin.cjs` lines 174, 185
- **Issue**: Impersonation JWT includes `impersonatedBy` field, but there's no way to query "who impersonated me" from the target user's perspective. No usage-time audit log entry.
- **Fix**: Log impersonation events to `admin_audit_log` at token creation time.

### M18. No rate limiting on alert/messaging endpoints
- **File**: `server/routes/alerts.cjs`, `server/routes/whatsapp.cjs`
- **Issue**: `/api/alerts/fire`, `/api/whatsapp/inbound` have no rate limiter. Could be abused to spam user's phone/email.
- **Fix**: Apply rate limiter middleware (exists in `server/middleware/rateLimit.cjs` but not applied to these routes).

### M19. console.log exposes user_id in cron scheduler
- **File**: `proxy-server.cjs` line 136
- **Issue**: `[cron] Fired alert ${alert.id} for ${alert.user_id}` logs user IDs to stdout.
- **Fix**: Remove user_id from log or hash it.

### M20. DashboardPanel greeting uses raw new Date()
- **File**: `src/panels/DashboardPanel.jsx` lines 30–33
- **Issue**: `new Date().getHours()` and `new Date().toLocaleDateString()` for greeting — uses browser local time, not user's configured timezone.
- **Fix**: Use `Intl.DateTimeFormat` with user's timezone.

### M21. DashboardPanel "notes this week" uses UTC boundary
- **File**: `src/panels/DashboardPanel.jsx` lines 58–63
- **Issue**: `new Date().toISOString()` for week boundary comparison. String comparison of UTC timestamps against local-time dates.
- **Fix**: Use `getTodayLocal()` for boundary computation.

### M22. systemPrompt.js hardcodes timezone
- **File**: `src/utils/systemPrompt.js` line 4
- **Issue**: `const userTZ = 'America/Los_Angeles'` — should come from user profile.
- **Fix**: Accept timezone as parameter from caller.

### M23. Unused imports in App.jsx
- **File**: `src/App.jsx` lines 4, 6
- **Issue**: `buildContext` and `routePersona` imported but never used. Bundle bloat.
- **Fix**: Remove imports.

### M24. HTML email builder XSS risk
- **File**: `src/components/alerts/alertUtils.js` lines 187–251
- **Issue**: Complex HTML string concatenation with manual escaping via `h()`. One missed escape = email XSS.
- **Fix**: Use template engine or React email renderer.

### M25. Calendar events filtered client-side
- **File**: `src/panels/DashboardPanel.jsx` lines 79–89
- **Issue**: Backend returns all calendar events, frontend filters by date. Wastes bandwidth.
- **Fix**: Pass date range in query params to `/api/gcal/events`.

### M26. Upcoming tasks uses raw new Date() for 14-day boundary
- **File**: `src/panels/DashboardPanel.jsx` lines 44–52
- **Issue**: `_d14.setDate(_d14.getDate() + 14)` uses browser local time, formatted as YYYY-MM-DD without timezone context.
- **Fix**: Compute with `getTodayLocal()`.

### M27. crypto.cjs silent fallback on decryption failure
- **File**: `server/utils/crypto.cjs` line 26
- **Issue**: `catch { return text; }` — if decryption fails, returns raw (possibly corrupted) data instead of throwing.
- **Fix**: Log error and throw. Caller should handle gracefully.

### M28. Ambiguous task title matching in tools
- **File**: `server/tools.cjs` lines 121–124
- **Issue**: `complete_task` falls back to `title.includes()` partial match. If user has "Buy milk" and "Milk delivery", "milk" matches the first one found.
- **Fix**: Prefer exact match. If ambiguous, return candidates and ask user to clarify.

---

## Low

### L1. Unused getSettings() function
- **File**: `db.cjs` lines 731–737
- **Issue**: Returns global settings dict. Legacy — settings are per-user now. Still exported.
- **Fix**: Remove function and export.

### L2. Unused getGcalTokens() function
- **File**: `db.cjs` lines 763–769
- **Issue**: Returns all users' GCal tokens as a dict. Security risk if exposed via API.
- **Fix**: Remove function and export.

### L3. Verbose console.log in seed/migration functions
- **File**: `db.cjs` lines 438, 441, 600, 1035, 1300, 1357, 1364
- **Issue**: Log user IDs, entity names, row counts during migrations. Noisy in production.
- **Fix**: Use structured logging with log levels.

### L4. File path traversal risk in note image deletion
- **File**: `server/routes/notes.cjs` lines 276, 305
- **Issue**: `path.join(__dirname, '..', '..', deleted.url)` reconstructs filesystem path from DB URL. Low risk because URL is server-generated.
- **Fix**: Validate path is under `uploads/` directory before deletion.

### L5. parseInt without radix
- **File**: `server/routes/chat.cjs` line 69
- **Issue**: `parseInt(req.params.id)` without radix argument.
- **Fix**: Use `parseInt(x, 10)`.

### L6. Unused testPicker state redundancy
- **File**: `src/components/alerts/AlertsModal.jsx` line 192
- **Issue**: `testPicker` state could be simplified — boolean derivable from value presence.
- **Fix**: Minor refactor.

### L7. Lenient email validation
- **File**: `src/components/settings/SettingsModal.jsx` — email input fields
- **Issue**: Uses `type="email"` HTML5 validation only. Allows many invalid formats.
- **Fix**: Add backend regex validation.

### L8. Production console.error statements
- **File**: `src/components/alerts/alertUtils.js` line 330; `src/panels/DashboardPanel.jsx` line 272
- **Issue**: Error details logged to browser console in production.
- **Fix**: Remove or gate behind debug flag.

### L9. localStorage iteration on every login/mount
- **File**: `src/App.jsx` lines 193–196; `src/panels/DashboardPanel.jsx` lines 21–27
- **Issue**: Iterates all localStorage keys to find date-keyed caches. O(n) scan.
- **Fix**: Use a registry key that tracks cache keys, or accept the cost (typically <50 keys).

### L10. Entity name uniqueness not enforced on creation
- **File**: `db.cjs` line 44 (UNIQUE on name) vs `seedEntitiesIfEmpty()` line 596
- **Issue**: UNIQUE constraint exists on `entities.name`, but seed function has no collision guard. Seed could fail silently on duplicate.
- **Fix**: Add ON CONFLICT DO NOTHING to seed INSERT.

### L11. Foreign key on notes.entity_id added via ALTER, not in CREATE
- **File**: `db.cjs` line 74
- **Issue**: `ALTER TABLE notes ADD COLUMN IF NOT EXISTS entity_id TEXT REFERENCES entities(id)` — not in initial CREATE TABLE.
- **Fix**: Move to CREATE TABLE definition for schema clarity.

### L12. /docs/api.md — stale endpoint list
- **File**: `docs/api.md`
- **Issue**: Missing recent endpoints: `/api/alerts/cadence`, `/api/alerts/cadence/:priority`, `/api/preferences/dnd`, `/api/chat/execute`, `/api/dashboard/command-center/*`. WhatsApp still listed as "planned" but is live.
- **Fix**: Update api.md to reflect current state.

### L13. /docs/architecture.md — stale backend structure
- **File**: `docs/architecture.md`
- **Issue**: "Backend Structure (current)" says `proxy-server.cjs — monolith, extraction planned for Phase 1`. Extraction is complete — 17 route files exist.
- **Fix**: Update to reflect completed extraction.

### L14. /docs/phases.md — stale phase status
- **File**: `docs/phases.md`
- **Issue**: Missing recent completions: server-side scheduler, DND, alert cadence config, Command Center cache fixes. `agent_memory` listed as "planned" but `logMemory()` is already implemented.
- **Fix**: Update checklist to reflect current state.

### L15. CLAUDE.md — stale "Next Up" and commit reference
- **File**: `CLAUDE.md`
- **Issue**: "Next Up" lists `agent_memory table + logMemory() helper` — already done. Last commit reference is stale. App.jsx line count outdated (~1,450 but now ~1,370 after alert loop removal).
- **Fix**: Update CLAUDE.md to reflect current state.

### L16. Design system rule violation — inline styles
- **File**: `src/components/settings/SettingsModal.jsx`, `src/panels/DashboardPanel.jsx`, `src/components/alerts/AlertsModal.jsx`
- **Issue**: `/docs/design-system.md` says "No inline styles — CSS variables only." Multiple components use inline `style={{}}` objects extensively.
- **Fix**: Migrate to CSS variables or Tailwind classes (already partially done).

### L17. Dead code: alertUtils.js functions no longer called from App.jsx
- **File**: `src/components/alerts/alertUtils.js` — `runAlertRules()` (line 289), `sendAlertEmail()` (line 254), `persistFiredAlerts()` (line 267), `evaluateRule()` (line 93)
- **Issue**: These functions are no longer called after the client-side alert loop was removed. Only `buildPlainTextAlert` is still used (by AlertsModal test button).
- **Fix**: Remove unused functions or mark as deprecated. Keep `buildPlainTextAlert` for test alert UI.

### L18. No pipeline() or resolveUser() architecture
- **File**: Codebase-wide
- **Issue**: `/docs/agents.md` specifies `async function pipeline(normalizedInput)` as the sacred agent pipeline signature and references `resolveUser()` pattern. Neither exists in the codebase. The current AI path goes directly from route handler to `runAgenticLoop()`.
- **Why**: Not a bug — these are Phase 3 planned features. Documenting for architectural awareness.
- **Fix**: No action needed until Phase 3. When implementing, ensure `pipeline()` wraps `runAgenticLoop()` and `resolveUser()` wraps the WhatsApp phone lookup.

---

## Engineering Rules Compliance

| # | Rule | Status | Violations |
|---|------|--------|------------|
| 1 | Diagnose before touching anything | ✅ | — |
| 2 | Surgical str_replace only | ✅ | — |
| 3 | npm run build before every push | ✅ | — |
| 4 | One commit per logical change | ✅ | — |
| 5 | Spec behavior not code | ✅ | — |
| 6 | No full JSX block dumps | ✅ | — |
| 7 | Never accept userId from client | ❌ | C1 (gmail.cjs), C2 (gcal.cjs) |
| 8 | requireOwnership() on every mutation | ⚠️ | M1 (financial), M2 (raw pool.query) |
| 9 | Read /docs before building | ✅ | — |

---

## Top 5 Priority Fixes

1. ~~**C1/C2**: Add `authenticateToken` to Gmail + GCal auth-url routes.~~ ✅ Fixed in `06ef601`
2. ~~**C3**: Apply encrypt/decrypt to all OAuth token storage paths.~~ ✅ Already encrypted (false positive)
3. **C6**: Propagate user timezone from profile through all date operations. (~2 hrs, systematic)
4. **C4/C5**: Delete `apiClient.js`, fix localStorage token reads in AlertsModal/SettingsModal. (~15 min)
5. **M3**: Add `getTaskById(taskId, userId)` helper to eliminate N+1 task lookups. (~30 min)
