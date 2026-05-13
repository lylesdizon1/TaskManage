// cardSerializer — converts action_card messages into compact XML tags
// that survive chatHistoryForLLM and let Aria answer "did you send that?"
// correctly on follow-up turns.
//
// Phase 3 spec decisions:
//   - XML tag inside user-role content (passes the synthetic-role strip)
//   - Last 5 cards retained — older drop out naturally with history window
//   - body field EXCLUDED for token cost + privacy; subject included
//   - 5 statuses: drafted | executing | sent_ok | failed | cancelled | expired

const MAX_CARDS_IN_CONTEXT = 5;

/**
 * Render a single action_card message as an XML tag string.
 * Returns null if the message isn't an action_card or has no parseable payload.
 */
export function cardSummary(msg) {
  if (!msg || msg.role !== 'action_card') return null;
  const payload = _extractPayload(msg);
  if (!payload || typeof payload !== 'object') return null;

  const cardId = payload.card_id || msg.cardId || msg.card_id || '';
  const type = payload.type || 'unknown';
  const status = payload.status || 'drafted';
  const lines = [
    `<aria_action_card id="${_esc(cardId)}" type="${_esc(type)}" status="${_esc(status)}">`,
  ];

  if (type === 'email') {
    const to = payload.resolved?.to;
    if (to) {
      const toStr = to.email || to.display_name || '';
      lines.push(`  to: ${_esc(toStr)}`);
    } else if (payload.unresolved?.includes('to')) {
      lines.push(`  to: <unresolved>`);
    }
    const from = payload.resolved?.from?.account_email;
    if (from) lines.push(`  from: ${_esc(from)}`);
    const subject = payload.resolved?.subject;
    if (subject) lines.push(`  subject: "${_esc(subject)}"`);
    if (status === 'sent_ok' && payload.result_metadata?.sent_at) {
      lines.push(`  sent_at: ${_esc(payload.result_metadata.sent_at)}`);
      if (payload.result_metadata.message_id) {
        lines.push(`  message_id: ${_esc(payload.result_metadata.message_id)}`);
      }
    }
    if (status === 'failed') {
      lines.push(`  error_reason: ${_esc(payload.error_reason || 'unknown')}`);
    }
  } else {
    // Future card types (task/event/etc.) — minimal shape; expand per-type
    // when those migrations ship in Commits 2-3.
    const title = payload.resolved?.title;
    if (title) lines.push(`  title: "${_esc(title)}"`);
  }

  lines.push(`</aria_action_card>`);
  return lines.join('\n');
}

/**
 * Render the trailing N action cards from a message list as a single
 * appended string to inject into the latest user-role content. Drops out
 * older cards so the LLM doesn't carry the entire history.
 */
export function summarizeRecentCards(messages, max = MAX_CARDS_IN_CONTEXT) {
  if (!Array.isArray(messages)) return '';
  const cards = [];
  for (let i = messages.length - 1; i >= 0 && cards.length < max; i--) {
    const s = cardSummary(messages[i]);
    if (s) cards.push(s);
  }
  if (cards.length === 0) return '';
  // Reverse so oldest-of-the-window appears first (matches chronological
  // reading order Aria would expect).
  return cards.reverse().join('\n');
}

function _extractPayload(msg) {
  if (msg.payload && typeof msg.payload === 'object') return msg.payload;
  if (typeof msg.content === 'string') {
    try { return JSON.parse(msg.content); } catch { return null; }
  }
  if (msg.content && typeof msg.content === 'object') return msg.content;
  return null;
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const MAX_CARDS_FOR_LLM = MAX_CARDS_IN_CONTEXT;
