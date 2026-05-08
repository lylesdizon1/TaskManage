'use strict';

/**
 * server/lib/ruleExtractor.cjs — single Haiku call that turns a
 * correction into a normalized rule object.
 *
 * Returns null on any failure (network, parse, schema). Never throws.
 */

const { withRetry } = require('./anthropicRetry.cjs');

const VALID_TYPES  = new Set(['style', 'confirmation', 'timing', 'routing', 'preference', 'boundary']);
const VALID_SCOPES = new Set(['global', 'entity', 'person', 'channel', 'tool']);

const SYSTEM_PROMPT = 'You extract user preference rules from corrections. Output ONLY valid JSON. No explanation.';

function _summarizeAction(a) {
  if (!a) return '';
  const name = a.tool_name || a.toolName || 'tool';
  const input = a.input_json || a.input || {};
  try { return `${name}(${JSON.stringify(input).slice(0, 120)})`; }
  catch { return name; }
}

function _safeParse(text) {
  if (!text) return null;
  // Find first JSON object
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/**
 * @param {string} userMessage
 * @param {string|null} lastAssistantMessage
 * @param {Array<Object>} recentActions - last 1-2 agent_actions rows
 * @param {Object} anthropicClient - an @anthropic-ai/sdk Anthropic instance
 * @returns {Promise<null | { rule_text, rule_type, scope, scope_value }>}
 */
async function extractRule(userMessage, lastAssistantMessage, recentActions, anthropicClient) {
  try {
    if (!anthropicClient?.messages?.create) return null;
    const actionsSummary = (recentActions || []).slice(0, 2).map(_summarizeAction).filter(Boolean).join('; ') || 'none';
    const userPrompt =
`User message: ${userMessage || ''}
Last assistant message: ${lastAssistantMessage || 'none'}
Recent actions: ${actionsSummary}

Extract the rule. Output ONLY:
{
  "rule_text": string (plain English, max 20 words),
  "rule_type": "style"|"confirmation"|"timing"|"routing"|"preference"|"boundary",
  "scope": "global"|"entity"|"person"|"channel"|"tool",
  "scope_value": string|null
}

Examples:
'always ask before sending emails'
→ {"rule_text":"Always confirm before sending any email","rule_type":"confirmation","scope":"tool","scope_value":"send_email"}

'keep emails shorter'
→ {"rule_text":"Keep email body concise and brief","rule_type":"style","scope":"channel","scope_value":"email"}

'never email Leo without asking'
→ {"rule_text":"Always confirm before emailing Leo","rule_type":"confirmation","scope":"person","scope_value":"Leo"}`;

    const resp = await Promise.race([
      withRetry(
        () => anthropicClient.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        'ruleExtractor',
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('rule-extract-timeout')), 15_000)),
    ]);

    const text = resp?.content?.[0]?.text || '';
    const parsed = _safeParse(text);
    if (!parsed) return null;

    const ruleText = typeof parsed.rule_text === 'string' ? parsed.rule_text.trim() : '';
    const ruleType = parsed.rule_type;
    const scope = parsed.scope;
    const scopeValue = parsed.scope_value ?? null;
    if (!ruleText) return null;
    if (!VALID_TYPES.has(ruleType)) return null;
    if (!VALID_SCOPES.has(scope)) return null;
    if (ruleText.split(/\s+/).length > 30) return null; // guard against runaway output
    return { rule_text: ruleText, rule_type: ruleType, scope, scope_value: scopeValue };
  } catch {
    return null;
  }
}

module.exports = { extractRule };
