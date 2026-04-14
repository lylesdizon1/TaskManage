# Aria Prompt Patterns & Tool Calls — Projects V1
*Authored by Ray — April 14, 2026*

---

## Core Aria Principle

Aria treats project content as structured execution context inside an entity workspace.

Aria SHOULD:
- Understand project hierarchy
- Summarize progress clearly
- Ask for clarification only when needed
- Prefer the active entity when one is selected
- Stay lightweight and action-oriented

Aria should NOT:
- Behave like a heavyweight PM assistant
- Ask excessive follow-up questions
- Dump raw data unless asked

---

## Intent Categories

1. create_project
2. create_project_task
3. create_checklist_items
4. create_project_note
5. complete_project_task
6. toggle_checklist_item
7. summarize_project
8. summarize_entity_projects
9. identify_blockers
10. suggest_next_steps

---

## Entity Resolution Rules

Order:
1. Explicitly named entity in user request
2. Currently selected entity in Command Center
3. Most recently active entity if highly confident
4. Ask clarifying question only if ambiguity matters

---

## Project Resolution Rules

Order:
1. Explicit project title in message
2. Most recently touched/open project in active entity
3. Single active project if unambiguous
4. Ask only if multiple viable matches exist

---

## Prompt Patterns

### Create Project
Examples: "Create a camping project", "Set up a QA project for Zac"
Response: "I drafted a new project for Careific: Release v0.9 QA. I can also add starter tasks if you want."
Tool path: parse intent → ProjectDraftTile → confirm → create_project

### Create Task
Examples: "Add a task to test the mobile dashboard"
Response: "I drafted a task under Release v0.9 QA: Test mobile dashboard."
Tool path: parse intent → resolve project → TaskDraftTile → confirm → create_project_task

### Create Checklist Items
Examples: "Add checklist items for camping gear: tent, cooler, lantern"
Response: "I drafted 4 checklist items under Test mobile dashboard."
Tool path: parse intent → resolve task → ChecklistDraftTile → confirm → batch create

### Add Note
Examples: "Add note: retry text is unclear on iPhone"
Response: "Added that note to Test mobile dashboard."
Tool path: parse intent → resolve project/task → write note

### Summaries
Examples: "What's left in the camping project?", "Summarize the release QA project"
Response shape: one-line status + 2-4 key open items + blocker callout if relevant
Example: "Camping Project is almost done. Gear is mostly packed, booking is complete, but food and gas are still open."

### Blockers + Next Steps
Examples: "What's blocking Zac?", "Any blockers in the release project?"
Example: "Main blocker is mobile dashboard QA. Zac's notes mention retry text confusion on iPhone and Safari inconsistency. Next best move is to verify the retry state."

### Completion
Rules: warn don't block on incomplete checklist/tasks
Examples:
- "Marked 'Tent' complete."
- "I can mark 'Test mobile dashboard' complete, but 2 checklist items are still open."
- "This project still has 1 open task. Mark complete anyway?"

---

## Tool Call / Route Mapping

| Tool | Route |
|---|---|
| create_project | POST /api/projects |
| update_project | PUT /api/projects/:id |
| delete_project | DELETE /api/projects/:id |
| create_project_task | POST /api/project-tasks |
| update_project_task | PUT /api/project-tasks/:id |
| complete_project_task | POST /api/project-tasks/:id/complete |
| create_task_checklist_items | POST /api/task-checklist-items |
| toggle_task_checklist_item | POST /api/task-checklist-items/:id/toggle |
| create_project_note | POST /api/project-notes |
| list_projects_for_entity | GET /api/projects?entity_id=... |
| list_open_project_tasks | GET /api/projects/:id/tasks |
| list_recent_project_notes | GET /api/project-notes |

---

## Command Center Card Patterns

- Project Status Card: title, % complete, entity badge
- Blocked Task Card: task title, short blocker summary, project reference
- Checklist Progress Card: task title, x/y complete
- Recent Note Card: short note preview, linked project/task
- Still Open Card: "2 tasks still open in Release v0.9 QA"

---

## Morning Brief Patterns

Include project rollups only when relevant:
- "Careific Release QA is 60% complete with 2 tasks still open."
- "Camping Project still needs food and gas."
- "Rose Motorcars has 1 blocked workspace task."

---

## Context Builder Blocks

```
ACTIVE PROJECTS
- {project_title} ({entity_name}): {open_tasks} open, {completed_tasks} done

PROJECT TASKS
- open tasks grouped by project
- checklist progress (x/y complete)

PROJECT NOTES
- recent notes summarized (not raw dump)
```

Rules:
- Prefer active entity
- Cap volume
- Include only relevant recent/open items
- Never bloat prompt with raw notes

---

## Guardrails

- Do not over-ask clarifying questions
- Do not dump raw project/task/note data
- Do not create a separate heavy PM module
- Do not introduce role-based SQL branching
- Do not broaden permissions beyond entity membership
- Keep actions lightweight and consistent with existing draft tiles

---

## Success Criteria

Users can naturally say:
- "Create a QA project for Zac" ✓
- "Add subtasks for the mobile dashboard test" ✓
- "What's left in camping?" ✓
- "What's blocking this release?" ✓
- "Summarize open work in Careific" ✓

...and Aria handles cleanly with minimal friction.
