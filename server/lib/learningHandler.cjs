'use strict';

/**
 * server/lib/learningHandler.cjs — post-turn correction/learning glue.
 *
 * Called after the agentic loop returns. Detects corrections, extracts a
 * rule via Haiku, persists via db.createOrUpdateLearning, and returns an
 * optional acknowledgment string to append to Aria's reply.
 *
 * Fails silent — never throws. Rate-limited to 5 extractions per user
 * per hour in a module-level map.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { detectCorrection } = require('./correctionDetector.cjs');
const { extractRule } = require('./ruleExtractor.cjs');

const MAX_EXTRACTIONS_PER_HOUR = 5;
const extractionCounters = new Map(); // userId → { count, resetAt }

let _anthropic = null;
function _client() {
  if (_anthropic) return _anthropic;
  if (!process.env.CLAUDE_API_KEY) return null;
  _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropic;
}

function _checkAndBump(userId) {
  const now = Date.now();
  const slot = extractionCounters.get(userId);
  if (!slot || now >= slot.resetAt) {
    extractionCounters.set(userId, { count: 1, resetAt: now + 3600_000 });
    return true;
  }
  if (slot.count >= MAX_EXTRACTIONS_PER_HOUR) return false;
  slot.count++;
  return true;
}

/**
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {string} opts.userMessage
 * @param {string|null} opts.lastAssistantMessage
 * @param {Object} opts.db
 * @returns {Promise<{ acknowledgment: string|null, learning: Object|null }>}
 */
async function handlePossibleCorrection({ userId, userMessage, lastAssistantMessage, db }) {
  try {
    const detection = detectCorrection(userMessage, lastAssistantMessage);
    if (!detection?.isCorrection) return { acknowledgment: null, learning: null };

    if (!_checkAndBump(userId)) {
      return { acknowledgment: null, learning: null };
    }

    const client = _client();
    if (!client) return { acknowledgment: null, learning: null };

    // Pull recent actions for extractor context (best-effort).
    let recentActions = [];
    try {
      const q = await db.pool.query(
        `SELECT tool_name, input_json FROM agent_actions
         WHERE user_id = $1 AND event_type = 'tool_executed'
         ORDER BY created_at DESC LIMIT 2`,
        [userId],
      );
      recentActions = q.rows || [];
    } catch { /* ignore */ }

    const rule = await extractRule(userMessage, lastAssistantMessage, recentActions, client);
    if (!rule) return { acknowledgment: null, learning: null };

    const result = await db.createOrUpdateLearning(
      userId, rule.rule_text, rule.rule_type, rule.scope, rule.scope_value,
      userMessage, !!detection.isExplicitRule,
    );
    if (!result?.learning) return { acknowledgment: null, learning: null };

    let acknowledgment = null;
    if (result.learning.confidence === 'rule') {
      acknowledgment = `\n\n\u2713 Got it — I'll remember that.`;
    } else if (result.learning.confidence === 'pattern' && result.confidenceUpgraded) {
      acknowledgment = `\n\n\u2713 Noted — I'm picking up on that pattern.`;
    }
    return { acknowledgment, learning: result.learning };
  } catch {
    return { acknowledgment: null, learning: null };
  }
}

module.exports = { handlePossibleCorrection };
