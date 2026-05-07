'use strict';

/**
 * server/lib/subAgents/policy.cjs — sub-agent policy primitives.
 *
 * Contains the V1 hard-disallow tool list and the result schema
 * validator. Pulled out of orchestrator.cjs so they're independently
 * testable and reusable by future sub-agent types.
 *
 * Spec: docs/agents-foundation-v1.md §5B "Hard-disallowed tools (V1,
 * defense-in-depth)" + §6 result schema.
 */

// ── Hard-disallowed tools (M3.4) ────────────────────────────────────
//
// V1 sub-agents are read-mostly. Mutations route through the user's
// Aria turn (where they're individually gated) — never through a
// background sub-agent. This list is enforced at orchestrator dispatch
// time regardless of behavior_rules / decisionEngine output (defense
// in depth — the engine could be misconfigured and the floor still
// holds).
//
// `create_research_finding` is the ONE allowed write inside V1 — it's
// scoped to the running session and writes only to sub_agent_findings.
const HARD_DISALLOWED_TOOLS = new Set([
  // Sends — communication outside the user's review surface
  'send_email', 'reply_email', 'forward_email',
  // Mutations on user data
  'create_task', 'update_task', 'complete_task', 'delete_task',
  'create_event', 'update_event', 'delete_event',
  'create_note', 'update_note', 'delete_note',
  'create_contact', 'update_contact', 'delete_contact',
  'create_journal_entry', 'close_task_with_note', 'add_event_outcome_note',
  'add_project_update_note',
  'create_skill', 'update_skill', 'activate_skill', 'pause_skill', 'delete_skill',
  // Bulk archive — high blast radius
  'bulk_archive_emails',
  // Email file movement
  'move_email', 'archive_email', 'unarchive_email', 'flag_email_as_crucial',
  'unflag_email', 'mark_email_read', 'star_email',
  // Confirmations / proposal flow
  'accept_rule_proposal', 'reject_rule_proposal',
  'set_preference', 'remove_preference',
  // No nesting — sub-agents cannot spawn sub-agents
  'start_sub_agent', 'kill_sub_agent',
]);

function isToolAllowedForSubAgent(toolName) {
  if (!toolName) return false;
  return !HARD_DISALLOWED_TOOLS.has(toolName);
}

// ── Result schema validator (M3.6) ──────────────────────────────────
//
// Every research-agent run that completes successfully produces a
// structured result. Findings without sources are rejected — the
// agent must back its claims with provenance. A failed validation
// returns the raw partial result via the failed-status path; the run
// is marked 'failed' rather than 'completed'.

function validateResultSchema(result) {
  const errors = [];
  if (!result || typeof result !== 'object') {
    return { ok: false, errors: ['result must be an object'] };
  }
  const required = ['summary', 'key_findings', 'sources', 'confidence', 'budget_used'];
  for (const k of required) {
    if (!(k in result)) errors.push(`missing required field: ${k}`);
  }
  if (typeof result.summary !== 'string' || !result.summary.trim()) {
    errors.push('summary must be a non-empty string');
  }
  if (!Array.isArray(result.key_findings)) {
    errors.push('key_findings must be an array');
  } else {
    result.key_findings.forEach((f, i) => {
      if (!f || typeof f !== 'object') {
        errors.push(`key_findings[${i}] must be an object`);
        return;
      }
      if (typeof f.point !== 'string' || !f.point.trim()) {
        errors.push(`key_findings[${i}].point must be a non-empty string`);
      }
      // Sources required per finding — the V1 anti-hallucination contract.
      if (typeof f.source !== 'string' || !f.source.trim()) {
        errors.push(`key_findings[${i}].source is required (string locator)`);
      }
    });
  }
  if (!Array.isArray(result.sources)) {
    errors.push('sources must be an array');
  }
  if (result.action_items !== undefined && !Array.isArray(result.action_items)) {
    errors.push('action_items must be an array if present');
  }
  if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) {
    errors.push('confidence must be a number in [0, 1]');
  }
  if (!result.budget_used || typeof result.budget_used !== 'object') {
    errors.push('budget_used must be an object');
  }
  return { ok: errors.length === 0, errors };
}

// ── Phase config validator ──────────────────────────────────────────
//
// Validates a phase config blob (from sub_agent_definitions.phases or
// passed to the orchestrator at dispatch time). Catches malformed
// config before the orchestrator burns cycles.

function validatePhaseConfig(phases) {
  const errors = [];
  if (!Array.isArray(phases) || phases.length === 0) {
    return { ok: false, errors: ['phases must be a non-empty array'] };
  }
  const seen = new Set();
  phases.forEach((p, i) => {
    if (!p || typeof p !== 'object') {
      errors.push(`phases[${i}] must be an object`);
      return;
    }
    if (typeof p.name !== 'string' || !p.name.trim()) {
      errors.push(`phases[${i}].name must be a non-empty string`);
    } else if (seen.has(p.name)) {
      errors.push(`phases[${i}].name "${p.name}" is duplicated`);
    } else {
      seen.add(p.name);
    }
    if (p.tool_call_budget !== undefined && (!Number.isInteger(p.tool_call_budget) || p.tool_call_budget < 0)) {
      errors.push(`phases[${i}].tool_call_budget must be a non-negative integer`);
    }
    if (p.wall_clock_ms !== undefined && (!Number.isFinite(p.wall_clock_ms) || p.wall_clock_ms <= 0)) {
      errors.push(`phases[${i}].wall_clock_ms must be a positive number`);
    }
  });
  return { ok: errors.length === 0, errors };
}

module.exports = {
  HARD_DISALLOWED_TOOLS,
  isToolAllowedForSubAgent,
  validateResultSchema,
  validatePhaseConfig,
};
