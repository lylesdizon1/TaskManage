# Decision Engine Extensions — V1 Workstream
*Filed 2026-05-06 from CC tuning session. Approved scope: investigation only this session; implementation deferred.*

## Context

`server/lib/decisionEngine.cjs` is the deterministic gate Aria's agentic loop consults before every tool execution. It composes user-defined `behavior_rules` with hardcoded trust-score logic and content-aware checks for email actions to decide one of `{auto_proceed, soft_confirm, confirm_required, hard_stop}`.

The engine's current rule shape is single-axis: `(rule, toolName) → conflict?`. It can match by tool name keyword and tool category, gate by polarity (`never`/`ask_first`/`avoid`), and tier by `strength`. That's adequate for *categorical* preferences — "always ask before deleting things in the email category" — but not for the *conditional/quantitative* gates real autonomy needs:

- Bulk action thresholds ("ask if >50 items")
- Recipient-set checks ("ask if sending to anyone outside my contacts")
- Owner / created_by checks ("ask before modifying calendar events I didn't create")
- Trust-driven thresholds ("force confirmation when trust_score for this action is below 0.6")
- Rate limits ("after 20 autonomous actions in an hour, force confirmation")

When asked to author 5 foundational guardrails on 2026-05-06 covering exactly these cases, **4 of 5 were not expressible** in `behavior_rules` as the engine stands today. The session locked in Path A: don't ship rule rows that don't enforce, file engine extensions as a workstream. This is that workstream.

## What blocks on this work

This is the **next foundational workstream** after the current trust-loop / close-loop / classifier-version work shipped in 2026-05-05/06 commits (see `docs/aria-health-audit-2026-05-05.md` for the audit + ship log).

**Phase 2 capability expansion** explicitly blocks on this engine work landing:
- aria@dizon.ai mailbox (Aria as a first-class email participant)
- Research agents (autonomous multi-tool research with bounded blast radius)
- Rule-proposal flow (Aria suggests new behavior_rules from observed patterns)

Each of these requires deterministic guardrails that work on tool-input semantics, not just tool-name semantics. Shipping them on top of the current engine would create a class of "soft autonomy" failures where Aria operates correctly per the rules-she-can-see but violates the user's actual intent because the engine couldn't see the offending input field.

## Current engine surface (today, V1)

For reference. Source of truth: `server/lib/decisionEngine.cjs`.

| Capability | Where | Notes |
|---|---|---|
| Tool-name keyword matching | `TOOL_ACTION_KEYWORDS` map (lines 62-86) | Each tool maps to action verbs ("delete", "remove", "erase" etc.) |
| Tool-category matching | `TOOL_CATEGORY` map (lines 90-102) | tasks / calendar / email / communication / general |
| Polarity gating | `conflictsWithAction` (line 136) | never/ask_first/avoid → friction; always/prefer → no gating |
| Strength tiers | `evaluateAction` (line 269+) | 5=hard_stop, 4=strong confirm, 3=soft confirm, inferred ≥0.7=soft |
| Trust-floor | line 325 | Hardcoded threshold 0.3, not parameterizable |
| Content-aware (email tools) | Tier 0 (line 200+) | OTP detection, financial-content escalation. Earned 1/75 saves on user-lyle. |

**Critical limitation:** `conflictsWithAction(rule, toolName)` does not receive `toolInput`. The full `evaluateAction` does receive `toolInput` (it's already the third parameter), but it never propagates that into rule evaluation. Every extension below depends on closing this gap.

## The 5 extensions

Listed in dependency order. (1) and (2) are foundational; (3)–(5) build on them.

### 1. Pass `toolInput` to `conflictsWithAction`

**Scope:** small. **Complexity:** low. **Risk:** low.

**Change:** Update the signature `conflictsWithAction(rule, toolName)` → `conflictsWithAction(rule, toolName, toolInput)`. Plumb `toolInput` through from `evaluateAction` (it's already in scope). Existing callers ignore the new arg; new rule shapes consume it.

**Why first:** every other extension below requires the rule predicate to see input fields. Without this, the engine can never branch on count, recipient set, owner, etc.

**Backward compat:** trivial — extra param, optional. All current rules are keyword-based and don't need toolInput. Existing 11 user rules continue working unchanged.

### 2. Input-predicate language in rule shape (jsonb conditions)

**Scope:** medium. **Complexity:** medium. **Risk:** medium.

**Change:** Extend `behavior_rules` rows with structured conditions, similar to `email_classification_rules.conditions` jsonb. New fields evaluated against `toolInput`:

```js
{
  // existing: rule_text, preference_type, category, strength
  predicate: {
    tool_names: ['bulk_archive_emails', 'bulk_delete_emails'],   // optional allowlist
    input: {
      count_gt: 50,                                              // input.expected_count > 50
      recipient_not_in: 'known_contacts',                        // input.to ∉ contacts
      field_eq: { 'criteria.older_than_hours': { lt: 168 } },    // dotted path
    },
    aggregate: {
      // for rate-limit (extension 4):
      autonomous_actions_in: { window: '60m', count_gte: 20 },
    },
  },
}
```

The schema can stay flexible (jsonb blob) so we don't lock into a specific predicate language v1. The engine evaluator parses the blob and short-circuits on first matching constraint.

**Why second:** every conditional guardrail needs structured predicates. Free-form `rule_text` is too brittle for deterministic matching.

**Migration:** add a `predicate` jsonb column to `behavior_rules`, nullable. Rules without `predicate` continue to use the existing keyword path.

**Surface area:** `decisionEngine.cjs evaluateAction` learns to evaluate predicates in addition to keyword matches. `ruleEngine.cjs inferRulesFromBehavior` doesn't generate predicate rules in v1 (only explicit user-authored).

### 3. Parameterize the trust-floor threshold

**Scope:** small. **Complexity:** low. **Risk:** low.

**Change:** Currently `decisionEngine.cjs:325` hardcodes `Number(trust.trustScore) < 0.3 → confirm_required`. Extract to either:
- A per-user setting (`user_preferences_v2`)
- A behavior_rule with `predicate: { trust_lt: 0.6 }`
- A global env var with per-user override

Recommendation: behavior_rule shape (depends on extension 2), so it composes with the rest of the rule system. The rule says "confirm any action whose trust score is below N" with a configurable N.

**Why now:** the conceptual guardrail "low-trust → confirm" is one of the most-requested. With trust_scores actually getting written now (174f62a), a 0.3 floor is too lax for guardrail-mode operation. Tunable per user lets paranoid users set 0.7+, autonomous users keep 0.3.

### 4. Rate-limit counter table + evaluate-time check

**Scope:** medium. **Complexity:** medium. **Risk:** medium.

**Change:** New table or materialized view tracking autonomous actions per user per rolling window. Engine consults at evaluate time:

```sql
CREATE TABLE autonomous_action_log (
  id           SERIAL PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name    TEXT NOT NULL,
  decision_id  INT REFERENCES decision_log(id),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX autonomous_action_log_user_window_idx ON autonomous_action_log(user_id, created_at DESC);
```

Or skip the new table — derive directly from `decision_log WHERE outcome='executed' AND disposition='auto_allowed'` filtered by time window. Saves a write per decision. Probably cheaper given existing decision_log volume.

Engine adds:
```js
// In evaluateAction, before tier checks:
const recentAutonomous = await db.countAutonomousActions(userId, '60 minutes');
if (recentAutonomous >= 20) {
  disposition = 'confirm_required';
  reason = 'Rate-limit guardrail: 20+ autonomous actions in last hour';
}
```

**Why now:** runaway-loop protection. Aria can't currently exceed 20 actions/hour deterministically — the only soft gate is the LLM's own pacing. A real ceiling protects against agentic-loop bugs.

**Tradeoff:** adds one DB query per evaluate. Latency budget for evaluateAction is currently 300ms with avg 10ms — lots of headroom. A simple count query is sub-ms with the right index.

### 5. Contact-list join in evaluate path

**Scope:** small (after 1 + 2 land). **Complexity:** low. **Risk:** low.

**Change:** In the predicate evaluator, support `recipient_in: 'known_contacts'` / `recipient_not_in: 'known_contacts'`. Resolves at evaluate time by querying the People/contacts table for the user.

Predicate match logic:
```js
if (predicate.input?.recipient_not_in === 'known_contacts') {
  const recipients = extractRecipients(toolInput);  // to + cc + bcc fields
  const known = await db.getKnownContacts(userId);
  if (recipients.some(r => !known.has(r))) return true;  // conflict — fire ask_first
}
```

**Why now:** "send_email to a non-contact requires confirmation" is a high-value guardrail that's currently expressible only via blanket ALWAYS_CONFIRM (which fires on every send). Tightening to "external recipients only" lets Aria send to Lyle's known recipients autonomously while gating cold sends.

## How the 5 extensions unblock the 5 conceptual guardrails

| Conceptual guardrail | Unblocked by | What's enforceable after |
|---|---|---|
| Require confirmation for high-radius actions (>50 items, deletes, send to non-contact) | 1 + 2 + 5 | Count thresholds via predicate; recipient-set check via 5 |
| Block calendar modification without owner | 1 + 2 | Predicate: `input.event_owner != user_id` requires extension 1 (toolInput access) and 2 (predicate language) |
| Escalate low-trust actions (<0.6) | 3 | Per-user threshold replaces hardcoded 0.3 |
| Require confirmation for external sends | 1 + 2 + 5 | Same path as recipient-not-in-contacts |
| Bound autonomous action rate (20/60min) | 4 | New table or decision_log derivation + evaluate-time count |

All 5 conceptual guardrails are achievable with extensions (1) + (2) + (3) + (4) + (5) shipped together. Partial shipments leave gaps.

## What's NOT in this workstream

Explicitly out of scope so the work stays focused:

- **No changes to `email_classification_rules`** — that's the email-classification rule engine, separate from `behavior_rules`. Already has structured `conditions` jsonb (the model for extension 2).
- **No changes to `ALWAYS_CONFIRM`** — the hardcoded set in `tools.cjs:703`. Stays as the floor; behavior_rules can only INCREASE friction, never decrease.
- **No new LLM calls in evaluate path** — the engine's 300ms budget is non-negotiable. All extensions stay deterministic.
- **No tool-internal logic moves** — bulk_archive's count gate at `tools.cjs:1702` stays in the tool body for now; it could migrate to a behavior_rule once extension 2 ships, but migration isn't required for the workstream to be done.
- **No correction-event loop changes** — `trustFeedback.cjs maybeGenerateCorrectionRule` already auto-generates rules from rejection patterns. After extension 2, that rule generator could emit predicate rules; v1 keeps generating text-keyword rules.

## Sequencing recommendation

Ship in dependency order, each with its own commit. Estimated effort:

1. **Extension 1** (toolInput plumbing) — half day. Pure plumbing, no behavior change.
2. **Extension 2** (predicate language + jsonb migration) — 2-3 days. Schema migration + evaluator + tests against the 11 existing rules to confirm backward compat.
3. **Extension 3** (trust-floor parameterization) — 1 day. Depends on 2 if exposed as predicate; otherwise 2 hours as user_preferences entry.
4. **Extension 5** (contact-list predicate) — half day after 1 + 2.
5. **Extension 4** (rate limit) — 1-2 days. Decide table-vs-derived. Add count helper. Wire into evaluateAction.

**Total: ~5-7 days of focused work.** Could parallelize 3 + 4 + 5 once 1 + 2 land.

## After this workstream lands

Re-run the foundational guardrail authoring exercise that triggered this filing. The 5 conceptual rules become writable as actual `behavior_rules` rows with `predicate` blobs, evaluated deterministically by the engine. At that point the original session's spec executes one-pass.

Phase 2 capability expansion (aria@ mailbox, research agents, rule-proposal flow) can then build on top of guardrails that actually enforce.

---

*Workstream owner: TBD. Filed by Claude on Lyle's behalf, 2026-05-06 evening session.*
