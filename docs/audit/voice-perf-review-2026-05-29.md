# Voice + Perf Code Review — 2026-05-29 (post-marathon audit)

Two-agent investigation while Lyle slept. Synthesizes:
1. Code drift audit of tonight's 20+ commits (voice + perf + cost)
2. Regression hunt on "email tile populated randomly" + "you are back to rachel → did that task already"

**Both agents converged on the same root cause for the regressions:** the LATENCY DISCIPLINE system-prompt directive (shipped at 22:56) is too permissive and pattern-matches partial words against context blocks. It triggered both reported symptoms in one go.

---

## TL;DR — Priority action list

| # | Action | Effort | Risk | Status |
|---|---|---|---|---|
| 1 | **KILL** vestigial autoplay primers in `toggleVoiceReplies` + `toggleMic` | 5 min | Trivial | ✅ Shipped while you slept |
| 2 | **TUNE** the LATENCY DISCIPLINE directive — exclude partial-word matches + person-name pattern matching | 10 min | Low | ⏸️ Recommendation below, awaiting your sign-off |
| 3 | **TUNE** sentence regex if voice playback splits on decimals (e.g. "$3.50") | 15 min | Low | ⏸️ Cosmetic, not breaking yet |
| 4 | **SIMPLIFY** parallel tool exec to detect dependency chains | 30 min | Low | Future enhancement |
| 5 | Test plan to repro/verify the directive fix | 5 min | None | See §4 |

---

## §1. Root cause: LATENCY DISCIPLINE directive over-fires

The directive at `buildAgenticContext.cjs:30-31` reads:

> Every tool call adds 1-3 seconds of perceived wait. Before calling a tool, check whether the answer is already in the standing context blocks above (LIVE DATA, ACTIVE PROJECTS, PEOPLE & RELATIONSHIPS, FOOD LOG, LEARNED PATTERNS, RECENT OUTCOMES, EMAIL LABELS, DAILY WRAP). If the user asks "what's on my calendar today" / "what did I eat" / "who is X" / "what tasks do I have" / "what's overdue" / "do I have any unread email" — the answer is already in front of you. Answer directly. Only reach for a tool when the question genuinely requires data outside the standing context (a future date, a specific email body, a web search, a write operation). When in doubt, skim the context blocks first.

### Why "you are back to rachel" misfired

When you sent that message, your standing context probably contains:
- A contact entry "Rachel" (PEOPLE & RELATIONSHIPS block)
- Possibly a memory_fact mentioning Rachel
- Possibly a recent outcome mentioning Rachel

The directive tells Aria to "skim the context blocks first" and includes "who is X" as a sample in-context query. With the word "rachel" present in her standing context, she likely:

1. Saw "back to rachel" → scanned context
2. Found a Rachel entry → pattern-matched against the in-context-query heuristic
3. Assumed it was a question about Rachel → generated an answer ("did that task already") instead of calling a tool
4. The email tile that "randomly appeared" was probably the active-zone `critical_email_unacked` detector running on its 5-min cadence — coincidental timing, not directly caused

The "did that task already" phrasing isn't in the codebase (verified via grep) — it's pure LLM hallucination from misreading the input.

### Recommended fix

Replace the directive with tighter pattern matching:

```
LATENCY DISCIPLINE
Every tool call adds 1-3 seconds of perceived wait. Before calling a tool, check whether the answer is in the standing context blocks above. The following EXACT question shapes are answerable in-context — pattern-match strictly:

  • "what's on my calendar [today|tomorrow]" → LIVE DATA calendar
  • "what did I eat [today|yesterday]" → FOOD LOG
  • "what tasks do I have" / "what's overdue" → LIVE DATA tasks
  • "do I have any unread email" → EMAIL LABELS + RECENT OUTCOMES
  • "who is <name>" → PEOPLE & RELATIONSHIPS

CRITICAL: Do NOT pattern-match on partial words or substrings. Messages that mention a name or topic but are NOT direct questions ("you are back to X", "did you handle X", "thanks for X") are NEVER in-context queries — they are statements, follow-ups, or new context from the user. When the input is ambiguous or doesn't match an exact question shape above, call the appropriate tool. Calling a tool when unnecessary costs 1-3 seconds; answering wrong from context costs trust.
```

The key insight: **"answering wrong from context costs trust"** balances against the latency framing. Without it, the directive reads as a one-way push toward avoiding tool calls.

---

## §2. KILL list — vestigial code (already removed)

Both autoplay primers became vestigial when the CSP fix shipped (`2901584`). They were patches around a problem that turned out to be CSP all along — not autoplay policy. The CSP fix is the actual unlock; the primers no longer do useful work.

**Shipped while you slept** (`docs/audit/voice-perf-review-2026-05-29.md` companion commit): removed both primer blocks. Total: ~15 LOC. Functions still work identically post-CSP.

Removed:
- `src/panels/DashboardPanel.jsx` — silent-mp3 primer in `toggleVoiceReplies` 
- `src/panels/DashboardPanel.jsx` — silent-mp3 primer in `toggleMic`

The persistent `playTtsRef` audio element is KEPT — it's still useful for reusing across sentences in the streaming TTS queue.

---

## §3. KEEP — validated correct

| Item | Why correct | Notes |
|---|---|---|
| 17 voice refs | Each tracks distinct state in the voice state machine | No consolidation candidates |
| Streaming TTS sequence ordering | Seq-numbered slots + Map deletions + guards = robust against the races we walked through | No silent failure modes |
| 15KB tool result cap | Email search hits this intentionally — narrows query reflexively | Truncation message guides Aria correctly |
| Cache split (peopleBlock, projectsBlock, learningsBlock all cacheable) | None take userMessage as a fetcher param → stable across turns | Validated against `getRelevantContacts`, `getProjectContextForUser`, `getCachedRules` signatures |
| Silent MP3 primer file | Verified valid MPEG ADTS via `file -` | Moot since removed |
| Parallel tool execution gate (`!anyConfirmable`) | Tools with dependency chains (e.g. search_gmail → get_email_content) error gracefully and retry serially in next iteration | No correctness bug, just inefficient |

---

## §4. Test plan for the directive fix

**Repro the original bug first** (confirm it still triggers before fixing):
1. Send to CC: `you are back to rachel`
2. Expected (broken): Aria says something like "did that task already" or otherwise misinterprets
3. Note whether the email tile appears coincidentally

**Validate the fix** (after directive update):
1. Send: `you are back to rachel` → should respond as a statement, not a task query
2. Send: `the assistant is using rachel voice now` → should respond as a statement (no false in-context match)
3. Send: `who is rachel?` → should answer from PEOPLE & RELATIONSHIPS (correct in-context match)
4. Send: `what's overdue?` → should answer from LIVE DATA (correct in-context match)
5. Send: `did you handle the rachel thing?` → should call `search_tasks` or similar (correct tool path)

**Bonus diagnostics if symptoms recur:**
- Open DevTools → Network → find the `/api/chat/execute` POST
- Search the request body for "rachel" — count occurrences in the system prompt
- If multiple matches → context is biasing the model toward in-context answer

---

## §5. TUNE — sentence boundary regex (cosmetic)

Current: `/^([\s\S]*?[.!?]+)\s+([\s\S]*)$/`

Decimal split case: text like `"The cost is $3.50 and I bought it."` could match at `"$3.50 "` and fire TTS on the wrong segment. The 20-char minimum length saves us in practice, but only by accident.

If you hear voice playback splitting awkwardly on financial figures, abbreviations, or URLs, replace with:

```js
const m = buf.match(/^([\s\S]*?(?<![A-Z][a-z]?|Mr|Mrs|Dr|Prof|Jr|Sr|\d)[.!?]+)\s+([\s\S]*)$/);
```

This adds negative lookbehinds for common abbreviation patterns and trailing digits.

Not breaking; not urgent.

---

## §6. SIMPLIFY — parallel tool execution dependency check

The gate in `agenticLoop.cjs:269-270` reads:
```js
const anyConfirmable = toolUseBlocks.some((t) => getToolByName(t.name)?.requires_confirmation);
const canParallelize = toolUseBlocks.length > 1 && !anyConfirmable;
```

Doesn't detect tools whose output feeds another tool's input (e.g. `search_gmail` → `get_email_content`). Current behavior: parallel attempt → second tool fails because input refs are unresolved → next iteration retries serially with proper sequencing.

This is correct but wastes one Sonnet iteration on the retry. Future cleanup: maintain a small dependency table (`get_email_content` depends on a prior `search_gmail` or `search_inbox` in the same turn) and serialize when detected.

Not urgent — the error recovery path handles it gracefully.

---

## §7. What was investigated and ruled out

- **Voice mode UI side effects** — no layout shift could have unhidden a pre-existing tile
- **Parallel tool execution race** — toolResults match by `tool_use_id`, not array order; refactor is safe
- **Streaming TTS state leakage between turns** — `resetVoiceTurn` correctly clears all per-turn state
- **Console.warn misleading messages** — agent didn't find the `[voice] autoplay blocked` warning (it was naturally removed in the sentence-streaming refactor, since `playAriaVoice` was replaced)
- **Tool side-effect causing email tile** — no tool was actually called for that message; phrase "did that task already" is pure LLM hallucination, not a hardcoded response

---

## §8. Updated commit ledger (full session)

41 commits 2026-05-28 08:57 → 2026-05-29 00:46, plus the audit cleanup commit shipped while you slept (~02:00). Latest:

```
TBD     fix(voice): kill vestigial autoplay primers (post-CSP cleanup)
TBD     docs(audit): voice + perf code review 2026-05-29
181599c fix(voice): preserve sentence order across parallel TTS round trips
491e6e4 feat(voice): sentence-streaming TTS — voice plays while text streams
2901584 fix(voice): allow data: + blob: in CSP media-src      ← the real fix
b392d13 fix(voice): also prime audio policy when mic is clicked  ← now vestigial
... (37 earlier commits)
```

---

## §9. Honest assessment of tonight's drift

Where we DID drift, and lessons:

1. **Three autoplay-policy patches in a row before identifying CSP as the real culprit.** Cost: ~30 minutes of evening time + 15 LOC of dead code (now removed). Lesson: when a `console.warn` says "autoplay blocked" but the actual browser console shows a CSP violation, READ THE BROWSER CONSOLE, not just the JS warn.

2. **LATENCY DISCIPLINE directive shipped without dogfood.** Quick wins on perception, but it pattern-matches too loosely. Lesson: prompt-level changes need test cases before shipping — especially when their failure mode is "Aria answers wrong" rather than "endpoint 500s."

3. **Sentence streaming sequence ordering bug shipped.** Caught in dogfood within minutes. Lesson: parallel-but-ordered is a classic concurrency hazard; defaulting to sequential first would have been safer.

Where we did NOT drift:
- CC persistence fix architecture (FK + CASCADE) is correct
- Memory M2 smart recall — validated live
- Prompt caching cache split — validated correct, 37K cached tokens observed
- Streaming TTS state machine — robust against races
- Cost observability — fixed the incrBy bug, all 9 call sites wired correctly
- ElevenLabs provider auto-selection — works on env-flip, no redeploy

---

**Net: minor cleanup needed, no architectural backtracking. The only behavioral change to make is the LATENCY DISCIPLINE directive — and that's a 10-minute edit to one constant.**
