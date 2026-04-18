# Inbox V2 — Product Spec
**File:** docs/inbox-v2.md
**Status:** Ready for build
**Author:** Lyle Dizon / Claude
**Date:** April 16, 2026

## Overview

The Dizon.ai Inbox is not a full email client —
it's an intelligent triage layer. The goal is to
surface what matters, let users act quickly, and
never require opening Gmail/Outlook for anything
routine. V1 ships ambient classification. V2 adds
search, history, actions, and thread UX.

## Core Principle: Native Email Organization

Dizon.ai does not build a custom folder/label
system. Gmail Labels and Outlook Folders are
first-class signals — ingested, mapped, learned
from, and acted on. Users have spent years
organizing their email. Aria learns from that
behavior rather than asking them to start over.

## V1 Current State (what exists)

### Ingestion
- Gmail scan via 15-min cron (3 accounts)
- Outlook scan via 15-min cron (1 account)
- Manual Scan Now button in Settings
- Configurable scan window (Last 24hrs default)
- Configurable scan frequency (Every hour default)

### Classification (AI)
- Needs Attention / For Review / Low Priority / Read
- Financial tag, VIP sender flagging
- Keyword trigger detection
- Commitment detection (Chrome extension)
- Auto-exclude no-reply senders toggle

### List View
- Grouped by classification section
- Collapsible sections with count badges
- Sender name + subject + snippet preview
- Timestamp, account tag, category tag chips
- Unread indicator (colored dot)
- All / Unread / Action Required tab filter
- Account dropdown filter
- AI summary card ("4 emails need your attention")

### Thread Detail View
- Full subject line (wraps on mobile)
- Sender name + avatar (initials)
- Full email body (sanitized HTML render)
- Google Meet / calendar event rendering
- RSVP buttons for calendar invites
- Meeting link, When/Location/Guests display

### Aria Integration
- Aria has inbox context (flagged emails, commitments)
- Aria can answer "what needs my attention?"
- Aria can create tasks from email content

### Settings
- VIP Senders, Trigger Keywords, Excluded Senders
- Auto-exclude no-reply toggle
- Commitment Detection toggle
- Scan Frequency + Window dropdowns

## V2 Goals

1. Search — find any email without leaving Dizon
2. Pagination — browse like a real email client
3. Label/Folder awareness — native Gmail/Outlook org
4. Actions — archive, mark read, move, star
5. Behavioral learning — learn filing patterns
6. Thread UX — attachments, reply deep link

---

## Feature 1: Email Search

### User Story
"I remember getting an email from Paul about
Railway config. I need to find it without
going to Gmail."

### UX
- Search bar always visible at top of Inbox
- Placeholder: "Search emails..."
- Triggers on Enter or 400ms debounce
- Results replace thread list with
  "Search results for X" header + clear button
- Empty state: "No emails found for X"

### Search Scope
- Subject line, sender name + email, body snippet
- Across ALL connected accounts by default
- Respects current account filter dropdown

### Backend
GET /api/inbox/search?q=X&account=all

Query: SELECT * FROM inbox_items WHERE
  user_id = $1 AND (
    subject ILIKE '%' || $2 || '%'
    OR sender_email ILIKE '%' || $2 || '%'
    OR sender_name ILIKE '%' || $2 || '%'
    OR snippet ILIKE '%' || $2 || '%'
  )
  ORDER BY received_at DESC
  LIMIT 50

Returns same shape as existing inbox list.
No new tables needed.

### Phase
Phase 1 — highest priority

---

## Feature 2: Pagination

### User Story
"I want to browse my emails like a real
email client — see my latest 25, go to
the next page."

### UX
- Default: 25 most recent emails
- Bottom of list: ← Previous | Page 1 of N | Next →
- "Showing 1–25 of 847 emails"
- On mobile: simplified Prev / Next only
- Loading state while fetching historical pages

### Backend
GET /api/inbox/items?page=1&per_page=25&account=all

Returns:
{
  items: [...],
  total: 847,
  page: 1,
  per_page: 25,
  total_pages: 34,
  has_next: true,
  has_prev: false
}

For pages beyond what's in DB:
→ trigger on-demand Gmail/Outlook fetch
→ store results in inbox_items
→ return when complete

### Phase
Phase 1 — alongside search

---

## Feature 3: Label/Folder Ingestion + Mapping

### Ingestion
Gmail: fetch labelIds on each message +
  full label list via GET /gmail/v1/users/me/labels

Outlook: fetch parentFolderId on each message +
  folder hierarchy via GET /me/mailFolders

New table: user_email_labels
  id, user_id, account_email, provider
  label_id, label_name, semantic_category
  confidence, message_count
  last_seen_at, created_at, updated_at

### Semantic Mapping (Haiku)
Single Haiku call on first label ingest.
Maps label names to semantic categories:
finance, legal, clients, vendors, personal,
team, receipts, newsletters, notifications,
travel, hr, projects, archive, other

Redis debounce: label-map:{userId} at 7d TTL.

### Aria Context Block
buildLabelsBlock(userId):
  ### EMAIL LABELS ###
  [Label Name] → [semantic_category] (N messages)

Cap at 300 chars. Exclude 'other'/'notifications'.

### Phase
Phase 1 — alongside search + pagination

---

## Feature 4: Email Actions

### Actions (V2)
- Mark as read
- Archive
- Star/Flag
- Move to label/folder

### Actions (V3 — not this sprint)
- Reply from Dizon
- Forward

### UX
- Swipe left on thread row (mobile) →
  Archive + Mark Read buttons
- Desktop: hover → action buttons (group-hover)
- "Archived" toast confirmation

### Backend
POST /api/inbox/:id/archive
POST /api/inbox/:id/mark-read
POST /api/inbox/:id/star
POST /api/inbox/:id/move
  body: { targetLabelId,
    scope: 'thread'|'sender'|'domain',
    createPattern: bool }

Gmail: users.messages.modify
Outlook: PATCH /me/messages/:id

New columns on inbox_items:
  archived_at TIMESTAMPTZ
  starred_at TIMESTAMPTZ
  user_classification TEXT

### Phase
Phase 2

---

## Feature 5: Behavioral Learning

### Filing Pattern Detection
New table: email_filing_patterns
  id, user_id, account_email
  match_type ('sender'|'domain'|'subject')
  match_value
  target_label_id, target_label_name
  confidence (0.0–1.0, starts 0.5)
  times_applied, last_applied_at
  user_approved (bool)
  created_at, updated_at

### Confidence Building
- First filing: 0.5
- Same pattern 3x: 0.8
- Same pattern 5x: 0.95
- Aria suggests automation at 0.8+

### Aria Suggestion (at 0.8+)
"I've noticed you always file emails from
@rosemotorcars.com into Rose. Want me to
do that automatically?"

User approves → user_approved = true
→ future emails auto-filed

### Phase
Phase 2

---

## Feature 6: Aria Label Awareness

### Natural Language References
User: "Anything from Careific I should know?"
Aria: "You have 3 unread in your Careific
label — one from Zac about native cal dev,
flagged Needs Attention."

### Label-Informed Prioritization
- Email in 'clients' label → bump priority
- Email in 'newsletters' from VIP → still flag
- Email in 'legal' label → always surface
  in morning brief if unread

### DECISION_INSTRUCTIONS addition
"You have access to the user's Gmail labels
and Outlook folders in the EMAIL LABELS block.
- Reference labels by name when discussing emails
- Prioritize unread in high-signal labels
  (clients, legal, finance)
- Suggest where to file using existing labels
- When you notice a filing pattern, suggest
  automation via suggest_filing_pattern tool"

### Phase
Phase 2

---

## New Aria Tools (Email Organization)

1. list_email_labels
   — List user's labels/folders with counts
   — input: {}

2. move_email
   — Move email to label/folder
   — input: { inbox_item_id, target_label_id,
     scope: 'thread'|'sender'|'domain',
     create_pattern: boolean }

3. suggest_filing_pattern
   — Suggest automatic filing rule
   — input: { match_type, match_value,
     target_label_id, target_label_name }

4. approve_filing_pattern
   — Approve auto-filing rule
   — input: { pattern_id }

---

## Separation of Concerns

### Organization state (labels/folders)
→ user_email_labels + email_filing_patterns
→ Synced from Gmail/Outlook
→ Never replicated into Dizon custom structure

### Execution state (tasks, follow-ups)
→ tasks, pending_close_loop
→ Dizon-native, not tied to labels
→ Label context informs but doesn't drive tasks

An email can be:
- Filed in Gmail "Legal" label (org state)
AND
- Have a task "Sign sublease amendment" (exec state)
Both exist independently.

---

## Build Order

### Phase 1 (this sprint)
1. Email search (GET /api/inbox/search)
2. Search UI in InboxPanel
3. Pagination (25/page, GET /api/inbox/items)
4. Pagination UI (Prev/Next controls)
5. Label/folder ingestion + storage
6. Semantic mapping via Haiku
7. Labels in Aria context block

### Phase 2 (next sprint)
8. list_email_labels + move_email Aria tools
9. Thread detail: Move to action
10. Behavioral pattern detection
11. Filing pattern suggestions from Aria
12. Reply in Gmail/Outlook deep link
13. DOMPurify for email body rendering
14. Attachment display
15. Swipe actions on mobile

### Phase 3 (following sprint)
16. Auto-filing after user approval
17. approve_filing_pattern tool
18. Scope-based bulk actions (sender/domain)
19. Receipt section + spend summary
20. Aria-initiated filing suggestions

---

## Out of Scope (V2)

- Full email compose from Dizon
- Contact sync from email
- Email templates
- Bulk select actions
- Push notifications (covered by WhatsApp)
- Email scheduling / snooze
- Custom Dizon folder system
