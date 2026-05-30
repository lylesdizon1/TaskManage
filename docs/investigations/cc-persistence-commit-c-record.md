# Commit C — One-Time Orphan DELETE (Record of Operation)

**Date:** 2026-05-28
**Authorized by:** Lyle (explicit acknowledgment of the 27 user-role orphan contents)
**Operation:** DELETE 556 orphan `chat_messages` rows from production
**Result:** Success — 556 deleted, 0 orphans remaining

## Why

Per `docs/investigations/cc-persistence-state.md`, 556 chat_messages rows had `conversation_id` values pointing at deleted (or never-created) parent rows in `chat_conversations`. Two factors blocked auto-cleanup:

1. **Schema missing FK CASCADE** — `chat_messages.conversation_id` was a plain INTEGER column with no FK constraint. When parent conversations were deleted (by `getOrCreateCommandCenterConversation` or other paths), messages survived.
2. **Server endpoints accepted any integer** — `/api/conversations/:id/messages` and `/api/chat/draft` wrote to whatever `conversation_id` the client supplied, no existence check.

Commits B (`8be0423`) and D (`08c883e`) shipped earlier on 2026-05-28 to stop NEW orphans accumulating (D: client race guard; B: server-side existence validation). After both deployed, the orphan count stabilized at 556. Commit C cleans the historical accumulation.

Commit A (FK ADD CONSTRAINT) requires Commit C to be complete because PostgreSQL won't accept `ALTER TABLE ADD FOREIGN KEY` against dirty data.

## Authorization trail

The 27 user-role orphan contents were reviewed before deletion:

| Count | Content category |
|---|---|
| 24 | "Catch me up on my day" (CC auto-trigger phrase) |
| 1 | "who is aj?" (2026-05-28 morning, the bug that triggered the investigation) |
| 1 | "create a task to remind me to buy a birthday cake in 30 mins, and add to my calendar" (2026-04-10) |
| 1 | "how do you marinate tandoori chicken" (2026-04-10) |

Lyle explicit acknowledgment phrase: *"I've reviewed the 27 user-role orphans (24 'Catch me up on my day', 1 'who is aj?', 1 birthday cake task, 1 tandoori chicken question). Authorize deletion of all 556."*

## Operation

Executed via `pg` Node client connected to Railway production DB. Wrapped in a single transaction with three safety guards:

1. Pre-DELETE count must be in `[551, 561]` (allowing ±5 from the audit baseline of 556). If outside window → ROLLBACK.
2. DELETE rowcount must equal the pre-count exactly. If not → ROLLBACK.
3. Post-DELETE orphan count must be 0. If not → ROLLBACK.

The DELETE query (anti-join form):

```sql
DELETE FROM chat_messages cm
WHERE cm.conversation_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM chat_conversations cc WHERE cc.id = cm.conversation_id
  );
```

### Execution output

```
pre-DELETE orphan count: 556
DELETE row count: 556
post-DELETE orphan count: 0
✓ COMMITTED: 556 orphan chat_messages deleted, 0 remaining.
```

All three safety guards passed. Transaction COMMITted.

## Breakdown of what was deleted

| User | Role | Count |
|---|---|---|
| user-lyle | assistant | 525 |
| user-lyle | user | 26 |
| user-mnnrm9jq-231fa1 | assistant | 4 |
| user-mnnrm9jq-231fa1 | user | 1 |
| **Total** | | **556** |

Age distribution: 161 from April 2026, 395 from May 2026.

## What this DOESN'T do

- Does NOT add the FK CASCADE — that's Commit A, to land next.
- Does NOT delete `chat_conversations` rows — only orphan messages.
- Does NOT delete any non-orphan rows.

## Next: Commit A

`ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_conversation_fk FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE`

Now safe to run because the dirty data is cleared. Without C, this ALTER would fail with constraint violation on every orphan row.

Also recommended for the same migration: FK on `chat_messages.user_id` and `chat_conversations.user_id` to `users(id)` (both currently TEXT with no FK).

---

*Operation recorded for audit trail. No code shipped in this commit — the destructive write happened directly against prod, not via a deployed migration.*
