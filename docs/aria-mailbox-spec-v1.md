# aria@dizon.ai — Aria as a First-Class Email Participant
*V1 spec — drafted 2026-05-06 from CC session. Multi-day implementation; this doc is the contract.*

## Context

Today Aria operates as the user's chat-and-tool agent. Email is something the user has; Aria reads it. The next leap is making Aria **a first-class email participant** with her own address: `aria@dizon.ai`. People can email Aria directly. Services can be subscribed at her address. The user delegates inbound triage and outbound drafting to her in a structured way.

This was the "Phase 2 capability" called out in `docs/decisionEngine-extensions-v1.md` as gated on the engine work. Engine work shipped (`bc2c464` … `0908b16`). Rule-proposal flow shipped (`367af97` … `7e7e6ab`). The autonomy guardrails are now real. Time to use them.

The spec is V1 — minimum viable, scoped to one user (Lyle), one provider (Gmail/Google Workspace), and explicit confirm-before-send. V2 hooks called out where relevant but not in V1 scope.

## Goals (V1)

1. **Inbound:** Aria has an inbox that receives mail addressed to `aria@dizon.ai`. New mail flows through the existing classification pipeline. The user sees Aria's inbox alongside their own.
2. **Outbound:** Aria can send mail FROM `aria@dizon.ai` via the existing `send_email` tool with an optional `from` parameter. Always confirm before send (V1).
3. **Triage:** When new mail arrives at aria@, Aria summarizes/classifies and surfaces a one-line digest in the user's inbox UI + Active Zone tile (when noteworthy).
4. **Drafts:** Aria can draft replies to aria@ messages and queue them as `pending_confirmations` for user approval. No autonomous outbound in V1.
5. **Identity:** aria@ is the **user's agent**, not a separate user. Same `user_id` scope. Tasks/calendar/contacts/preferences all shared. Aria signs replies as "Aria, for Lyle."

## Non-goals (V1 — explicitly deferred)

- **No autonomous outbound.** Even when behavior_rules permit it, V1 always gates outbound from aria@ via `pending_confirmations`. Relaxation comes in V2 once the trust loop has data.
- **No multi-user aria@.** Single user (Lyle). V2 = aria@ per organization or per shared workspace.
- **No alternative providers.** Gmail only. Outlook/Microsoft 365 in V2.
- **No inbound auto-RSVP.** Calendar invites surface to user; user's existing calendar tools handle the actual RSVP.
- **No cross-account threading visualization.** aria@'s threads live in the same `inbox_items` table tagged with `account_email='aria@dizon.ai'`. No special UI visualization in V1.
- **No content filter rules specific to aria@.** Existing `email_classification_rules` apply uniformly.

## User stories

| As Lyle, I want to… | So that… |
|---|---|
| Subscribe to newsletters at aria@ instead of my main inbox | My primary inbox stays clean and Aria does the digest |
| Forward a meeting request to aria@ | Aria surfaces it for me to RSVP without it cluttering my inbox |
| Send an email "from Aria" to a vendor | The vendor knows it's an assistant communication, with reply-to me |
| See a single Active Zone tile when mail comes in for Aria | I know to glance at her inbox without manually checking |
| Have Aria draft a reply to an aria@ message | I review and approve, no surprise sends |
| Ask "what came in for you today?" | Aria summarizes her inbox in one turn |

## Architecture

### Inbound path

```
External sender → SMTP → Gmail (aria@dizon.ai inbox)
                              ↓
                       existing GCal/Gmail */15 cron sync
                              ↓
                       gmailScan + classifyEmail (existing)
                              ↓
                       inbox_items (account_email='aria@dizon.ai')
                              ↓
                       Active Zone detector → tile (existing pipeline,
                                                   tagged for "aria mailbox")
```

V1 reuses the existing Gmail integration verbatim. aria@ is just another `user_integrations` row with `type='gmail'` and `account_email='aria@dizon.ai'`. The `*/15` cron picks it up. `classifyEmail` runs against incoming messages exactly like any other inbox.

**One new column:** `user_integrations.is_aria_inbox BOOLEAN DEFAULT FALSE`. Set true on the aria@ integration row. Used by the Active Zone tile composer + send_email tool to identify the aria mailbox without string-matching the email address.

### Outbound path

```
User: "Aria, ask Bob about the proposal"
   ↓
Aria runs: send_email(from='aria@dizon.ai', to='bob@x.com', subject=…, body=…)
   ↓
ALWAYS_CONFIRM gate (existing) → pending_confirmations card
   ↓
User approves → executeTool sends via Gmail API on aria@'s OAuth tokens
   ↓
Sent message appears in aria@'s Gmail Sent folder (preserves audit trail)
```

**Tool change:** `send_email` and `reply_email` gain an optional `from` parameter (existing tools accept `account_email` already; rename or alias for consistency). Default = the user's primary Gmail account. Explicit `from='aria@dizon.ai'` routes through aria@'s OAuth tokens.

**Reply-To header:** outbound from aria@ sets `Reply-To: lyle@dizon.ai` so future replies route to the user, not back to aria. Aria's inbox is for new conversations, not ongoing threads.

**Signature:** outbound from aria@ has a signature footer:
```
—
Sent by Aria, an AI assistant working with Lyle Dizon (aria@dizon.ai).
Reply directly to me at lyle@dizon.ai.
```
Tunable via a single `user_preferences_v2` key `aria_outbound_signature` (defaults to the above text).

### Identity & ownership

- aria@ is owned by `user_id='user-lyle'`. All `inbox_items`, `email_classifications`, `pending_confirmations` etc. are user-scoped as today.
- aria@'s OAuth tokens stored in `user_integrations.config_json.tokens` (existing pattern, encrypted via `crypto.cjs`).
- Cross-tenant safety: same as today's Gmail integration. The `requireOwnership` middleware already gates every endpoint by `user_id`. No new attack surface.

## Schema changes

| Change | Reason |
|---|---|
| `ALTER TABLE user_integrations ADD COLUMN IF NOT EXISTS is_aria_inbox BOOLEAN DEFAULT FALSE` | Identifies aria@ rows without string-matching the email address. Single nullable bool column. |
| `ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS via_aria BOOLEAN DEFAULT FALSE` | Tags items received at aria@ for UI filtering. Computed at sync time from `account_email` lookup. *(Optional — could derive at read time via JOIN on user_integrations.is_aria_inbox; column adds redundancy but speeds up the inbox-list query.)* |
| `user_preferences_v2['aria_outbound_signature']` | Tunable signature text. No schema change — uses existing key-value table. |
| `user_preferences_v2['aria_outbound_reply_to']` | Override for the Reply-To header (defaults to user's primary email). No schema change. |

That's it. No new tables.

## Tool surface

### Existing tools, modified

| Tool | Change |
|---|---|
| `send_email` | Add optional `from: string` param (defaults to user's primary Gmail). When `from` resolves to an aria_inbox integration, attach the aria signature + Reply-To header. |
| `reply_email` | Same `from` plumbing. Replies from aria@ on threads originally sent to aria@ stay scoped to that mailbox. |
| `list_email_labels` | Existing tool — no change needed. Already groups by `account_email` so aria@ shows up alongside other accounts. |
| `search_inbox` / `search_gmail` | Existing — already account-scoped via `account_email` param. |

### New tools

| Tool | Purpose |
|---|---|
| `aria_inbox_summary` | One-call summary of recent aria@ activity. Returns `{count_today, count_unread, top_threads: [...], action_items: [...]}`. Used when user asks "what came in for you today?". Read-only, no confirmation. |
| `aria_inbox_status` | Lightweight status check: is aria@ connected, last sync, recent error count. For health endpoint surfacing. |

Both new tools are intelligence-group, low-risk, no confirmation.

### Behavior rule expressivity

The existing engine extensions handle the known autonomy patterns:
- **Always confirm send_email from aria@** → already covered by `send_email` being in `ALWAYS_CONFIRM`.
- **Auto-allow sends to known contacts from user's primary** → behavior_rule with `external_recipients` (Ext 5). aria@ outbound stays gated regardless.
- **Higher trust floor for aria@** → could set `trust_floor_threshold = 0.7` per-user (Ext 3) and rely on per-action trust_scores. No aria-specific schema needed.

## Confirmation / autonomy model

V1 contract:

```
INBOUND  → autonomous classification + tile surface (no user gate)
OUTBOUND → ALWAYS confirm via pending_confirmations (4-char WhatsApp / chat card)
```

Open question for V2: does the user want aria@ outbound to RELAX based on accumulated trust? If user approves 50 aria@ sends in a row, should send #51 to a known contact auto-allow? Probably yes via behavior_rule, but not V1.

V1 hard floor: `send_email` from aria@ NEVER auto-allows. Even if every guardrail says ok. This is the same shape as `delete_event` today — irreversible-once-out-the-door, must confirm.

## Risk & safety

| Risk | Mitigation |
|---|---|
| Spam / phishing arriving at aria@ pulls Aria into bad context | aria@ goes through the same `classifyEmail` pipeline. v1.5 promo/newsletter heuristics already demote 99% of junk. Plus engine's content-aware tier (Tier 0) flags OTPs / financial. |
| Outbound impersonation: someone tells Aria to send something hostile from aria@ | ALWAYS_CONFIRM at outbound. User reviews every send. Plus the existing decisionEngine + behavior_rule layers (Ext 1-5) all apply. |
| Reply-loop: aria@ receives a reply to her own outbound, Aria auto-replies again | Reply-To header points at user's primary, not aria@. Aria's outbound never lands back in aria@'s inbox. |
| Calendar invite spam at aria@ | Existing classification handles. V1: surface to user, never auto-RSVP. |
| Privacy bleed: aria@ classification reveals user's tasks/calendar to a snooping sender | aria@ classification is server-side only; nothing in the email reply-text exposes context unless Aria explicitly drafts it (which the user reviews before send). |
| Domain hijack: someone spoofs aria@dizon.ai to send mail | DKIM/SPF/DMARC for `dizon.ai` (operational config, not code). |
| aria@'s OAuth refresh token rotation breaks sync | Existing Gmail token-saver path covers this. aria@ is just another integration row. |

## Phasing

### V1 (this spec — multi-day implementation)
- DNS + Google Workspace setup for aria@dizon.ai (operational, not code)
- OAuth onboarding flow: connect aria@ as a user_integrations row, mark `is_aria_inbox=true`
- Schema migrations (one bool column on user_integrations, optional one on inbox_items)
- `send_email` tool param: optional `from`
- New tools: `aria_inbox_summary`, `aria_inbox_status`
- Inbound flows through existing pipeline (zero new code on the sync path)
- Active Zone tile composer recognizes aria@ items and emits a dedicated tile when activity is noteworthy
- Aria system-prompt directive: "you have an inbox at aria@dizon.ai" + behavior contract (always confirm outbound, summarize on request)
- One-time migration to mark the user's existing Gmail accounts `is_aria_inbox=false` explicitly

### V2 (out of scope — captured for future)
- aria@ for orgs / shared workspaces (multi-user delegation)
- Alternative providers (Outlook, custom SMTP, Postmark-style inbound webhooks)
- Trust-loop-driven autonomous outbound (sends to known contacts auto-allow after threshold)
- aria@ separate identity model (own tasks/calendar, NOT user-scoped — multi-tenant rework)
- Inbound auto-RSVP for low-stakes meeting invites
- aria@ as a calendaring entity (book aria@ as an attendee, she handles availability)
- Public-facing aria@ on dizon.ai marketing site (the "talk to my AI" affordance)

## Open questions (need answers before implementation)

1. **Domain operational state.** Is `dizon.ai` already a Google Workspace domain? If not, that's a multi-day operational setup independent of code work. Confirm before scheduling.
2. **Signature wording.** Default proposal: "Sent by Aria, an AI assistant working with Lyle Dizon (aria@dizon.ai). Reply directly to me at lyle@dizon.ai." Tunable via preference key. Lyle's call.
3. **Default reply-to.** Spec says user's primary email. Should it be configurable per-recipient? V1 = global default; per-recipient override is V2.
4. **Active Zone tile shape.** Existing detectors pattern: `criticalEmailUnacked` + `closeTheLoopsBatch`. Add a `ariaMailboxActivity` detector that fires when N+ unread in last hour, or every threadid hits importance >= high. Threshold tunable.
5. **Outbound failure mode.** When the Gmail API rejects an aria@ send (rate limit, auth expired), how does the user see it? Today `send_email` failures surface as tool-error in chat. Same path; aria@ is no different.
6. **Onboarding UX.** Adding aria@ as an integration: standard OAuth flow OR special "connect Aria's mailbox" button in Settings? V1 = reuse existing Settings → Integrations → Add Gmail flow, with the connecting account naturally being aria@. Add a post-connect step that flips `is_aria_inbox=true` on the matching row.

## Implementation plan (sequenced punch-list)

Sized for execution. Each item is a single commit / PR target.

1. **Schema:** `user_integrations.is_aria_inbox BOOLEAN`, idempotent migration. Update `getUserIntegrations*` SELECTs. ~30 min.
2. **Gmail OAuth flow:** verify the existing flow accepts aria@dizon.ai as the connecting account; add a tiny post-connect hook that sets `is_aria_inbox=true` based on a server-side allow-list (just `aria@dizon.ai` for V1). ~1 hr.
3. **`send_email` tool:** add optional `from` param, plumb through to provider's send call. Validate `from` resolves to a connected integration. Add aria@ signature + Reply-To header injection when from is aria@. ~2 hrs.
4. **New tools:** `aria_inbox_summary`, `aria_inbox_status`. Backed by existing inbox helpers + a tiny aggregation. ~1 hr.
5. **Active Zone detector:** `detectAriaMailboxActivity(state)` in `candidateDetector.cjs`. Fires when aria@ has unread+important. Tile composer renders. ~2 hrs.
6. **System prompt directive:** new section in `buildAgenticContext.cjs` that tells Aria she has an inbox at aria@, lists the new tools, spells out the always-confirm contract. ~30 min.
7. **Tests:** `send_email` from-param unit tests, aria@ classification round-trip with seed, Active Zone detector test against fixture state. ~2 hrs.
8. **Operational setup (NOT code):** DNS, Google Workspace user creation, OAuth client config. Out-of-band but a hard prerequisite. ~few hours of console work.
9. **Smoke test:** send a real email to aria@, watch sync pick it up, verify classification + tile + Aria summary. ~30 min.

**Total code:** ~9-10 hours of focused work. Plus DNS/Workspace operational setup.

**Recommended sequencing:** ship items 1-4 first (gets the inbound + outbound paths working without UX), then 5-7 (UX + tile + tests), then 8-9 (production go-live). Items 1-4 can land before DNS is ready since the schema/code is operational without a real aria@ existing.

## Out-of-scope details captured for completeness

- **Webhook-based inbound.** Considered Postmark/SendGrid webhook for parsed inbound but rejected — Gmail-via-API reuses 100% of existing sync infra. Webhook would mean new parsing pipeline, new auth, new reliability model. V1 wants reuse.
- **Aria as calendar attendee.** Tempting but separate workstream — calendar identity ≠ email identity in our schema. Defer.
- **Outbound throttling.** Not in V1; trust-loop's rate limit (Ext 4) and the always-confirm gate together provide sufficient ceiling.
- **Aria reads emails to detect tasks/events automatically.** This is the existing classification pipeline applied to aria@. Already covered.
- **"Aria, write a reply for me" without showing the draft.** Anti-pattern — every outbound from aria@ shows the draft via the existing email-draft tile pattern. No headless drafting in V1.

---

*Filed by Claude on Lyle's behalf, 2026-05-06 evening session. Workstream owner: TBD. Engine prerequisites (Ext 1-5 + rule-proposal flow) shipped same session.*
