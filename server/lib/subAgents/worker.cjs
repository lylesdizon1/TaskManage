'use strict';

/**
 * server/lib/subAgents/worker.cjs — async sub-agent worker.
 *
 * Spec: docs/agents-foundation-v1.md §5B + Q1 ASYNC.
 *
 * V1 design: single in-process worker that polls for queued sessions,
 * claims one at a time via SELECT FOR UPDATE SKIP LOCKED, runs the
 * orchestrator to completion, then loops. PG-backed state survives
 * restart (in-flight sessions get re-claimed on boot).
 *
 * Future (V2): BullMQ + multiple worker processes. The claim semantics
 * (SKIP LOCKED) already support multi-worker; only the polling loop
 * needs to swap out.
 *
 * Boot from proxy-server.cjs at server start.
 */

const db = require('../../../db.cjs');
const { runSession } = require('./orchestrator.cjs');
const { PHASES: RESEARCH_PHASES } = require('./researchAgent.cjs');
const { publishProgress } = require('./progress.cjs');

// Phase implementations by definition_id. New sub-agent types register
// their phase impls here.
const PHASE_REGISTRY = {
  research_agent: RESEARCH_PHASES,
};

const POLL_INTERVAL_MS = 3000;
const STARTUP_DELAY_MS = 5000;
const WORKER_ID = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let _running = false;
let _stopRequested = false;

// Recover in-flight sessions on boot — anything left in 'running' from a
// crashed prior process gets re-queued so the worker can pick it up.
async function recoverOrphaned() {
  try {
    const { rowCount } = await db.pool.query(
      `UPDATE sub_agent_sessions
          SET status = 'queued', worker_id = NULL, claimed_at = NULL
        WHERE status = 'running'
          AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '15 minutes')`,
    ).catch(() => ({ rowCount: 0 }));
    if (rowCount > 0) {
      console.log(`[subAgents.worker] recovered ${rowCount} orphaned session(s)`);
    }
  } catch (err) {
    console.warn('[subAgents.worker] recoverOrphaned failed:', err.message);
  }
}

async function processOne() {
  let session;
  try {
    session = await db.claimNextSubAgentSession(WORKER_ID);
  } catch (err) {
    console.warn('[subAgents.worker] claim failed:', err.message);
    return false;
  }
  if (!session) return false;

  console.log(`[subAgents.worker] claimed session ${session.id} (definition=${session.definitionId})`);

  let definition;
  try {
    definition = await db.getSubAgentDefinition(session.definitionId);
  } catch (err) {
    await db.updateSubAgentSession(session.id, {
      status: 'failed',
      error: `failed to load definition: ${err.message}`,
    });
    return true;
  }
  if (!definition) {
    await db.updateSubAgentSession(session.id, {
      status: 'failed',
      error: `unknown definition_id: ${session.definitionId}`,
    });
    return true;
  }

  const phaseImpls = PHASE_REGISTRY[definition.id];
  if (!phaseImpls) {
    await db.updateSubAgentSession(session.id, {
      status: 'failed',
      error: `no phase implementations registered for ${definition.id}`,
    });
    return true;
  }

  try {
    const out = await runSession({ session, definition, phaseImpls });
    console.log(`[subAgents.worker] session ${session.id} → ${out.status}`);
    // Completion notification — fire-and-forget. Lazy require to avoid
    // circular module load with notify which may import other server
    // pieces.
    try {
      const { notifyCompletion } = require('./notify.cjs');
      await notifyCompletion(session.id).catch(() => {});
    } catch {}
  } catch (err) {
    console.error(`[subAgents.worker] session ${session.id} crashed:`, err.message);
    await db.updateSubAgentSession(session.id, {
      status: 'failed',
      error: `worker crash: ${err.message}`,
    });
    await publishProgress(session.id, 'session_done', { status: 'failed', error: err.message });
  }
  return true;
}

async function workerLoop() {
  _running = true;
  while (!_stopRequested) {
    let didWork = false;
    try {
      didWork = await processOne();
    } catch (err) {
      console.error('[subAgents.worker] loop error:', err.message);
    }
    if (!didWork) {
      // No queued work — back off the poll interval.
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } else {
      // Yield to the event loop between claims so the express server
      // doesn't starve on a long-running session aftermath.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  _running = false;
}

/**
 * Boot the worker. Idempotent — repeated calls are no-ops if already
 * running. Called once from proxy-server.cjs after schema init.
 */
function startSubAgentWorker() {
  if (_running) return;
  _stopRequested = false;
  // Defer startup so DB pool + schema migrations finish first.
  setTimeout(async () => {
    await recoverOrphaned();
    workerLoop().catch((err) => {
      console.error('[subAgents.worker] fatal:', err);
      _running = false;
    });
  }, STARTUP_DELAY_MS);
  console.log(`[subAgents.worker] startup scheduled (id=${WORKER_ID}, delay=${STARTUP_DELAY_MS}ms)`);
}

function stopSubAgentWorker() {
  _stopRequested = true;
}

module.exports = {
  startSubAgentWorker,
  stopSubAgentWorker,
  // Exported for tests:
  _processOne: processOne,
  _WORKER_ID: WORKER_ID,
};
