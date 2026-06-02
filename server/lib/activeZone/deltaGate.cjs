'use strict';

/**
 * server/lib/activeZone/deltaGate.cjs
 *
 * Pure delta-gate for Active Zone surfacing. Active Zone shows DELTAS, not
 * snapshots: each item surfaces once on first appearance, and again ONLY
 * when its material/urgency state ESCALATES. Steady-state and de-escalations
 * are suppressed.
 *
 * Inputs:
 *   - candidates: detector output, each with { candidate_type|type, item_key,
 *     state_signature } (see candidateDetector.annotateDelta).
 *   - storedSigMap: Map keyed by `${kind} ${itemKey}` → last-surfaced
 *     state_signature (from db.getSurfacedSignatures). Absent ⇒ never surfaced.
 *
 * Decision per candidate:
 *   - not in ledger          → NEW       → surface, caller writes ledger
 *   - same signature         → SUPPRESS  → (no write)
 *   - signature ESCALATED    → RESURFACE → surface, caller updates ledger
 *   - changed but NOT escalated (de-escalation / member removed / churn)
 *                            → SUPPRESS  → (no write)
 *
 * Escalation is defined member-wise so BOTH "a new thing appeared" and "an
 * existing thing got more urgent" count, while "something was handled / left"
 * does not: escalation ⇔ ∃ member whose new rank > its last-surfaced rank
 * (an absent member's prior rank is 0, so a NEW member always escalates).
 */

/** Parse a state_signature into Map<memberId, rank>. Singletons (a bare
 *  number, no '@') map to a single '_' member carrying that rank. */
function parseSignature(sig) {
  const m = new Map();
  if (sig == null || sig === '') return m;
  for (const tok of String(sig).split(',')) {
    if (!tok) continue;
    const at = tok.lastIndexOf('@');
    if (at === -1) {
      m.set('_', Number(tok) || 0);
    } else {
      m.set(tok.slice(0, at), Number(tok.slice(at + 1)) || 0);
    }
  }
  return m;
}

/** True if newSig represents an escalation over storedSig. */
function isEscalation(storedSig, newSig) {
  if (storedSig == null) return true;        // never surfaced ⇒ treat as escalation
  if (storedSig === newSig) return false;    // identical ⇒ steady state
  const oldM = parseSignature(storedSig);
  const newM = parseSignature(newSig);
  for (const [id, rank] of newM) {
    if (rank > (oldM.get(id) ?? 0)) return true; // new member, or a member got more urgent
  }
  return false;                               // only de-escalations / removals
}

/**
 * Gate a candidate list against the stored-signature map.
 * @returns {{ surfaced: Array, suppressed: Array, decisions: Array }}
 *   decisions: [{ kind, item_key, decision: 'new'|'resurface'|'suppress', stored, signature }]
 */
function gateCandidates(candidates, storedSigMap) {
  const surfaced = [];
  const suppressed = [];
  const decisions = [];
  const map = storedSigMap instanceof Map ? storedSigMap : new Map();
  for (const c of candidates || []) {
    const kind = c.candidate_type || c.type;
    const stored = map.get(`${kind} ${c.item_key}`); // undefined ⇒ absent
    let decision;
    if (stored === undefined) decision = 'new';
    else if (stored === c.state_signature) decision = 'suppress';
    else if (isEscalation(stored, c.state_signature)) decision = 'resurface';
    else decision = 'suppress';
    decisions.push({ kind, item_key: c.item_key, decision, stored: stored ?? null, signature: c.state_signature });
    if (decision === 'new' || decision === 'resurface') surfaced.push(c);
    else suppressed.push(c);
  }
  return { surfaced, suppressed, decisions };
}

module.exports = { gateCandidates, isEscalation, parseSignature };
