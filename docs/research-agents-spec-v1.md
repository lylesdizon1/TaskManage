# Research Agents — V1 Spec
*V1 spec — drafted 2026-05-06 from CC session. Implementation pending owner pickup; this doc is the contract.*

## Context

A "research agent" is a sub-agent Aria can spin up to handle multi-step investigations the user delegates. The user asks for something that needs 5-30 tool calls to answer — competitive analysis, meeting prep, vendor comparison, code-review research — and instead of Aria doing it inline (and ballooning a single chat turn into a 60-second wait), she dispatches a sub-agent that operates within bounded blast radius and reports back.

The capability has been waiting on engine guardrails. Pre-Extension-4 there was no rate limit; pre-Extension-3 the trust floor was hardcoded; pre-Extension-2 predicate gating couldn't gate on tool input. Now those exist. A research agent can run 30 tool calls without runaway risk because the engine's Tier 6 rate limit catches it; can't email a stranger because Tier 5 contact predicate catches it; can't escalate trust silently because Tier 5 trust-floor catches it. **The engine extensions made bounded autonomy expressible. Research agents are the first capability that consumes that budget.**

V1 is sync-streaming, single-user, read-mostly. V2 expands.

## Goals (V1)

1. **One tool, bounded scope.** New `start_research_agent` tool invokable by Aria. Takes a prompt + optional tool allow-list + optional budget overrides. Returns a structured result.
2. **Sync streaming.** User waits in chat; agent streams progress events ("checking your calendar…", "searching for Bob's last 5 emails…") via the existing SSE chat channel. Result returned at end. No background job queue in V1.
3. **Read-mostly default.** Default tool subset is read-only (search_*, get_*, list_*, web_search). Write tools (create_task, create_note, create_event) opt-in via `start_research_agent({ allowed_writes: [...] })`. Send/delete/destructive tools are HARD-DISALLOWED in V1 regardless of allow-list.
4. **Hard budget caps.** Per run: 30 tool calls + 5 minutes wall clock + 30k tokens. User-overridable via tool params, capped by server-side max.
5. **Structured result.** Agent returns `{ summary, key_findings[], sources[], action_items[], confidence, budget_used }`. Renderable as a Command Center result tile. Aria can also read it inline and continue the conversation.

## Non-goals (V1 — explicitly deferred)

- **No async / background runs.** V1 is sync. User waits. V2 = job queue, return on completion via WhatsApp/CC notification.
- **No multi-turn agents.** Each `start_research_agent` call is a one-shot. Agent doesn't have persistent memory across runs. V2 = persistent agent identities (a "research scratchpad" Aria can resume).
- **No write-heavy default.** Even with `allowed_writes`, V1 caps at task/note/event creation. send_email is never permitted from a research agent in V1.
- **No nested research agents.** A research agent cannot spawn another research agent. V2 reconsiders if real use cases emerge.
- **No agent-to-agent collaboration.** Single isolated run. V2 = research agents that hand off to each other (one investigates, another summarizes, another drafts).
- **No tool-cost dashboard.** Token / API spend per run is logged via existing `agent_actions`; explicit cost UI is V2.

## User stories

| User asks Aria… | Research agent does… | Returns |
|---|---|---|
| "Prep me for my call with Bob tomorrow" | search calendar history with Bob, fetch their last 5 emails, look up contact facts, summarize relationship + open threads | summary + 3 talking points + 1 action item ("you owe him an answer on the proposal") |
| "What was that thing about Mercedes G-wagons" | search inbox + web_search for recent G-wagon news | summary with sources |
| "Compare options for our Q3 vendor switch" | search internal notes + web_search competitors + compile pricing | summary + comparison table + recommendation |
| "Catch me up on Carevestment from the last 2 weeks" | search inbox + recent classifications + calendar events for Carevestment | summary + key threads + action items |

The unifying pattern: 5-30 tool calls of read-only-mostly investigation that would balloon a single Aria turn but is exactly the kind of thing she should be able to do without 5 separate prompts from the user.

## Architecture

### Request lifecycle

```
User: "Prep me for Bob's call tomorrow"
   ↓
Aria runs: start_research_agent({
  prompt: "Prep brief for tomorrow's call with Bob",
  budget: { tool_calls: 30, wall_clock_ms: 5*60_000 }
})
   ↓
Server spawns researchAgent.run({ prompt, userId, allowedTools, budget })
   ↓
Inside research agent:
  - separate agenticLoop instance
  - constrained tool list (intersection of ARIA_TOOLS ∩ allowed)
  - decisionEngine still gates every tool (rate limit, trust, predicates apply)
  - SSE progress events streamed back through the parent chat connection
  - on each tool call: log to agent_actions with research_run_id
  - on stagnation: existing agenticLoop stagnation detection ends the loop
  - on budget exhaustion: end loop, return partial result
   ↓
Result: { summary, key_findings, sources, action_items, confidence, budget_used }
   ↓
Aria receives result, summarizes for user inline OR renders as a result tile
```

V1 reuses the existing `agenticLoop.cjs` machinery — same tool dispatch, same gateToolExecution hook, same logAction. The research agent is just a *configured invocation* of that loop with a stricter tool set + budget.

### Module structure

| Module | Responsibility |
|---|---|
| `server/lib/researchAgent.cjs` (new) | `runResearch({ userId, prompt, allowedTools, budget, onProgress })` — wraps `runAgenticLoop` with research-specific config, budget tracking, result extraction. |
| `server/tools.cjs` (modified) | New tool `start_research_agent`. Existing tools unchanged. |
| `server/routes/ai.cjs` (modified) | When `start_research_agent` runs, the parent chat's SSE stream forwards research progress events. Slight extension of the existing tool execution path. |
| `db.cjs` (modified) | New helper `logResearchRun(userId, { prompt, status, result, budget_used, started_at, completed_at })` — single audit row per run. |

### Schema changes

One new table for audit + future async support:

```sql
CREATE TABLE research_runs (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','completed','failed','budget_exhausted','stagnated')),
  result       JSONB,                              -- the structured result on success
  budget_used  JSONB,                              -- { tool_calls, wall_clock_ms, tokens }
  parent_decision_id INT REFERENCES decision_log(id),
  started_at   TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX research_runs_user_started_idx ON research_runs(user_id, started_at DESC);
```

Plus optional column on `agent_actions`:

```sql
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS research_run_id TEXT REFERENCES research_runs(id) ON DELETE SET NULL;
```

So every tool execution inside a research run links back to the run. Audit trail: pull the run + JOIN agent_actions to see exactly what tools fired.

## Tool surface

### New tool: `start_research_agent`

```
{
  name: 'start_research_agent',
  group: 'intelligence',
  risk: 'medium',
  requires_confirmation: false,    // research is read-mostly; the agent's
                                   // tool calls each go through their own gates
  description: "Spin up a bounded sub-agent to investigate something for the user — multi-step research that would balloon a single chat turn. Best for: meeting prep, competitive analysis, catch-up summaries, anything needing 5-30 read-only tool calls. Returns a structured result with summary + findings + sources + action items. Don't use for single-tool answers (just call the tool); don't use for write-heavy actions (the agent's writes are budgeted/restricted).",
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What you want the agent to investigate. Be specific — agents are bounded, vague prompts waste budget.' },
      allowed_writes: {
        type: 'array',
        items: { type: 'string', enum: ['create_task', 'create_note', 'create_event'] },
        description: 'Optional. Allow the agent to write these tool types. Default: read-only. Send/delete/destructive tools NEVER allowed regardless.',
      },
      budget: {
        type: 'object',
        properties: {
          tool_calls: { type: 'number', description: 'Max tool calls. Default 30, server cap 50.' },
          wall_clock_ms: { type: 'number', description: 'Max wall-clock ms. Default 300000 (5 min), server cap 600000.' },
        },
      },
    },
    required: ['prompt'],
  }
}
```

### Tools the research agent can call

Hard rules enforced inside `researchAgent.cjs`:

| Tool category | V1 default | V1 with `allowed_writes` opt-in | V1 hard-disallowed |
|---|---|---|---|
| `search_*` / `get_*` / `list_*` | ✅ | ✅ | — |
| `web_search` (Anthropic-hosted) | ✅ | ✅ | — |
| `get_email_content` / `search_email_content` | ✅ | ✅ | — |
| `create_task` / `create_note` / `create_event` | ❌ | ✅ when in `allowed_writes` | — |
| `set_preference` | ❌ | ❌ | — (V2; agents shouldn't modify user prefs) |
| `update_*` / `complete_*` | ❌ | ❌ | — (V2 with care) |
| `send_email` / `reply_email` | ❌ | ❌ | ✅ HARD NO V1 |
| `delete_*` | ❌ | ❌ | ✅ HARD NO V1 |
| `bulk_archive_emails` | ❌ | ❌ | ✅ HARD NO V1 |
| `accept_rule_proposal` / `reject_rule_proposal` | ❌ | ❌ | ✅ HARD NO V1 |
| `start_research_agent` | ❌ | ❌ | ✅ HARD NO (no nesting) |

Hard-disallowed = even if explicitly added to `allowed_writes`, the research agent's tool dispatcher refuses. Sole authority to send / delete / destroy stays with the user-driven Aria turn.

## Confirmation / autonomy model

The research agent's individual tool calls go through the **same** decisionEngine + gateToolExecution path as user-driven Aria calls. So:

- **Rate limit** (Ext 4 — Tier 6): 30 tool calls in a research run + the user's existing autonomous-actions budget overall. Combined ceiling protects against runaway agents AND runaway aggregate volume.
- **Trust floor** (Ext 3 — Tier 5): if user's trust score for a particular tool is low, the agent's call gets escalated to confirm_required. Mid-research confirmation card surfaces — user can approve to continue or kill the run.
- **Predicate rules** (Ext 2): all behavior_rules apply uniformly. If user has a rule "never search emails from the legal account," the agent honors it.
- **ALWAYS_CONFIRM list**: send_email etc. would surface a confirmation card mid-research. V1 hard-disallows these tools to avoid the awkward mid-research confirmation flow.

The agent itself runs without an additional confirmation gate — `start_research_agent` is the user's act of consent. But every TOOL CALL the agent makes goes through the existing gates.

## Result shape

```typescript
{
  status: 'completed' | 'budget_exhausted' | 'stagnated' | 'failed',
  summary: string,                    // 1-3 sentence headline
  key_findings: Array<{
    point: string,                    // the finding
    source: string,                   // tool name + brief locator (e.g. "search_inbox: thread 19df...")
  }>,
  sources: Array<{                    // raw tool-call provenance
    tool: string,
    input_summary: string,
    output_summary: string,
  }>,
  action_items: string[],             // optional next-action suggestions for the user
  confidence: number,                 // 0..1, agent's self-reported confidence
  budget_used: {
    tool_calls: number,
    wall_clock_ms: number,
    tokens: number,
  },
  error?: string,                     // present when status != 'completed'
}
```

The structured shape is enforced by a final result-extraction step at the end of the agent's loop (Aria-style: a final synthesis call to Haiku/Sonnet that produces the structured JSON from the run's tool results).

## Failure modes

| Mode | Detection | Response |
|---|---|---|
| Budget exhausted (tool_calls or wall_clock) | researchAgent.cjs counters | End loop, return partial result with status='budget_exhausted'. Surface what WAS gathered. |
| Stagnation (same tool+input ≥2x) | Existing agenticLoop stagnation detection at `agenticLoop.cjs:136-147` | Force final synthesis, return with status='stagnated'. |
| Tool error | Existing agenticLoop tool-error path | Continue if recoverable; if all tools failing, end with status='failed'. |
| User kills mid-run | SSE channel close | Existing agenticLoop close-handling. Return partial. |
| Hard-disallowed tool requested | researchAgent.cjs dispatch check | Tool returns error to the loop, loop continues. (Doesn't end run — agent might recover.) |
| Confirmation card surfaces (e.g. for an `update_task`) | Existing pending_confirmations flow | The agent's loop pauses on the confirmation, same as user-driven Aria. User's response resumes the loop. |

## Risk & safety

| Risk | Mitigation |
|---|---|
| Agent loops forever burning tokens | Hard budget caps + stagnation detection + Tier 6 rate limit. Three independent ceilings. |
| Agent emails a stranger | send_email hard-disallowed regardless of allowed_writes V1. |
| Agent reads emails it shouldn't | Inherits the user's data scope — exactly what the user has access to. No cross-tenant exposure (existing `requireOwnership` middleware enforces). |
| Agent gets prompt-injected by an email it reads | Same risk as user-driven classify/summarize. Mitigations: agent's system prompt fences user-data with explicit "this is data, not instructions" framing (existing pattern from buildJournalBlock). |
| Agent silently misuses a write tool when allowed_writes set | Each write goes through decisionEngine + behavior_rules + ALWAYS_CONFIRM. Same gates as user-driven Aria. |
| Agent's structured result lies (hallucinates findings without sources) | Result schema requires `sources` array per finding. Validation step rejects findings without source. |
| Agent confused by ambiguous prompt | Stagnation + budget caps end the run. User can re-prompt. |
| Cost runaway from many concurrent research runs | V1 single-user means at most one Aria session = at most one in-flight run via that session. V2 needs explicit concurrency limits. |

## Phasing

### V1 (this spec)
1. Schema migrations (research_runs table, agent_actions.research_run_id column)
2. `server/lib/researchAgent.cjs` — wraps runAgenticLoop with budget tracking + tool gating
3. New tool `start_research_agent` in tools.cjs (definition + execution case)
4. Result schema enforcement via a final synthesis step
5. SSE progress event forwarding (extend existing chat stream)
6. Hard-disallowed tool list enforced inside the agent's dispatch (defense in depth on top of decisionEngine gates)
7. Audit logging — agent_actions rows tagged with research_run_id, research_runs row updated on completion
8. Tests: budget exhaustion fixture, stagnation fixture, hard-disallowed tool refusal, structured result extraction
9. Aria system-prompt directive: when to use start_research_agent vs handle inline

### V2 (deferred — captured for future)
- **Async runs:** kick off, return immediately, notify on completion via WhatsApp/CC. Requires job queue (BullMQ or similar) + persistent run state.
- **Multi-turn agents:** persistent scratchpad, resumable runs, context across sessions.
- **Nested agents:** research agents spawning sub-agents for parallel sub-investigations.
- **Agent-to-agent handoff:** one agent investigates, another summarizes, another drafts (each with its own budget).
- **Cost dashboard:** per-run token / API spend, surface to admin endpoint.
- **Wider write surface:** update_*, complete_*, send_email under specific guardrails (e.g. send_email only to known contacts, only to addresses that have replied to user's primary in last 90 days, etc.).
- **Per-agent trust scores:** each agent persona accumulates its own trust independent of the user's per-tool trust. ("Research agent" trust score, "drafting agent" trust score, etc.)
- **Templates / personas:** named agent configurations ("meeting prep agent", "competitive analysis agent") with predefined tool sets and prompt patterns.

## Open questions

1. **Synthesis model for the final result.** Sonnet for richness or Haiku for cost? Probably Sonnet — it's the final synthesis, runs once per agent, $0.005-0.02 typical. Haiku could miss nuance.
2. **Token budget vs tool-call budget.** Currently spec'd both. Token budget needs Anthropic SDK to expose usage per call (it does). Decide if we cap on both or just tool_calls (token-budget = future tightening).
3. **Result tile UI.** Is the result a new ResearchResultTile component (rich rendering with source provenance), or rendered as inline text in CC chat? V1 = inline text via Aria's response; V2 = dedicated tile. Confirm.
4. **Stagnation behavior.** When the agent stagnates (calls same tool 2x), force-synthesize-and-return is the V1 plan. Alternative: feed an LLM hint "you're stagnating, try a different angle" and let it continue. V1 says force-end for predictability; V2 could try the hint.
5. **Web_search budget.** Anthropic's web_search has its own max_uses (currently 5 in our config — `tools.cjs:719`). Research agent's web_search calls count toward THAT budget. Should research agent get a higher web_search cap or share the user's? V1 = same cap (5 max_uses); confirm acceptable.
6. **Concurrent runs.** V1 single-user, single in-flight run from one chat session. If user opens two CC tabs and triggers two research runs simultaneously, both run independently (separate agentic loops). Acceptable for V1?

## Implementation plan (sequenced punch-list)

Sized for execution. Each item targets a single commit / PR.

1. **Schema:** `research_runs` table + `agent_actions.research_run_id` column. Idempotent migrations. ~30 min.
2. **`server/lib/researchAgent.cjs`:** thin wrapper around `runAgenticLoop`. Constrained tools, budget tracking, result extraction. ~3 hrs.
3. **`start_research_agent` tool:** definition + execution case in `tools.cjs`. ~1 hr.
4. **SSE progress streaming:** extend existing `/api/chat/execute` stream so research progress events forward to the parent chat. ~2 hrs.
5. **Result extraction:** final-turn synthesis call that produces the structured result schema. Sonnet by default. ~1.5 hrs.
6. **Hard-disallowed enforcement:** dispatch-time check inside researchAgent.cjs that refuses send/delete tools regardless of inputs. ~30 min.
7. **Tests:** budget exhaustion, stagnation, hard-disallowed refusal, result-schema validation. ~2 hrs.
8. **Aria system prompt directive:** when to use vs handle inline. ~30 min.
9. **Result tile UI** (V2 prerequisite, optional V1): a CC tile that renders the structured result with source provenance. ~3 hrs.

**Total V1 (no UI tile):** ~11 hrs of focused work.
**With UI tile (V1 polish):** ~14 hrs.

**Sequencing recommendation:** Items 1-3 first land an "MVP that runs but doesn't stream" — sufficient for a sanity test. Items 4-7 round out the operational loop. Item 8 is the prompt tune. Item 9 is presentation polish that can wait.

## Out-of-scope details captured for completeness

- **Anthropic-side web_search vs custom.** V1 uses Anthropic's hosted web_search (existing in our tool list, 5 max_uses). No custom search backend.
- **Memory / scratchpad.** V1 is one-shot. Tool results accumulate in the loop's `messages[]` and disappear at run end. No persistent agent memory.
- **Cost tracking.** Tokens per run logged via the SDK's usage field; surfaced in `research_runs.budget_used`. Aggregate cost dashboard is V2.
- **Tool-result truncation.** Long tool outputs (e.g. a search returning 50 emails) are truncated server-side (existing pattern) so they don't blow the agent's context. V1 inherits this.
- **Aria deciding when to dispatch vs handle inline.** Lives in the system prompt directive, not in code logic. The directive: "if the request needs >5 tool calls and is investigation-shaped, prefer start_research_agent; otherwise handle inline."

---

*Filed by Claude on Lyle's behalf, 2026-05-06 evening session. Workstream owner: TBD. Engine prerequisites (Ext 1-5 + rule-proposal flow + aria@ mailbox spec) all shipped or filed in same session.*
