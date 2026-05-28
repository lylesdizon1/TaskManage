# Code Quality Audit (2026-05-28)

~27k LOC across `db.cjs` (11.8k), `tools.cjs` (3.3k), `proxy-server.cjs`, route files, panels.

**Scorecard:** 0 BROKEN, 7 HACKY, 0 DEAD, 4 ACCEPTABLE-DEBT. Overall **B+**.

---

## What's actually broken

**Nothing.** The 132-test suite passes. No production bugs identified during the audit. The two recent race conditions (CC persistence ccConvId, Gmail token merge) both shipped fixes this week.

---

## 7 hacky items (work but need hardening)

### Q1. `console.error` in tools.cjs instead of `logger.error`

- **Files:** `server/tools.cjs:1349, 1353, 1397, 1423`
- **Why hacky:** Production logging goes through `guardrails/logger.cjs` for structured fields + log levels. Four sites in tools.cjs use raw `console.error`, breaking observability conventions.
- **Fix (3-line):**
  ```js
  const logger = require('../guardrails/logger.cjs'); // top of file
  // then:
  logger.error('memory.log.failed', { error: e.message });
  ```

### Q2. Magic numbers without named constants

- **Sites:**
  - `db.cjs:48,50` — PG pool idle timeout 30000ms, connection timeout 5000ms
  - `db.cjs:2711` — calendar bulk insert chunk size 500
  - `proxy-server.cjs:383–404` — Redis TTL 86400 for alert dedup
  - `server/tools.cjs:1141–1142` — `BULK_ARCHIVE_AUTONOMY_THRESHOLD = 50`, `HARD_CAP = 250`
- **Why hacky:** Numbers without comments require code archaeology to change safely. The bulk-archive caps in particular have a meaningful threshold (50 = human-judgment territory) that deserves a comment.
- **Fix:** Add named constants + one-line comments explaining why.

### Q3. `cc_messages_[date]` localStorage cache pattern

- **File:** `src/panels/DashboardPanel.jsx:438–446`
- **Why hacky:** Read on mount, never written back. Two tabs of the same user → tab A reads cached messages, tab B writes a new message → tab A is stale until reload. Currently not breaking because the DB is the source of truth and other paths refetch, but the pattern is fragile if future work adds offline-first queuing.
- **Fix:** Either commit the localStorage write path (and reconcile on visibility-change), or rip it out entirely and rely on DB + Redis fast-path. Lean towards the second — caching transient chat messages in localStorage rarely earns its complexity.

### Q4. Daily food goal in localStorage (FoodPanel)

- **File:** `src/panels/FoodPanel.jsx:24, 156` (GOAL_STORAGE_KEY)
- **Why hacky:** Browser-local — different on phone vs laptop. Documented at file head as V1 limitation.
- **Fix:** Add `user_preferences.food_daily_kcal_goal INT` column + tiny GET/PUT endpoint. ~30 min.

### Q5. `image_blob_id` foreign key cascade behavior on contacts vs food

- **Files:** `db.cjs` (contacts uses `ON DELETE SET NULL`, food_log_photos uses `ON DELETE CASCADE`)
- **Why hacky:** Two different policies for the same upstream table. Contacts survive blob retention sweeps (correct for People CRM); food photos die with the entry (correct for meal records). Both are intentional — just worth a code comment explaining why they differ.

### Q6. Cleanup catches that silently drop errors

- **Files:** `proxy-server.cjs:633, 822` (`db.clearGcalAuthStatus`, `db.clearIntegrationAuthStatus` in cron cleanup)
- **Why hacky:** Silent on missing row is fine; silent on actual errors (DB down, malformed row) hides real problems.
- **Fix:** Use `.catch((e) => logger.debug('integration.cleanup.skipped', { error: e.message }))` so the signal exists at debug level without noise.

### Q7. `cc_*` localStorage state cleared daily — implicit assumption

- **File:** `src/panels/DashboardPanel.jsx:282–284`
- **Why hacky:** Daily-clear pattern is undocumented. If two tabs cross the day boundary at slightly different times (Intl format differences, system clock skew), behavior is undefined.
- **Fix:** Add a comment explaining the assumption. Optional: use a service worker / Broadcast Channel for cross-tab coordination if the issue ever surfaces in dogfood.

---

## 4 acceptable-debt items (track in backlog, don't fix today)

### A1. `db.cjs` at 11.8k LOC

Domain-mixed single file (users, tasks, entities, alerts, memory, etc.) with migration co-location. Documented intentional at line 30. Defer split until Phase 6 when adding a new domain breaks bandwidth.

### A2. `server/tools.cjs` at 3.3k LOC

55 tool registrations + executors. Splitting by group (tasks/email/memory/etc.) is reasonable but loses registration cohesion. Watch threshold: if it hits 5k LOC, split.

### A3. `DashboardPanel.jsx` at 3.8k LOC

Already extracted from a 7.5k monolith. Further fragmentation would split CC orchestration across files. Keep as-is until a clear sub-boundary emerges.

### A4. `SettingsModal.jsx` at 2.6k LOC, 6 tabs

Each tab is a candidate component extraction. Low-priority refactor; current state works.

---

## What was checked and came back clean

| Category | Finding |
|---|---|
| Disabled / stale tests | 0 — no `.skip()` or `.only()`. All 11 test files active. 132 passing. |
| Dead code | 0 — no unused exports, no commented-out function bodies. The four wrapper aliases in proxy-server.cjs:24-29 are wired into route handlers. |
| Inconsistent error response shapes | Mild — minor variation in 400/422/500 use. Not impacting behavior. |
| Auth-header patterns | Consistent across all routes (Authorization: Bearer + authenticateToken middleware). |
| Timezone handling | Consistent — every cron + LLM call flows tz from `req.user.timezone` / `user.timezone`. No hardcoded TZ in app logic. |
| Hardcoded user-lyle / Rose Motorcars | Found only in comments + UI placeholders + seed-data comments. No application logic. ✅ |
| Migration footguns | All ALTER use IF NOT EXISTS. `criticalMigration()` for SET NOT NULL is correct gate. One DROP (gmail_tokens) but with prior data move documented. ✅ |
| Race conditions | Two found, both fixed this week (ccConvId, gmail token merge). One latent shape (cc_messages localStorage) tracked in Q3 above. |
| Recent commits with FIXME/HACK | 0 in commit messages or diffs over the last 14 days. |

---

## Quick wins (each < 1 hour)

1. **Q1** — replace 4 `console.error` calls in tools.cjs with `logger.error`. 5 min.
2. **Q2** — add 5 named constants + comments. 15 min.
3. **Q6** — convert 2 silent cleanup catches to `logger.debug`. 10 min.
4. **S8** (from security doc) — encrypt Slack webhook on write. 5 min.

≈ 35 minutes total for a clean sweep of the small stuff.
