# CLAUDE.md — Dizon.ai Project Context
> Read this file at the start of every session. Do not skip it.
> Last updated: April 3, 2026

---

## 1. PROJECT OVERVIEW

**Dizon.ai** is a Life OS for high-performing multi-business operators.
- **Owner:** Lyle Dizon
- **Stack:** React/Vite (frontend) · Express (proxy-server.cjs) · PostgreSQL (db.cjs) · Railway (hosting)
- **Repo:** `lylesdizon1/TaskManage` · Branch: `dizon/v2-phase0`
- **Production URL:** `taskmanage-production-b1bd.up.railway.app`
- **Railway project:** `natural-abundance` (2/2 services: TaskManage + Postgres)

---

## 2. ENGINEERING RULES (NON-NEGOTIABLE)

1. **Diagnose before touching anything.** Use `sed -n` to read the relevant lines first.
2. **Surgical edits only.** `str_replace` one change at a time. Never paste full file contents back.
3. **Verify after every edit.** Run `wc -l src/App.jsx` and `tail -5` after every file write.
4. **One commit per logical change.** Never bundle unrelated changes.
5. **Build before push.** Run `npm run build` and confirm it passes before every `git push`.
6. **Spec behavior, not code.** When something is broken, describe what it should do — not how to implement it.
7. **Clean solution first.** Always recommend the correct long-term fix first. If offering a hack, label it explicitly with tradeoffs stated.
8. **Design before implementing.** Share a comp or spec before writing any UI code.
9. **No full JSX block dumps.** Ever.
10. **Commit and push after every extraction or fix.** Railway autodeploys from `dizon/v2-phase0`.

---

## 3. DEPLOYMENT

```bash
cd ~/TaskManage
git add -A
git commit -m "type(scope): description"
git push origin dizon/v2-phase0
```

Railway autodeploys on push. Wait ~60 seconds then verify at the Railway dashboard.

**Commit types:** `feat` · `fix` · `refactor` · `chore`

---

## 4. ARCHITECTURE MAP

### Frontend — `src/`

```
src/
├── App.jsx                          # ROOT — state, routing, AuthenticatedApp (~1,499 lines)
├── utils/
│   ├── auth.js                      # decodeJwtPayload, tokenExpiresSoon
│   ├── helpers.js                   # uid, escapeHtml, conditionDescription, getRuleScope, buildGroupedEntities
│   └── systemPrompt.js              # buildSystemPrompt (AI context builder)
├── constants/
│   └── colors.js                    # COLOR_PRESETS, AVAILABLE_COLORS, getEntityStyle, getTagStyle, PRIORITY_BORDER, PRIORITY_BADGE
├── components/
│   ├── icons/
│   │   └── Icons.jsx                # All icon components (GearIcon, XIcon, BellIcon, etc.)
│   ├── ui/
│   │   ├── TagPill.jsx              # Tag display component
│   │   └── ToastContainer.jsx       # Toast notification system
│   ├── alerts/
│   │   ├── alertUtils.js            # DEFAULT_ALERT_RULES, CONDITION_META, EMPTY_NEW_RULE, evaluateRule, buildEmailHtml, buildPlainTextAlert, runAlertRules
│   │   └── AlertsModal.jsx          # RuleRow + AlertsModal components
│   ├── chat/
│   │   └── ChatComponents.jsx       # chatDateGroup, ChatMessageThread, SlidingChatPanel, ChatTabPanel, UniversalPromptBar
│   ├── tasks/
│   │   ├── AddTaskForm.jsx          # Task creation form
│   │   ├── TaskCard.jsx             # Individual task display
│   │   └── FilterBar.jsx            # Task filtering UI
│   ├── modals/
│   │   └── QuickCaptureModal.jsx    # QuickCaptureModal, QuickCaptureFAB, CreateEventModal
│   └── settings/
│       └── SettingsModal.jsx        # Full settings modal (AI, Password, Email Intelligence, Entities, Users)
├── panels/
│   ├── DashboardPanel.jsx           # Main dashboard
│   ├── InboxPanel.jsx               # Email inbox + SkeletonBlock
│   ├── NotesPanel.jsx               # Notes, Tiptap editor, image handling, PILLAR_CONFIG
│   └── CalendarPanel.jsx            # Google Calendar integration
└── screens/
    └── LoginScreen.jsx              # Auth screen
```

### Backend — `proxy-server.cjs`

Key endpoints:
- `POST /api/alerts/morning` — morning brief → Slack + WhatsApp
- `POST /api/alerts/fire` — unified alert delivery (Slack, WhatsApp, Email, SMS stub)
- `GET /api/config/status` — returns which env vars are configured
- `POST /api/email/send` — Resend email delivery
- `POST /api/claude` — Claude API proxy
- `GET /api/gmail/*` — Gmail OAuth + inbox scanning

### Database — `db.cjs`

PostgreSQL via Railway. Key tables: users, tasks, notes, entities, financial_transactions (legacy — no longer used in UI).

---

## 5. ENVIRONMENT VARIABLES (Railway)

| Variable | Purpose |
|---|---|
| `SLACK_WEBHOOK_URL` | Slack incoming webhook |
| `ULTRAMSG_INSTANCE` | UltraMsg WhatsApp instance ID |
| `ULTRAMSG_TOKEN` | UltraMsg auth token |
| `ULTRAMSG_PHONE` | WhatsApp destination number |
| `RESEND_API_KEY` | Resend email API key |
| `RESEND_FROM_EMAIL` | Sender address (default: onboarding@resend.dev) |
| `ALERT_RECIPIENT_EMAIL` | Default alert email recipient |
| `JWT_SECRET` | Auth token signing key (permanent — never rotate without migration) |

---

## 6. DESIGN SYSTEM (LOCKED — DO NOT CHANGE)

- **Surface:** `#fbf8fe`
- **Sidebar:** `#f5f2fa`
- **Primary:** `#4f4dcf` / `#7777fa`
- **Headlines:** Plus Jakarta Sans
- **Body:** Manrope
- **Source of truth:** Stitch export — implement from comp HTML only

---

## 7. AI PERSONA SYSTEM

**Aria** is the primary router/executive assistant. Auto-routing (Phase 2C) is live:
- `TASK` / `CALENDAR` / `ENTITY` / `GENERAL` → Aria
- `FINANCIAL` → CFO persona
- `FAMILY` → Home persona
- `HEALTH` → Health persona
- `JOURNAL` → Life Coach persona

Context engine: 8k token budget. Slim helpers: `slimTask`, `slimNote`, `slimTransaction`, `slimEvent`.

---

## 8. ALERTS SYSTEM

**Delivery channels:** WhatsApp (UltraMsg) · Slack · Email (Resend) · SMS (stub — Twilio pending)

**Rule types:**
- `overdue` — per-task, time-bucketed cooldown by `remindIntervalHours`
- `due-in-hours` — per-task
- `high-priority` — daily
- `daily-digest` — once/session
- `morning-brief` — scheduled at `condition.time`
- `critical-mail` — hooks into Email Intelligence VIP senders + keywords
- `event-reminder` — calendar-based (built, not yet wired)

**Cooldown:** `firedAlertsRef` backed by `localStorage` key `dizon_fired_alerts`. Keys are time-bucketed: `rule::task::bucket` where `bucket = floor(Date.now() / intervalMs)`.

**All delivery routes through:** `POST /api/alerts/fire` with `{ message, channels, recipientEmail }`.

---

## 9. KNOWN ISSUES / TECH DEBT

| Issue | Priority | Notes |
|---|---|---|
| Gmail banner injection broken | High | Chrome ext content script not injecting into Gmail — likely `all_frames` manifest issue |
| Alerts interval pill not showing | Low | `remindIntervalHours` missing from DB-persisted rules — needs merge on load |
| Alerts not in Settings tab | Low | Bell icon in top nav should move inside SettingsModal as a tab |
| Email Intelligence not shown in Alerts | Low | Critical Mail rule has no UI to configure VIP senders from Alerts view |
| Bundle size >500KB warning | Medium | Needs Phase 6 lazy loading |
| SMS not implemented | Low | Twilio integration pending — stub silently skips |

---

## 10. PHASE TRACKER

### Phase 0 — Feature Freeze (MVP complete)

| Feature | Status |
|---|---|
| Morning brief Railway cron at 8am | ❌ Not started |
| Alerts config (multi-channel, per-rule) | ✅ Done |
| Registration allowlist | ❌ Not started |
| Inbox: Create Task from email item | ❌ Not started |
| 12hr time format in briefs | ❌ Not started |
| Gmail commitment detection tuning | ❌ Not started |

### Monolith Extraction

| Phase | Status | Result |
|---|---|---|
| Phase 1 — Zero-risk utils | ✅ Done | -232 lines |
| Phase 2 — Isolated UI | ✅ Done | -424 lines |
| Phase 3 — Chat + Tasks + Calendar | ✅ Done | -1,351 lines |
| Phase 4 — Delete Financials + Panels | ✅ Done | -1,910 lines |
| Phase 5 — Final components | ✅ Done | -2,078 lines |
| **Total** | ✅ **Done** | **-6,078 lines (80.2% reduction)** |
| Phase 6 — Lazy loading | ❌ Not started | Target: bundle <150KB |

### Multi-user Onboarding (post Phase 0)
Allowlist → per-user GCal OAuth → isolation smoke test → onboard Liz → onboard Zac

---

## 11. KEY DECISIONS LOG

| Decision | Rationale |
|---|---|
| UltraMsg over Twilio for WhatsApp | No-code, already working. Twilio when SMS needed. |
| Resend for email | Already integrated, working. |
| Deleted FinancialsPanel entirely | Not being used. Dead code removed. |
| Per-rule channel config (not global) | More flexible — morning brief Slack only, overdue WA+Email |
| `firedAlertsRef` backed by localStorage | In-memory only caused spam on every page reload |
| Extraction order: utils → UI → panels → modals | Risk-ascending — zero deps first, stateful last |
| No Cox/CDK data dependencies in BuyFlip | Zero Cox dependency is explicit constraint |
| FinancialsPanel removed | Feature scrapped, ~790 lines deleted |
| `apiFetch` not modified for auth | Other callers depend on current behavior — fix at call sites instead |

---

## 12. SESSION LOG

| Date | Summary | Final App.jsx |
|---|---|---|
| Apr 3, 2026 | Built multi-channel alerts (WA/Slack/SMS/Email), per-rule channels, re-notify intervals, localStorage cooldown. Full monolith extraction Phases 1–5. 80.2% reduction. | 1,499 lines |

---

## 13. NEXT SESSION PRIORITIES

1. QA Railway deploy from Phase 5 — click through every panel
2. Remaining Phase 0 items (pick one to start):
   - Morning brief Railway cron
   - Registration allowlist
   - Inbox: Create Task from email
   - 12hr time format
   - Gmail commitment detection tuning
3. Phase 6 lazy loading (after Phase 0 complete)
4. Backend rewrite with JSDoc documentation layer
