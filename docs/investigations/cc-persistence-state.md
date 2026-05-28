# Command Center Persistence — Investigation Findings

**Branch:** `dizon/cc-persistence-investigation` (off `51d36e7`)
**Date:** 2026-05-28
**Status:** Read-only audit. No code changes. Fix scope recommendation at end.

---

## TL;DR

Three independent bugs in the desktop Command Center chat persistence layer. Lyle hit them live on 2026-05-28 — his "who is aj?" message went to an orphaned conversation while the UI showed a different conversation. Symptoms: message vanished from view, Aria appeared to respond, persisted message and persisted response landed in a third conversation with no parent row.

| Bug | Severity | Scope |
|---|---|---|
| 1. `ccConvId` drift via race condition between init and send | High | Lyle-visible, repeatable when init re-fires mid-session |
| 2. Missing FK CASCADE on `chat_messages.conversation_id` | High | 556 orphan rows accumulated across all users (551 Lyle's), oldest 2026-04-04, newest ~minutes ago |
| 3. Server endpoints don't validate `conversation_id` exists | Medium | Both `/api/conversations/:id/messages` and `/api/chat/draft` accept any integer |

All three contribute to the symptom but they're independent fixes. Bug 1 produces the user-visible drift; Bugs 2 and 3 let the orphans accumulate silently.

## Symptom that triggered the investigation

2026-05-28 16:53:09 — Lyle typed *"who is aj?"* in Command Center. Diagnostic queries show:

| Time | Event | Conversation |
|---|---|---|
| 16:53:09.759 | Conversation 1580 created via `/api/dashboard/command-center/session` | 1580 (new daily) |
| 16:53:09.801 | User message "who is aj?" saved | **1579 (orphan)** |
| 16:53:09.808 | Today's brief saved | 1580 |
| 16:53:24.449 | Aria's reply to "who is aj?" saved | **1579 (orphan)** |

Lyle saw the brief render in CC (conversation 1580) but his message and Aria's reply went to conversation 1579 — which had no parent row in `chat_conversations`. UI rendered 1580's contents (brief only). User message vanished from view.

Same minute also produced ~13 nearly-identical "Escalade service overdue" assistant messages distributed across conversation IDs 1511, 1512, 1513, 1517, 1518, 1519, 1520, 1521, 1522, 1540, 1558, 1567, 1579 — none of which have parent rows. Source unclear; speculation in Bug 3 section.

---

## Bug 1 — `ccConvId` drift via race condition

### Code path

`src/panels/DashboardPanel.jsx`:
- Line 448: `const [ccConvId, setCcConvId] = useState(null);`
- Line 954: `setCcConvId(conversation.id)` — ONLY write site, inside `initCommandCenter`
- Line 1187: `handleCcSend` reads `ccConvId` via closure
- Line 1189: Send guard — `if (!text || ccSending || !ccConvId) return;`
- Line 1227: User message POST uses captured `ccConvId`
- Line 1672: Assistant message POST uses captured `ccConvId`

### How drift happens

1. `useCallback` for `handleCcSend` (line 1187-1704) captures `ccConvId` in its dep array (line 1704). When `ccConvId` changes, the callback recreates.
2. BUT: an already-running `handleCcSend` execution has already captured the OLD `ccConvId` via closure. Mid-flight state change doesn't re-bind.
3. If `setCcConvId(1580)` fires from init at line 954 between when the user clicks send (capturing 1579) and when the POST at line 1227 executes (still uses captured 1579), the message lands in the wrong conversation.

### Why init might fire mid-session

Two paths trigger init (`initCommandCenterRef.current()`):
- Effect at line 1024 — depends on `[initialBriefData, currentUser?.id, ccConvId]`. Guard: `if (ccConvId || ccInitRunningRef.current) return;`. Should not fire when `ccConvId` is set.
- Effect at line 1031 — 5-second fallback. Guard: `if (!ccConvId && !ccInitRunningRef.current) initCommandCenterRef.current();`. Same guard.

Both guards check `ccConvId` is truthy. So init shouldn't fire when there's already a conversation. **Yet conversation 1580 was created at 16:53:09.759 in Lyle's session, suggesting `ccConvId` was null at that moment.**

Possible explanations (not exhaustively diagnosed):
- Lyle had a fresh page load — `ccConvId` was null at mount. Init started.
- Lyle typed his message before init completed (page took >5s OR he typed faster than init resolved).
- `setCcConvId(1580)` ran at 16:53:09.759 BUT React batched the state update — `ccConvId` was still 1579 in the user-message-POST closure that fired at 16:53:09.801.

The 40ms gap between `setCcConvId(1580)` and the user POST is consistent with React state batching + event-handler race.

### Why this also wrote the user POST to 1579 (which already existed)

`ccConvId=1579` came from somewhere — most likely a previous session that left it persisted in some cache (React Query, localStorage, or just plain useState surviving navigation). Investigation didn't fully chase the persistence source for `ccConvId` itself, but it's clearly non-trivial: the state was 1579 (yesterday's CC conversation? Or one even older?) when init kicked off.

### Severity

High. Repeats whenever a user sends a message during the init window. Probability scales with how slow `/api/dashboard/command-center/session` is — slower means longer window.

---

## Bug 2 — Missing FK CASCADE on chat_messages

### Schema gap

`db.cjs:307-315`:
```sql
CREATE TABLE IF NOT EXISTS chat_messages (
  id              SERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  model           TEXT DEFAULT 'claude',
  conversation_id INTEGER,             -- NO FK, NO NOT NULL, NO CASCADE
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

And `db.cjs:323-330`:
```sql
CREATE TABLE IF NOT EXISTS chat_conversations (
  id         SERIAL PRIMARY KEY,
  user_id    TEXT NOT NULL,            -- NO FK to users
  ...
);
```

Compared with other tables in the same schema (lines 144, 264, 387, 388, 399, 411, 436, 448, 471), every other user-scoped table has `user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`. The chat tables are an outlier — they lack ALL FK constraints.

### Consequence

When `getOrCreateCommandCenterConversation` runs (db.cjs:6255), it manually deletes messages first then the conversation:

```js
await pool.query(`DELETE FROM chat_messages WHERE conversation_id = ANY($1)`, [ids]);
await pool.query(`DELETE FROM chat_conversations WHERE id = ANY($1)`, [ids]);
```

This is correct for its purpose but is the ONLY code path doing it. Any other delete that happens (via direct SQL, via admin tooling, via crashes between the two statements) leaves messages orphaned.

### Production state

Run 2026-05-28 19:00 UTC:

```
orphan chat_messages all users:  556
orphan chat_messages for Lyle:   551
oldest orphan:                   2026-04-04T17:37:59
newest orphan:                   2026-05-28T19:00:21   ← ~minutes before this query
orphans by role:                 assistant: 529, user: 27
```

**The newest orphan is just minutes old.** Active creation continues. Whatever the writer is, it's still firing in production today.

### What this looks like in queries

`SELECT cm.* FROM chat_messages cm LEFT JOIN chat_conversations cc ON cc.id = cm.conversation_id WHERE cc.id IS NULL` — 556 rows globally, 551 for Lyle.

### Severity

High. The orphan count grows ~10-30 messages/day at current usage. No user-visible damage if the UI only renders messages from valid conversations, but data integrity is compromised and any analytics over chat_messages is biased by orphans.

---

## Bug 3 — Servers accept arbitrary `conversation_id`

### Endpoints

Two writers accept `conversation_id` from client input without validating existence:

**`server/routes/chat.cjs:100-110`** (`POST /api/conversations/:id/messages`):
```js
const msg = await db.addConversationMessage(parseInt(req.params.id, 10), req.user.id, role, content, model);
```
`addConversationMessage` (db.cjs:6218) goes straight to INSERT. No "does conversation exist?" check.

**`server/routes/chatDraft.cjs:70-151`** (`POST /api/chat/draft`):
```js
const conversationId = parseInt(req.body?.conversation_id, 10);
// ... later ...
await db.createActionCardMessage({ conversationId, userId, cardId, payload });
```
Same shape — accepts client integer, inserts.

### Consequence

When a client has a stale `ccConvId` (Bug 1), the message lands as an immediate orphan. Even without Bug 2 ever happening, Bug 3 lets new orphans appear in real time.

### What is writing the mass-fan-out assistant messages?

Investigation did NOT conclusively identify the writer of the ~13 assistant messages at 16:53:18-21 to orphan conversation IDs. The strongest hypothesis:

- Lyle has many tabs/windows open over time, accumulated over months
- Each tab has its own `ccConvId` state from whenever it initialized
- A polling tick (`handleFreshUpdate`, possibly some other interval) fires across all tabs nearly-simultaneously
- Each tab posts an assistant message using its own stale `ccConvId`

`handleFreshUpdate` (DashboardPanel.jsx:1132) has a comment at line 1128-1131 saying "proactive narrations are CLIENT-ONLY ephemeral" — meaning they should NOT persist. The code reading confirms it only calls `setCcMessages` (local state), not `apiFetch` to a POST endpoint. **So `handleFreshUpdate` is not the writer.**

Other suspects worth chasing during the fix:
- The chat-send path (`handleCcSend`) firing from multiple tabs
- The chat-draft path (`/api/chat/draft`) — multiple tabs hitting it
- Some interval handler I haven't found yet

This requires running the app in two tabs, watching network requests, and correlating with chat_messages inserts. Not done in this audit.

### Severity

Medium. Bug 3 alone wouldn't cause user-visible drift, but it enables the orphan accumulation that Bug 2 schema-allows.

---

## Fix scope recommendation

The investigation surfaced enough to scope a focused remediation session. Three commits, sequential:

### Commit A — Add FK + CASCADE on chat_messages

`db.cjs::runMigrations()` adds:
```sql
ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_conversation_fk
  FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE;

ALTER TABLE chat_messages
  ADD CONSTRAINT chat_messages_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chat_conversations
  ADD CONSTRAINT chat_conversations_user_fk
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
```

**Migration blocker**: cannot ADD CONSTRAINT until orphan rows are cleared. The orphans must be DELETEd first (or `NOT VALID` workaround applied). Recommend: a one-time prod DELETE of the 556 orphans BEFORE the ALTER (separate commit, separate authorization — see Commit C below).

~30 LOC. Destructive migration.

### Commit B — Server-side validation of `conversation_id`

Both writers validate that the conversation exists AND belongs to the requesting user before INSERT. Returns 404 (existence-leak-safe; same response for "doesn't exist" and "exists but yours"). ~25 LOC across `chat.cjs` and `chatDraft.cjs`.

### Commit C — One-time orphan DELETE (prod write, requires authorization)

Before Commit A's ALTER can be added, the 556 orphan rows must be removed. Scoped query:

```sql
DELETE FROM chat_messages
WHERE conversation_id IS NOT NULL
  AND conversation_id NOT IN (SELECT id FROM chat_conversations);
```

Bounded by the LEFT JOIN audit: exactly 556 rows. Recommend reading the orphan rows' content first (in case there's any user-authored content worth preserving among the 27 user-role orphans), then DELETE.

### Commit D — `ccConvId` drift fix (the actual user-visible bug)

Options:
- (a) Block `handleCcSend` while init is running — add `ccInitRunningRef.current` to the early-return guard at line 1189. ~3 LOC, surface-treats the symptom.
- (b) Make `handleCcSend` re-fetch `ccConvId` from a ref at send time, not closure. ~10 LOC, more robust.
- (c) Have `handleCcSend` await `/api/dashboard/command-center/session` if `ccConvId` is null OR if init is mid-flight. Defensive; ~20 LOC.

Recommend (a) as the minimum viable fix paired with (b) for robustness. (c) is over-engineering.

### Sequencing

C → A → B → D in that order. C must run before A because A's FK constraint won't accept dirty data. B and D are independent of A/C and can ship in any order.

---

## What this investigation did NOT do

- Did not run app in multiple tabs to reproduce the mass-fan-out writer
- Did not chase where stale `ccConvId` persists across page loads (localStorage? React Query cache?)
- Did not check if any other tables in the schema are missing CASCADE — only audited chat_messages / chat_conversations
- Did not check for ccConvId drift in mobile / WhatsApp paths — both have different code

These are valid follow-up investigations if the fix surfaces additional symptoms.

---

*End of findings. No code changed. Awaiting Lyle review before any of the proposed Commits A/B/C/D are cut.*
