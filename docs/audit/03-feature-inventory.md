# Feature Inventory (2026-05-28)

What Dizon.ai actually does today. Reference doc — read this when scoping new work to avoid duplicating what already exists.

---

## 1. By the numbers

| Layer | Count |
|---|---|
| Route files | 41 |
| HTTP endpoints (GET/POST/PUT/PATCH/DELETE) | 201 |
| Aria tools | 55 across 10 groups |
| Cron jobs | 13 active |
| DB tables | 73 |
| React panels | 11 (~13k LOC total) |
| Extractor pipelines (memory) | 5 (M1a, M1b, contact, journal, outcome) |
| Active-zone detectors | 10 |
| Outbound channels | 3 (WhatsApp, Slack, Email) |
| Inbound channels | 4 (WhatsApp, Gmail, Outlook, Email-to-note) |
| Live integrations | 6 (Gmail, GCal, Outlook, QuickBooks, Slack, WhatsApp) |

---

## 2. API surface (by domain)

201 endpoints across 41 route files. All require `authenticateToken` unless noted; mutations gated by `requireOwnership`.

| Domain | File | Endpoints | Notes |
|---|---|---|---|
| Auth | `auth.cjs` | 6 | login, register, invite redemption, refresh, password change, /me |
| Tasks | `tasks.cjs` | 6 | CRUD, bulk update, archive, restore, completion |
| Calendar | `gcal.cjs`, `outlook.cjs` | 20 | OAuth, event CRUD, calendars list, sync jobs, post-meeting notes |
| Inbox | `inbox.cjs` | 19 | CRUD, flag, archive, thread mgmt, classification feedback |
| Notes | `notes.cjs` | 14 | CRUD, categories, images, daily digest, email-to-note |
| Email send | `email.cjs` | 2 | test send, send via connected account |
| Chat/Aria | `chat.cjs`, `chatDraft.cjs`, `ariaDraft.cjs` | 13 | conversation CRUD, message stream, draft parse, execute w/ confirmation |
| Admin | `admin.cjs` | 30 | org/user CRUD, suspend, impersonate, audit log, memory purge (`requireSuperAdmin`) |
| Contacts | `contacts.cjs` | 12 | list, search, CRUD, notes, facts, context |
| Projects | `projects.cjs` | 18 | project/task/checklist CRUD, notes, members |
| Financial | `financial.cjs` | 10 | accounts, transactions, CSV import, summaries |
| **Food** (NEW today) | `food.cjs` | 7 | log, day, history, insights, photo, edit, delete |
| Dashboard/Alerts | `dashboard.cjs`, `alerts.cjs`, `activeZone.cjs` | 18 | morning brief, timeline, alert config, active-zone tiles |
| Entities | `entities.cjs` | 8 | org-scoped workspaces, member mgmt |
| Shared Access | `sharedAccess.cjs` | 4 | grant/revoke read-only scopes |
| Skills/Agents | `skills.cjs`, `agentActions.cjs` | 14 | skill CRUD, activation, sub-agent dispatch |
| Learning | `learnings.cjs` | 2 | list, delete (deprecated path) |
| Classification | `classification.cjs` | 6 | email rules, batch lookup, suggestion |
| Preferences | `preferences.cjs` | 3 | list, set, remove |
| Connections | `connections.cjs` | 5 | peer-to-peer invites |
| Outcomes | `outcomes.cjs` | 2 | log events, query decisions |
| Journal | `journal.cjs` | 4 | wrap CRUD, today, completion |
| Close-Loop | `closeLoop.cjs` | 4 | pending items, dismiss, resolve |
| QuickBooks | `quickbooks.cjs` | 5 | sync, accounts |
| Calendar notes | `calendar-notes.cjs` | 4 | pre/post meeting notes |
| Image blobs | `imageBlobs.cjs` | 1 | GET only (no upload endpoint yet) |
| Email cleanup | `emailClean.cjs` | 6 | policies, runs |
| Settings | `settings.cjs` | 5 | integrations, alert config |
| WhatsApp inbound | `whatsapp.cjs` | 1 | webhook (public — no JWT) |

---

## 3. Aria tool surface — 55 tools across 10 groups

Tools with `requires_confirmation: true` block execution until user approves via the confirmation gate.

### Tasks (5)
`create_task`, `complete_task`, `update_task`, `delete_task` ⚠️ confirmation, `search_tasks`

### Calendar (3)
`create_event`, `update_event`, `delete_event` ⚠️ confirmation

### Notes (3)
`create_note`, `search_notes`, `update_note` (image_blob_id param auto-gates)

### Communication (8)
`send_email` ⚠️ confirmation, `reply_email` ⚠️ confirmation, `archive_email`, `search_inbox`, `search_gmail`, `get_email_content`, `search_email_content`, `bulk_archive_emails`, `flag_email_as_crucial`, `move_email`

### People (7)
`list_contacts`, `get_contact`, `create_contact` (image_blob_id auto-gates), `update_contact`, `note_about_contact`, `list_shared_access`, `grant_shared_access` ⚠️ confirmation, `revoke_shared_access` ⚠️ confirmation

### Memory (1)
`remember_this` — explicit fact recall, persists at 0.9 strength

### Journal (6)
`create_journal_entry`, `list_journal_entries`, `get_today_close_loop_context`, `close_task_with_note`, `add_event_outcome_note`, `add_project_update_note`

### Skills/Agents (10)
`list_skills`, `create_skill`, `update_skill`, `pause_skill`, `delete_skill`, `activate_skill`, `start_sub_agent`, `get_sub_agent_result`, `kill_sub_agent`, `list_sub_agent_runs`

### Rules/Decisions (3)
`list_rule_proposals`, `accept_rule_proposal`, `reject_rule_proposal`

### Food (1, NEW today)
`log_food` — wraps estimate + persist; channel-aware source default

### Misc (2)
`capture_from_image` (vision), `web_search`, `set_preference`, `remove_preference`, `list_preferences`

---

## 4. Cron jobs (13 running)

| # | Schedule | Job | LLM? | Notes |
|---|---|---|---|---|
| 1 | `* * * * *` | Alert scheduler | No | Drains scheduled_alerts → WhatsApp/Slack/Email |
| 2 | `* * * * *` | Post-meeting note reminder | No (triggers downstream) | "Reply with outcomes" nudge |
| 3 | `* * * * *` | Morning brief | YES (Sonnet) | Per-user TZ check; Redis fast-path; once/day |
| 4 | `* * * * *` | Daily wrap | YES (Sonnet) | Per-user TZ check; startup catch-up |
| 5 | `0 * * * *` | Pending confirmations sweep | No | Expires old gates |
| 6 | `0 3 * * *` | Aria rule decay | No | Applies 0.95^days to behavior_rules |
| 7 | `0 4 * * *` | Stale classification sweep | YES (Haiku) | 20 emails/user/run cap |
| 8 | `*/15 * * * *` | GCal sync | No | Per-account, 14-day window |
| 9 | `*/15 * * * *` | Outlook sync | No (mail scan triggers Haiku) | Cal + mail on same tick |
| 10 | `*/15 * * * *` | QuickBooks sync | No | Rate-limited by Intuit |
| 11 | `*/30 * * * *` | Gmail token refresh | No | Keep tokens alive offline |
| 12 | `*/30 * * * *` | Proactive surfacer (P2b) | No (surfaces existing data) | INERT — needs `PROACTIVE_SURFACER_ENABLED=true` |
| 13 | Startup-only | Trust scores pre-warm | No | Seeds default matrix |

---

## 5. Database — 73 tables, grouped

### User & Auth
`users`, `organizations`, `org_members`, `org_links`, `invites`, `pending_whatsapp_verifications`

### Core data
`tasks`, `projects`, `project_tasks`, `project_notes`, `notes`, `note_categories`, `note_images`, `contacts`, `contact_identities`, `calendar_events`, `calendar_notes`, `journal_entries`, `food_log_entries` (NEW), `food_log_photos` (NEW), `entities`, `entity_members`

### Integrations
`user_integrations`, `gcal_tokens` (legacy), `gmail_config`, `entity_qb_connections`, `qb_snapshots`, `qb_transactions`

### Inbox & Classification
`inbox_items`, `email_classification_rules`, `email_classifications`, `classification_feedback`, `email_clean_policies`, `email_filing_patterns`, `inferred_classification_rules`, `user_email_labels`

### Alerts & User settings
`scheduled_alerts`, `fired_alerts`, `alert_cadence_config`, `active_zone_tiles`, `user_settings`, `user_preferences`, `user_preferences_v2`

### AI / Memory / Decisions
`agent_memory` (legacy), `memory_facts`, `behavior_rules`, `rule_proposals`, `decision_log`, `trust_scores`, `correction_events`, `outcome_records`, `outcome_signals`, `outcome_entities`

### Agents & Skills
`skills`, `skill_invocations`, `sub_agent_definitions`, `sub_agent_sessions`, `sub_agent_steps`, `sub_agent_findings`, `agent_actions`, `agent_approvals`, `agent_tasks`

### Conversations & Chat
`chat_conversations`, `chat_messages` (now with 3 FK constraints + CASCADE per today's CC persistence fix)

### Observability
`audit_log`, `admin_audit_log`, `shared_access_grants`, `pending_confirmations`, `proactive_dispatch` (NEW for P2b), `image_blobs`

### Other
`user_learnings` (deprecated), `connections`, `whatsapp_conversations`, `settings`

---

## 6. Frontend — 11 panels

| Panel | LOC | Purpose |
|---|---|---|
| DashboardPanel | 3,855 | Command Center, active-zone tiles, morning brief surface |
| InboxPanel | 2,962 | Email UI with classification, VIP rules, bulk actions |
| AgentsPanel | 1,597 | Skill editor, sub-agent dispatch, research monitor |
| CalendarPanel | 1,181 | 14-day multi-account view, outcome notes |
| NotesPanel | 821 | Note CRUD by pillar, search, images, daily digest |
| AdminPanel | 767 | Super-admin org/user CRUD, audit log |
| FoodPanel (NEW) | 572 | Meal log, macro ring, Aria insights, edit/delete |
| PeoplePanel | 412 | Contacts CRUD, facts, shared-access grants |
| ProjectsPanel | 396 | Entity-scoped projects, tasks, checklists, notes |
| ActivityPanel | 336 | Timeline of completions, creations, agent actions |
| SharedAccessPanel | 187 | View/revoke grants received |

---

## 7. Memory + extractor pipelines

| Pipeline | Trigger | Model | Gating |
|---|---|---|---|
| **M1a explicit recall** | `remember_this` tool | None (direct write) | Always on |
| **M1b conversation extractor** | Post-agentic-turn | Haiku | `MEMORY_EXTRACTOR_ENABLED=true` + 30s Redis debounce per user + quality gate (≥30 chars, not YES/NO) — **LIVE AS OF 2026-05-28** |
| **Contact fact extractor** | `note_about_contact` tool | Haiku | Always on |
| **Journal enrichment** | journal_entries with wins/frustrations populated | Haiku | `JOURNAL_ENRICHMENT_ENABLED` + 24h Redis debounce per entry |
| **Outcome enrichment** | decision_log row created | Haiku | Fire-and-forget |

**Recall path:** `getMemoryFactsForUserSmart` in `buildAgenticContext.cjs` — keyword-ranked, contact-aware. Renders LEARNED PATTERNS, FOOD LOG (NEW today), PEOPLE & RELATIONSHIPS, CLOSE-LOOP CONTEXT blocks into Aria's system prompt.

---

## 8. Proactive systems — 10 active-zone detectors

| # | Detector | Priority formula | Push-eligible? |
|---|---|---|---|
| 1 | overdue_tasks_batch | days × priority | No (CC tile only) |
| 2 | close_the_loops_batch | open count | No |
| 3 | upcoming_meeting_with_prep | time-to-event | No |
| 4 | meeting_just_ended | recency | No |
| 5 | pending_confirmation | always 95 | No |
| 6 | draft_resume | recency | No |
| 7 | daily_wrap_due | TZ window | No (separate cron) |
| 8 | critical_email_unacked | flagged count | No |
| 9 | single_urgent_task | always 90 | No |
| 10 | stale_relationship (P2b) | `min(100, 40 + 2*(days−30))` | **Yes** (only push-eligible) |

P2b surfacer cron iterates push-eligible candidates, but currently shipped INERT (`PROACTIVE_SURFACER_ENABLED=false`).

---

## 9. Integrations (per-user OAuth model)

All in `user_integrations` keyed by `UNIQUE(user_id, integration_type, account_email)`.

| Integration | Provider | Multi-account? | Tokens encrypted? | Sync |
|---|---|---|---|---|
| Gmail | google | ✅ | ✅ | On-demand + token refresh every 30 min |
| GCal | google | ✅ | ✅ | Every 15 min (14-day window) |
| Outlook (mail + cal) | microsoft | ✅ | ✅ | Every 15 min (calendar) |
| QuickBooks | intuit | Per-entity | ✅ | Every 15 min |
| Slack | slack | System-wide webhook only | ⚠️ NOT encrypted (S8 in security doc) | Outbound only |
| WhatsApp | UltraMsg | System-wide creds | N/A | Webhook inbound + REST outbound |

System-wide env-var creds: `CLAUDE_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_*`, `ULTRAMSG_*`, `RESEND_API_KEY`, `SLACK_WEBHOOK_URL`, `OUTLOOK_CLIENT_*`.

---

## 10. Feature flags (currently active)

| Flag | Default | What it does | Status |
|---|---|---|---|
| `MEMORY_EXTRACTOR_ENABLED` | false | Activates M1b conversation-turn extractor | **TRUE in prod as of 2026-05-28 AM** |
| `PROACTIVE_SURFACER_ENABLED` | false | Activates P2b surfacer cron | false (needs role-tagged contacts first) |
| `JOURNAL_ENRICHMENT_ENABLED` | false | Activates journal Haiku enrichment | Status unknown — check Railway env |

---

## 11. Recent work (last 14 days)

| Date | Commit shape | Purpose |
|---|---|---|
| 2026-05-28 | feat(food) C1/C2/edit + fix(food) context | Food log V1 end-to-end |
| 2026-05-28 | fix(chat) — 3 FK constraints | CC persistence structural fix (D+B+C+A+followup) |
| 2026-05-28 | feat(proactive) P2b scaffold | Surfacer cron + stale_relationship (shipped inert) |
| 2026-05-28 | feat(memory) M2 smart recall | Query-aware fact ranking |
| 2026-05-27 | docs(specs) P2 lock | Proactive surfacing decisions locked |
| 2026-05-26 | feat(people) Commit B | People CRM via business card OCR |
| 2026-05-21 | feat(memory) M1b | Conversation-turn extractor (shipped inert) |

Plus: close-loop date label fixes, calendar dedup, GCal stale event cleanup, alert relative-day qualifier.

---

## What does NOT exist yet (commonly-asked)

- **Voice / SMS inbound** — schema room exists; no implementation
- **Per-user Slack OAuth** — only system-wide webhook
- **Chrome extension** — minimal scope spec exists, deferred behind OCR + memory + Twilio
- **Mobile app** — parked indefinitely (WhatsApp covers the mobile surface)
- **POST /api/image-blobs** — only GET exists; desktop image upload blocked
- **Twilio migration** — only untouched P1; UltraMsg still in prod
- **Per-user daily token budget** — see cost doc
- **Memory write-loop tools** (`confirm_fact`, `retire_fact`) — would close the M2 → V2 loop
- **`memory_fact_followup` detector** — deferred to V2 per spec §3.2
- **Aria @ mailbox** — spec locked; engine extensions prerequisite done; not built
