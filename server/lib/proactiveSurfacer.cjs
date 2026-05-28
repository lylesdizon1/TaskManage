'use strict';

/**
 * server/lib/proactiveSurfacer.cjs — P2b orchestrator.
 *
 * Runs every 30 min via cron in proxy-server.cjs. Walks each opted-in
 * user, evaluates push-eligible candidates from candidateDetector, and
 * dispatches via the user's preferred channel (WhatsApp first, Slack
 * fallback). Records every dispatch to proactive_dispatch for fatigue
 * + dedup + telemetry.
 *
 * V1 detectors that flow through this path:
 *   - stale_relationship (priority 40-100, push-eligible)
 *
 * Hard rules (per docs/specs/proactive-surfacing-v1.md):
 *   - DND respected absolutely. No "low-priority allowed during quiet
 *     hours" — silent means silent.
 *   - Daily cap per channel (3/day WhatsApp default, overridable in
 *     user_preferences.proactive_whatsapp_daily_cap).
 *   - Per-candidate cooldown 48h on WhatsApp — no re-firing the same
 *     stale_relationship batch twice within 48h.
 *   - Never throws to caller. Each user's failure is isolated.
 */

const { sendWhatsApp, sendSlack, getIntegrationStatus } = require('../utils/integrations.cjs');
const { loadUserStateForActiveZone, detectAllCandidates } = require('./activeZone/candidateDetector.cjs');

const PER_CANDIDATE_COOLDOWN_MS = 48 * 3600 * 1000; // 48h
const ONE_DAY_MS = 24 * 3600 * 1000;

/**
 * Pick the first available channel from the preference order. WhatsApp
 * is locked first per spec §8; Slack is the fallback when WA isn't
 * configured. No email path in V1 — those go through morning brief.
 */
function pickChannel(status) {
  if (status?.whatsapp) return 'whatsapp';
  if (status?.slack) return 'slack';
  return null;
}

/**
 * Format a candidate to push text. One detector per format function;
 * unknown types return null (skipped silently — should never happen
 * since the caller already filtered to push_eligible types).
 */
function formatCandidate(candidate) {
  if (candidate.type === 'stale_relationship') {
    return formatStaleRelationship(candidate);
  }
  return null;
}

function formatStaleRelationship(candidate) {
  const items = Array.isArray(candidate.items) ? candidate.items : [];
  if (items.length === 0) return null;
  // Render top 1 by daysSilent for the push; rest live in the CC tile.
  // Single-contact framing is warmer than a list dump.
  const top = items[0];
  const days = top.daysSilent || candidate.context?.max_days_silent || 30;
  const roleBit = top.role ? ` (${top.role})` : '';
  const restNote = items.length > 1 ? ` (+${items.length - 1} more in your CC)` : '';
  return `Heads up — you haven't connected with ${top.displayName}${roleBit} in ~${days} days.${restNote} Want to send a quick check-in?`;
}

/**
 * Dispatch the formatted text via the chosen channel. Returns
 * { ok: true } on success, { ok: false, reason } otherwise.
 */
async function dispatchToChannel(db, userId, channel, text) {
  try {
    if (channel === 'whatsapp') return await sendWhatsApp(db, userId, text);
    if (channel === 'slack')    return await sendSlack(db, userId, text);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  return { ok: false, reason: `unknown channel: ${channel}` };
}

/**
 * Per-user entry point. Caller is the cron tick in proxy-server.cjs.
 */
async function runProactiveSurfacerForUser(userInfo, { db, logger }) {
  const userId = userInfo.id;
  const dailyCap = Number.isFinite(userInfo.whatsappDailyCap) ? userInfo.whatsappDailyCap : 3;

  try {
    // 1. DND check — hard gate per spec.
    const inDnd = await db.isUserInDND(userId);
    if (inDnd) {
      logger.debug?.('proactive.skip.dnd', { userId });
      return { dispatched: 0, reason: 'dnd' };
    }

    // 2. Load state + run detectors.
    const state = await loadUserStateForActiveZone(userId, db);
    const candidates = detectAllCandidates(state, { topN: 5 });
    const pushCandidates = candidates.filter((c) =>
      c.push_eligible === true
      && c.priority_score >= (c.push_min_priority || 0));

    if (pushCandidates.length === 0) {
      return { dispatched: 0, reason: 'no_push_candidates' };
    }

    // 3. Channel availability.
    const status = await getIntegrationStatus(db, userId);
    const channel = pickChannel(status);
    if (!channel) {
      logger.debug?.('proactive.skip.noChannel', { userId });
      return { dispatched: 0, reason: 'no_channel' };
    }

    // 4. Per-channel daily cap.
    const sentToday = await db.countRecentDispatches(userId, channel, ONE_DAY_MS);
    if (sentToday >= dailyCap) {
      logger.info?.('proactive.skip.cap', { userId, channel, sentToday, dailyCap });
      return { dispatched: 0, reason: 'daily_cap' };
    }

    // 5. Walk candidates in priority order, respecting cooldown.
    let dispatched = 0;
    for (const candidate of pushCandidates) {
      const latest = await db.getLatestDispatchForCandidate(userId, candidate.type, candidate.candidate_key);
      if (latest && (Date.now() - new Date(latest.dispatchedAt).getTime()) < PER_CANDIDATE_COOLDOWN_MS) {
        continue; // cooldown active
      }
      const text = formatCandidate(candidate);
      if (!text) continue;

      const result = await dispatchToChannel(db, userId, channel, text);
      if (!result?.ok) {
        logger.error?.('proactive.dispatch.failed', { userId, channel, type: candidate.type, reason: result?.reason });
        continue;
      }
      await db.recordProactiveDispatch({
        userId,
        candidateType: candidate.type,
        candidateKey: candidate.candidate_key,
        channel,
        priorityScore: candidate.priority_score,
      });
      logger.info?.('proactive.dispatch.sent', {
        userId, channel, type: candidate.type, priority: candidate.priority_score,
      });
      dispatched++;

      // Re-check cap after each send so we don't blow past it on a tick
      // with multiple eligible candidates.
      if (sentToday + dispatched >= dailyCap) break;
    }
    return { dispatched };
  } catch (err) {
    logger.error?.('proactive.user.failed', { userId, error: err.message });
    return { dispatched: 0, reason: 'error', error: err.message };
  }
}

/**
 * Top-level tick entry — iterate opted-in users.
 */
async function runProactiveSurfacerTick({ db, logger }) {
  try {
    const users = await db.getUsersWithProactiveSurfacingEnabled();
    let totalDispatched = 0;
    for (const user of users) {
      const result = await runProactiveSurfacerForUser(user, { db, logger });
      totalDispatched += result.dispatched || 0;
    }
    if (totalDispatched > 0) {
      logger.info?.('proactive.tick.complete', { users: users.length, dispatched: totalDispatched });
    }
  } catch (err) {
    logger.error?.('proactive.tick.failed', { error: err.message });
  }
}

module.exports = {
  runProactiveSurfacerForUser,
  runProactiveSurfacerTick,
  formatStaleRelationship,
  pickChannel,
};
