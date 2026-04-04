# Dizon.ai — Phase Tracker
Last updated: April 4, 2026

## Phase 0 — Feature Freeze (Current)
- [x] Multi-channel alerts (WhatsApp/Slack/Email)
- [x] App.jsx monolith extraction (1,499 lines)
- [x] Lazy loading (227kB bundle)
- [x] Multi-user hardening (requireOwnership, upsertTask, GCal userId)
- [x] CLAUDE.md + /docs structure
- [ ] WhatsApp two-way input — blocked on Aria's number
- [ ] Morning brief Railway cron (8am)
- [ ] Registration allowlist
- [ ] Inbox: Create Task from email item
- [ ] 12hr time format in briefs
- [ ] Mobile: Tasks tab blank fix
- [ ] Mobile: Aria chat two-column fix
- [ ] Mobile: Dashboard action pills overflow fix

## Phase 1 — Schema Migration
- [ ] oauth_tokens table
- [ ] integration_config table
- [ ] agent_memory table + logMemory() helper
- [ ] agent_tasks table
- [ ] agent_approvals table
- [ ] task_assignees table
- [ ] Backend extraction (routes/ middleware/ utils/)

## Phase 2 — Component Extraction
App.jsx → component tree. Exit: wc -l App.jsx < 250.

## Phase 3 — Agent Foundation
- [ ] logMemory() on all action handlers
- [ ] buildContext.js — getRelevantMemories() injected
- [ ] Agent router in Express
- [ ] agent_tasks logging
- [ ] agent_approvals on high-stakes actions
- [ ] ApprovalModule in frontend

## Phase 4 — Dynamic UI
- [ ] Decision Agent scoring function
- [ ] Module system
- [ ] Dashboard renders module array

## Phase 5 — Multi-User
- [ ] Allowlist registration
- [ ] Per-user OAuth verification
- [ ] Onboard Zac + Liz

## Phase 6 — Invite-Only Launch
- [ ] Staging environment
- [ ] Free/Pro/BYOK tier logic
