'use strict';

/**
 * server/lib/conversationTurn.cjs — the single shared "handle one chat turn"
 * spine that web chat, WhatsApp, and voice all ride.
 *
 * Before this module each channel duplicated the reasoning glue: build the
 * agentic context, assemble the (cache-split) system prompt, run the agentic
 * loop, then post-process (correction learning + memory extraction). That
 * duplication is exactly what let voice drift into a parallel, stateless,
 * confirmation-broken path. Now there is ONE reasoning pipeline; channels
 * differ only in their transport, history load/persist, and confirmation
 * strategy — all injected.
 *
 * What stays in the route (channel-specific, injected here):
 *   - transport (SSE vs JSON vs UltraMsg) via onProgress + the return value
 *   - the exact `messages` array (web: client-supplied window; WhatsApp/voice:
 *     server-loaded window + this turn)
 *   - history load + persist
 *   - the confirmation gate (web: in-request LISTEN/NOTIFY waiter; WhatsApp/
 *     voice: create-pending-row + deny + next-turn completion) via
 *     gateToolExecution
 *   - tool schema filtering + model choice
 *
 * What's shared (this module):
 *   - buildAgenticContext (same live context for every channel)
 *   - skill-feedback detection (fire-and-forget)
 *   - system-prompt assembly incl. the prompt-cache split
 *   - runAgenticLoop invocation
 *   - correction learning + memory extraction (applyCorrectionAndEnrichment)
 */

const { runAgenticLoop } = require('./agenticLoop.cjs');
const { buildAgenticContext } = require('./buildAgenticContext.cjs');
const { handlePossibleCorrection } = require('./learningHandler.cjs');
const { processSkillFeedback } = require('./trustFeedback.cjs');
const logger = require('../../guardrails/logger.cjs');

/**
 * Assemble the system parameter Anthropic receives. Mirrors the exact shape
 * each channel used inline before extraction:
 *   - clientPrompt (web's custom-prompt path): a single flat string with the
 *     server context blocks spliced in, so a caller-supplied base prompt
 *     still gets learnings/email/projects/skills.
 *   - otherwise the 2-block array — cacheable prefix (profile, persona,
 *     decision rules, slow context) marked ephemeral + the dynamic suffix.
 *     `systemSuffix` (WhatsApp/voice channel instructions) rides the second,
 *     uncached block so it never busts the cache prefix.
 *   - legacy fallback to a flat string when the context builder didn't expose
 *     the cache split (defensive; current builder always does).
 */
function assembleSystem({ ctx, clientPrompt, systemSuffix }) {
  const suffix = systemSuffix || '';
  if (clientPrompt) {
    const serverBlocks = (ctx.learningsBlock || '') + (ctx.emailBlock || '')
      + (ctx.outcomesBlock || '') + (ctx.factsBlock || '')
      + (ctx.projectsBlock || '') + (ctx.skillsBlock || '');
    return ctx.profileContext + clientPrompt + ctx.decisionInstructions + serverBlocks + ctx.contextBlock + suffix;
  }
  if (ctx.systemCacheable !== undefined && ctx.systemDynamic !== undefined) {
    return [
      { type: 'text', text: ctx.systemCacheable || '', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: (ctx.systemDynamic || '') + suffix },
    ];
  }
  return (ctx.systemPrompt || '') + suffix;
}

/**
 * Run one conversation turn through the shared reasoning pipeline.
 *
 * @param {Object}   p
 * @param {string}   p.channel            - source_channel enum value ('web_chat' | 'whatsapp' | 'voice')
 * @param {string}   p.userId
 * @param {Array}    p.entityIds
 * @param {Object}   p.db
 * @param {string}   p.tz
 * @param {string}   [p.contextHint]
 * @param {string}   p.userMessageText    - plain text of THIS turn (skills/context envelope)
 * @param {Array}    p.messages           - exact messages array for the loop
 * @param {string}   [p.clientPrompt]     - web custom-prompt path only
 * @param {string}   [p.systemSuffix]     - channel instructions (WhatsApp/voice)
 * @param {Array}    p.tools              - tool schemas (already filtered per channel)
 * @param {string}   [p.model]
 * @param {Function} p.executeTool        - bound (toolName, input, uid) executor
 * @param {Function} [p.gateToolExecution]
 * @param {Function} [p.onProgress]
 * @param {Function} [p.logAction]
 * @param {Object}   [p.gcalDeps]         - GCal token deps spread into buildAgenticContext
 * @param {Function} [p.onContextReady]   - sync callback(ctx) fired AFTER context build,
 *                                          BEFORE the loop (web uses it to flush SSE +
 *                                          emit skills_loaded). Throwing here propagates.
 * @param {Object}   [p.loggerOverride]
 * @param {string}   [p.requestId]
 * @returns {Promise<{text,toolSummaries,maxIterationsReached,decision,ctx}>}
 */
async function handleConversationTurn({
  channel, userId, entityIds, db, tz, contextHint,
  userMessageText, messages,
  clientPrompt, systemSuffix,
  tools, model,
  executeTool, gateToolExecution, onProgress, logAction,
  gcalDeps = {}, onContextReady,
  loggerOverride, requestId,
}) {
  const log = loggerOverride || logger;

  const ctx = await buildAgenticContext({
    userId, entityIds, db, tz, contextHint,
    userMessage: userMessageText || '',
    ...gcalDeps,
    logger: log, requestId,
  });

  // Skill trust feedback — fire-and-forget. Detects explicit phrasing like
  // "stop loading the X skill" / "always load my Y skill" and applies trust
  // deltas. Same detection on every channel.
  if (userMessageText) {
    processSkillFeedback({ userId, userMessage: userMessageText, db })
      .then((applied) => {
        if (applied.length && log?.info) log.info('skill.feedback.applied', { userId, applied });
      })
      .catch(() => {});
  }

  // Hand the freshly-built context back to the caller before the loop runs.
  // Web flushes SSE headers + emits its skills_loaded event here. Placed
  // after a SUCCESSFUL buildAgenticContext so a context-build throw still
  // surfaces before any headers are flushed (preserves web's JSON-500 path).
  if (onContextReady) onContextReady(ctx);

  const system = assembleSystem({ ctx, clientPrompt, systemSuffix });

  const loopResult = await runAgenticLoop({
    messages,
    system,
    tools,
    userId,
    executeTool,
    onProgress,
    gateToolExecution,
    logAction,
    model,
    channel,
  });

  return { ...loopResult, ctx };
}

/**
 * Shared post-loop learning: correction acknowledgment + memory extraction.
 * The per-channel guards stay explicit (doCorrection / doEnrichment) because
 * each channel decides differently — e.g. WhatsApp/voice skip both when this
 * turn only staged a confirmation prompt (no real assistant signal yet).
 *
 * Correction runs first and may APPEND an acknowledgment to the reply, so the
 * (possibly augmented) text is what gets enriched and returned.
 *
 * @returns {Promise<string>} the reply text, post-correction
 */
async function applyCorrectionAndEnrichment({
  channel, userId, db, userMessage, assistantText, toolsCalled = [],
  doCorrection = true, doEnrichment = true, loggerOverride,
}) {
  const log = loggerOverride || logger;
  let text = assistantText;

  if (doCorrection && userMessage) {
    try {
      const { acknowledgment } = await handlePossibleCorrection({
        userId, userMessage, lastAssistantMessage: text || null, db,
      });
      if (acknowledgment) text = (text || '') + acknowledgment;
    } catch (err) {
      log?.error?.('conversationTurn.learning.failed', { userId, channel, error: err.message });
    }
  }

  // M1b memory extraction — fire-and-forget, env-gated inside the extractor.
  if (doEnrichment && userMessage && text) {
    try {
      const { enrichConversationTurn } = require('./conversationEnrichment.cjs');
      enrichConversationTurn({
        userId, channel, userMessage, assistantText: text,
        toolsCalled: (toolsCalled || []).filter(Boolean),
      }).catch((err) => log?.error?.('conversationTurn.memoryExtract.failed', { userId, channel, error: err.message }));
    } catch (e) {
      log?.warn?.('conversationTurn.memoryExtract.requireFailed', { error: e.message });
    }
  }

  return text;
}

module.exports = { handleConversationTurn, assembleSystem, applyCorrectionAndEnrichment };
