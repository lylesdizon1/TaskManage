# Memory + Channel-Agnostic Surfaces — Phase 2 Spec

**Author:** CC
**Draft date:** 2026-05-26
**Status:** Draft, awaiting Lyle review. Reframed per Part 1 verification findings (see commit history) and the four dogfood gaps logged in `project_memory_dogfood_gaps.md`.
**Scope:** Parts 2-5 of the memory + channel-agnostic close-loop work. Part 1 (verification audit) was delivered separately in conversation; this doc consumes those findings as ground truth.
**Sequencing constraint:** Phase 1 implementation (memory P1 sub-items) is **blocked behind Gap 3 Bug B landing**, per Lyle's anti-pattern concern: the conversation-turn extractor cannot run across two divergent context paths. If Bug B stays quiet through Commit B's soak (3-4 days), the gate flexes — extractor work may begin in parallel with Bug B audit/fix. Spec stands either way.

---

## Verification recap (from Part 1)

Carrying forward the findings that reshape this spec:

- **Two memory tables already exist**, not one. `agent_memory` is the action audit log (write-only, surfaced via `getRecentMemories` filtered to task/event tools). `memory_facts` is the actual facts system with `strength_score NUMERIC(3,2) DEFAULT 0.5` and a partial-unique index for global + contact-scoped axes. **Extension target is `memory_facts`; `agent_memory` stays untouched.**
- **Three extractors write to memory_facts today**: `journalEnrichment.cjs` (178 LOC, daily wrap input), `outcomeEnrichment.cjs` (138 LOC, post-task/event outcome notes), `contactFactExtractor.cjs` (142 LOC, contact-scoped). The new conversation-turn extractor slots into the same pattern — fourth extractor, same shape.
- **Strength only goes UP today** (+0.1 per repeat observation, capped at 1.0). No decay, no access tracking, no `source_channel`. Schema additions required.
- **Context engine is server-side `buildAgenticContext.cjs`** — frontend `src/lib/context-engine/` is largely inert for agentic flows. The brief endpoint uses its own path (post Gap 3 Bug A fix in `58ffab7`, brief now goes through shared `contextRendering.cjs`). When Bug B lands, the client-side `buildSystemPrompt` for `/api/chat/execute` will be eliminated and `ctx.systemPrompt` becomes the single source of truth across all surfaces.
- **Agentic loop is channel-agnostic at the function level** (`runAgenticLoop` in `agenticLoop.cjs`) but `channel` is not in the signature today — it's observable at the route level (`ai.cjs:543` → `'web'`, `whatsapp.cjs:423` → `'whatsapp'`). Plumb through.
- **Close-the-loop bulk UI exists in `ActiveZoneOrchestrator.jsx` `BulkCloseRow`** but operates via REST from React, not via tool calls. For cross-channel parity (close loops via WhatsApp conversation), the flow must become tool-driven. Architecturally the biggest lift in this spec.
- **Daily Wrap has no "12 phases"** in current code. The web flow is a 4-field journal form (`DailyWrapTile.jsx`) + `journalEnrichment` trigger on save. Lyle confirmed the 12-phase idea was aspirational; this spec proposes a 6-phase WhatsApp flow that builds on the existing journal_entries table without renumbering anything web-side.

---

# Part 2 — Memory Extraction (Conversation-Turn)

## Goal

After each agentic loop turn that produced user signal, run a Haiku-cheap extraction pass that writes durable facts to `memory_facts`. Targets: facts about people, preferences (mine + others'), decisions made, stated intentions, ambient context. Skip: routine acknowledgments, already-structured tool outputs, Aria's restatements.

Channel-agnostic by construction — same extractor fires for web chat, WhatsApp, future SMS. `source_channel` column captures provenance for audit but doesn't gate retrieval.

## Schema additions

`memory_facts` extensions (ALTER TABLE, idempotent — same pattern as Commit B):

```sql
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS source_channel TEXT;
-- Index supports the retrieval scoring read path (Part 4).
CREATE INDEX IF NOT EXISTS memory_facts_user_retrieval_idx
  ON memory_facts (user_id, strength_score DESC, last_seen_at DESC)
  WHERE contact_id IS NULL;
```

`agent_memory` extension (separately useful, low cost):

```sql
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS source_channel TEXT;
```

Allowed `source_channel` values: `'web_chat'`, `'whatsapp'`, `'sms'` (future), `'journal'`, `'outcome'`, `'contact_note'`. Validate at write time in a tiny enum helper to prevent stringly-typed drift.

## Extractor — `server/lib/conversationEnrichment.cjs` (new)

~150-200 LOC. Mirrors `journalEnrichment.cjs` structure: Haiku call, quality gate, debounce, fire-and-forget from the agentic loop.

**Trigger:** at end of each `runAgenticLoop` iteration where the user sent textual input (not pure tool-result turns). Hook point: `agenticLoop.cjs:265` (after the loop returns successfully). Fire-and-forget — never blocks the user reply.

**Quality gate** (before Haiku call):
- User message length ≥ 30 chars (skip ackowledgments)
- User message ≠ exact YES/Y/yes/NO/N/no (skip confirmation replies)
- Not within 30s of the prior extraction for this user (Redis debounce; `mem:extract:{userId}` with 30s TTL)
- Not a tool-result-only turn (loop produced no assistant text)

**Haiku prompt shape:**

```
You are an extraction-only assistant. From the conversation turn below,
extract durable facts the user would want remembered. One JSON object only:

{
  "facts": [
    {
      "text": "<the fact in third-person, neutral phrasing>",
      "type": "<'preference' | 'decision' | 'intention' | 'context' | 'person_fact'>",
      "confidence": 0.0-1.0,
      "contact_mention": "<exact name string if the fact is about a specific person, else null>"
    }
  ]
}

Rules:
- 0-5 facts per turn. Empty array is correct when nothing durable was said.
- Skip routine acknowledgments, time-of-day greetings, and tool restatements.
- Skip facts already implied by the structured tool calls Aria made this turn
  (e.g. don't re-extract "user wants to create a task X" — that already lives
  in tasks).
- contact_mention is the exact case-sensitive name as the user wrote it.
  Resolution to a contact_id happens server-side, not here.
- confidence ≥ 0.5 to be saved. Be honest about how durable the fact is.

User message: "<...>"
Aria's response: "<...>"
Tool calls made this turn: [<...tool names...>]
```

**Server-side post-processing:**
- Drop facts with confidence < 0.3
- For each remaining fact:
  - If `contact_mention` matches a contact by name (existing `searchContactsByName` helper), call `addContactFact(userId, contactId, text, type, confidence)` — routes to contact-scoped axis
  - Else call `upsertMemoryFact(userId, null, text, type, confidence, source_channel)` — global axis
- `upsertMemoryFact` extended to accept `source_channel` parameter (small change to `db.cjs:10256`)

**Dedup against `journalEnrichment`:**
Same fact extracted from a wrap entry AND a chat turn should not double-bump `supporting_count`. The existing partial UNIQUE index on `(user_id, fact_text) WHERE contact_id IS NULL` already collapses identical text via ON CONFLICT. The +0.1 bump happens once per `upsertMemoryFact` call regardless — so duplicate observation across paths is captured as a single +0.1 (because the second call hits the conflict and updates). **No dedup logic needed.** This is a happy accident of the existing schema.

The earlier suggested option (b) — suppress turn-extractor during wrap zones — is still available if the natural dedup proves insufficient. Hold for soak data.

**`source_channel` plumbing:**
- `runAgenticLoop` signature gains `channel` parameter (~5 LOC)
- Web (`ai.cjs:618`) passes `channel: 'web_chat'`
- WhatsApp (`whatsapp.cjs:497`) passes `channel: 'whatsapp'`
- Extractor reads `channel` from the loop context and forwards to upsertMemoryFact

## LOC estimate — Part 2

| Item | LOC |
|---|---|
| Schema migrations (memory_facts + agent_memory + index) | ~20 |
| `conversationEnrichment.cjs` (new) | ~180 |
| `runAgenticLoop` channel param | ~5 |
| `upsertMemoryFact` source_channel param | ~10 |
| Hook into agentic loop post-iteration | ~15 |
| Source channel enum helper | ~10 |
| **Total Part 2** | **~240 LOC** |

---

# Part 3 — `remember_this` Tool

## Goal

User explicit signal — "remember that I prefer X" — bypasses normal extraction quality gates and writes high-confidence facts directly. Channel-agnostic, unconditionally available in the agentic loop, non-gated (user is explicitly invoking).

## Tool schema

```js
{
  name: 'remember_this',
  description: "Save a fact to long-term memory. Use when the user explicitly asks to remember something (\"remember that I...\", \"don't forget...\", \"keep in mind...\"). If content is omitted, the previous turn's user message is saved verbatim.",
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Optional explicit fact text. Defaults to the previous user message.' },
      contact_name: { type: 'string', description: 'Optional: if the fact is about a specific person, the name to resolve to a contact.' },
    },
    required: [],
  },
}
```

## Executor behavior

- Resolves `contact_name` to `contact_id` via `searchContactsByName` if present
- Persists via `upsertMemoryFact(userId, contactId|null, text, 'explicit_remember', 0.9, channel)`
- `source_channel` populated from agentic loop context
- Returns `{ success: true, fact_text, contact_id, contact_name }`
- Aria's confirmation reply: `"Saved — <brief restatement>."`

Not in `IMAGE_SAVE_TOOLS`, not gated by `requiresConfirmation`. User is the one invoking; no double-confirmation.

## LOC estimate — Part 3

| Item | LOC |
|---|---|
| Tool schema in tools.cjs | ~25 |
| Tool executor in tools.cjs | ~40 |
| Confirmation reply rendering (one-line addition to existing flow) | ~5 |
| **Total Part 3** | **~70 LOC** |

---

# Part 4 — Retrieval Scoring (Phase 2 sub-phase)

## Goal

Today's retrieval is `strength_score DESC, last_seen_at DESC` — strength-only sort. Add access boost and recency decay so memories that get used rise, and memories that go stale fade. **No semantic search yet** (deferred to Phase 3 per Lyle's Q2 — pgvector or embeddings is ~500 LOC + infra decision).

## Read path changes

`getMemoryFactsForUser(userId, limit)` in `db.cjs:10218` — extend to compute effective score:

```sql
SELECT fact_text, fact_type, supporting_count, strength_score,
       access_count, last_accessed_at, last_seen_at,
       -- Effective score: strength * recency_factor * access_factor
       -- recency: 1.0 if seen today, decays 0.95/day after, floor 0.3
       -- access: 1.0 base, +0.05 per access in last 30d, capped 1.5
       (strength_score
         * GREATEST(0.3, POWER(0.95, EXTRACT(EPOCH FROM (NOW() - last_seen_at)) / 86400.0))
         * LEAST(1.5, 1.0 + (access_count * 0.05))
       ) AS effective_score
FROM memory_facts
WHERE user_id = $1 AND contact_id IS NULL
ORDER BY effective_score DESC, last_seen_at DESC
LIMIT $2
```

Equivalent shape for `getTopContactFacts` (contact-scoped axis).

## Access tracking

Each fact returned by `getMemoryFactsForUser` (or any retrieval path that surfaces facts into Aria's context) bumps:

```sql
UPDATE memory_facts
SET access_count = access_count + 1,
    last_accessed_at = NOW()
WHERE id = ANY($1)
```

Fire-and-forget after `buildAgenticContext` selects the top-N facts. Adds one cheap UPDATE per agentic turn. Skip if zero facts surfaced.

## Decay cron

Weekly cron in `proxy-server.cjs` (slot alongside the existing rule-decay at `proxy-server.cjs:503`). Runs Sundays at 4 AM UTC. Spec per Q3:

```sql
UPDATE memory_facts
SET strength_score = GREATEST(0.1, strength_score * 0.95)
WHERE strength_score > 0.1
  AND last_seen_at < NOW() - INTERVAL '30 days'
  AND last_accessed_at IS NULL
     OR last_accessed_at < NOW() - INTERVAL '30 days'
```

Floor 0.1 prevents decay-to-zero (long-tail facts recoverable if access patterns resume). Skip rows touched in the last 30 days via either `last_seen_at` (re-observation) or `last_accessed_at` (recent recall).

## LOC estimate — Part 4

| Item | LOC |
|---|---|
| Read-path scoring rewrite | ~30 |
| Access-tracking UPDATE hook | ~20 |
| Decay cron in proxy-server.cjs | ~30 |
| Tests for boundary conditions (decay floor, access cap) | deferred to soak |
| **Total Part 4** | **~80 LOC** |

---

# Part 5 — Channel-Agnostic Close-the-Loop + WhatsApp Daily Wrap

## Architectural lift overview

The web bulk-close UI (`ActiveZoneOrchestrator.jsx::BulkCloseRow`) iterates `pending_close_loop` rows via REST. For cross-channel parity (close loops via WhatsApp conversation, resume in web mid-flow), the flow must become **tool-driven** so the agentic loop can drive it on any channel.

**Biggest single piece of work in this spec.** Estimated ~700 LOC across schema + tools + sessions table + web refactor + WhatsApp orchestration. Worth its own commit (or sub-commit chain) separate from Parts 2-4.

## New: `close_loop_sessions` table

```sql
CREATE TABLE IF NOT EXISTS close_loop_sessions (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_channel  TEXT NOT NULL,  -- 'web' | 'whatsapp' | 'sms'
  trigger_type    TEXT NOT NULL,  -- 'post_meeting' | 'eod_wrap' | 'manual'
  -- Ordered list of loop IDs to walk. JSONB rather than a join table
  -- because the order matters and the list is small (≤20 per session
  -- typically). Index access by element via expanded queries.
  loop_ids        JSONB NOT NULL DEFAULT '[]',
  current_index   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'completed' | 'expired'
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  last_activity   TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS close_loop_sessions_user_active_idx
  ON close_loop_sessions (user_id, last_activity DESC)
  WHERE status IN ('active', 'paused');
```

Sessions expire after 4 hours of inactivity (cron sweep).

## Six new tools

| Tool | Purpose |
|---|---|
| `start_close_loop_session` | Aria-callable. Queries open `pending_close_loop` rows (optionally filtered by event/topic/age), inserts a session row, returns first loop's title + context. |
| `next_loop` | Advances `current_index`, returns next loop's title + context. Returns `{done: true}` when at end. |
| `resolve_current_loop` | Calls existing `/api/close-loop/resolve` for the current loop, advances index. Accepts optional `outcome_note` argument. |
| `skip_current_loop` | Advances index without resolving. |
| `pause_session` | Flips status to 'paused'. Idempotent. |
| `resume_session` | Flips status back to 'active', returns current loop. |

All six are non-gated (user is in active conversation; confirmation is implicit per turn). Auth via `userId` from request context.

## Web UI refactor

`BulkCloseRow` currently fetches `pending_close_loop` directly via REST. Refactor to instead read from `close_loop_sessions.current_index` so the web UI and Aria-driven flow share state.

User-visible behavior preserved: same iteration UX, same resolve buttons, same skip behavior. The plumbing changes; the experience doesn't.

**Cross-channel handoff:** Lyle starts a wrap in WhatsApp at 9pm → `close_loop_sessions` row created with `source_channel='whatsapp'`. Opens web at 9:30pm. `ActiveZoneOrchestrator` queries active sessions, finds the in-flight one, renders "In progress: closing loop 2 of 5 (started on WhatsApp)" with a Resume Here button. Web takes over (updates `source_channel` to 'web'); WhatsApp side falls back to next-tick "your session is now active on web" message if user replies there.

## WhatsApp post-meeting close-the-loop flow

Trigger: calendar event ends + 5 min (existing post-meeting cron at `proxy-server.cjs:301`).

Flow:
1. Cron queries open `pending_close_loop` rows tied to the just-ended event's attendees/topic via `closeLoopEmitter.cjs` heuristics
2. If ≥1 loop found, send WhatsApp:
   > "Just wrapped [meeting title]. You have 3 related loops open. Close them now? (YES / NO / LATER)"
3. **YES** → call `start_close_loop_session` via the agentic loop, set `trigger_type='post_meeting'`. Aria walks through loops one at a time.
4. **NO** → loops stay open. No further nag.
5. **LATER** → loops re-queued for EOD wrap reminder (no new alert; the EOD wrap will surface them).
6. Per loop: "Loop 1/3: [title]. Created [date]. Last note: '[excerpt]'. What's the outcome?"
7. User free-text reply → Aria calls `resolve_current_loop` with `outcome_note=<reply>`, advances.
8. After all done: "Closed 3 loops. Anything else from that meeting worth capturing?" → optional `remember_this` call.

Uses strict YES/NO disambiguation from existing `whatsapp.cjs` matcher (LIFO + 10-min window). LATER joins the matcher set as a third valid response.

## WhatsApp Daily Wrap — 6-phase conversational flow

Per Lyle's Q1 answer: design as a clean conversational flow, not a retrofit of 12 aspirational phases.

| Phase | Aria says | User replies | Tool called |
|---|---|---|---|
| 1. Greeting + scope | "Ready to wrap the day?" | YES / skip-to-X | (none) |
| 2. Close loops | "You have 5 loops open. Close them now? (YES / NO / SOME)" | YES → walk; NO → skip; SOME → "today's only or today+stale?" | `start_close_loop_session` w/ `trigger_type='eod_wrap'`, then per-loop |
| 3. Wins | "Any wins today?" | free text or "skip" | `upsert_journal_entry` with `wins` patch |
| 4. Frustrations | "Anything frustrating?" | free text or "skip" | `upsert_journal_entry` with `frustrations` patch |
| 5. Tomorrow focus | "Focus for tomorrow?" | free text or "skip" | `upsert_journal_entry` with `tomorrow_focus` patch |
| 6. Summary | "Saved: 3 loops closed, 2 wins, 1 frustration, tomorrow focused on X. Good night." | (none) | (none — terminates session) |

Each phase is skippable with "skip" or by short-circuiting ("just close loops" jumps to phase 2 then exits).

New tool: `upsert_journal_entry`. Wraps existing `/api/journal` POST. One per call, fields patched incrementally so partial wrap data lands even if the user bails mid-flow.

**Daily Wrap state lives in the same `close_loop_sessions` table** with `trigger_type='eod_wrap'`. `current_index` doubles as phase pointer (0-5). Status flips to 'completed' at phase 6.

## Edge cases

- **Unrelated question mid-flow:** Aria pauses session, answers, asks "ready to continue with loop 2?" → resume_session.
- **"skip"** → calls skip_current_loop, moves on.
- **"I'll do the rest later"** → pause_session. EOD wrap cron re-surfaces if before midnight.
- **New loop created during session** → NOT added to current session's loop_ids. Picked up next trigger.
- **Loop touched in web mid-session** → web UI calls `resolve_current_loop` instead of REST endpoint. Session state stays consistent.

## LOC estimate — Part 5

| Item | LOC |
|---|---|
| `close_loop_sessions` table + indexes + helpers | ~80 |
| 6 new tools (schemas + executors) | ~250 |
| 1 new tool (`upsert_journal_entry`) | ~50 |
| Web BulkCloseRow refactor to session-driven | ~150 |
| WhatsApp post-meeting cron orchestration | ~80 |
| WhatsApp Daily Wrap 6-phase flow + system prompt extensions | ~120 |
| Session-expiry cron | ~30 |
| **Total Part 5** | **~760 LOC** |

---

# Implementation sequencing (revised)

Per Lyle's M1/M2 breakdown, with the Bug B gate noted:

## M1 (Phase 1, parallel-safe with OCR Commits B/D/C **once Bug B lands**)

| Item | LOC | Notes |
|---|---|---|
| memory_facts + agent_memory schema | ~30 | Migration |
| Source channel enum helper | ~10 |  |
| `runAgenticLoop` channel param | ~5 |  |
| `upsertMemoryFact` source_channel param | ~10 |  |
| `conversationEnrichment.cjs` extractor | ~180 | New file |
| Confidence threshold filter | ~20 |  |
| `remember_this` tool (schema + executor) | ~70 |  |
| **M1 Total** | **~325 LOC** |  |

## M2 (after M1 soaks)

| Item | LOC | Notes |
|---|---|---|
| Retrieval scoring (access boost + recency) | ~50 | Rewrites `getMemoryFactsForUser` |
| Access-tracking UPDATE hook | ~20 |  |
| Weekly decay cron | ~30 |  |
| `close_loop_sessions` table + helpers | ~80 |  |
| 6 close-loop tools + 1 journal tool | ~300 |  |
| Web BulkCloseRow refactor to session-driven | ~150 |  |
| WhatsApp post-meeting close-loop flow | ~80 |  |
| WhatsApp Daily Wrap 6-phase flow | ~120 |  |
| Session-expiry cron | ~30 |  |
| **M2 Total** | **~860 LOC** |  |

## M3 (later, evaluate after M2 soaks)

| Item | LOC | Notes |
|---|---|---|
| Embedding-based semantic match | ~500 | Requires pgvector or external infra; deferred per Q2 |

---

# Open questions for Lyle

1. **`source_channel` enum strictness** — validate at write time (reject unknown values) or accept-and-log? Recommend strict; trivial to relax later, hard to retrofit if production data has typos.

2. **Decay cron timing** — Sundays 4 AM UTC slotted next to existing rule-decay cron at `proxy-server.cjs:503`. Acceptable, or prefer a different time? Per-user-tz timing isn't worth it for weekly-cadence maintenance.

3. **Access-tracking blast radius** — every agentic turn surfaces up to 10 memory_facts and bumps their `access_count`. At dogfood scale (~50 turns/day across 3 users) that's ~500 row updates daily. Trivial cost. Worth flagging because a future scale-up changes the calculus.

4. **`close_loop_sessions` JSONB vs join table for `loop_ids`** — JSONB chosen for ordering preservation + small list size. Alternative is a `close_loop_session_items` join table with explicit `position` column. Recommend JSONB unless we hit query patterns that need indexed list access (we won't in Phase 2).

5. **WhatsApp "SOME" branch in Daily Wrap Phase 2** — design intent is "today's only or today + stale?" Are there other meaningful subsets (e.g. "high-priority only", "from specific person")? Recommend keep to two for v1, expand if dogfood demand surfaces.

6. **Cross-channel handoff UX** — when Lyle resumes a WhatsApp-started session on web, should the web UI auto-detect and surface a Resume Here button (this spec's plan), or stay quiet and require explicit `/people` → "open active session" navigation? Auto-detect is friendlier but slightly magical. Recommend auto-detect; soak data tells us if it surprises.

7. **`agent_memory.source_channel` — useful or noise?** I included it for audit symmetry. The action log is mostly read by admin and never surfaces to Aria's context. If you don't see a near-term query that uses it, drop the ALTER and save 5 LOC.

8. **Bug B gate timing** — locked rule is M1 cannot start until Bug B lands. **If Bug B stays quiet through Commit B's soak**, the practical gate weakens — the anti-pattern concern was "extractor across two divergent context paths" but if there's only one effective path in practice, M1 can begin. Recommend: re-evaluate Bug B status when Commit B's soak completes; if quiet, authorize M1 in parallel with Bug B audit; if a Bug B repro lands, M1 stays gated.

---

# Out of scope for this spec

- Mobile app (parked indefinitely per locked roadmap)
- Chrome extension memory surfacing (covered in extension minimal-scope spec; consumes M1 output, doesn't extend it)
- Semantic embedding retrieval (Phase 3)
- Pre-rendering message templates → fire-time rendering (P2 architectural item from Gap 5; relevant when memory-triggered nudges land in Phase 2, but not blocking M1)
- Cross-user memory sharing (existing `shared_access_grants` infrastructure handles this; Phase 2 work uses it as-is)

---

*Spec ends here. ~1,185 LOC total across M1 + M2. M3 (semantic) is ~500 LOC additional and deferred. All numbered open questions need answers before M1 cuts code.*
