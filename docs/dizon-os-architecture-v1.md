# Dizon.ai OS — Architecture v1
*Authored by Ray — April 13, 2026*

## Core Components

1. Action Gate System
   - pending_confirmations + resolution_json
   - LISTEN/NOTIFY execution flow
   - Exactly-once guarantees

2. Entity Graph
   - entities + entity_members
   - visibility: private / members / org
   - Owner-based mutation rules

3. Execution Engine
   - agenticLoop
   - Tool chaining + confirmation gating
   - Multi-channel execution (web, WhatsApp)

4. Context Layer
   - Tasks, notes, emails, events
   - Unified retrieval for AI context
   - User-scoped always

5. Security Layer
   - Middleware-based auth
   - No role-based SQL branching
   - Future: Postgres RLS

6. Interface Layer
   - Command Center UI
   - Dynamic tiles + drafts
   - Real-time feedback loop

## System Principles

- DB is source of truth
- Events are signals, not truth
- No in-memory critical state
- Exactly-once execution
- Multi-tenant isolation enforced everywhere

## Next Evolution

- Invite system + collaboration
- Admin surface (controlled)
- RLS enforcement
- Action Gate generalization across all workflows
