'use strict';

/**
 * server/lib/subAgents/progress.cjs — Redis pub-sub for live sub-agent
 * progress events.
 *
 * Each sub-agent session has a dedicated channel:
 *   sub-agent:progress:<session_id>
 *
 * The Agents-tab UI subscribes to visible sessions; CC chat subscribes
 * to active sessions it dispatched. Server-side worker publishes events
 * as the orchestrator advances. Fail-soft when Redis is absent.
 */

let _publisher = null;
async function _getPublisher() {
  if (_publisher) return _publisher;
  if (!process.env.REDIS_URL) return null;
  try {
    const { createClient } = require('redis');
    const c = createClient({ url: process.env.REDIS_URL });
    c.on('error', () => {});
    await c.connect();
    _publisher = c;
    return c;
  } catch {
    return null;
  }
}

function channelFor(sessionId) {
  return `sub-agent:progress:${sessionId}`;
}

/**
 * Publish a progress event. Fire-and-forget — never throws, never blocks.
 *
 * @param {string} sessionId
 * @param {string} eventType   'session_started' | 'phase_enter' | 'tool_call' | 'synthesis' | 'session_done' | etc.
 * @param {object} payload     event-specific data
 */
async function publishProgress(sessionId, eventType, payload = {}) {
  if (!sessionId || !eventType) return;
  try {
    const pub = await _getPublisher();
    if (!pub) return;
    const message = JSON.stringify({
      session_id: sessionId,
      event_type: eventType,
      ts: new Date().toISOString(),
      ...payload,
    });
    await pub.publish(channelFor(sessionId), message);
  } catch { /* fail-soft */ }
}

/**
 * Subscribe to a session's progress channel. Returns an unsubscribe
 * function. Each connection makes its own subscriber client because
 * node-redis subscribers can't issue regular commands.
 *
 * @param {string} sessionId
 * @param {(event: object) => void} onEvent
 * @returns {Promise<() => Promise<void>>} unsubscribe function
 */
async function subscribeToProgress(sessionId, onEvent) {
  if (!sessionId || typeof onEvent !== 'function') return () => {};
  if (!process.env.REDIS_URL) return () => {};
  let client;
  try {
    const { createClient } = require('redis');
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', () => {});
    await client.connect();
    await client.subscribe(channelFor(sessionId), (msg) => {
      try { onEvent(JSON.parse(msg)); } catch {}
    });
    return async () => {
      try { await client.unsubscribe(channelFor(sessionId)); } catch {}
      try { await client.quit(); } catch {}
    };
  } catch {
    return async () => { try { if (client) await client.quit(); } catch {} };
  }
}

module.exports = {
  publishProgress,
  subscribeToProgress,
  channelFor,
};
