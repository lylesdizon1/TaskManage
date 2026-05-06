# Aria Intelligence System — Health Audit
**Date:** 2026-05-05 (overnight pass)
**Audited user:** `user-lyle` (primary), system-wide rollups where instructive
**Scope:** 5-phase intelligence stack: behavior rules, trust scoring, conflict resolution, scoped autonomy, orchestration.

---

## 1. Executive Summary

- **The rails are laid; the trains aren't running.** Every phase has working code, hooks, schema, and integration points. But two of the five phases are silently no-op in production for `user-lyle` because of a write-step bug.
- **🔴 Trust scoring loop is structurally OPEN at the write step.** `trust_scores` has **0 rows total across all users** despite 70 `decision_log` entries with closed outcomes for `user-lyle`. Root cause: `applyTrustFeedback` is `UPDATE`-only (no UPSERT). Rows are seeded only at registration via `seedDefaultTrustScores`, which `user-lyle` predates. Every trust signal has been silently discarded since Phase 4 shipped.
- **🔴 Correction loop never fires.** `correction_events: 0 rows total`. Driven by the same trust break — `logCorrection` is called inside `maybeGenerateCorrectionRule`, which only runs on `outcome='rejected'|'corrected'`. Since trust feedback no-ops first, the rule-materialization step never reaches the correction path. Compounds: with no `correction_events`, the auto-rule generator (Phase 4) cannot trigger.
- **🟡 Decision engine works correctly but has nothing to gate.** 95%+ of decisions are `auto_allowed` because `user-lyle` has 0 active `behavior_rules` and 0 `trust_scores` rows. The engine is fast (avg 10ms, max 148ms — well under 300ms budget) and fail-closed correct; it's just operating on empty inputs.
- **🟢 Autonomy boundary is being respected, but mostly by the legacy `ALWAYS_CONFIRM` list, not by Phase 3/4.** 32 send_email confirmations executed (19 approved, 4 rejected, 9 expired) — that's the operational gate. `decisionEngine.evaluateAction` correctly evaluates but contributes only 1 truly engine-driven gating event in 70 (an `archive_email` escalated to `confirm_required` via `content_financial` content-aware tier — a genuine save).
- **🟡 Behavior rules: 5 ever generated, 1 currently active across all users.** ruleEngine is wired into agent action hooks but 2 of 4 detectors are stubs (`detectWorkflowPattern`, `detectFrequencyPattern`). Active inference surface = `time_preference` and `entity_affinity` only.
- **🟢 Orchestration (agenticLoop) is clean.** Tool-use contract is correct, gate hook is wired, audit logging is comprehensive (478 `agent_actions` for `user-lyle`). Closing path goes through `closeDecisionWithFeedback` on every disposition.

**TL;DR for tomorrow:** before expanding Aria's capability surface, fix `applyTrustFeedback` to UPSERT (or back-seed existing users). The Phase 2/4 silent-failure pattern means every action since launch has produced zero learning signal for pre-Phase-4 users.

---

## 2. Phase-by-Phase Health

### Phase 1 — Behavior Rules
**Implementation:** `server/lib/ruleEngine.cjs` (inference), `ruleCache.cjs` (5min Redis TTL, fetched into agent context), `ruleDecay.cjs` (nightly 0.95^days strength decay), `ruleExtractor.cjs` (Haiku-extracted from corrections). Storage: `behavior_rules` table.

**Invocation path:** `ruleEngine.inferRulesFromBehavior` is fire-and-forget called from `server/tools.cjs:24` after successful tool execution. `ruleCache.getCachedRules` is consulted at `buildAgenticContext.cjs:317-320` per chat turn AND inside `decisionEngine.cjs:43` per gated tool call. **Both read paths active and live.**

**Read by downstream?** Yes — twice. (a) Rules render into the system prompt via `buildPreferencesBlock` (`buildAgenticContext.cjs:443`) so the LLM sees them directly. (b) `decisionEngine` evaluates them deterministically via `conflictsWithAction` for hard-stop / soft-confirm gating (Tiers 1-4).

**Drift:** `detectWorkflowPattern` and `detectFrequencyPattern` are stubs returning `[]` (lines 136-142 of ruleEngine.cjs) — explicitly deferred per the comment ("requires action-sequence log we don't keep today"). Only `detectTimePreference` and `detectEntityAffinity` actually emit candidates. **`ruleDecay.processRuleDecay` has no caller in the codebase** — likely a cron job scheduled outside the repo, or unscheduled (the only 5 rules show 4 archived to is_active=false, suggesting decay HAS run at some point, possibly externally).

**Silent-failure mode:** If inference stops, the user wouldn't notice — explicit preferences (set via `set_preference` tool) still flow through. Inference is enrichment, not load-bearing. The user experience would degrade slowly: Aria stops surfacing "I notice you prefer..." nudges.

### Phase 2 — Trust Scoring
**Implementation:** `server/lib/trustFeedback.cjs` — single entry `closeDecisionWithFeedback({userId, decisionId, outcome, actionType, contextSummary})`. Storage: `trust_scores` table (per user × per action_type, with counters and trustScore [0,1]).

**Invocation path:** Wired correctly. `closeDecisionWithFeedback` is called at 5 sites: `ai.cjs:431, 447, 510` and `whatsapp.cjs:183, 228, 383, 399`. Each branch (hard_stop → 'rejected', auto_allow → 'executed', confirmation → 'confirmed'/'rejected'/'executed') closes the decision.

**Read by downstream?** `decisionEngine.evaluateAction` calls `db.getTrustScore(userId, toolName)` at Tier 5 and references `trust.trustScore`, `trust.impactLevel`, `trust.isReversible` for confidence/risk computation. **For `user-lyle` this returns `null` for every call** (0 rows), so Tier 5 trust-floor friction never activates and confidence_score in `decision_log` is `null` for all 70 entries.

**Drift / smoking gun:** `db.cjs:3942-3996` — `applyTrustFeedback` is `UPDATE trust_scores SET ... WHERE user_id=$1 AND action_type=$2`. **No `INSERT ... ON CONFLICT DO UPDATE`.** Row creation is `db.cjs:4033 seedDefaultTrustScores` called only at registration (`auth.cjs:196`). Pre-Phase-4 users (everyone existing before Phase 4 wiring) have no rows; every `closeDecisionWithFeedback` since has updated 0 rows silently. The function returns `trustRow: null` (line 3985) and the caller logs `trustScore: undefined` (trustFeedback.cjs:72). No alarm.

**Silent-failure mode:** Catastrophic for the learning loop, completely invisible to the user. Aria appears identical; trust never accumulates; no friction adapts to user behavior; no auto-rule materialization. **Most load-bearing thing to fix before any capability expansion.**

### Phase 3 — Conflict Resolution
**Implementation:** `server/lib/decisionEngine.cjs` (398 lines, 6-tier resolution), `correctionDetector.cjs` (regex pre-filter), `classificationFeedback.cjs` (thumbs up/down + auto-suppression rules for email classification).

**Invocation path:** `evaluateAction` is called from the gate hook at `ai.cjs:415` and `whatsapp.cjs:372`. `correctionDetector` runs post-turn from `learningHandler.cjs:15`. `classificationFeedback.processClassificationFeedback` is wired to `inbox.cjs:7`.

**Read by downstream?** Engine outputs feed (a) the gate decision (allow/deny/confirm), (b) `decision_log` row with `conflict_level` and `conflicted_rules`, (c) close-loop trust feedback (also broken — see Phase 2). User-facing surface: conflict reasons render in confirmation cards via `tool_confirm` SSE event with `reason` and `conflict_level` (ai.cjs:480-489).

**Drift:** Engine has rich logic (content-aware OTP detection at Tier 0, financial-content escalation, hard constraints, ask_first, soft confirms, inferred patterns, trust floor). On `user-lyle`'s data, only ONE non-trivial path has fired: `archive_email` at `conflict_level='content_financial'` — the engine correctly escalated a financial email archive to confirm_required. **This is the engine's only earned win in 70 decisions.** `classificationFeedback` has 3 user inputs (1 thumbs_up Hubstaff, 1 thumbs_up meeting, 1 thumbs_down Venmo) but `inferred_classification_rules: 0 rows` — the 2-correction threshold for auto-suppression hasn't been hit on any pattern. Not a bug, sparse data.

**Silent-failure mode:** Engine errors fail closed (line 351-356 returns `confirm_required`). If the engine module itself failed to load or the DB join broke, every action would suddenly require confirmation — the user WOULD notice. Good failure shape.

### Phase 4 — Scoped Autonomy
**Implementation:** Three layers compose in `gateToolExecution`:
1. **Decision engine output** — can return `hard_stop`, `confirm_required`, `soft_confirm`, `auto_proceed`. (Engine can only INCREASE friction.)
2. **`ALWAYS_CONFIRM` allow-list** at `tools.cjs:703` — `{send_email, reply_email, delete_task, delete_event}`.
3. **`tool.requires_confirmation: true`** property + LLM-emitted `<decision>{requires_confirmation: true}</decision>` block.

**Invocation path:** Composition happens at `ai.cjs:439-453` and `whatsapp.cjs:396-410`. After engine returns auto_proceed, `requiresConfirmation(tool, llmDecision)` is checked; either layer can escalate.

**Read by downstream?** Confirmation flow uses `pending_confirmations` (status: pending/approved/rejected/expired) + `db.listenForConfirmation` (NOTIFY/LISTEN). WhatsApp 4-char codes derived from confirm_id hash (`whatsapp.cjs:412 codeFromConfirmId`).

**Drift:** Boundary is being respected operationally — 19 send_email approved, 4 rejected, 9 expired in `pending_confirmations`. **But:** of 32 send_email confirmations in `pending_confirmations`, only 8 have matching `decision_log` entries. Either (a) decisionEngine's gate hook isn't being invoked for all paths, (b) older confirmations predate Phase 4 wiring, or (c) the gate-hook is bypassed when `requiresConfirmation` returns true via the legacy allow-list. Most likely (b) — the 4 rejections are all from April 12, before Phase 4 was wired through.

**Silent-failure mode:** If the gate hook were skipped, high-impact actions would auto-execute — user would notice (sent emails they didn't authorize). Allow-list is hard-coded in tools.cjs, so even a decisionEngine outage would fall back to confirmation for the dangerous tools. Defense-in-depth here is solid.

### Phase 5 — Orchestration
**Implementation:** `server/lib/agenticLoop.cjs` — Anthropic Messages tool-use loop with extensions: parses `<decision>{...}</decision>` blocks, accepts `gateToolExecution` and `logAction` hooks, supports stagnation detection (same tool+input ≥2x → force text), supports `alreadyExecuted` for the WhatsApp webhook-resolved case where the confirmation completes before the agentic loop awaits it.

**Invocation path:** Single entry `runAgenticLoop` called from `ai.cjs:540` (web chat) and `whatsapp.cjs:489` (inbound webhook).

**Read by downstream?** Loop output is the assistant message + tool results threaded back. `logAction` hook fires for every event (`decision_created`, `tool_unknown`, `tool_cancelled`, `tool_executed_elsewhere`, `tool_executed`, `tool_failed`) → `agent_actions` table (478 rows for user-lyle).

**Drift:** None observed. The loop does NOT directly call `ruleEngine` / `trustFeedback` / `decisionEngine` — it delegates 100% to the gate hook, which is the right shape. Phase composition lives in the route handlers (ai.cjs, whatsapp.cjs).

**Silent-failure mode:** If agenticLoop bypassed the gate, every tool would auto-execute. User would notice immediately on a send_email. Loop is small (255 lines), hot, well-tested by traffic (478 logAction events).

---

## 3. Three Deep-Dive Findings

### A. Trust scoring closed loop — written-but-never-stored
- **Recorded:** 0 rows in `trust_scores` system-wide. 70 `decision_log` entries for `user-lyle` with outcomes set (`executed`: 61, `confirmed`: 5, `rejected` via hard_stop: 0, `null` (unclosed): 4).
- **Read:** `decisionEngine.evaluateAction` queries `trust_scores` via `db.getTrustScore` for every gated action; returns `null`; Tier 5 trust-floor never engages; confidence/risk computation skipped.
- **Why:** `applyTrustFeedback` is UPDATE-only. `seedDefaultTrustScores` runs only at registration. `user-lyle` registered before Phase 4 — has 0 rows. Every `closeDecisionWithFeedback` since has been a no-op. The function logs `trustFeedback.applied` with `trustScore: undefined`; if anyone watched logs they'd have spotted it, but no alert fires.
- **Loop status:** **OPEN**. Fix: change `applyTrustFeedback` to `INSERT ... ON CONFLICT (user_id, action_type) DO UPDATE`, OR back-seed existing users with `seedDefaultTrustScores` in a one-shot migration. The migration is safer (re-running `seedDefaultTrustScores` is idempotent via `ON CONFLICT DO NOTHING`).

### B. Behavior rules vs. observed behavior — spot-check
Top 5 most-fired tools for `user-lyle` in the last 30 days and what was actually evaluated:

| Tool | Invocations | Decision-log entries | Disposition | Conflict level | Rule consulted |
|---|---|---|---|---|---|
| bulk_archive_emails | 179 (mostly 1 batch of 178) | 3 | auto_allowed | none | empty rule set |
| search_inbox | 32 | 15 | auto_allowed | none | empty rule set |
| send_email | 31 confirm-requested | 8 | auto_allowed (engine) → ALWAYS_CONFIRM (gate) | none | n/a |
| create_task | 29 | 16 | auto_allowed | none | empty rule set |
| get_contact | 13 | 9 | auto_allowed | none | empty rule set |
| **archive_email** | 1 | 1 | **confirm_required** | **content_financial** | **content tier escalated** |

Findings:
- **Out-of-spec actions:** None. Every executed tool has a matching `agent_actions` row (478 total). decisionEngine ran on the gated paths; legacy paths (some bulk_archive batches without decision_log entries) went through `executeTool` directly, which is by design — the gate hook is the choke point and it's wired in ai.cjs/whatsapp.cjs.
- **Rules that fired:** zero from behavior_rules (0 active for `user-lyle`). One content-aware rule fired (`content_financial` on an `archive_email`) — Aria correctly asked before archiving an email containing financial data. **This is Phase 3's only earned save in the audit window.**
- **Behavior rule signal density is too low to be useful right now.** 5 inferred rules total, 4 archived to is_active=false. The system is technically "watching" but has too few signals to make any rule cross 0.7 strength threshold consistently. Enriching the inferred-rule strength formula or lowering the surfacing threshold would help — separate workstream.

### C. Scoped autonomy in practice — boundary respected
Current autonomy ceiling for Aria, derived from `tools.cjs:703` `ALWAYS_CONFIRM` + per-tool `requires_confirmation` properties + decisionEngine output:

**Auto-execute (no confirm needed):**
- `search_*`, `get_*`, `list_*` (read-only — 60+ executions, fine)
- `create_task`, `create_event`, `create_note` (write but reversible — 43 executions)
- `set_preference` (1 execution)
- `bulk_archive_emails` (179 executions — **flag**)
- `flag_email_as_crucial` (1 execution)
- `get_email_content`, `search_email_content` (11 executions)

**Always confirm (in `ALWAYS_CONFIRM`):**
- `send_email` — 31 confirm requests (19 approved, 4 rejected, 9 expired)
- `reply_email` — 0 invocations in the audit window
- `delete_task` — 0 invocations in the audit window
- `delete_event` — 0 invocations in the audit window

**Engine-escalated (rare but real):**
- `archive_email` with `content_financial` content tier → confirm_required (1 case)

**Boundary respected? Yes, with one operational concern:**
- `bulk_archive_emails` is auto-execute and high-blast-radius (one call archived 178 threads on April 18). It's not in `ALWAYS_CONFIRM`. The tool likely has internal safety policies, but the autonomy boundary as implemented gives Aria a 178-email irreversible action with no human gate. **Worth asking: does this match your intended autonomy ceiling for bulk operations?**

---

## 4. Drift / Dead Code / Silent Failures (Named)

| Finding | File:Line | Severity | Notes |
|---|---|---|---|
| `applyTrustFeedback` is UPDATE-only — no UPSERT | `db.cjs:3942-3996` | 🔴 HIGH | Pre-Phase-4 users get 0 trust feedback writes forever. Single biggest gap in the system. |
| `correction_events` table empty (depends on Trust write) | n/a (table state) | 🔴 HIGH | Cascades from above — fix trust write and the correction loop comes alive. |
| ~~`ruleDecay.processRuleDecay` has no in-repo caller~~ **CORRECTED** — scheduled at `proxy-server.cjs:492` via `cron.schedule('0 3 * * *')`. The audit's grep missed the indirect require path. Decay IS running nightly. | n/a | 🟢 N/A | False negative in initial audit; correction applied 2026-05-06. |
| `detectWorkflowPattern`, `detectFrequencyPattern` are stubs returning `[]` | `ruleEngine.cjs:136, 140` | 🟡 MED | Documented as deferred — needs action-sequence + email-action timestamp logs. Not silent; explicitly TODO. |
| `inferred_classification_rules` empty despite classificationFeedback wired | classificationFeedback.cjs | 🟢 LOW | Threshold-driven (2+ same-pattern corrections). Sparse user input is the reason. Not a bug. |
| `bulk_archive_emails` auto-executes high-blast-radius operations | tools.cjs `ALWAYS_CONFIRM` doesn't include it | 🟡 MED | Not strictly drift — was probably intentional for one-tap inbox cleanup. Worth verifying autonomy ceiling intent. |
| Phase 3 disposition vocab translation (hard_stop → 'suggest_only' etc.) | `decisionEngine.cjs:51-57` | 🟢 LOW | Documented translation. Means the storage vocab lies a little (`suggest_only` actually means "blocked"). Audit reports against `decision_log.disposition` need to know this. |
| `decision_log.outcome=null` rows (4 for user-lyle) | n/a | 🟢 LOW | Decisions opened but never closed. Likely SSE channel close before resolution. Not user-visible. |
| Some send_email confirmations have no `decision_log` entry | n/a | 🟢 LOW | Pre-Phase-4 confirmations from April 12. Cohort effect, not an active drift. |
| Behavior rules system-wide signal density | 5 rules / 1 active | 🟡 MED | Too sparse to drive engine gating. Either lower signal threshold or accept "rules layer is enrichment, not enforcement, until volume grows." |

---

## 5. Recommendations

### Must-fix before Phase 6 capability expansion
1. **Repair `applyTrustFeedback` write path.** Two options, ranked:
   - **(preferred) UPSERT in `applyTrustFeedback`:** `INSERT INTO trust_scores ... ON CONFLICT (user_id, action_type) DO UPDATE SET ...`. Defaults from `DEFAULT_TRUST_MATRIX` for the action_type if available, otherwise sensible neutrals (trustScore=0.5, impact_level='medium'). Forward-correct: handles new users + existing users.
   - **One-shot back-seed migration:** `for each existing user: seedDefaultTrustScores(user.id)`. Idempotent (the seed uses `ON CONFLICT DO NOTHING`). Lower-risk, fastest path to flowing the loop.
   Pair this with a **liveness check** on next deploy: read `trust_scores` count after a known confirm flow; alert if 0.
2. ~~**Verify `ruleDecay` scheduler.**~~ **DONE** — confirmed scheduled at `proxy-server.cjs:492` via `cron.schedule('0 3 * * *')` daily. Initial audit grep had a false negative. No action needed.
3. **Decide on `bulk_archive_emails` autonomy ceiling.** A 178-email auto-execute is in spec only if you want it to be. If not, add it to `ALWAYS_CONFIRM` with a `count > N` threshold OR require a confirm card with the count + sample.

### Safe-to-defer
4. **Fill in stub detectors** (`detectWorkflowPattern`, `detectFrequencyPattern`) — needs a per-action timestamp log not currently kept. Schema work first; defer until action-sequence value is proven.
5. **Backfill `correction_events` from `pending_confirmations.status='rejected'`** — there are 4 historical rejections that aren't represented in the correction trail. Optional one-shot migration.
6. **Lower `behavior_rules` surfacing threshold OR enrich detector outputs.** Currently most rules decay to inactive before they accumulate enough signal to influence decisions. Tune `MIN_SIGNALS=3` (ruleEngine.cjs:32) and decay rate (`ruleDecay.cjs`). Wait for v1.5 data to show whether trust-loop fix alone improves the signal density first.
7. **Document the disposition vocabulary translation** (`hard_stop → suggest_only`) in `docs/dizon-os-architecture-v1.md` — the storage vocab is a footgun for anyone querying `decision_log` looking for blocks.

### Don't expand capability surface yet
8. **Aria's tool-use surface is structurally healthy and operationally tested.** Expanding tools (Phase 6 feature arc) without first closing the trust loop means new tools will accumulate decisions that produce no learning signal — exactly the behavior that surfaced the original "Aria forgot what we just discussed" bug. Trust-loop repair first; capability expansion second.

---

## Appendix — Key Numbers

| Metric | Value |
|---|---|
| `agent_actions` (lyle, 30d) | 478 |
| `decision_log` (lyle, all-time) | 70 |
| `decision_log` `auto_allowed` (lyle) | 65 (61 executed, 4 confirmed, 4 unclosed) |
| `decision_log` `confirm_required` (lyle) | 1 (`archive_email` × `content_financial`) |
| `decision_log` avg latency | 10ms (max 148ms; 0 over 300ms budget) |
| `pending_confirmations` (lyle, all-time) | 32 (19 approved, 4 rejected, 9 expired) |
| `trust_scores` rows | **0 system-wide** |
| `correction_events` rows | **0 system-wide** |
| `behavior_rules` rows | 5 (1 active, 4 archived) |
| `behavior_rules` for lyle | 3 (0 active) |
| `inferred_classification_rules` rows | 0 |
| `classification_feedback` rows | 3 (2 thumbs_up, 1 thumbs_down) |
| `agent_memory` (lyle) | 166 |

---

*Report compiled by overnight audit pass. No code changes, no DB writes, no commits.*

---

## Overnight follow-up — six fixes shipped

All on `dizon/v2-phase0`, all auto-deployed via Railway. Listed in build order; each addresses an audit finding:

| Commit | What | Audit finding addressed |
|---|---|---|
| `174f62a` | `applyTrustFeedback` UPSERT — every gated decision now creates or updates a `trust_scores` row instead of silently no-op'ing on missing rows | 🔴 #1 trust-loop write break |
| `7b3675f` | Event close-loop producer — `sweepEventCloseLoops` hooked into Outlook + GCal sync paths (*/15 cron). Past meetings now generate "How did it go?" prompts within 15 minutes | 6a event-producer gap |
| `9fd3bb5` | Auto-unflag-on-demote in `classifyEmail` — when reclassification drops a row below auto-flag thresholds, the stale flag clears automatically. Manual flags preserved | structural close-the-loop for `critical_email_unacked` overcount |
| `7489d66` | Three orthogonal hardenings: (a) trust-scores pre-warm at startup so every user gets matrix defaults; (b) `/api/admin/aria-health` superadmin endpoint with canaries + per-user breakdown; (c) Aria system-prompt tune directing her to single-call `complete_task(task_id, completion_note)` instead of the two-step pattern that lost the close-loop prompt | 6b task auto-resolve race + observability layer |
| `db711cf` | Stale-classification sweep — daily 4am cron + `POST /api/admin/aria-health/sweep-stale-classifications` admin trigger. Force re-classifies stale flagged emails (Gmail only V1) so v1.5 demotion finally lands. Bounded at 20/user/run | 🔴 v1.5 backfill gap (12/15 unacked flagged stuck on v1.3) |
| `2776bcb` | Surface `signals_fired` in the Inbox classification tooltip — v1.5's structured signal attribution was invisible until now | UX visibility for v1.5 telemetry |

### What changes when you wake up

1. **The next deploy boots with trust pre-warm** — every user now has `DEFAULT_TRUST_MATRIX` rows seeded (idempotent ON CONFLICT DO NOTHING). The `decisionEngine` Tier 5 trust-floor check will start hitting real data on the very first decision.
2. **First `*/15` calendar sync after deploy** — past meetings (≤24h old, no outcome note) get close-loop rows. Active Zone tile will start surfacing "How did it go?" prompts.
3. **First user action that triggers `closeDecisionWithFeedback`** — `trust_scores` table will start accumulating real deltas.
4. **First inbox-sync that touches a stale row** OR **next 4am cron** OR **manual `POST /api/admin/aria-health/sweep-stale-classifications`** — stale v1.3 classifications get refreshed under v1.5; auto-unflag-on-demote fires for demoted Hubstaff weeklies, Apple receipt, etc. The `critical_email_unacked` tile count will start dropping.

### Recommended morning verification

```bash
# Hit the new health endpoint as superadmin
curl -H "Authorization: Bearer $TOKEN" \
  https://taskmanage-production-b1bd.up.railway.app/api/admin/aria-health

# Expected after deploy: trust_loop_writes canary should flip from
# 'BROKEN' to 'healthy' within minutes. trust_scores.rows should
# go from 0 to ~ (users × 18) after the pre-warm IIFE settles.

# Trigger the stale-classification sweep manually (don't wait for 4am):
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "https://taskmanage-production-b1bd.up.railway.app/api/admin/aria-health/sweep-stale-classifications?userId=user-lyle"

# Expected: { swept: 12-15, candidates: 12-15, fetch_failed: 0-2,
#   classify_failed: 0 } — 12 v1.3 rows reclassified under v1.5.
# After this, the critical_email_unacked tile count should drop by
# 4-6 items (Hubstaff weeklies + Apple receipt + stale Google Meet).
```

### Still deferred to your call

1. **`bulk_archive_emails` autonomy ceiling** — design decision. Tool already gates via `requires_confirmation: true`; the audit's high-blast-radius concern was partly mooted (179 invocations included dry-runs). Worth a re-look but not safe to silently change.
2. **`behavior_rules` signal-density tuning** — `MIN_SIGNALS=3` floor, decay rate. Touchy without v1.5 sweep data to baseline against. Wait for sweep to land + trust loop to flow, re-evaluate in a few days.
3. **Outlook stale-classification sweep parity** — V1 Gmail-only. Outlook items skipped. Forward-looking; user-lyle has no Outlook flagged items today.
4. **`surfaced_at` schema column on `pending_close_loop`** — proper schema fix for the task close-loop race. Prompt-tune ships first; if the ≤10s race bucket persists after the prompt change, this is the next layer.
5. **`disposition` vocabulary translation docs** — the `hard_stop → suggest_only` mapping in `decisionEngine.cjs:51-57` is undocumented in `docs/dizon-os-architecture-v1.md`. Worth adding so future audits don't get tripped.

### Total LOC tonight

~360 lines net. 6 commits. Touched: `db.cjs`, `proxy-server.cjs`, `server/routes/admin.cjs`, `server/lib/{classificationEngine, closeLoopEmitter, outlookCalSync, buildAgenticContext}.cjs`, `server/lib/staleClassificationSweep.cjs` (new), `src/panels/InboxPanel.jsx`. No schema migrations. No DB writes from CLI. All changes are forward-rolling — every new decision/sync/classify will exercise the new paths, no historical backfill required to start seeing improvements.


---

## Addendum — Close-Loop Producer Gaps (added post-audit)

User-reported observation: *"It hasn't asked me to close loops on some tasks, and calendar meetings for outcomes."* Root cause investigation below.

### 6a. 🔴 Event close-loop producer never built

`pending_close_loop` is consumer-only for `source_type='event'`. The event side of the close-loop system is half-built: schema, detector, composer, resolver are all wired and waiting, but **nothing inserts event rows into the queue**.

**Producer audit — every `emitCloseLoop` caller in the repo:**
- `server/tools.cjs:953` — emits `source_type='task'` (Aria-tool task completion path)
- `server/routes/tasks.cjs:123` — emits `source_type='task'` (PUT /tasks/:id completion path)
- `server/routes/projects.cjs:177` — emits `source_type='project_task'`
- *No emitter for `source_type='event'` exists anywhere in the codebase.*

**Consumer side fully wired:**
- `server/lib/activeZone/candidateDetector.cjs:186` filters queue for events
- `src/panels/DashboardPanel.jsx:1696, 2197` composes the "How did your meeting go?" tile
- `server/routes/outcomes.cjs:36` accepts `sourceType: 'event'` for resolution
- `server/lib/activeZone/tileComposer.cjs:100` literally has the prompt template: `'Meeting "${title}" just ended. Frame as: ask for outcome / notes.'`

**Live data confirms:** for `user-lyle`, 14 past calendar events ended in the last 7 days, **0 rows in `pending_close_loop` with `source_type='event'`**. The schema is waiting; the producer is missing.

**Silent-failure mode:** Aria physically cannot ask "how did that meeting go?" because no row triggers the prompt. User notices indirectly (no calendar outcome notes ever being captured by Aria), but there's no error, no log, no warning — it's a feature that simply never fires.

### 6b. 🟡 Task close-loop auto-resolve race (rare but real)

**Across all 19 task close-loop rows for `user-lyle`, resolution-lag distribution:**

| Bucket | Count | Pattern |
|---|---|---|
| ≤10s | 2 | **auto-resolve race** |
| ≤60s | 1 | quick interactive resolve |
| ≤1h | 7 | mostly batch resolutions (4 rows resolved in same second on Apr 24) |
| >1h | 9 | legitimate user interactions, hours-to-days later |

The two ≤10s rows are both from May 5 (the same morning as the Wheelworks Aria narration bug):
- `task-mop71l5t` "Get a message" — triggered 16:20:33.459, resolved 16:20:43.040 (10s)
- `task-mny7xd9h` "Get Escalade tires rotated and serviced — call Wheelworks" — triggered 16:20:33.458, resolved 16:20:43.042 (10s)

**The race mechanism (verified in code):**
1. User says "complete the Wheelworks task" → Aria's agentic loop runs `complete_task` with no `completion_note` parameter
2. `tools.cjs:950` checks `if (!toolInput.completion_note)` → fires `emitCloseLoop` (creates pending row)
3. ~10s later (next tool call in same turn, OR same turn streaming through), Aria runs `close_task_with_note` with a note
4. `tools.cjs:2127-2128` calls `db.resolveCloseLoopItem(userId, 'task', task.id)` → resolves the row
5. Net: row is born and dies before any UI surface renders the close-loop tile

**Root cause:** Aria is choosing the 2-step `complete_task → close_task_with_note` pattern when the user's request actually carries the note inline. `complete_task` already accepts `completion_note` as an inline parameter (`tools.cjs:939`); using it would emit nothing because the `if (!toolInput.completion_note)` guard short-circuits.

**This is an Aria-prompt-tuning issue, not a code bug** — the close-loop emitter is doing exactly what it's specced to do, and the resolver is also correct. Aria's tool-selection heuristic is the loose joint.

**Severity:** rare in absolute terms (2/19 = 10.5%), but concentrated on the most recent activity, so user perception is "Aria isn't asking me anymore."

### 6c. Fix shapes (sketches — not implementation)

**For 6a (event producer) — recommend Option B + later C:**

| Option | Trigger | Pros | Cons |
|---|---|---|---|
| A — dedicated cron | every Nmin scan `calendar_events WHERE end_time < NOW() AND end_time > NOW() - 24h AND id NOT IN (pcl events) AND id NOT IN (calendar_notes events)` | Precise timing | New cron infra, more state |
| **B — calendar-sync hook (recommended)** | At end of `outlookCalSync` / GCal sync (already runs every 15min), for each synced event whose end_time is in the past, no outcome note exists, no pcl row exists → `emitCloseLoop(userId, 'event', event.id, event.title)` | Piggybacks on existing scheduled work; no new infra; runs at the cadence calendar already updates | 15min latency between event end and prompt — fine for the use case ("how did your meeting go?" doesn't need to fire at second 0) |
| C — lazy backfill at Active Zone load | In `loadUserStateForActiveZone`, before the detector runs, scan recent past events without outcome notes and missing from pcl, insert | Always fresh; pull-based | Couples queue mutation to read paths |

**Recommended:** Ship B first. It's a ~10-line addition to whichever sync path runs (probably `server/lib/outlookCalSync.cjs` and the GCal equivalent — search for the post-sync hook). One-shot backfill on deploy: emit for past 7 days of events that lack notes. No schema changes, no new cron. C can be added later as belt-and-suspenders if 15min latency proves unacceptable.

Code sketch:
```js
// At end of calendar sync, after upserting events for the user:
const { rows: pastNoNote } = await db.pool.query(
  `SELECT ce.id, ce.title FROM calendar_events ce
   LEFT JOIN calendar_notes cn ON cn.event_id = ce.id AND cn.user_id = ce.user_id
   LEFT JOIN pending_close_loop pcl
     ON pcl.user_id = ce.user_id AND pcl.source_type = 'event' AND pcl.source_id = ce.id
   WHERE ce.user_id = $1
     AND ce.end_time < NOW()
     AND ce.end_time > NOW() - INTERVAL '24 hours'
     AND cn.id IS NULL
     AND pcl.id IS NULL`,
  [userId],
);
for (const r of pastNoNote) {
  emitCloseLoop(userId, 'event', r.id, r.title).catch(() => {});
}
```
The `LEFT JOIN ... IS NULL` pattern + 24h window keeps it idempotent and bounded.

**For 6b (task auto-resolve race) — two viable fixes:**

| Option | Layer | Mechanism |
|---|---|---|
| **i — Aria prompt tune (recommended)** | LLM behavior | Update the system prompt: "When the user's completion request includes a note or outcome, prefer `complete_task(task_id, completion_note)` over the two-step `complete_task` + `close_task_with_note` pattern. The two-step path emits a redundant close-loop ping that gets immediately resolved without ever surfacing." Cheapest fix; root cause. |
| ii — emit-side cooldown | server/tools.cjs:953 | Check if a `close_task_with_note` ran for the same task within the LLM turn. Hard to do without a turn-level transaction id. |
| iii — `surfaced_at` column on pcl + only-resolve-if-surfaced | schema + UI | Track when the UI first rendered the row; resolve calls become no-ops if surfaced_at IS NULL within 30s of triggered_at. Heavier but proper. |

**Recommended:** ship (i) first, monitor whether the ≤10s bucket disappears. (iii) is principled but premature — only matters if (i) doesn't fix it.

### 6d. Updated audit numbers

| Metric | Value |
|---|---|
| `pending_close_loop` total (lyle) | 19 |
| `pending_close_loop` `source_type='event'` (lyle) | **0** ← producer missing |
| `pending_close_loop` `source_type='task'` (lyle) | 19 (all resolved) |
| Tasks completed in last 14d (lyle) | 11 (all in pcl) |
| Tasks resolved within ≤10s of trigger (race) | 2 / 19 |
| Past events in last 7d (lyle) | 14 (0 in pcl) |

