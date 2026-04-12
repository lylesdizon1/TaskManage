'use strict';

/**
 * server/lib/correctionDetector.cjs — lightweight regex pre-filter for
 * user corrections. Gatekeeper in front of the Claude extractor so we
 * never burn an API call on a normal message.
 */

const STRONG_SIGNALS = [
  "that's wrong", "don't do that", "never", "always",
  "from now on", "i prefer", "don't ever", "stop doing",
  "always ask", "never do", "do it this way", "not like that",
  "that's not right", "wrong way", "every time",
  "make sure you always", "rule:", "remember:", "next time",
  "in the future", "don't send",
];

const WEAK_SIGNALS = [
  "shorter", "longer", "keep it", "make it", "more concise",
  "less formal", "more formal", "too long", "too short",
];

const EXPLICIT_RULE_SIGNALS = [
  "always", "never", "from now on", "every time",
  "don't ever", "make sure you always", "rule:", "remember:",
];

function _contains(haystack, needle) {
  return haystack.indexOf(needle) !== -1;
}

/**
 * @param {string} userMessage
 * @param {string|null} lastAssistantMessage - null/undefined when the user
 *   message is not a reply to the assistant (so weak signals don't fire).
 * @returns {null | { isCorrection: true, isExplicitRule: boolean }}
 */
function detectCorrection(userMessage, lastAssistantMessage) {
  const msg = String(userMessage || '').trim();
  if (!msg) return null;
  const words = msg.split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;

  const lower = msg.toLowerCase();

  let hit = STRONG_SIGNALS.some(s => _contains(lower, s));
  if (!hit && lastAssistantMessage) {
    hit = WEAK_SIGNALS.some(s => _contains(lower, s));
  }
  if (!hit) return null;

  const isExplicitRule = EXPLICIT_RULE_SIGNALS.some(s => _contains(lower, s));
  return { isCorrection: true, isExplicitRule };
}

module.exports = { detectCorrection };
