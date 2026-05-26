# Gap 5 — Nudge Date Math Investigation

**Branch:** `dizon/gap-5-investigation` (from `58ffab7`)
**Investigation date:** 2026-05-26
**Status:** Read-only audit. No code changes. Fix scope recommendation at end.

---

## Symptom

Aria sent a WhatsApp nudge on Monday May 25 saying the Escalade service was "due at 10 am." The service was actually due Tuesday May 26 at 10:00 AM PT. User read the Monday message as referring to "today" (Monday) because the message body contains a time but **no relative-date qualifier**.

## Verdict — short version

**Not a date-math bug. A render-template bug.** The scheduler fired exactly as designed (24 hours before the due moment, in user-tz). The persisted message string lacks the "tomorrow" qualifier needed for any non-zero lead time. User reads a Monday-morning message about a 10 AM time as "due today," even though the system correctly intended "due tomorrow."

## Trace

### Why Aria's message arrived Monday

`scheduleTaskAlerts` (`db.cjs:8565-8663`) runs when a task is created or updated with a due_date. For a medium-priority task (which Aria defaults to per `db.cjs:8417`), the cadence config is:

```js
{ priority: 'medium', offsets: [{ minutes_before: 1440, label: '24 hours before' }], channels: ['whatsapp'] }
```

Single offset: fire 24 hours before due moment.

For the Escalade service (due_date `2026-05-26`, due_time `10:00`, priority `medium`, tz `America/Los_Angeles`):

```js
// db.cjs:8584-8588
const tzOffset = getTimezoneOffset(tz);                  // '-07:00' (PDT)
const dueStr  = `${dueDate}T${dueTime}:00${tzOffset}`;   // '2026-05-26T10:00:00-07:00'
const dueDt   = new Date(dueStr);                         // 2026-05-26 17:00 UTC
```

Fire time:
```js
fireAt = new Date(dueDt.getTime() - 1440 * 60000);
       = new Date(dueDt.getTime() - 86_400_000);
       = 2026-05-25 17:00 UTC = 10:00 AM PT Monday
```

Scheduler math is **correct**. Fire moment lines up with 24h before due moment in user-tz. The earlier weekly-cadence tz bug (`b53e1a4`, 2026-05-14) doesn't apply here — that bug was on the `day_of_week + hour` branch (lines 8603-8628). The Escalade fire path went through the `minutes_before` branch (line 8601-8602), which always used absolute ms arithmetic and was never broken.

### Why the message reads "due today" to the user

Pre-rendered at scheduling time. `db.cjs:8636-8654`:

```js
let timeStr;
if (dueTime) {
  const [h, m] = dueTime.split(':').map(Number);
  const ampm   = h >= 12 ? 'pm' : 'am';
  const h12    = h % 12 || 12;
  timeStr      = `${h12}:${String(m).padStart(2, '0')}${ampm}`;  // '10:00am'
}
// ...
const message = timeStr
  ? `Hey ${firstName} — you've got "${taskTitle}" due at ${timeStr}.\n\n${closing}`
  : `Hey ${firstName} — you've got "${taskTitle}" due today.\n\n${closing}`;
```

Rendered string for the Escalade:

> Hey Lyle — you've got "Escalade service" due at 10:00am.
>
> Good time to get ahead of it.

The template has **no day qualifier**. A user reading this Monday morning has no in-message signal that "10:00am" refers to Tuesday — the natural interpretation is "today" because the message just arrived.

The template ALSO has a "due today" fallback (the `: 'due today'` branch) — but it only fires when `dueTime` is null. With both a date AND a time present, the template strips the date context entirely. Worst-of-both: more specific time, less specific day.

### Diagnostic confidence

High. I didn't query prod (sandbox gated production-DB reads), but the symptom matches the code path deterministically:
- WhatsApp + service + "due at 10am" wording isolates to `scheduleTaskAlerts`'s template
- 24h lead time is the medium-priority default
- No other WhatsApp-sending cron renders text in this format

If the user wants to verify with production data, the smoking-gun query is on `scheduled_alerts`:

```sql
SELECT id, task_id, alert_key, message, fire_at, fired_at, fired
FROM scheduled_alerts
WHERE user_id = '<lyle-id>'
  AND message ILIKE '%escalade%'
ORDER BY fire_at DESC LIMIT 5;
```

Expected: row with `message LIKE '%due at 10:00am%'`, `fired_at` Monday 5/25 ~10:00 PDT, `alert_key LIKE 'sched::%::1440'`.

---

## Footprint Audit (widened per strategic framing)

Strategic framing from the brief: the nudge scheduler shares time-logic infrastructure with the Phase 2 surfaces about to ride this pattern (proactive surfacing, when-to-leave, memory-triggered nudges, Daily Wrap enrichment). Mapping the full footprint so the surgical edit doesn't leave parallel sites to fix later.

### Tier 1 — Render templates that produce user-facing time-aware messages

| Site | File:line | Bug? | Notes |
|---|---|---|---|
| **Task-alert scheduler message** | `db.cjs:8652-8654` | **YES — the Gap 5 root cause** | Lacks day qualifier when both date + time are present. Pre-rendered at scheduling time, so message is wrong for any non-zero lead time. |
| Post-meeting "just ended" message | `proxy-server.cjs:309` | No | Fires within 5 min of event end. Says "just ended" — temporally unambiguous. |
| Morning brief calendar block | `server/routes/alerts.cjs:91-94` | No | Uses `toLocaleTimeString` with explicit `timeZone: tz`. Fixed previously. |
| Morning brief date line | `alerts.cjs:79` | No | `new Date().toLocaleDateString(..., { timeZone: tz })`. |
| Daily Wrap push | `alerts.cjs` (`buildAndSendDailyWrap`) | Not audited in depth here | Fires at user-configured wrap time; if a similar template exists it should be checked. **Flag for fix-scope inclusion.** |
| Aria agentic context (calendar/tasks) | `buildAgenticContext.cjs` via `contextRendering.cjs` | No | Already bucketed by temporal status (`7c24218`, `58ffab7`). |

### Tier 2 — Date math at scheduling time

| Site | File:line | Bug? | Notes |
|---|---|---|---|
| `scheduleTaskAlerts` minutes_before branch | `db.cjs:8601-8602` | No | Absolute ms arithmetic from a tz-anchored Date. Tz-correct. |
| `scheduleTaskAlerts` day_of_week branch | `db.cjs:8603-8628` | No (fixed 2026-05-14) | Uses `Intl.formatToParts` to resolve user-tz weekday + date, then builds the absolute moment via `tzOffset`. Was previously broken via `setHours`/`getDay`; fixed in `b53e1a4`. |
| `getTimezoneOffset` | `db.cjs:8510-8533` | No | DST-safe via `Intl.DateTimeFormat` with `timeZoneName: 'shortOffset'`. Fallback to `-07:00` only if parse fails. |
| `cron.schedule` cadences in `proxy-server.cjs` | Multiple | No | All use `getLocalHHMM(user.timezone)` against `user.briefTime` / `user.wrapTime` for per-user firing. Tz-correct. |

### Tier 3 — `setDate`/`setHours`/`getDate` sites (potential server-local landmines)

Grep returned these. Audited each:

| Site | File:line | Server-local risk? |
|---|---|---|
| `cutoff.setDate(cutoff.getDate() - 30)` | `outlookCalSync.cjs:116` | **No.** 30-day cutoff is coarse — ±1-day drift across DST is no-op user-visible. |
| `cutoff.setDate(cutoff.getDate() - 30)` | `proxy-server.cjs:627` | **No.** Same pattern, calendar_events purge. |
| `d.setDate(d.getDate() + i)` weekMap loop | `buildAgenticContext.cjs:408` | **No.** Each Date is then formatted via `Intl.DateTimeFormat({ timeZone: tz, ... })`, so the day labels render in user-tz regardless of how the Date is constructed. |
| `new Date(now.getFullYear(), now.getMonth(), now.getDate())` | `tools.cjs:1199` | **Marginal.** `_resolveDateRange` for `search_inbox`. Computes "today" as server-local midnight, then `.toISOString()` ships as UTC instant. For inbox search with `dateFrom: 'today'`, a user querying near local midnight could see a different window than they expected. Not user-language-visible — `search_inbox` is an internal tool — but worth flagging for the Phase 2 memory work which may consume `search_inbox`-style ranges. |
| Various `gcal.cjs` window math | `gcal.cjs:319-336, 445` | **Marginal.** Lines 322-331 (the `timeZone` branch) is correctly user-tz-anchored. Lines 333-336 (the fallback when no `timeZone` param is provided) use server-local midnight. **All current callers pass `timeZone`**, so the fallback is dead path in practice. Code health note, not an active bug. |
| `nextDay.setDate(nextDay.getDate() + 1)` for all-day events | `gcal.cjs:216, 445` | **No.** All-day event end-date convention; date-only, no time component. |

### Tier 4 — Time-aware infrastructure Phase 2 surfaces will inherit

These are the substrate Phase 2 features ("when-to-leave", proactive surfacing, memory-triggered nudges, Daily Wrap enrichment) will ride:

| Component | Status | Note for Phase 2 |
|---|---|---|
| `scheduled_alerts` table + cron | Healthy except render template | Reuse pattern is sound. **Pre-rendering at scheduling time is fragile** — see "Architectural recommendation" below. |
| `pending_close_loop` queue + cron | Healthy | Triggers at event end; render happens at consumption time, not schedule time. |
| Morning brief / Daily Wrap cron | Healthy (post `7c24218`) | Time-state computed at fire time from `user.timezone`. |
| `buildAgenticContext` calendar bucketing | Healthy | Bucketing done at request time, always against `user.timezone` `now`. |
| Server cron tick cadence | OK | Every minute, fires per-user when local HH:MM matches. |
| Render-time relative-date helper | **Missing** | No shared "render this future moment relative to now in user-tz" helper exists. Each render site re-implements (or omits) relative-date phrasing. |

---

## Severity Tagging

- **P0 — fix in Gap 5 commit**: `db.cjs:8652-8654` template. User-facing daily, single-line fix, no schema impact.
- **P1 — fix in same commit if scope allows**: Daily Wrap push template audit (`alerts.cjs::buildAndSendDailyWrap`). Same template family, likely same render-time-vs-schedule-time fragility. Investigate during fix.
- **P2 — flag for Phase 2 design, not Gap 5 scope**: pre-rendering messages at scheduling time. When a "1 day before" alert is scheduled, the message is rendered THEN, frozen, and shipped at fire time. If the task is edited between scheduling and firing (title change, date change), the alert message reflects the old state. Phase 2's "memory-triggered nudges" need to render at fire time, not schedule time, to be coherent. Re-architecture, not a Gap 5 fix.
- **P3 — code health**: `tools.cjs:1199` and `gcal.cjs:333-336` server-local midnight patterns. Dead fallback paths today. Worth a one-line `getTodayLocal` swap when next touched.

---

## Recommended Surgical Edit (Gap 5 fix scope)

**Single edit, single file, ~25-40 LOC.** No schema. No migration. No new helpers needed if we keep it tight.

### What to change

Rewrite `db.cjs:8635-8654` so the message template includes a relative-date qualifier computed from the `fireAt` → `dueDt` lead time in user-tz:

- **Lead time 0** → `"due now"`
- **Lead time < 6h same day** → `"due in N hours at <time>"`
- **Lead time = same calendar day in user-tz, > 6h** → `"due today at <time>"`
- **Lead time = next calendar day in user-tz** → `"due tomorrow at <time>"`
- **Lead time > 1 day, < 7 days** → `"due <Weekday> at <time>"`
- **Lead time ≥ 7 days** → `"due <Mon DD> at <time>"`

Relative-day comparison uses `Intl.DateTimeFormat('en-CA', { timeZone: tz, ... })` on `fireAt` vs `dueDt` to compute the user-local-date delta — same pattern already in use elsewhere in `db.cjs` and `contextRendering.cjs`.

### What to verify before cutting

1. **Daily Wrap push template** (`alerts.cjs::buildAndSendDailyWrap`). Same fragility risk — fold into Gap 5 commit if a similar template-pre-render bug exists, hold otherwise.
2. **Existing scheduled_alerts rows** are pre-rendered with the broken template. Those rows in flight WILL fire with the wrong message until consumed. **Two options:**
   - (a) Accept — the broken rows fire over the next ~24h, then the new code takes over. Acceptable at dogfood scale.
   - (b) Sweep — `UPDATE scheduled_alerts SET message = <re-render>` for unfired rows. More work; might be worth it depending on volume. Recommend (a) unless prod has >100 unfired rows queued.

### What NOT to change in this commit

- Pre-rendering at scheduling time (the P2 architectural concern). Phase 2 work.
- `tools.cjs:1199` and `gcal.cjs:333-336` server-local midnight (P3 code health).
- No relative-date helper extraction yet — Phase 2 will surface enough callers to justify it; one-off render-time logic in `scheduleTaskAlerts` is fine for now.

### Estimated LOC

- Template rewrite + relative-day helper inline: ~30-40 LOC in `db.cjs`
- If Daily Wrap audit surfaces a same-shape bug: +20-30 LOC

Single commit, single logical change.

---

## Open Questions for Lyle

1. **In-flight `scheduled_alerts` rows** — do we sweep + re-render, or let the broken messages drain naturally over ~24-48h? My recommendation is drain naturally at dogfood scale, but if you've seen >5 fires of this pattern over a few days, the queue might be larger than I'd guess.
2. **Daily Wrap push template** — want me to confirm whether it has the same shape during the fix-scope spec, or audit it now as part of this investigation?
3. **`tools.cjs:1199` `_resolveDateRange`** — Phase 2 memory work may consume `search_inbox` for fact retrieval over date windows. Want it tagged for fix during the memory work, or pulled into Gap 5?

---

## Footnote: prod-DB confirmation deferred

Sandbox declined three SELECT queries (users → tasks → scheduled_alerts) during investigation. Code-path analysis is deterministic on the symptom, so the diagnosis stands. If a prod query is wanted as belt-and-suspenders before the fix lands, the query is documented above (`scheduled_alerts` ILIKE %escalade%). One row, ~10 seconds of psql, removes all uncertainty.

---

*End of findings. No code changed. Awaiting fix-scope spec from Lyle.*
