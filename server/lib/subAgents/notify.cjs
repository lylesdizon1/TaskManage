'use strict';

/**
 * server/lib/subAgents/notify.cjs — completion notification.
 *
 * Spec: docs/agents-foundation-v1.md M3.10.
 *
 * Fires a WhatsApp message (and falls back to email — TODO) when a
 * sub-agent run completes. V1 scope: WhatsApp only via the existing
 * UltraMsg path. Failure is silent — the run already succeeded; a
 * missed notification doesn't reverse that.
 */

const db = require('../../../db.cjs');
const { sendWhatsApp } = require('../../utils/integrations.cjs');

function _truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function _composeMessage(session) {
  const status = session.status;
  const prompt = _truncate(session.prompt || '', 80);

  if (status === 'completed') {
    const summary = _truncate(session.result?.summary || '', 200);
    const findingCount = Array.isArray(session.result?.key_findings) ? session.result.key_findings.length : 0;
    return `🔬 Research done · "${prompt}"\n\n${summary}\n\n${findingCount} finding${findingCount === 1 ? '' : 's'}. View in Agents → Recent runs.`;
  }
  if (status === 'budget_exhausted') {
    return `🔬 Research stopped (budget) · "${prompt}". Partial findings available — view in Agents.`;
  }
  if (status === 'killed') {
    return `🔬 Research cancelled · "${prompt}".`;
  }
  if (status === 'failed') {
    return `🔬 Research failed · "${prompt}". Error: ${_truncate(session.error || 'unknown', 100)}`;
  }
  return `🔬 Research · "${prompt}" → ${status}`;
}

/**
 * Send a completion notification for a finished session. Idempotent
 * caller responsibility — this fires every time it's called. Callers
 * (worker.cjs) call once per session.
 */
async function notifyCompletion(sessionId) {
  if (!sessionId) return;
  let session;
  try {
    session = await db.getSubAgentSession(sessionId);
  } catch { return; }
  if (!session) return;

  const TERMINAL = new Set(['completed','budget_exhausted','stagnated','failed','killed']);
  if (!TERMINAL.has(session.status)) return;

  // V1: WhatsApp only. Email fallback is V2.
  try {
    const message = _composeMessage(session);
    await sendWhatsApp(db, session.userId, message);
  } catch { /* fail-soft — notification is nice-to-have */ }
}

module.exports = {
  notifyCompletion,
  _composeMessage,
};
