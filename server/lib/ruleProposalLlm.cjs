'use strict';

/**
 * server/lib/ruleProposalLlm.cjs — Haiku-driven enrichment for rule
 * proposals. Given an action_type and the recent rejected tool_inputs,
 * propose a structured predicate that catches the SHARED PATTERN across
 * rejections — narrower and more useful than "confirm any call to this
 * tool."
 *
 * Examples of what this can propose:
 *   - User rejected 3 send_email to "stranger@x.com" → predicate matching
 *     that recipient via { field: 'to', op: 'contains', value: 'stranger@x.com' }
 *   - User rejected 2 update_task setting priority='high' → predicate
 *     matching { field: 'priority', op: 'eq', value: 'high' }
 *   - User rejected 2 archive_email on emails containing 'invoice' →
 *     { field: 'subject', op: 'contains', value: 'invoice' }
 *
 * Failure-soft: any LLM error, parse error, validation failure, or
 * timeout returns null. Caller (trustFeedback) falls back to the simple
 * { tool_names: [actionType] } predicate so the proposal still ships.
 *
 * NEVER throws past the boundary.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('./anthropicRetry.cjs');
const logger = require('../../guardrails/logger.cjs');

let _anthropic = null;
function _defaultClient() {
  if (_anthropic) return _anthropic;
  if (!process.env.CLAUDE_API_KEY) return null;
  _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropic;
}

const VALID_OPS = new Set([
  'gt', 'gte', 'lt', 'lte', 'eq', 'neq',
  'in', 'not_in', 'contains', 'exists', 'not_exists',
]);
const RESERVED_TOP_KEYS = new Set(['trust', 'rate', 'external_recipients']);
const ALLOWED_TOP_KEYS  = new Set(['tool_names', 'input', 'recipients']);

/**
 * Structurally validate a predicate object before persisting. Mirrors
 * the runtime grammar in decisionEngine.evaluatePredicate so a Haiku
 * response that the engine would later choke on gets caught now.
 *
 * Returns null when valid, an error string when invalid.
 */
function validatePredicate(predicate) {
  if (predicate == null || typeof predicate !== 'object' || Array.isArray(predicate)) {
    return 'predicate must be a non-array object';
  }
  for (const k of Object.keys(predicate)) {
    if (RESERVED_TOP_KEYS.has(k)) return `reserved future key: ${k}`;
    if (!ALLOWED_TOP_KEYS.has(k)) return `unknown top-level key: ${k}`;
  }
  if (predicate.tool_names !== undefined) {
    if (!Array.isArray(predicate.tool_names) || !predicate.tool_names.every((s) => typeof s === 'string')) {
      return 'tool_names must be an array of strings';
    }
  }
  if (predicate.input !== undefined) {
    const err = _validateNode(predicate.input, 0);
    if (err) return err;
  }
  if (predicate.recipients !== undefined) {
    const r = predicate.recipients;
    if (r == null || typeof r !== 'object') return 'recipients must be an object';
    if (r.in_contacts !== true && r.not_in_contacts !== true) {
      return 'recipients must specify in_contacts: true or not_in_contacts: true';
    }
  }
  return null;
}

function _validateNode(node, depth) {
  if (depth > 8) return 'predicate nesting too deep (>8)';
  if (node == null || typeof node !== 'object') return 'predicate node must be an object';
  if (Array.isArray(node.and)) {
    if (!node.and.length) return 'and: must have at least one child';
    for (const c of node.and) { const e = _validateNode(c, depth + 1); if (e) return e; }
    return null;
  }
  if (Array.isArray(node.or)) {
    if (!node.or.length) return 'or: must have at least one child';
    for (const c of node.or) { const e = _validateNode(c, depth + 1); if (e) return e; }
    return null;
  }
  if (node.not !== undefined) return _validateNode(node.not, depth + 1);
  if (typeof node.field === 'string' && typeof node.op === 'string') {
    if (!VALID_OPS.has(node.op)) return `unknown op: ${node.op}`;
    return null;
  }
  return `unknown predicate node shape: ${JSON.stringify(node).slice(0, 80)}`;
}

const PROPOSAL_TIMEOUT_MS = 8000;

/**
 * Ask Haiku to propose a predicate that catches the shared pattern in
 * the rejected tool inputs. Returns the predicate object (with tool_names
 * + input) on success, null on any failure.
 *
 * @param {string} actionType — e.g. 'send_email', 'update_task'
 * @param {Object[]} toolInputs — array of the rejected tool_input blobs
 * @param {Object} [client] — optional Anthropic client (for tests)
 */
async function proposeRichPredicate(actionType, toolInputs, client = null) {
  if (!actionType || !Array.isArray(toolInputs) || !toolInputs.length) return null;
  const llm = client || _defaultClient();
  if (!llm?.messages?.create) return null;

  // Cap each input at ~600 chars to keep prompt size bounded. Haiku can
  // handle more but we don't want to balloon the proposal cost.
  const compactInputs = toolInputs.slice(0, 5).map((inp) => {
    try {
      const s = JSON.stringify(inp || {});
      return s.length > 600 ? s.slice(0, 600) + '…' : s;
    } catch {
      return '{}';
    }
  });

  const prompt =
`The user has rejected the same kind of autonomous action multiple times. Examine the rejected tool inputs and propose a STRUCTURED PREDICATE that catches the SHARED pattern across them — narrower than just "any call to this tool".

Action type: ${actionType}

Rejected tool inputs (JSON, most recent first):
${compactInputs.map((s, i) => `[${i + 1}] ${s}`).join('\n')}

Output ONLY a JSON object matching this schema:
{
  "tool_names": ["${actionType}"],
  "input": <PredicateNode>
}

PredicateNode is one of:
  { "and": [PredicateNode, ...] }
  { "or":  [PredicateNode, ...] }
  { "not": PredicateNode }
  { "field": "<dotted.path>", "op": "<operator>", "value": <any> }

Valid operators: gt, gte, lt, lte, eq, neq, in, not_in, contains, exists, not_exists.

Field paths are dotted lookups into the tool input (e.g. "to", "priority", "criteria.older_than_hours").

Goal: find a SHARED FIELD VALUE across the rejected inputs and gate on it. The predicate should fire when that pattern is present, NOT every time the tool runs.

If no clear shared pattern exists, return: { "tool_names": ["${actionType}"] }

Do NOT include "trust", "rate", or "external_recipients" keys.

Examples:
  All rejected sends to "stranger@x.com" → { "tool_names": ["send_email"], "input": { "field": "to", "op": "contains", "value": "stranger@x.com" } }
  All rejected updates set priority="high" → { "tool_names": ["update_task"], "input": { "field": "priority", "op": "eq", "value": "high" } }
  Mixed inputs with no clear pattern → { "tool_names": ["${actionType}"] }

Respond with JSON only. No prose, no markdown fence.`;

  try {
    const resp = await Promise.race([
      withRetry(
        () => llm.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 250,
          messages: [{ role: 'user', content: prompt }],
        }),
        'ruleProposalLlm',
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('proposeRichPredicate-timeout')), PROPOSAL_TIMEOUT_MS)),
    ]);
    const text = resp?.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
    const err = validatePredicate(parsed);
    if (err) {
      logger.warn('ruleProposalLlm.invalid', { actionType, error: err, sample: JSON.stringify(parsed).slice(0, 200) });
      return null;
    }
    // Belt-and-suspenders: tool_names must include the action_type we're
    // proposing for, otherwise Haiku misunderstood the prompt.
    if (Array.isArray(parsed.tool_names) && parsed.tool_names.length && !parsed.tool_names.includes(actionType)) {
      logger.warn('ruleProposalLlm.toolNamesMismatch', { actionType, returned: parsed.tool_names });
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn('ruleProposalLlm.failed', { actionType, error: err.message });
    return null;
  }
}

module.exports = { proposeRichPredicate, validatePredicate };
