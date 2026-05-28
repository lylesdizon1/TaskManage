# LLM Cost Risk Audit (2026-05-28)

Every Anthropic / OpenAI call site reviewed. Findings cross-verified against actual code — two of the agent's "CATASTROPHIC" claims downgraded after verification.

**Verified scorecard:** 1 CATASTROPHIC, 5 HIGH, 4 MEDIUM, 3 LOW.

---

## CATASTROPHIC

### C1. M1b conversation extractor has no per-user daily cap — LIVE NOW

- **File:** `server/lib/conversationEnrichment.cjs`
- **Status:** Activated this morning (`MEMORY_EXTRACTOR_ENABLED=true` in Railway).
- **Per-call cost:** Haiku 4.5 @ `max_tokens: 600` per fire.
- **Existing controls:**
  - Quality gate: ≥30 chars user msg, not YES/NO/Y/N.
  - Redis debounce: 30s per `mem:extract:{userId}` key.
  - Per-turn: fires once per assistant reply.
- **Missing controls:**
  - **No per-user daily cap.** A user sending one chat message every 31 seconds for an hour fires 116 Haiku calls/hour without hitting the debounce.
  - **No global per-instance backstop.** If two server instances both fire, Redis sees one debounce-set after the first; the second can race past.
  - **Multi-channel amplification.** Web chat + WhatsApp don't share the same gate cleanly — both call `enrichConversationTurn` with the same `userId` but different `channel` arguments, and the debounce is per userId, so this is actually OK. **But** if you open 3 browser tabs and send via each, the first tab sets the debounce and the other two skip — that's the intended behavior. So multi-tab amplification is NOT a real risk here. Re-verified.
- **Real spiral scenario:** Single user, dedicated bot, sends a 35-character user message every 31s for 24h = 2,787 Haiku calls = ~$2/day per user. Across N users this scales linearly.
- **Fix:** Add per-user daily Haiku cap. Redis `mem:extract:count:{userId}:{YYYY-MM-DD}` incremented after each successful fire; gate `≥ 100/day` rejects (silent). 10 LOC change in `enrichConversationTurn`.

---

## HIGH

### H1. `/api/food/log` and `/api/food/insights` have no rate limits — shipped today

- **Files:** `server/routes/food.cjs:42 (POST /log)`, `server/routes/food.cjs:142 (GET /insights)`
- **Verified:** No `userRateLimit` middleware wrapping these routes. Confirmed in code.
- **Per-call cost:**
  - `/api/food/log`: Haiku @ 1500 max_tokens (description → items + macros). ~$0.001 per call.
  - `/api/food/insights`: Haiku @ 1500 max_tokens (14d rollup → bullets). ~$0.002 per call.
- **Spiral scenario:** User clicks "Find my trends" 100 times in 60 seconds → 100 Haiku calls. A bot script could hit it 10,000 times/day = ~$20/day per attacker account.
- **Fix:** Wrap both routes:
  ```js
  const foodLogLimit = userRateLimit({ key: 'food-log', limit: 30, windowSec: 3600 });
  const foodInsightsLimit = userRateLimit({ key: 'food-insights', limit: 10, windowSec: 3600 });
  router.post('/api/food/log', authenticateToken, foodLogLimit, async (req, res) => {...});
  router.get('/api/food/insights', authenticateToken, foodInsightsLimit, async (req, res) => {...});
  ```
- **Time to fix:** 10 minutes.

### H2. Email classification has no per-tick cap

- **File:** `server/lib/classificationEngine.cjs:117, 174`
- **Per-call cost:** Haiku @ 300 max_tokens × 2 calls per email (financial classifier + full classifier).
- **Spiral scenario:** User with 500 unclassified inbox items on a sync tick → 1,000 Haiku calls in one minute (~$2 per tick per user). A Black Friday burst of transactional email could amplify ×5.
- **Fix:** Cap classification per sync tick:
  ```js
  const TO_CLASSIFY_PER_TICK = 30;
  const toClassify = unclassified.slice(0, TO_CLASSIFY_PER_TICK);
  // queue the rest for next tick (or background drain)
  ```

### H3. Agentic loop has no per-USER daily token budget

- **Files:** `server/lib/agenticLoop.cjs` (MAX_ITERATIONS = 5 per turn — verified), `server/routes/ai.cjs` (50 chat/hour rate limit).
- **Verified:** `MAX_ITERATIONS = 5` IS enforced server-side. The catastrophic claim of "50 turns × 30k tokens" assumed 50 separate POSTs within the 50/hour rate limit — that's a real risk but a per-turn-cap exists; the per-day cap doesn't.
- **Spiral scenario:** User with bloated context (100 contacts + 50 tasks + heavy memory_facts) sends 50 messages in 1 hour (within rate limit). Each turn = ~30k tokens × Sonnet @ $3/MTok = ~$0.09/turn = $4.50/hour.
- **Fix:** Per-user daily token budget enforced in Redis (see §7 architecture below). Or per-user prompt-size cap (truncate oldest blocks if context > 20k tokens).

### H4. WhatsApp vision retry storm

- **File:** `server/routes/whatsapp.cjs` + `server/tools.cjs:967` (`capture_from_image`)
- **Per-call cost:** Sonnet 4.6 vision @ 800 max_tokens. ~$0.02/call.
- **Spiral scenario:** UltraMsg retries on transport failure. If the same image arrives 5 times within seconds before its blob is persisted, the dedup key (`imageBlobId`) doesn't yet exist → 5 Sonnet vision calls for one user-intended action.
- **Fix:** SHA256-hash the inbound image bytes; cache classification result for 5 min. Skip vision call when hash matches recent.

### H5. Outcome enrichment fires per-meeting

- **File:** `server/lib/outcomeEnrichment.cjs:23`
- **Per-call cost:** Haiku @ 500 max_tokens.
- **Spiral scenario:** Heavy-meeting user (20 events/day) × user replies to each post-meeting nudge with notes = 20 Haiku/day. Acceptable solo, compounds with other extractor pipelines.
- **Fix:** Batch — only enrich when ≥3 outcome notes accumulated in a sync window.

---

## MEDIUM

### M1. Journal enrichment debounce key shape

- **File:** `server/lib/journalEnrichment.cjs`
- **Existing:** 24h Redis debounce per entry. Good.
- **Edge:** Debounce key set BEFORE the Haiku call; if call fails, the user can't re-trigger for 24h. Minor UX issue, not a cost spiral.

### M2. Retry storm amplification

- **File:** `server/lib/anthropicRetry.cjs`
- **Existing:** Max 3 retries on transient errors, exponential 1s–7s backoff.
- **Risk:** If Anthropic returns 5xx for 30s and 100 chat calls are in flight, all retry. When Anthropic recovers, all 300 retries fire together. Cost = 3× during recovery.
- **Fix:** Reduce to 2 retries. Add circuit breaker: pause new requests for 10s when >50% of last-minute calls failed.

### M3. No per-user daily token budget across all paths

- **Files:** All LLM call sites.
- **Risk:** Heavy user across multiple endpoints in one day could spend $50+ with no global guard. Compounded by attacker scenario.
- **Fix:** This is §7 below — the architectural recommendation.

### M4. Sub-agent dispatch has no per-USER cap

- **Files:** `server/lib/subAgents/orchestrator.cjs:32-100` IS server-enforced for budget per session (30 tool calls / 5 min / 30k tokens / $2 USD). Verified.
- **But:** Nothing prevents a user from calling `start_sub_agent` 10 times in a row.
- **Spiral scenario:** User dispatches 10 concurrent research sessions = 10 × $2 = $20 in 10 minutes.
- **Fix:** Add `db.countActiveSubAgentSessions(userId)` check before dispatch; reject if ≥2 active or ≥5 in last hour.

---

## LOW

### L1. `/api/claude`, `/api/openai`, `/api/chat/stream` proxy endpoints
User can hammer with own-quota — covered by general apiLimiter (100/min). Add per-user rate limits as defense-in-depth.

### L2. Cron jobs every minute (4 of them)
Alerts, post-meeting, morning brief, daily wrap. Brief + wrap use Redis + DB lock dedup. Verified guards in place.

### L3. Bloating system prompt
No hard cap on `buildAgenticContext` output. With 50 contacts × 3 facts each + 100 tasks + 30 notes, can easily exceed 20k tokens. Doubles input cost.

---

## What was CORRECT in the agent's audit

- M1b cost exposure: real
- Food endpoint rate-limit gap: real (just shipped)
- WhatsApp vision retry concern: real
- Email classification per-tick: real
- No per-user daily token budget: real architectural gap

## What was OVERSTATED

- Sub-agent budgets ARE server-enforced (`orchestrator.cjs` has `makeBudgetTracker` + `budget.exhausted()`). The risk is per-USER concurrency, not per-session.
- Agentic loop has `MAX_ITERATIONS = 5` (verified). Real risk is per-day budget, not per-turn.
- M1b multi-tab amplification: the 30s debounce is keyed by `userId`, not by browser tab, so multi-tab actually does the right thing.

---

## §7. Defense-in-depth cost cap architecture (proposed)

Layered controls — each one closes a different failure mode.

### Layer 1: Per-user daily token counter (Redis)

```js
// In every LLM call wrapper:
const key = `cost:tokens:${userId}:${dateKey}`;
const current = Number(await rediGet(key) || 0);
const projected = current + estimateInputTokens(prompt);
if (projected > DAILY_TOKEN_CAP) {
  return { error: 'daily_budget_exhausted' };
}
// after the call:
await rediIncrBy(key, response.usage.input_tokens + response.usage.output_tokens);
await rediExpire(key, 86400);
```

- Default cap: 5M tokens/user/day (≈ $5/user/day at Sonnet rates, plenty of headroom for normal use)
- Hard fail: return 429 with "daily budget exhausted, retry tomorrow"

### Layer 2: Per-endpoint rate limits (gap-filling)

| Endpoint | Limit | Window |
|---|---|---|
| `/api/chat/execute` | 50 | 1 hour ✅ (exists) |
| `/api/food/log` | 30 | 1 hour ❌ (add) |
| `/api/food/insights` | 10 | 1 hour ❌ (add) |
| `/api/claude` | 20 | 1 hour ❌ (add) |
| `/api/openai` | 20 | 1 hour ❌ (add) |
| `start_sub_agent` (tool) | 5 | 1 hour ❌ (add) |
| `capture_from_image` (tool) | 50 | 1 hour ❌ (add) |

### Layer 3: Sub-agent concurrency cap

```js
// In orchestrator.cjs before dispatch:
const active = await db.countActiveSubAgentSessions(userId);
if (active >= 2) return { error: 'max 2 concurrent sub-agent sessions' };
const lastHour = await db.countSubAgentSessionsInWindow(userId, 3600);
if (lastHour >= 5) return { error: 'max 5 sub-agent sessions per hour' };
```

### Layer 4: Per-extractor daily caps (M1b especially)

```js
// In conversationEnrichment.cjs:
const dailyKey = `mem:extract:count:${userId}:${dateKey}`;
const count = Number(await rediGet(dailyKey) || 0);
if (count >= 100) return; // silent no-op
// ... existing logic ...
await rediIncr(dailyKey);
await rediExpire(dailyKey, 86400);
```

### Layer 5: Image dedup for vision

```js
// Before calling Sonnet vision on inbound image:
const hash = crypto.createHash('sha256').update(imageBytes).digest('hex');
const cached = await rediGet(`vision:cache:${hash}`);
if (cached) return JSON.parse(cached);
const result = await sonnetVision(imageBytes);
await rediSet(`vision:cache:${hash}`, JSON.stringify(result), 300); // 5 min
```

### Layer 6: Circuit breaker on cost spikes

```js
// 60s rolling window per endpoint:
const cost60s = await rediGet(`cost:60s:${endpoint}`);
if (cost60s > baseline * 3) {
  // spike — pause new calls for 10s
  return res.status(503).json({ error: 'cost circuit open' });
}
```

### Layer 7: Context size cap

`buildAgenticContext` truncates oldest blocks when total > 20k tokens. Today: no cap.

### Layer 8: Observability — Admin dashboard

- Per-user daily cost rollup
- Per-endpoint cost over time
- Sub-agent session count + budget consumed
- Retry rate by LLM API
- Alerts: any user > 50% of daily budget in 1 hour
- Alerts: any endpoint avg cost spikes > 2σ

---

## Rollout plan (suggested)

1. **Hour 0** (tonight): Ship H1 fix — rate limits on food endpoints. 15 min.
2. **Day 1**: Ship Layer 4 — M1b per-user daily cap. 30 min.
3. **Day 2**: Ship Layer 1 — Redis daily token counter (high default, observability only). 2 hours.
4. **Day 3**: Tighten Layer 1 limits based on observed P99 user. Add Layer 3 sub-agent caps. 1 hour.
5. **Week 1**: Ship Layer 5 (vision dedup) + Layer 7 (context cap). 2 hours each.
6. **Week 2**: Build Layer 8 observability dashboard. Half-day.
7. **Week 3**: Enable Layer 6 circuit breaker with sane defaults. 1 hour + monitor.

---

## Bottom line

The system has more cost discipline than the audit's tone suggested. Sub-agent budgets are real (server-enforced, multi-axis). Agentic loop iteration cap is real (5/turn). The actual gaps are:

1. **No per-user daily token budget anywhere** — the architectural hole
2. **New endpoints (food log) skipped rate limiting** — process gap
3. **M1b has no per-user daily cap** — currently LIVE, currently exposed

90 minutes of focused work closes #2 and #3. Layer 1 (daily token budget) is the bigger architectural lift, ~half a day, but it backstops every other layer.
