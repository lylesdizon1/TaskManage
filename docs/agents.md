# Dizon.ai — Agent System
Last updated: April 4, 2026
Status: Planned (Phase 3)

## Aria — Orchestrator
Routes all input to sub-agents. Never executes directly.
Confidence threshold: < 0.7 → handle directly or ask clarifying question.

## Sub-Agents
| Agent | Tools | Approval Required |
|---|---|---|
| Task | createTask, updateTask, completeTask, assignTask | assignTask to another user |
| Email | readEmail, flagEmail, createInboxItem, createTaskFromInboxItem | None (read-only on Gmail) |
| Calendar | readEvents, createEvent, findAvailability, sendInvite | sendInvite, createEvent |
| Financial | logTransaction, categorizeTransaction, extractReceipt | None in v1 |
| Research | webSearch, summarize, compare, fetchUrl | None |
| Communication | draftEmail, sendSlack, sendWhatsApp | Always — never auto-send |
| Decision | rankModules, composeUI, learnPattern | Never — orchestration only |

## Approval Risk Tiers
- Low: Auto-execute after 10 min if no response
- Medium: 1-tap approve via WhatsApp ("1"/"2"). Expires 1hr.
- High: Always explicit. No expiry. Never auto-executes.

## Agent Pipeline
async function pipeline(normalizedInput) — sacred, do not rename

## Tables (Phase 1)
agent_memory, agent_tasks, agent_approvals — see /docs/schema.md
