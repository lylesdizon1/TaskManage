# Dizon.ai — Audit Summary (2026-05-28)

Four-agent parallel audit of the codebase. Findings synthesized + cross-verified against actual code (cost-agent claims about sub-agent budgets and agentic loop required correction — see §5 below).

Companion docs:
- `01-security.md` — auth, secrets, webhooks, XSS, SQL injection
- `02-code-quality.md` — hacky patterns, broken/dead code, refactor candidates
- `03-feature-inventory.md` — complete reference of what exists today
- `04-llm-cost-risks.md` — cost spirals + defense-in-depth architecture

---

## 1. Overall scorecard

| Dimension | Grade | Headline |
|---|---|---|
| Security | **B+** | 0 critical, 1 HIGH (UltraMsg webhook signature missing), 3 MEDIUM, 4 LOW |
| Code quality | **B+** | 0 broken bugs, 0 dead code, 7 hacky items, 4 acceptable backlog items |
| Feature completeness | **A** | 41 route files, 201 endpoints, 55 Aria tools, 11 cron jobs, 73 DB tables, 11 panels |
| LLM cost discipline | **C+** | Sub-agent budgets solid (server-enforced). Major gaps: no per-user daily token cap; food endpoints lack rate limits; M1b (live now) has no per-user daily cap |

---

## 2. The 5 things to fix first (ranked by leverage)

| # | Issue | File | Time | Severity |
|---|---|---|---|---|
| 1 | M1b extractor has no per-user daily cap (CURRENTLY LIVE since this morning) | `server/lib/conversationEnrichment.cjs` | 30 min | **CATASTROPHIC** if multi-tab user is active |
| 2 | `/api/food/log` + `/api/food/insights` have no rate limits | `server/routes/food.cjs` | 15 min | **HIGH** — button-mash on insights = unlimited Haiku |
| 3 | UltraMsg webhook lacks HMAC signature validation | `server/routes/whatsapp.cjs:178` | 60 min | **HIGH** — anyone knowing your phone can trigger Aria as you |
| 4 | Email classification has no per-tick cap | `server/lib/classificationEngine.cjs` | 30 min | **HIGH** — 500-email inbox sync = 1000 Haiku calls/tick |
| 5 | No per-user daily token budget across all paths | (architectural) | 2-3 hr | **MEDIUM** — defense-in-depth; needs Redis counter + check on every LLM call |

Items 1–4 are concrete code changes ≤ 1 hr each. Item 5 is the architectural cap — see `04-llm-cost-risks.md` §7 for the design.

---

## 3. What we got RIGHT (worth noting)

The audit surfaced as many "clean" findings as concerns. Worth calling out so we don't accidentally break what's working:

- **SQL injection**: 100% parameterized queries across 20 route files. No template-literal interpolation found anywhere. ✅
- **Auth bypass**: All 18 non-admin routes require `authenticateToken`. Admin router uses `requireSuperAdmin`. Cross-tenant scoping enforced via `userId` parameter on every shared helper. ✅
- **Frontend secrets**: No CLAUDE_API_KEY / JWT_SECRET / OAuth secrets bundled into `src/`. Settings panel masks secrets before display. ✅
- **Sub-agent budgets**: `orchestrator.cjs` has real server-side `makeBudgetTracker` with hard caps (30 tool calls / 5 min / 30k tokens / $2 USD per session). The cost agent's "prompt-side only" claim was wrong. ✅
- **Migrations**: All ALTER use `IF NOT EXISTS`. `criticalMigration()` refuses to boot on broken assumptions. No mass DROPs without prior data move. ✅
- **Race conditions**: Two recent ones (CC persistence ccConvId, gmail token merge) already shipped fixes today and earlier this week. ✅
- **DND respect**: SQL-level enforcement in the alert scheduler with AT TIME ZONE. ✅

---

## 4. What's hacky but acceptable

These are tracked debt, not bugs. Address when convenient:

- `db.cjs` at 11.8k LOC — single file by intent (migration co-location). Future split into `users.cjs`/`tasks.cjs`/`alerts.cjs` is Phase 6 work.
- `tools.cjs` at 3.3k LOC — borderline; the 55 tools share registration cohesion.
- `DashboardPanel.jsx` at 3.8k LOC — extracted from the prior 7.5k monolith; further fragmentation would hurt the CC orchestration logic.
- Daily goal stored in `localStorage` in FoodPanel — V1 limitation, schema column trivial follow-up.
- 4 `console.error` calls in `tools.cjs:1349,1353,1397,1423` — should be `logger.error` (3-line fix).
- Magic numbers (PG pool timeouts, Redis TTLs, bulk-archive caps) — should be named constants with comments.

See `02-code-quality.md` for the full catalog.

---

## 5. Where the cost-spiral agent was wrong (verified corrections)

The agent was paranoid (good) but a few claims didn't survive code review:

1. **"Sub-agent budgets are prompt-side only"** — FALSE. `server/lib/subAgents/orchestrator.cjs:32-100` implements `makeBudgetTracker` with hard `budget.exhausted()` gates checked before each tool dispatch. Tool calls, wall-clock, tokens, and $ spend are all enforced server-side. The actual risk is more nuanced: no per-USER limit on concurrent sub-agent dispatches (you can `start_sub_agent` 10 times in a row), but each session is bounded.

2. **"Agentic loop has no iteration cap"** — FALSE. `server/lib/agenticLoop.cjs:27` defines `MAX_ITERATIONS = 5` and the while-loop terminates. The real risk is **across turns**: 50 user messages × 1 Sonnet call each × heavy context = real money. The per-turn cap exists; the per-day budget does not.

3. **"Outlook mail scan classifies every email per tick"** — partial. The actual flow is bounded by what's `unclassified_at IS NULL` on the most recent sync — verify the per-tick cap separately before sizing this.

Net: the CATASTROPHIC count drops from 3 to 1 (M1b, which IS live in prod and IS uncapped). Items #2 (agentic loop) and #3 (sub-agents) re-classify as HIGH — real risks, but not "spiral in 60 seconds" risks.

---

## 6. Recent context (helpful for the next session)

- M1b activated this morning (2026-05-28). It's running in prod with only the 30s Redis debounce. No per-user daily cap. Multi-tab amplification is theoretical until proven; check the Anthropic dashboard before sleeping each night for the next 3 days.
- The food log (C1+C2+context-fix+edit) shipped today. Both new endpoints (`/api/food/log` and `/api/food/insights`) need rate limits added before they get heavy use.
- P2b proactive surfacer scaffold shipped INERT — needs `PROACTIVE_SURFACER_ENABLED=true` flip + role population on contacts before it fires.
- CC persistence (Commits D+B+C+A+followup) shipped today. Schema is structurally bulletproof now (FKs + CASCADE).
- M2 smart recall live and validated in the Allen test.

---

## 7. Recommended audit cadence going forward

- **Weekly**: Anthropic dashboard cost review (5 min, eyeball spike days)
- **Bi-weekly**: re-run the cost agent (catches new endpoint additions that skipped rate limiting)
- **Monthly**: full audit (this exercise) — security drift, schema bloat, dead code accumulation
- **Per major release**: focused security audit on the changed surface

---

**Final note:** The codebase is in materially better shape than the audit's tone suggests — most catastrophic-sounding findings either don't apply (sub-agent budgets are real) or are easily fixed (one Redis counter solves M1b and food endpoint exposure together). 90 minutes of focused work closes the top 4 gaps.
