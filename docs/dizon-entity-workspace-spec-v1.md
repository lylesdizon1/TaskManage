# Dizon.ai Entity Workspace & Projects — V1/V2 Spec
*Authored by Ray — April 14, 2026*

---

## Core Idea

Each entity becomes a lightweight workspace. Inside each entity, users can create projects, tasks, checklist-style subtasks, and notes. Aria can reference all of it for summaries, blockers, next steps, and memory.

**This is not Asana. Keep it conversational, lightweight, and fast.**

---

## Product Framing

Lightweight, AI-native execution layer supporting both:
- Business collaboration (e.g. QA releases with Zac)
- Family coordination (e.g. Camping Project)

---

## Example Use Cases

**Business — Careific / Zac**
Project: Release v0.9 QA
Tasks: Test login flows, Test mobile dashboard, Test outcome capture, Review entity membership
Checklist under "Test mobile dashboard": verify active zone state, verify keyboard handling, verify retry state, verify notes save, verify loading speed
Notes: Active zone flickers on first load on iPhone. Retry text unclear after timeout.

**Family — Camping**
Project: Memorial Day Camping
Tasks: Gear, Food, Booking, Car prep
Checklist under "Gear": tent, sleeping bags, cooler, lantern, warm clothes
Notes: Lantern is in garage cabinet. Need to buy ice morning of. Reservation confirmation sent to Liz.

---

## V1 Scope

**Includes:**
- Projects scoped to an entity
- Tasks inside projects
- Checklist-style subtasks under tasks
- Notes attached to projects and tasks
- Shared visibility for all entity members
- Simple shared mutation rights for all entity members
- Aria access to project/task/subtask/note context

**Does NOT include:**
- Complex role systems beyond existing entity owner/member model
- Per-project permissions
- Per-task privacy
- Task dependencies
- Recurring project templates
- Advanced analytics

---

## V1 Data Model

```sql
projects (
  id, entity_id, title, description, 
  status CHECK ('active','completed','archived'),
  created_by, completed_at, created_at, updated_at
)

project_tasks (
  id, project_id, entity_id, title, description,
  status CHECK ('open','completed','cancelled'),
  created_by, completed_at, created_at, updated_at
)

task_checklist_items (
  id, task_id, entity_id, text, is_done,
  created_by, completed_at, created_at, updated_at
)

project_notes (
  id, project_id (nullable), task_id (nullable),
  entity_id, body, created_by, created_at, updated_at
)
```

**Model rules:**
- Every project belongs to one entity
- Every task belongs to one project and one entity
- Every checklist item belongs to one task and one entity
- Notes can belong to either a project or a task
- entity_id present on all records for clean scoping and indexability

---

## V1 Permission Model

Uses existing entity membership model.

- Entity owner → create, edit, complete, delete all project content
- Entity members → create, edit, complete, delete all project content
- Non-members → cannot see or mutate any project content
- Entity owner → still controls membership
- No special admin bypasses
- No per-project roles in V1

---

## V1 Behavior Rules

**Projects:** Can be marked complete manually. If all tasks complete, prompt user to mark project complete.

**Tasks:** Can be marked complete manually. If checklist items exist — warn (do not block) if incomplete items remain.

**Checklist items:** Simple checkbox model. Lightweight, not full tasks. Completing all items should visually suggest parent task is ready.

**Notes:** Contextual support. Aria can reference in summaries and status updates.

---

## V1 API Surface

```
Projects:
GET    /api/projects?entity_id=...
POST   /api/projects
PUT    /api/projects/:id
DELETE /api/projects/:id

Tasks:
GET    /api/projects/:projectId/tasks
POST   /api/project-tasks
PUT    /api/project-tasks/:id
DELETE /api/project-tasks/:id
POST   /api/project-tasks/:id/complete

Checklist items:
POST   /api/task-checklist-items
PUT    /api/task-checklist-items/:id
DELETE /api/task-checklist-items/:id
POST   /api/task-checklist-items/:id/toggle

Notes:
GET    /api/project-notes?project_id=... or task_id=...
POST   /api/project-notes
PUT    /api/project-notes/:id
DELETE /api/project-notes/:id
```

All routes must:
- Require auth
- Enforce entity membership
- Use canonical entity access helpers
- Avoid role-based SQL branching

---

## V1 Aria Behavior

Aria should be entity-aware and project-aware. She can:
- Summarize what is still open in a project
- Identify blockers from notes
- Explain why a project is not done yet
- Summarize work by member or by entity
- Generate a starter checklist for a new project

Example queries:
- "What is left for Zac on the release QA project?"
- "Are we ready for camping?"
- "Summarize blockers in the Careific mobile dashboard project"

**Context rules:** Aria only sees workspace content for entities the current user can access.

---

## V1 UI Shape

- Entity page / view → Projects list
- Inside project: tasks list, each task expandable, checklist items inline, notes section
- Status chips and lightweight progress indicators
- Fast add flows for: new project, new task, new checklist item, new note

---

## Recommended Build Order

1. Projects schema + CRUD
2. Tasks inside projects
3. Checklist items under tasks
4. Notes on project/task
5. Entity membership enforcement on all routes
6. Basic project/task UI
7. Aria context integration
8. V2: assignment, due dates, templates

---

## V2 Scope (future)

- Assignee on tasks and checklist items
- Due dates and priority
- Task templates / project templates
- Recurring projects
- Project progress percentage
- Aria-generated checklist templates
- Simple activity history
- Reusable project patterns learned from prior projects

## V2 Aria Upgrades

- Create project structures from a single prompt
- Auto-suggest subtasks from similar historical projects
- Identify likely missing steps
- Compare current project against past project patterns
- Draft status summaries for the group
- Suggest next actions when a project stalls

---

## Key Decisions (locked)

1. Lightweight entity workspace, not heavyweight PM suite
2. Tasks and notes inside entity workspace are collaborative and visible to entity members
3. Checklist items remain lightweight in V1
4. Calendar event entity tags remain contextual only, not a sharing primitive
5. No complex permissions beyond entity owner/member model in V1

---

*Build V1 now. This extends the product from "remember things" to "help us get stuff done together." That is a much bigger and more differentiated product direction.*
