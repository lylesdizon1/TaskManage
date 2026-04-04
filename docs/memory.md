# Dizon.ai — Memory System
Last updated: April 4, 2026
Status: Planned (Phase 1 schema, Phase 3 instrumentation)

## Three Memory Types

### Episodic — What happened
Raw event log. Every meaningful user action writes a row.
TTL: 90–180 days depending on action type.

### Semantic — What is true about the user
Standing facts and preferences.
Explicit user statements: no expiry.
System-derived facts: expire in 60 days unless reinforced.

### Procedural — How the user does things
Derived patterns from nightly job.
TTL: 30 days, refreshed when pattern recurs.

## logMemory() — Called on every action handler
```javascript
await logMemory({
  userId,
  agent,           // 'task_agent' | 'email_agent' | 'financial_agent' etc.
  memoryType,      // 'episodic' | 'semantic' | 'procedural'
  content,         // JSONB — what happened
  relevanceScore,  // 0.0–1.0
  expiresAt,       // null for semantic explicit facts
})
```

## Context Injection — getRelevantMemories()
Called by buildContext.js at the start of every Aria conversation.
Returns top 10 memories ranked by relevance + recency.
Injected into Aria's system prompt under "## What I know about you".

## Nightly Pattern Job
Runs 2am via Railway cron.
One script per agent type.
Output → procedural memory writes.
