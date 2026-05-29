# Voice Channel Parity + Conversation-Context Rules (v1)

Status: **SHIPPED 2026-05-29** — Option A built: shared `handleConversationTurn` (`server/lib/conversationTurn.cjs`); web, WhatsApp, and voice all ride it. Voice rebuilt as a stateful parity channel (conversation_id, 20-turn window, 30-min reset, deferred YES/NO confirmation).
Owner: Lyle + Claude
Branch: `dizon/voice-satellite` (off `dizon/v2-phase0`)

## Goal
Voice must behave like the text/WhatsApp channels: multi-turn continuity,
persistent memory, working confirmations ("yes, delete it" actually lands), and
tool execution — by riding the **same reasoning pipeline** as text, not a
parallel stateless path.

## Discovery (the premise that shaped this)
- There is **no pre-existing shared "handle a chat turn" function.** Each channel
  wraps the shared reasoning primitive `runAgenticLoop` (`server/lib/agenticLoop.cjs:70`)
  with its own history-load + persist glue:
  - **Web `/api/chat/execute`** (`server/routes/ai.cjs:420`) — SSE, **stateless**;
    the client owns conversation state (sends ~last 9 msgs) and persists turns
    out-of-band via `POST /api/conversations/:id/messages`.
  - **WhatsApp `/api/whatsapp`** (`server/routes/whatsapp.cjs`) — async,
    **server-side stateful**; loads last 20 turns (`getWhatsAppHistory`, 30-min
    session window), prepends, runs the loop, persists both turns. **This is the
    template for voice.**
- **Memory is already channel-agnostic** — `memory_facts` is keyed by `user_id`,
  no channel/conversation scoping; pulled into context by `buildAgenticContext`.
- **Confirmations**: `pending_confirmations` keyed by `(user, channel)`. Async
  channels (WhatsApp) create a row, prompt YES/NO, and **deny** to end the turn;
  the next inbound affirmative looks up `findLatestPendingConfirmation(userId, channel)`
  and executes the tool **directly from the stored row** with
  `{ alreadyExecuted: true, result }` for exactly-once. It never resumes the loop.

## Decisions

### Architecture — Option A: one shared handler
Extract a single `handleConversationTurn({ channel, ... })` that web, WhatsApp,
and voice all call. Same reasoning loop, tools, decision engine, memory. Logic
must not be duplicated per channel. **Must be backward compatible — no regression
to web chat or WhatsApp.**

### Two memory layers (do NOT conflate)
- **Working memory** = recent verbatim turns → `chat_messages` (the store text
  uses), windowed. *Add a `channel` column for provenance.*
- **Long-term memory** = distilled durable facts → `memory_facts` (unchanged,
  already cross-channel). Async, decaying, lossy — **never** used for "what did I
  just say."

Cross-channel awareness comes through the **shared long-term memory layer**, NOT
by merging raw recent threads.

### Conversation store — unified
Voice persists to `chat_conversations` / `chat_messages` (same store text uses),
so voice conversations also appear in the web Conversations UI.

### Windowing (load-bearing)
- `getConversationMessages` (`db.cjs:6319`) is **uncapped** — it loads the entire
  conversation. The shared handler **must window server-side** (web only avoids
  this by slicing on the client; voice/WhatsApp have no client).
- **Window = most-recent 20 turns** (`ORDER BY created_at DESC LIMIT 20`,
  re-sorted ASC). Matches WhatsApp; comfortably within the model budget.
- **Session reset = 30 min** for voice (mirror WhatsApp): a gap > 30 min starts a
  fresh window so stale context is dropped.

### Confirmations — channel-scoped (safety)
- Keep `pending_confirmations` keyed by `(user, channel='voice')`. Do **not**
  let a "yes" on one channel complete a confirmation started on another — the
  channel scoping is a guardrail against a misheard always-on-mic "yes"
  completing a destructive action from another channel.
- Voice mirrors WhatsApp: create row + speak prompt + deny; next-turn affirmative
  → `findLatestPendingConfirmation(userId, 'voice')` → `executeTool` directly →
  `updatePendingConfirmationStatus(..., 'approved', { alreadyExecuted, result })`
  → `notifyConfirmation` → `closeDecisionWithFeedback`.
- Use a longer expiry for the async channel (WhatsApp uses 10 min; default is 2).
- **No extra destructive-action friction now** (parity is the goal). Friction
  over an always-on voice mic is a documented FUTURE consideration.

### Memory enum fix
Add `'voice'` to the allowed `source_channel` set
(`server/utils/sourceChannel.cjs`). Today voice passes `channel:'voice'` to the
memory extractor, which throws (swallowed) — voice **recalls** memory but never
**persists** extracted facts.

## Caching (context, not a blocker)
- Prompt caching (`cache_control: ephemeral`) is applied to **system + tools**
  only (`agenticLoop.cjs:86-118`, `buildAgenticContext.cjs:578-606`).
  Conversation **history is not currently cached**.
- Caching is **orthogonal to windowing**: a cached prefix still counts against
  the context window — it only avoids re-billing/re-processing input tokens.
  **Windowing is still required.**
- ~5-min TTL: helps rapid bursts, cold for slow conversations.
- FUTURE (optional): extend a cache breakpoint to the windowed-history prefix so
  fast multi-turn voice exchanges only bill the new turn.

## Retention (observed, not changed)
- `chat_messages` growth is **unbounded** — no TTL/pruning job; only user-initiated
  deletes. `content` is `TEXT` with no length cap. Cheap for short voice turns.
- Exception: the Command Center daily conversation is wiped/recreated each day
  (`getOrCreateCommandCenterConversation`, `db.cjs:6365`).

## Pre-merge gates
- Voice routes through the SAME shared handler as text (verified by code path).
- Multi-turn works (turn N references N-1; "delete it" → "yes" completes).
- Memory persists in one turn, recalls in a later turn.
- `conversation_id` threaded from the client each turn; backend loads + appends +
  persists to the same store text uses.
- Confirmation/tool behavior identical to text, inherited not reimplemented.
- Backward compatible: web chat + WhatsApp unchanged in behavior.
- Wake word, hotkey, power-state, privacy gate, Scribe STT, ElevenLabs TTS
  unchanged. Build clean.

## Satellite client
- Generate + persist a `conversation_id` locally (state file) at first run so the
  thread survives restarts. Reset via flag and/or spoken "new conversation".
- Send `conversation_id` with every transcript.
- Response transport: the voice route returns **JSON** (server-side stateful
  wrapper, like WhatsApp's webhook) — the satellite speaks `reply`. No SSE needed.
