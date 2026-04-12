'use strict';

/**
 * server/lib/correctionDetector.cjs — lightweight regex pre-filter for
 * user corrections. Gatekeeper in front of the Claude extractor so we
 * never burn an API call on a normal message.
 */

// Word-boundary patterns for tokens that must match whole words only.
// Prevents false positives like "nevertheless" or "alwaysOnDisplay".
const STRONG_REGEX = [
  /\balways\b/i,
  /\bnever\b/i,
];

const STRONG_SIGNALS = [
  "that's wrong", "don't do that",
  "from now on", "i prefer", "don't ever", "stop doing",
  "always ask", "never do", "do it this way", "not like that",
  "that's not right", "wrong way", "every time",
  "make sure you always", "rule:", "remember:", "next time",
  "in the future", "don't send",
  // Formatting / instruction-style corrections
  "start the", "don't dump", "break it", "break it apart",
  "separate it", "split it", "format it", "format this",
  "lay it out", "structure it", "instead of", "rather than",
  "don't just", "don't put", "don't write", "don't list", "don't use",
  "please use", "please format",
  "easier to read", "hard to read",
  "going forward", "for future", "for next time",
  "differently", "another way", "a better way", "do it like this",
];

// REPLY_ONLY signals only count when the user is replying to an
// assistant message (lastAssistantMessage is truthy).
const REPLY_ONLY_SIGNALS = [
  "shorter", "longer", "keep it", "make it", "more concise",
  "less formal", "more formal", "too long", "too short",
  "show it", "display it", "this way", "like this",
  "when displaying", "when drafting", "when writing", "when you",
  "use a", "use bullet", "use numbered", "use line",
  "make sure", "cleaner", "clearer", "nicer",
  "better format", "more readable", "less cluttered", "organized",
];

const EXPLICIT_RULE_SIGNALS = [
  "from now on", "every time",
  "don't ever", "make sure you always", "rule:", "remember:",
];
const EXPLICIT_RULE_REGEX = [
  /\balways\b/i,
  /\bnever\b/i,
];

function _contains(haystack, needle) {
  return haystack.indexOf(needle) !== -1;
}

/**
 * @param {string} userMessage
 * @param {string|null} lastAssistantMessage - null/undefined when the user
 *   message is not a reply to the assistant (so REPLY_ONLY signals don't fire).
 * @returns {null | { isCorrection: true, isExplicitRule: boolean }}
 */
function detectCorrection(userMessage, lastAssistantMessage) {
  const msg = String(userMessage || '').trim();
  if (!msg) return null;
  const words = msg.split(/\s+/).filter(Boolean);
  if (words.length < 3) return null;

  const lower = msg.toLowerCase();

  let hit = STRONG_REGEX.some(r => r.test(msg))
         || STRONG_SIGNALS.some(s => _contains(lower, s));
  if (!hit && lastAssistantMessage) {
    hit = REPLY_ONLY_SIGNALS.some(s => _contains(lower, s));
  }
  if (!hit) return null;

  const isExplicitRule =
       EXPLICIT_RULE_REGEX.some(r => r.test(msg))
    || EXPLICIT_RULE_SIGNALS.some(s => _contains(lower, s));
  return { isCorrection: true, isExplicitRule };
}

module.exports = { detectCorrection };
