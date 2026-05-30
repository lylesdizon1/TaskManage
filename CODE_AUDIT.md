# TaskManage — Code-Health Audit (READ-ONLY)

- **Branch:** `dizon/code-audit` · **Baseline:** `v2-phase0` · **Date:** 2026-05-30
- **Method:** 6 lenses, parallel read-only (Explore) agents; **every finding refute-tested** — only survivors with `file:line` evidence are listed.
- **Coverage:** lenses 6/6. Surviving findings: 26 (5 Critical, 11 High, 4 Medium, 6 Low).

## Consolidated findings (severity-ranked)

| Severity | File:line | Issue | Lens |
|---|---|---|---|
| **Critical** | `/Users/lyle16/TaskManage/src/panels/DashboardPanel.jsx:888` | User-facing date comparison uses UTC instead of user's timezone. `new Date().toISOString().slice(0, 10)` returns UTC date; compared against `ev.end` ( | House-rule compliance |
| **Critical** | `/Users/lyle16/TaskManage/db.cjs:3429-3435` | setGcalPrimaryAccount: two sequential UPDATEs without transaction boundary. If second UPDATE fails, user is left with no primary calendar account. | Data layer |
| **Critical** | `server/lib/agenticLoop.cjs:113-124` | Promise.race timeout abandons stream without cleanup. When the 30-second timeout fires, Promise.race rejects and exits runAgenticLoop, but the Anthrop | Bugs & resilience |
| **Critical** | `src/App.jsx:821-836` | Orphaned scanInterval on logout/re-login. Async IIFE sets scanInterval after dependency changes, creating a race where cleanup fires before IIFE compl | Bugs & resilience |
| **Critical** | `db.cjs:6417` | Function name 'getOrCreateCommandCenterConversation' misleads callers: always deletes and recreates, never returns existing | Consistency & architecture |
| **High** | `server/routes/auth.cjs:33-35` | Timing attack vulnerability in login endpoint | Security & auth |
| **High** | `/Users/lyle16/TaskManage/db.cjs:1476-1487` | backfillSuperadminSettingsFromGlobal: nested loop issues one INSERT per (superadmin, key) pair. 15+ separate INSERTs on startup. | Data layer |
| **High** | `/Users/lyle16/TaskManage/db.cjs:1362-1399` | backfillSuperadminIntegrationsFromEnv: nested loop with up to 3 conditional INSERTs per superadmin. 10+ superadmins × 3 = 30+ round-trips. | Data layer |
| **High** | `server/lib/outlookCalSync.cjs:29-37` | Transient errors unconditionally mark needs_reauth. Any error from withFreshAccessToken (including rate limits, 5xx, timeouts) immediately marks the a | Bugs & resilience |
| **High** | `/Users/lyle16/TaskManage/server/lib/emailProvider.cjs:34-41` | Dead module: EmailProviderShape is exported but never imported or used anywhere in the codebase | Dead code |
| **High** | `/Users/lyle16/TaskManage/src/components/alerts/AlertsModal.jsx:1-end` | Dead component: AlertsModal is defined and exported but never imported or rendered anywhere in the frontend | Dead code |
| **High** | `/Users/lyle16/TaskManage/src/components/command-center/ContactDraftTile.jsx:36-150` | Dead component: ContactDraftTile is defined but never imported or used in the frontend | Dead code |
| **High** | `server/routes/dashboard.cjs:125, 157, 233, 365` | Timezone date formatting computed 4 times in single router instead of once | Consistency & architecture |
| **High** | `server/routes/dashboard.cjs:125 (+ alerts.cjs:33, food.cjs:46, gcal.cjs:323, notes.cjs:56,61, journal.cjs:24)` | Timezone date formatting duplicated across 6 routes instead of shared helper | Consistency & architecture |
| **High** | `server/routes/ai.cjs, server/routes/whatsapp.cjs:ai.cjs:718, whatsapp.cjs:736` | Inconsistent model parameter passing: ai.cjs passes model to handleConversationTurn, whatsapp.cjs does not | Consistency & architecture |
| **High** | `server/routes/voice.cjs, server/routes/whatsapp.cjs:voice.cjs:298, whatsapp.cjs:768` | Inconsistent doEnrichment flag logic: voice gates on (!staged && reply), whatsapp gates on (!waSentConfirmation && msgBody && reply) | Consistency & architecture |
| **Medium** | `/Users/lyle16/TaskManage/server/lib/buildAgenticContext.cjs:674` | Server-side context block for LLM uses UTC date instead of user's timezone when displaying last email interaction. `new Date(lastEmail.occurredAt).toI | House-rule compliance |
| **Medium** | `/Users/lyle16/TaskManage/src/components/dashboard/ActiveZoneVoice.jsx:1-end` | Dead component: ActiveZoneVoice is defined but never imported or rendered anywhere | Dead code |
| **Medium** | `/Users/lyle16/TaskManage/src/components/tasks/TaskCard.jsx:1-end` | Dead component: TaskCard is defined and exported but never imported or used anywhere | Dead code |
| **Medium** | `server/lib/conversationEnrichment.cjs:63` | STRICT_CONFIRM_RE (YES\|Y\|NO\|N) differs from voice (10+ patterns) and whatsapp (4 tokens); inconsistent confirmation filtering | Consistency & architecture |
| **Low** | `proxy-server.cjs:71` | CORS configuration uses hardcoded localhost fallback | Security & auth |
| **Low** | `server/routes/auth.cjs:54` | JWT token includes potentially sensitive claim (entityIds array) | Security & auth |
| **Low** | `server/lib/outlookCalSync.cjs:57-58` | res.text().catch silently swallows errors. If res.text() itself fails (network timeout), .catch returns empty string, logged as body='', losing contex | Bugs & resilience |
| **Low** | `/Users/lyle16/TaskManage/src/hooks/useErrorHandler.js:13-35` | Dead hook: useErrorHandler is exported but never imported or used in any component | Dead code |
| **Low** | `/Users/lyle16/TaskManage/src/hooks/useStream.js:3-105` | Dead hook: useStream is exported but never imported or used anywhere in the frontend | Dead code |
| **Low** | `/Users/lyle16/TaskManage:fix_*.py, dashboard_exact.py, revert_*.py, sidebar_shell.py` | Dead root-level Python one-off fixer scripts: 20+ orphaned fix scripts in project root | Dead code |

---

## Security & auth

### Critical
None.

### High
**[HIGH] server/routes/auth.cjs:33-35 — Timing attack in login endpoint allows username enumeration**

The login handler checks user existence (line 33-35) and returns `401` immediately if not found, BEFORE calling `bcrypt.compare()` at line 38. This creates a measurable time difference between non-existent users (instant rejection, ~1ms) and existing users (bcrypt delay, ~100ms). An attacker can enumerate valid usernames by measuring response latency over the network.

*Why it matters:* Username enumeration reduces the search space for password attacks. An attacker can build a list of valid usernames in the system, then focus brute-force efforts only on real accounts.

*Suggested fix:* Always perform bcrypt comparison regardless of user existence. Use a constant-time comparison pattern: fetch user (may be null), compute `bcrypt.compare(password, user ? user.passwordHash : dummyHash)`, then check both user existence AND password validity before proceeding. Both failure cases must return the same generic error message after the same time cost. Alternatively, pre-compute and cache a dummy hash cost to add to all non-existent user checks.

### Medium
None.

### Low
**[LOW] proxy-server.cjs:71 — CORS allows localhost fallback in production**

If the `ALLOWED_ORIGINS` environment variable is unset or misconfigured, CORS defaults to `['http://localhost:3000']`. In production, this creates a footgun: a deployment without the env var would allow cross-origin requests from localhost, potentially exposing the API to unintended local clients or adjacent services.

*Why it matters:* CORS is a defense layer. A production CORS misconfiguration weakens the same-origin policy and could allow unauthorized callers in certain deployment scenarios.

*Suggested fix:* Remove the fallback entirely or make it production-aware: `origin: process.env.NODE_ENV === 'production' ? [] : ['http://localhost:3000']` (fail-closed in prod). Alternatively, require ALLOWED_ORIGINS to be set at startup with no fallback, and fail fast if absent.

**[LOW] server/routes/auth.cjs:47-58 — JWT payload includes stale entityIds claim**

The JWT (line 54) includes `entityIds: user.entityIds || []`. While the fresh DB context is fetched and replaces this claim on every request (auth.cjs:76), the JWT itself is overprivileged: it contains claims that are immediately discarded, and a compromised token reveals all entities the user can access.

*Why it matters:* JWTs should be minimal identity tokens, not permission bundles. Removing unnecessary claims reduces the JWT's attack surface and ensures no stale authorization claims persist if token validation somehow skips the DB refresh step.

*Suggested fix:* Remove `entityIds` from the JWT and rely entirely on the DB refresh in `authenticateToken()`. The JWT becomes a pure identity token (`id + role + email`), and all contextual data is fetched fresh from the database on every request. This is a defense-in-depth improvement with no functional impact, since DB context is already the source of truth.

## House-rule compliance

**[CRITICAL] /Users/lyle16/TaskManage/src/panels/DashboardPanel.jsx:888 — UTC date comparison for all-day events**

The `isEventPast` guard uses `new Date().toISOString().slice(0, 10)` (UTC) instead of the user's local date. This causes off-by-one errors in determining whether all-day events are past or upcoming when the user is in a timezone east of UTC. The condition directly affects whether the timeline's event note actions render (lines 3424-3426).

Why it matters: House rule requires `getTodayLocal(userTZ)` for all user-facing/local-day boundaries. Violating this produces incorrect event state in the UI.

Suggested fix: Replace `new Date().toISOString().slice(0, 10)` with `getTodayLocal(userTZ)`. The helper is already imported at line 5; `userTZ` is available in scope at line 275.

---

**[MEDIUM] /Users/lyle16/TaskManage/server/lib/buildAgenticContext.cjs:674 — UTC date in people block context sent to LLM**

When building the PEOPLE & RELATIONSHIPS context block, the last email date is rendered using `new Date(lastEmail.occurredAt).toISOString().slice(0, 10)` (UTC), but the LLM receives it without timezone context. If the user is west of UTC, the displayed date will be tomorrow in UTC, creating chronological confusion when Aria reasons about contact history.

Why it matters: Context sent to the LLM should reflect the user's local timeline for accurate relationship reasoning.

Suggested fix: Pass `tz` parameter to `buildPeopleBlock()` (already available in parent scope at line 312; other blocks receive it at call sites). Then use `new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(lastEmail.occurredAt))` to match the pattern already used in the file (e.g., lines 351-353, 816).

## Data layer

### Critical

**[Critical] /Users/lyle16/TaskManage/db.cjs:3429-3435 — setGcalPrimaryAccount missing transaction boundary between two dependent UPDATEs**

Two sequential UPDATE statements without atomicity: line 3430 sets all `is_primary=false` for a user, line 3431-3433 sets one to `true`. If the second UPDATE fails (network timeout, crash, constraint violation), the user is left with no primary calendar account, violating invariants and breaking downstream assumptions.

Why it matters: Loss of atomicity leaves the database in an invalid state (no primary when one should exist). Silent failure between the two statements means callers cannot detect the partial completion. Subsequent GCal syncs or calendar UI operations may fail or behave unpredictably.

Suggested fix: Wrap both UPDATEs in an explicit transaction (`BEGIN; UPDATE...; UPDATE...; COMMIT;`), or use a single compound UPDATE with CASE: `UPDATE gcal_tokens SET is_primary = (google_email = $2) WHERE user_id = $1` to achieve atomicity in one statement.

### High

**[High] /Users/lyle16/TaskManage/db.cjs:1476-1487 — backfillSuperadminSettingsFromGlobal N+1 query pattern**

Nested loop (line 1476-1487) issues one INSERT per (superadmin, USER_OWNED_KEY) pair. With 5 superadmins and 3 keys = 15 separate INSERT statements executed synchronously, each with database round-trip overhead.

Why it matters: Migration code runs at startup; unnecessary round-trips increase startup latency. Under production scale with multiple superadmins, cumulative overhead becomes measurable. Each INSERT incurs connection overhead, statement parsing, and I/O cost.

Suggested fix: Batch the INSERTs: collect all (user_id, setting_key, value_json) tuples for all superadmins and all keys that exist in globalMap, then execute a single bulk INSERT with VALUES ($1, $2, $3), ($4, $5, $6)... and ON CONFLICT (...) DO NOTHING.

**[High] /Users/lyle16/TaskManage/db.cjs:1362-1399 — backfillSuperadminIntegrationsFromEnv N+1 query pattern**

Nested loop (line 1362-1399) with conditional INSERTs: for each superadmin, up to 3 separate INSERT queries are issued (email_alerts at line 1366, slack_webhook at line 1375, ultramsg_whatsapp at line 1384). With 10 superadmins × up to 3 integrations = 30 separate INSERT statements, each as a synchronous round-trip.

Why it matters: Startup migration performance degrades linearly with superadmin count. Each query incurs PostgreSQL statement parsing, network latency, and connection overhead. High-availability deployments with 10+ superadmins see cumulative delay in startup time.

Suggested fix: Batch the INSERTs: collect all (user_id, integration_type, account_email, config_json, is_enabled) tuples for all superadmins and all enabled integrations (based on env var checks), then execute a single bulk INSERT with VALUES (...), (...), ... and ON CONFLICT (...) DO NOTHING.

## Bugs & resilience

### Critical

**[CRITICAL] server/lib/agenticLoop.cjs:113-124 — Promise.race timeout abandons stream**
When the timeout fires at line 122, the Promise.race rejects and exits the entire `runAgenticLoop` function, abandoning the Anthropic stream mid-response. The stream continues running in the background, consuming tokens and firing unhandled errors, while the caller receives a "taking too long" message. The loser of the race (the stream promise) is never cleaned up or awaited.
- Why it matters: Users see an error but Anthropic tokens are still being consumed, inflating actual costs above what the user sees. If this occurs during a tool-use loop, the model may have already started executing critical actions before being abandoned.
- Suggested fix: Extract the stream object before the race and call stream.abort() when the timeout wins: `const stream = trackedAnthropicStream(...); const response = await Promise.race([stream, timeout]).catch(() => { stream?.abort?.(); throw ...; });`

**[CRITICAL] src/App.jsx:821-836 — Orphaned email scan interval on logout/login**
The async IIFE sets scanInterval at line 832 after awaiting an API call. When currentUser?.id changes (logout + re-login), the cleanup function at line 835 runs and clears the interval, but the IIFE is still running asynchronously. This creates a race: the cleanup fires before the IIFE completes, then the IIFE's setInterval executes AFTER cleanup, leaving an orphaned interval that polls with the stale authToken. The interval is never cleared again unless the user logs out again.
- Why it matters: The stale interval will fail every request (401) and accumulate in memory, plus the abandoned authToken may be logged to error handlers, posing a minor credential leak risk.
- Suggested fix: Add a cancellation flag: `let cancelled = false; /* IIFE body */ if (!cancelled) scanInterval = setInterval(...); return () => { cancelled = true; if (scanInterval) clearInterval(scanInterval); };`

### High

**[HIGH] server/lib/outlookCalSync.cjs:29-37 — Transient errors permanently mark account needs_reauth**
Line 34 unconditionally calls `db.markIntegrationNeedsReauth` on ANY error from `withFreshAccessToken`, including transient failures (429 rate limit, 5xx, network timeout). Once marked, the account is skipped for the ENTIRE 15-minute cron cycle, leaving the user without calendar sync for 15+ minutes for a 10-second API blip.
- Why it matters: A single transient failure can silence email/calendar sync for a long time, even though retry in 30 seconds would likely succeed. Users must manually reconnect even though their token is valid.
- Suggested fix: Only set needs_reauth for permanent failures: check the error message for keywords like 'revoked', 'invalid_grant', 'unauthorized' before calling markIntegrationNeedsReauth. For transient errors (timeout, 5xx, rate limit), log and skip without persisting the flag.

### Low

**[LOW] server/lib/outlookCalSync.cjs:57-58 — Error text() failure loses context**
Line 57 `const body = await res.text().catch(() => '')` silently swallows errors from res.text() itself. If the error text is large and text() fails (network hiccup mid-read), the logged error at line 58 shows `body: ''`, losing debugging context. The operator cannot tell what the actual HTTP error response was.
- Why it matters: When investigating why an Outlook sync failed, the empty body field makes the log entry unhelpful. Root cause diagnosis is harder.
- Suggested fix: Clamp and preserve error context: `const body = await res.text().then(t => t.slice(0, 500)).catch(() => '[error body unavailable]');`

## Dead code

### High Severity

**[HIGH] /Users/lyle16/TaskManage/server/lib/emailProvider.cjs:34-41 — Unused module export**
This module exports `EmailProviderShape` as an interface contract for inbox providers, but nothing in the codebase imports it. The comment mentions it should be used by the inbox router to resolve providers, but the actual provider dispatch happens elsewhere. Safe to delete; no dependents exist.

**[HIGH] /Users/lyle16/TaskManage/src/components/alerts/AlertsModal.jsx:1-end — Unreferenced React component**
AlertsModal is fully implemented but abandoned. App.jsx imports only `DEFAULT_ALERT_RULES` from alertUtils.js, not the component. The alerts functionality has been moved to SettingsModal's alerts tab (per CLAUDE.md). Component is complete but utterly unused. Delete it entirely.

**[HIGH] /Users/lyle16/TaskManage/src/components/command-center/ContactDraftTile.jsx:36-150 — Unreferenced React component**
ContactDraftTile was designed for the create_contact flow (business card OCR → review → confirm) but was never integrated into DashboardPanel. The component is functionally complete but has zero callers. Delete if contact creation is not an immediate feature; reimplement with full integration if planned.

### Medium Severity

**[MEDIUM] /Users/lyle16/TaskManage/src/components/dashboard/ActiveZoneVoice.jsx:1-end — Unreferenced React component**
ActiveZoneVoice is mentioned only in a comment in ActiveZoneOrchestrator.jsx line 11, describing an intended empty state. However, ActiveZoneOrchestrator returns null on empty (line 474), never conditionally renders ActiveZoneVoice. Unreachable dead code. Delete if empty-state voice panel is not planned for near term.

**[MEDIUM] /Users/lyle16/TaskManage/src/components/tasks/TaskCard.jsx:1-end — Unreferenced React component**
TaskCard was likely extracted from an older Tasks panel implementation but is no longer referenced anywhere. No imports found. Task display is now handled inline or via task-list components. Safe to delete.

### Low Severity

**[LOW] /Users/lyle16/TaskManage/src/hooks/useErrorHandler.js:13-35 — Unused custom hook**
useErrorHandler exports a reusable error-handling utility but no components import it. Error handling appears to be done inline or via other patterns. Delete if not intended for future use, or add a TODO comment documenting the expected use case if it's intentional middleware.

**[LOW] /Users/lyle16/TaskManage/src/hooks/useStream.js:3-105 — Unused custom hook**
useStream implements streaming chat logic but no components import it. Streaming may now be handled server-side or via a different pattern. Delete. Note: line 24 references 'tm_token' but comment suggests should be 'token' (latent bug), so deletion prevents future confusion.

**[LOW] /Users/lyle16/TaskManage (project root) — 20+ orphaned Python fixer scripts**
Root directory contains temporary development scripts: `fix_autorouting.py`, `fix_context_budget.py`, `fix_context_keys.py`, `fix_context_selector.py`, `fix_dashboard_notes.py`, `fix_dashboard_v2.py`, `fix_db_digest.py`, `fix_digest_regen.py`, `fix_digest_type.py`, `fix_persona_indicator.py`, `fix_persona_pill.py`, `fix_persona_router.py`, `fix_pill_gap.py`, `fix_pill_size.py`, `fix_sliding_chat_prop.py`, `fix_tasks_panel.py`, `fix_topbar.py`, `revert_digest_type.py`, `sidebar_shell.py`, `dashboard_exact.py`. None are referenced in any code, config, or documentation. These should have been deleted after use. Safe to remove — no imports exist anywhere.

## Consistency & architecture

**[Critical] db.cjs:6417 — Misleading function name violates "getOrCreate" semantic**

The function `getOrCreateCommandCenterConversation` always deletes and recreates the conversation, never returns existing. Callers reading the name expect idempotency and reuse; the actual behavior is delete-first every time (lines 6421–6437 delete, 6440–6446 create fresh). Risk: maintainers incorrectly reason about conversation lifecycle, assume history is preserved, or build features expecting reuse.

*Suggested fix:* Rename to `getOrCreateFreshCommandCenterConversation` or `recreateCommandCenterConversation`. Alternatively, extract the delete logic into `deleteCommandCenterConversationsForDate(userId, dateStr)` and name the main function accurately.

---

**[High] server/routes/dashboard.cjs:125, 157, 233, 365 — Timezone-aware date formatting computed 4 times in single request**

The same `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })` pattern is recomputed independently in four endpoints within the dashboard router. This is wasteful and creates a latent bug risk: if one call is modified but others are not, they diverge.

*Suggested fix:* At the router initialization (around line 110), compute `const todayStr = getTodayLocal(req.user.timezone || DEFAULT_TIMEZONE)` once and reuse it. Scope it correctly so all three endpoints use the same value. This also simplifies the upcoming `getLocalDateStr(tz)` refactor.

---

**[High] server/routes/dashboard.cjs:125 (and 5 other routes) — Timezone date formatting duplicated across 6 routes instead of using shared helper**

Dashboard (line 125), Alerts (line 33), Food (line 46), GCal (line 323), Notes (lines 56, 61), and Journal all manually construct `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())`. This creates maintenance risk: inconsistency if one route is updated, harder to audit timezone handling, and obscures the single source of truth (server/utils/date.cjs:getTodayLocal).

*Suggested fix:* Add a `getLocalDateStr(tz)` helper in server/utils/date.cjs that wraps the Intl call (returns YYYY-MM-DD for DB queries). Replace all 6 open-coded instances with calls to this helper. Reuse the existing `getTodayLocal` pattern.

---

**[High] server/routes/whatsapp.cjs:736 vs server/routes/ai.cjs:718 — Inconsistent model parameter passing between web and WhatsApp**

Web chat (ai.cjs line 718) passes `model` to `handleConversationTurn`, respecting client-supplied values (defaults to sonnet at line 426). WhatsApp (whatsapp.cjs line 736) does NOT pass `model`, so it always uses the default in agenticLoop (line 115: 'claude-sonnet-4-6'). Voice explicitly sets VOICE_MODEL='claude-sonnet-4-6' at the route level (voice.cjs:51). This inconsistency means: (a) WhatsApp cannot opt into faster/cheaper models via future UI, (b) audit trails don't record which model was used for each channel, (c) cost tracking may diverge if channels diverge in the future.

*Suggested fix:* Add `model: 'claude-sonnet-4-6'` explicitly to the `handleConversationTurn` call in whatsapp.cjs line 736 to make the choice explicit and auditable (matches web_chat pattern).

---

**[High] server/routes/voice.cjs:298 vs server/routes/whatsapp.cjs:768 — Inconsistent doEnrichment flag logic across channels**

Voice (line 298) gates enrichment on `!staged && !!reply`: enrichment skips when ANY confirmation was staged this turn. WhatsApp (line 768) gates on `!waSentConfirmation && !!msgBody && !!reply`: enrichment proceeds if confirmation was sent BUT user still provided a message and the model replied. The semantic difference: voice's gate is stricter (any confirmation blocks enrichment), while WhatsApp's allows enrichment if user typed additional context after a confirmation was shown. This divergence can cause features relying on memory extraction (entity tagging, preference learning) to behave differently across channels for identical user behavior.

*Suggested fix:* Standardize the enrichment gate. Recommended: enrich iff `!!reply && !!userMessage`, regardless of confirmation state (confirmation prompts are transient UI; the user's later reply carries intent). Add a comment at both call sites explaining the gate.

---

**[Medium] server/lib/conversationEnrichment.cjs:63 — STRICT_CONFIRM_RE (YES|Y|NO|N) differs from channel-specific confirmation patterns**

Enrichment uses `STRICT_CONFIRM_RE = /^(YES|Y|NO|N)\.?$/i` to filter confirmation replies from memory extraction. Voice uses `STRICT_YES = /^(YES|YEAH|YEP|YUP|Y|SURE|OKAY|OK|CONFIRM|DO IT)\.?$/i` and `STRICT_NO = /^(NO|NOPE|NAH|N|CANCEL|STOP)\.?$/i` (10+ patterns). WhatsApp uses `STRICT_YES = /^(YES|Y)\.?$/i` and `STRICT_NO = /^(NO|N)\.?$/i` (narrowest). Enrichment sits in the middle. For the enrichment's gate, confirmation replies should be filtered out — but the filter divergence means: voice users saying 'okay sure' will resolve confirmation (intended) but NOT be filtered from enrichment (unintended, leaks YES/NO into memory). WhatsApp users are handled correctly.

*Suggested fix:* Extract a shared `CONFIRMATION_PATTERN` helper in server/utils/ that both enrichment and the route confirmation logic reuse. Define it once with all accepted patterns, then use consistently across all channels.
