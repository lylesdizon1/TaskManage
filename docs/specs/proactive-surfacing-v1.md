# Proactive Surfacing — V1 Spec

**Status:** LOCKED — decisions resolved 2026-05-28. Ready for P2b scaffold work.
**Date:** 2026-05-28
**Author:** Claude + Lyle
**Related:** `agents-foundation-v1.md`, `memory-phase-2.md`, `aria-health-audit-2026-05-05.md`

---

## 1. Why now

Today's two ships closed the memory loop end-to-end:
- **M1b** (`conversationEnrichment.cjs`) — facts get extracted from every agentic turn.
- **M2** (`getMemoryFactsForUserSmart`) — facts surface contextually when the user asks.

Both are **reactive** systems. They run *in response to* a user message. The next leverage is **initiation**: Aria volunteering signal at the right moment, without being asked. That's P2.

The locked roadmap (2026-05-14) lists P2 as proactive surfacing. P1 is essentially done (OCR Phase 1 A+B, memory M1a/M1b/M2, dogfood gaps 1/2/4). Twilio migration is the remaining infra item but is invisible to users; P2 is where the next user-facing leverage lives.

---

## 2. What already exists (audit)

The system is **not greenfield** — substantial proactive machinery is already running. The spec extends, doesn't replace.

### 2.1 Existing proactive surfaces

| System | Trigger | Channel | What it surfaces |
|---|---|---|---|
| Server alert scheduler | `* * * * *` cron | WhatsApp/Slack/Email | User-configured alert rules (overdue tasks, priority changes) |
| Post-meeting note reminder | `* * * * *` cron | Tile in CC | Pending close-loop items >48h old |
| Morning brief | per-user HH:MM, daily | WhatsApp/Slack/Email | Today's calendar + tasks + yesterday's wrap |
| Daily wrap nudge | per-user wrapTime | WhatsApp/Slack + web | "Time to wrap your day" prompt |
| **Active Zone** (`candidateDetector.cjs`) | On CC visit | **CC web tile only** | 9 detectors, top-3 by priority |

### 2.2 Active Zone — the existing engine

`server/lib/activeZone/candidateDetector.cjs` already implements the surfacer pattern V2 needs:

- **9 registered detectors:** overdue_tasks_batch, close_the_loops_batch, upcoming_meeting_with_prep, meeting_just_ended, pending_confirmation, draft_resume, daily_wrap_due, critical_email_unacked, single_urgent_task.
- **Priority scoring** (0–100), urgency tie-break.
- **Stable candidate_key dedup** (hash of type + sorted item ids).
- **Top-N orchestrator** with overlap resolution (higher priority wins; drops overlapping items from lower-priority candidates).
- **Pure detection layer** — easy to unit test. State loader is separate.

### 2.3 What's structurally missing

| Gap | Impact |
|---|---|
| No **push channel** for active-zone candidates | All surfacing requires the user to *open the CC*. Aria can't reach you on WhatsApp with "hey, your Escalade service is overdue + your meeting with Allen is tomorrow" unless an alert rule fires. |
| No **stale-relationship** detector | Memory says "Allen is your accountant"; system doesn't notice when you haven't talked to/about Allen in 14d. |
| No **stale-project** detector | Project workspace has tasks, but no signal fires when a project hasn't moved in N days. |
| No **memory-fact-driven** detector | The 100+ facts in `memory_facts` are read-only context. None ever triggers a nudge ("still planning to X you mentioned 3 weeks ago?"). |
| No **fatigue control across channels** | Alert scheduler, morning brief, daily wrap, ad-hoc Aria sends all push independently. No global per-day cap, no cooldown between consecutive nudges. |

V1's job is to fill exactly these gaps while reusing the existing detector framework.

---

## 3. V1 scope — what we ship vs defer

### 3.1 In scope

1. **Two new detectors** in the existing candidateDetector framework:
   - `stale_relationship` — contact not mentioned in conversation or referenced in calendar/task/notes for **30+ days** (locked), where contact is tagged as `active=true` or has a `relationship` field implying expected cadence.
   - `stale_project` — project entity has no task activity, note, or update for 7+ days.

2. **Push pipeline** — a new cron tick that runs `detectAllCandidates` per user (independent of CC visits), filters candidates eligible for push (not all are), and dispatches via WhatsApp (primary) or fallback channel per user preference.

3. **Fatigue control layer** — a `proactive_dispatch` table tracking what was sent when, with per-user-per-day-per-channel caps and per-candidate-key cooldowns.

4. **DND respect** — push pipeline must honor existing DND windows (already enforced in alert scheduler via `user_preferences` AT TIME ZONE).

5. **User-visible controls** — Settings tab: per-detector enable/disable, per-channel caps, optional quiet hours override.

### 3.2 Out of scope (V2+)

- **`memory_fact_followup` detector** — deferred to V2. Reasoning: (a) corpus is too young to trigger (5 intentions/decisions total, all <1 day old as of 2026-05-28); (b) requires `confirm_fact` / `retire_fact` tools that don't exist yet; (c) "still on the radar?" carries quiz-master risk that better-aged signals can validate first. Revisit once the corpus has >20 intentions/decisions at 21d+ age.
- Voice / SMS push channels (P3).
- Cross-user proactive (e.g., "your shared project with Leo hasn't moved").
- Reply-aware threading (a push that links back to the source conversation).
- Aria-initiated outbound *sends* to third parties without user confirmation. (Hard rule: V1 only surfaces to the user, never composes outbound messages autonomously.)
- Calendar-driven prep nudges beyond what `upcoming_meeting_with_prep` already does.
- ML-based ranking. V1 uses the existing rule-based priority system.

### 3.3 Hard constraints (non-negotiable)

- **No autonomous outbound sends.** V1 only nudges *the user themselves*. Any "send X to Y" path requires explicit confirmation, which is existing behavior.
- **Fail-soft.** A detector that throws must not crash the surfacer. Match the existing detector pattern (each detector returns null when it has nothing to say).
- **Dedup with existing surfaces.** If the morning brief already mentioned the Escalade service this morning, the surfacer must not re-push it 4 hours later.
- **DND is hard.** No push during quiet hours.

---

## 4. Architecture

### 4.1 Reuse the existing detector framework

New detectors plug into `candidateDetector.cjs` next to the existing 9. They get state from `loadUserStateForActiveZone`, which means we need to extend the state loader to include:
- Recent message/event history per contact (for `stale_relationship`)
- Per-project last-activity timestamps (for `stale_project`)
- Eligible memory facts with `last_seen_at` cursor (for `memory_fact_followup`)

Detectors return the same `{ type, candidate_key, priority_score, urgency, items, context }` shape. **The CC web UI gets these new candidates for free** — no separate code path for the web surface.

### 4.2 New: push eligibility flag

Each detector declares whether its candidate is push-eligible:

```js
{
  type: 'stale_relationship',
  candidate_key: '...',
  priority_score: 60,
  push_eligible: true,        // NEW field
  push_min_priority: 55,      // NEW field, optional override
  items: [...],
  context: {...}
}
```

Detectors with `push_eligible: false` still surface in the CC tile but never push. Reasons a detector might be CC-only: `draft_resume`, `daily_wrap_due` (already pushed by separate cron).

### 4.3 New cron: `proactiveSurfacerTick`

```
*/30 * * * *  (every 30 min)
  for each active user:
    state = loadUserStateForActiveZone(user)
    candidates = detectAllCandidates(state, { topN: 5 })
    push_candidates = candidates.filter(c => c.push_eligible && c.priority_score >= (c.push_min_priority || 60))
    for each push_candidate:
      if fatigueCheck(user, push_candidate): skip
      if dndCheck(user): skip
      send via preferred channel
      record in proactive_dispatch
```

Tick cadence: **30 min is the default**. Tunable per detector — `stale_relationship` doesn't need finer resolution than daily; `pending_confirmation` (already covered by other systems) shouldn't fire here at all.

### 4.4 New table: `proactive_dispatch`

```sql
CREATE TABLE proactive_dispatch (
  id            SERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate_type TEXT NOT NULL,
  candidate_key  TEXT NOT NULL,
  channel        TEXT NOT NULL,           -- 'whatsapp' | 'slack' | 'email' | 'cc'
  priority_score INT NOT NULL,
  dispatched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,            -- user replied / dismissed / clicked
  outcome_text   TEXT                     -- short summary of action taken, optional
);
CREATE INDEX idx_proactive_dispatch_user_time
  ON proactive_dispatch(user_id, dispatched_at DESC);
CREATE INDEX idx_proactive_dispatch_dedup
  ON proactive_dispatch(user_id, candidate_type, candidate_key, dispatched_at DESC);
```

Used for:
- **Fatigue check**: count dispatches in last 24h per channel.
- **Dedup**: don't re-fire same candidate_key within cooldown window.
- **Acknowledgment loop**: if user dismisses, raise cooldown for that candidate_key.
- **Telemetry**: which detectors are useful (high ack rate) vs noise (low ack, frequent dismiss).

### 4.5 Fatigue + cooldown defaults

| Channel | Daily cap | Per-detector cooldown |
|---|---|---|
| WhatsApp | 3 | 48h (no re-fire within 48h of last) |
| Slack | 5 | 24h |
| Email digest | 1/day | (digest groups, no per-item cooldown) |
| CC tile | unlimited (visible only on visit) | 6h within session |

All overridable in settings.

---

## 5. Signal sources for V1 — the three new detectors

### 5.1 `stale_relationship`

**Definition:** A contact tagged as `active=true` OR `relationship` field set (accountant, attorney, mentor, etc.), where:
- No conversation mention in user/assistant messages in last **30 days** (locked default)
- No calendar event with that contact in last 30 days
- No note tagged to the contact in last 30 days

**Priority formula:** `min(100, 40 + 2 * (days_silent - 30))` — fires at 40 on day 30, caps at 100 by day 60.

**Surfacing message template:**
> "Heads up — you haven't connected with **{contact.display_name}** ({contact.relationship}) in ~{n} days. Want me to draft a quick check-in?"

**Acceptance criteria:**
- Allen Douglass (accountant, last mentioned today) does NOT fire.
- A contact set as relationship='mentor' with no mention in 45d DOES fire at priority 70.
- Confirmed-inactive contacts (tagged `archived_at` or `active=false`) never fire.

### 5.2 `stale_project`

**Definition:** A project entity (entities table with `type` containing 'project') where:
- No task created, updated, or completed in last N days (default 7)
- No project_notes row in last N days
- Has at least one active (incomplete) task

**Priority formula:** `min(100, 30 + 5 * days_silent)`.

**Surfacing message template:**
> "**{project.name}** hasn't moved in ~{n} days. ({active_task_count} active tasks remain.) Want a snapshot?"

**Acceptance criteria:**
- Projects with all tasks done don't fire.
- Projects updated within window don't fire.
- One nudge per stale project per cooldown (48h).

### 5.3 `memory_fact_followup` — DEFERRED to V2

See §3.2 for rationale. Detector design retained for V2 reference:
- `fact_type IN ('intention', 'decision')`, `last_seen_at` >21 days, `strength_score >= 0.5`.
- Needs `confirm_fact` / `retire_fact` tools before it's useful.
- Cap at 1 fact-followup per user per week to avoid quiz-master feel.
- Reopen when corpus has >20 qualifying facts at 21d+ age.

---

## 6. Channel routing

V1 defaults: **WhatsApp first, fallback to Slack, fallback to CC tile only**. Per-user override in settings.

WhatsApp delivery uses existing `sendWhatsApp(db, userId, text)` from `utils/integrations.cjs`. No new vendor integration needed.

The push message is a single line + (optional) suggested action. No multi-message threading in V1.

---

## 7. Implementation phases

### P2a — Spec (this session)
Lock the spec. Lyle reviews. Adjust open questions.

### P2b — Surfacer scaffold (next session, ~250-400 LOC)
1. Create `proactive_dispatch` table + db helpers.
2. Add `push_eligible` field to existing detector outputs (backfill all 9 to `false` by default — preserve current behavior).
3. New `proactiveSurfacerTick` cron in proxy-server.cjs.
4. Fatigue + DND check helpers.
5. Single test detector for validation — `stale_relationship`.

### P2c — Remaining V1 detector + Settings UI (session +1, ~150-200 LOC)
6. Add `stale_project` detector.
7. Settings UI for per-detector enable/disable, embedded in the existing **Alerts tab** (locked).

### P2d — Dogfood + tune (session +2)
9. Run for ~1 week, measure: dispatches/day, ack rate, dismiss rate per detector.
10. Tune priority formulas + cooldowns based on data.

---

## 8. Locked decisions (2026-05-28)

| # | Decision | Locked answer |
|---|---|---|
| 1 | Per-detector default state | **ON** (sensible caps still apply) |
| 2 | Channel preference default | **WhatsApp first**, then fallback per existing alert preferences |
| 3 | `memory_fact_followup` inclusion | **DEFERRED to V2** — corpus too young, needs write-loop tools, quiz-master risk untested |
| 4 | Stale-relationship threshold | **30 days** (longer than initial proposal — matches Lyle's normal cadence) |
| 5 | Push during evening shutdown | **Silent** — full DND respect, no low-priority exception |
| 6 | Settings UI location | **Extend Alerts tab** — no new tab |

---

## 9. Telemetry & success metrics

Once V1 ships, success = sustained positive ack rate.

| Metric | Target |
|---|---|
| Median dispatches per user per day | 1–3 |
| Ack rate (user replied or actioned within 4h) | >40% |
| Dismiss rate (explicit dismiss) | <20% |
| Detector-level dismiss rate | none >30% (kill detectors above this) |
| User-disabled detectors in settings | track distribution |

Dashboards live in AdminPanel; per-detector breakdown surfaces ranking effectiveness.

---

## 10. What this spec does NOT solve

Worth naming so we don't drift:

- **Cross-system intelligence** — surfacer doesn't reason about *why* a project is stale, it just notices. The "smart suggestion" of *what to do next* on a stale project is V2 (likely a sub-agent invocation).
- **Calibration of memory_facts** — the spec assumes facts are right. If M1b extracts garbage, the surfacer will nudge on garbage. Garbage prevention lives in extractor tuning, not here.
- **Existing alert scheduler rationalization** — the alert scheduler, morning brief, daily wrap cron, and this new surfacer all push to WhatsApp. V1 makes the surfacer respect fatigue *with itself*; it does not unify global fatigue across all push systems. That's a worthwhile cleanup but separate.

---

## Decisions Log

- [x] Per-detector default state — **ON**
- [x] Channel preference default — **WhatsApp first**
- [x] Stale-relationship N — **30 days**
- [x] memory_fact_followup inclusion — **DEFERRED to V2**
- [x] Quiet hours allow low-priority — **No, silent**
- [x] Settings UI location — **Extend Alerts tab**
