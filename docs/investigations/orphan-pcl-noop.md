# Orphan pending_close_loop Cleanup — Investigation Result: NO-OP

**Branch:** `dizon/orphan-pcl-cleanup` (off `51d36e7`)
**Date:** 2026-05-28
**Status:** Read-only investigation. No code change required.

## Conclusion

Zero orphan pending_close_loop rows exist in prod. The item is closed with no destructive cleanup needed.

## Diagnostic queries

Three queries against prod (read-only):

**1. Orphan event-pcl rows (source_id NOT in calendar_events):**

```sql
SELECT pcl.user_id, COUNT(*) AS n
FROM pending_close_loop pcl
WHERE pcl.source_type = 'event'
  AND pcl.resolved_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM calendar_events ce
    WHERE ce.id = pcl.source_id AND ce.user_id = pcl.user_id
  )
GROUP BY pcl.user_id
```

Result: empty set. Zero open event-pcl rows with missing parent.

**2. Cross-source orphan summary (event/task/project_task):**

```sql
SELECT
  SUM(CASE WHEN source_type='event' AND NOT EXISTS (...) THEN 1 ELSE 0 END) AS event_orphans,
  SUM(CASE WHEN source_type='task' AND NOT EXISTS (...) THEN 1 ELSE 0 END) AS task_orphans,
  SUM(CASE WHEN source_type='project_task' AND NOT EXISTS (...) THEN 1 ELSE 0 END) AS project_task_orphans,
  COUNT(*) AS total_open
FROM pending_close_loop pcl
WHERE resolved_at IS NULL
```

Result: `event_orphans=0, task_orphans=0, project_task_orphans=0, total_open=32`. None of the 32 currently-open rows are orphaned.

**3. Lyle's pcl resolution stats:**

```sql
SELECT
  COUNT(*) FILTER (WHERE resolved_at IS NULL AND dismissed_at IS NULL) AS open,
  COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved,
  COUNT(*) FILTER (WHERE dismissed_at IS NOT NULL) AS dismissed
FROM pending_close_loop WHERE user_id = 'user-lyle'
```

Result: `open=0, resolved=78, dismissed=6, total=78`. All 78 of Lyle's pcl rows are closed.

## Why expected orphans didn't materialize

The expectation was: Path C (`fa636ae`) plus Fix A (`6126f3b`) shipped on 2026-05-26 would clean up the stale calendar_events for the Standup Call series, leaving the corresponding pcl rows (97/98/99/etc) orphaned and visually noisy in close-loop.

Three factors prevented this:

1. **Lyle resolved all his pcl rows manually** on 2026-05-26 at 19:56:14 UTC (visible in the resolved_at timestamps clustered at that minute). The close-loop tile got cleared.

2. **Fix A operates only on the forward fetch window** (`localMidnightUtc(tz, 0)` to `localMidnightUtc(tz, 14)`). Past events — including the May 14/20/21 Standup Call instances that were causing the duplicate-display — are out of scope by design. They're handled by the 30-day end_time cutoff sweep at `proxy-server.cjs:625-627`.

3. **The stale calendar_events rows still exist** for those past Standup Call instances (synced_at frozen at 2026-05-08 / 2026-05-14), but they're not orphaning anything — their corresponding pcl rows are all resolved. They'll age out naturally on the 30-day cutoff.

## What this means for the broader pattern

The fix sequence yesterday (Path C SELECT-side dedup + Fix A forward-window sync cleanup) plus the user's manual close-loop dismissal organically converged on a clean state. No follow-up destructive write is required.

If future orphans accumulate (e.g. via a new code path that emits pcl rows pointing at non-existent calendar_events), the diagnostic queries above remain the right detection tool. The bounded DELETE would be:

```sql
DELETE FROM pending_close_loop
WHERE source_type = 'event'
  AND resolved_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM calendar_events ce
    WHERE ce.id = source_id AND ce.user_id = pending_close_loop.user_id
  );
```

Saved here for reference but NOT executed today (zero rows would match).

---

*No code changed. Branch retained as an artifact for the investigation trail. Recommend deleting the branch after this commit lands on a doc-repository if you want to keep the prod repo tidy.*
