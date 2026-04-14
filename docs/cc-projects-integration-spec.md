# Command Center Projects Integration Spec
*Authored by Ray — April 14, 2026*

---

## Core Principle

Projects are NOT a separate product surface. They are a structured context layer inside Command Center.

Command Center remains the primary interface, execution surface, and intelligence layer. Projects enhance it by providing structured state.

---

## Context Builder Integration

New parallel fetches in buildAgenticContext:
- activeProjects
- openProjectTasks
- recentProjectNotes

Inject into system prompt:

```
ACTIVE PROJECTS
- {project_title} ({entity}): {status_summary}

PROJECT TASKS
- open tasks grouped by project
- checklist progress (x/y complete)

PROJECT NOTES
- recent notes (summarized, not raw dump)
```

All data entity-scoped and respects membership.

---

## Entity-Aware Behavior

When entity is selected:
- Prioritize that entity's projects
- Surface relevant tasks and blockers

When no entity selected:
- Prioritize recently touched projects
- Highlight incomplete work across entities

---

## Command Center UI Surfaces

Context cards following existing patterns:

- Project Status Card: "Release v0.9 QA — 3 of 5 tasks complete"
- Blocked Task Card: "Mobile dashboard testing still open"
- Checklist Progress Card: "Camping Gear — 4 of 6 packed"
- Recent Note Card: "Zac noted retry text unclear on iPhone"

---

## Aria Action Layer

Aria supports:
- Create project → ProjectDraftTile
- Create task → TaskDraftTile (reuse existing)
- Create checklist items → ChecklistDraftTile (lightweight)
- Add note → direct write
- Complete task → with checklist warning
- Toggle checklist item

---

## Draft Tile Integration

- ProjectDraftTile (new)
- TaskDraftTile (reuse existing pattern)
- ChecklistDraftTile (lightweight, batch creation)

User confirms before write. Consistent with existing CC flows.

---

## Still Open Integration

Extend "Still Open" context cards:
- "Release QA still has 2 open tasks"
- "Camping project still needs food and gas"

Roll up: project → tasks → checklist

---

## Completion Behavior

- Checklist items → update task progress
- Task completion allowed anytime, warn if checklist incomplete
- All checklist items complete → suggest completing task
- All tasks complete → suggest completing project
- Do NOT auto-complete in V1

---

## Morning Brief Integration

Include project summaries concisely:
- "Careific QA is 60% complete"
- "Camping project has 3 items left"

---

## Notes + Intelligence

Notes should be:
- Summarized into context
- Referenced by Aria
- Used to detect blockers

Aria answers:
- "What's blocking this project?"
- "What issues were noted?"

---

## Implementation Order

1. Context builder integration
2. Basic cards
3. Aria actions
4. Draft tiles
5. Still Open integration
6. Morning brief updates

---

## Success Criteria

"Are we ready?" → Aria answers correctly.

That is success.
