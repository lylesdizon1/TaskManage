'use strict';

/**
 * server/lib/activeZone/tileComposer.cjs
 *
 * Turns candidates from candidateDetector.cjs into rendered tiles with
 * user-facing headline/body/actions.
 *
 * Layers:
 *   1. Redis cache (5-min TTL keyed on userId + candidate_key + 5-min
 *      bucket). Hit → composer_source='cache', skip LLM.
 *   2. Haiku LLM call with a 3 s timeout. Success → composer_source='llm'.
 *   3. Deterministic fallback template per candidate_type.
 *      Source='fallback'. Always renders; never blocks the user on LLM
 *      availability.
 *
 * Rendered tile shape:
 *   {
 *     tile_id,            // uuid; stable per persisted row
 *     candidate_type,
 *     candidate_key,
 *     priority_score,
 *     urgency,
 *     headline,           // ≤80 chars, ends without period
 *     body,               // ≤200 chars, optional
 *     primary_action:   { label, action, target? },
 *     secondary_action: { label, action },  // always "Not now" → defer
 *     items_preview,      // structured payload for UI expand
 *     composer_source,    // 'llm'|'cache'|'fallback'
 *   }
 *
 * Never throws past the boundary — any failure falls back and logs.
 */

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../../../guardrails/logger.cjs');
const { rediGet, rediSet } = require('../redis.cjs');
const { withRetry } = require('../anthropicRetry.cjs');

const LLM_TIMEOUT_MS = 3000;
const CACHE_TTL_SEC = 300;
const COMPOSER_MODEL = 'claude-haiku-4-5-20251001';

let _anthropicClient = null;
function _client() {
  if (_anthropicClient) return _anthropicClient;
  if (!process.env.CLAUDE_API_KEY) return null;
  _anthropicClient = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropicClient;
}

function _bucket5min(now) {
  const t = Math.floor(now.getTime() / (5 * 60 * 1000));
  return String(t);
}

function _cacheKey(userId, candidateKey, bucket) {
  return `az:tile:${userId}:${candidateKey}:${bucket}`;
}

function _safeJson(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── Per-candidate LLM prompts ────────────────────────────────────────────

function _promptFor(candidate, { firstName, localTime }) {
  const { candidate_type: type, items = [], context = {} } = candidate;
  const base =
`You are Aria, ${firstName}'s personal AI assistant. Compose ONE tile for their orchestration surface.

Output ONLY valid JSON:
{
  "headline": "<≤80 chars, warm + direct + efficient; no corporate tone; no cheesy enthusiasm; no trailing period>",
  "body": "<≤200 chars, optional context or short list — can be empty string if headline is enough>",
  "primary_label": "<≤20 chars, imperative verb phrase>"
}

Current time (user-local): ${localTime}
Situation: ${type}`;

  const per = {
    overdue_tasks_batch:
`Items: ${items.length} overdue tasks: ${items.slice(0, 5).map((t) => `"${t.title || 'Untitled'}" (due ${t.dueDate || t.due_date})`).join(', ')}.
Max days overdue: ${context.max_days_overdue}. Frame it as: acknowledge + invitation to resolve.`,

    close_the_loops_batch:
`Items: ${context.count} unresolved close-the-loops: ${items.slice(0, 5).map((l) => `"${l.titleSnapshot || l.title_snapshot || l.sourceType || l.source_type || 'untitled'}"`).join(', ')}.
Has stale (>48h old): ${context.has_stale}. Frame as: batch them and knock them out.`,

    upcoming_meeting_with_prep:
`Meeting "${context.event?.title || 'Untitled'}" starts soon (${localTime}).
Related unfinished tasks: ${(context.related_tasks || []).map((t) => `"${t.title}"`).join(', ')}.
Frame as: time-sensitive prep hint.`,

    meeting_just_ended:
`Meeting "${context.event?.title || 'Untitled'}" just ended. Frame as: ask for outcome / notes.`,

    pending_confirmation:
`Aria is blocked waiting on user to approve an action: ${context.tool_name}.
Frame as: unblock this so Aria can finish.`,

    draft_resume:
`${context.count} in-progress drafts from earlier today. Frame as: nudge to finish one.`,

    daily_wrap_due:
`It's ${localTime} — past 9pm — and no daily wrap yet. Frame as: one light invite to wrap up.`,

    critical_email_unacked:
`${context.unviewed_count || 0} unviewed and ${context.viewed_count || 0} already-read-but-unresolved flagged-critical emails (${context.count} total).${context.max_days_open ? ` Oldest open loop: ${context.max_days_open}d since flagged.` : ''} Frame as: if unviewed ones exist, "new critical email — take a look"; if the read-but-unresolved ones are the focus, frame as a close-the-loop nag to handle what they've already seen.`,

    single_urgent_task:
`One high-priority task due today: "${context.task?.title}". Frame as: focused nudge.`,
  };

  return `${base}\n${per[type] || ''}`;
}

// ── Deterministic fallbacks ──────────────────────────────────────────────

function _fallbackFor(candidate) {
  const { candidate_type: type, items = [], context = {} } = candidate;
  switch (type) {
    case 'overdue_tasks_batch':
      return {
        headline: `${items.length} tasks are overdue`,
        body: items.slice(0, 3).map((t) => `• ${t.title || 'Untitled'}`).join('\n'),
        primary_label: 'See them',
      };
    case 'close_the_loops_batch':
      return {
        headline: `${context.count} open loops from this week`,
        body: 'Quick close-outs — should take two minutes.',
        primary_label: 'Close them',
      };
    case 'upcoming_meeting_with_prep':
      return {
        headline: `${context.event?.title || 'Meeting'} starts soon`,
        body: (context.related_tasks || []).length
          ? `You have ${context.related_tasks.length} related task${context.related_tasks.length === 1 ? '' : 's'} tagged to this.`
          : '',
        primary_label: 'Open prep',
      };
    case 'meeting_just_ended':
      return {
        headline: `${context.event?.title || 'Meeting'} just wrapped`,
        body: 'Anything to note before it fades?',
        primary_label: 'Add outcome',
      };
    case 'pending_confirmation':
      return {
        headline: `Waiting on your OK for ${context.tool_name || 'an action'}`,
        body: '',
        primary_label: 'Review',
      };
    case 'draft_resume':
      return {
        headline: `${context.count} draft${context.count === 1 ? '' : 's'} waiting`,
        body: '',
        primary_label: 'Pick one up',
      };
    case 'daily_wrap_due':
      return {
        headline: 'Quick daily wrap?',
        body: 'Three lines — wins, frustrations, tomorrow.',
        primary_label: 'Wrap up',
      };
    case 'critical_email_unacked': {
      const unv = context.unviewed_count || 0;
      const seen = context.viewed_count || 0;
      // Lead with whichever bucket is the actionable story.
      const headline = unv > 0
        ? `${unv} new critical email${unv === 1 ? '' : 's'} to look at`
        : `${seen} critical email${seen === 1 ? '' : 's'} read but still open${context.max_days_open ? ` (${context.max_days_open}d)` : ''}`;
      const body = (unv > 0 && seen > 0)
        ? `${seen} already read but unresolved — close the loop.`
        : '';
      return { headline, body, primary_label: unv > 0 ? 'Take a look' : 'Close the loop' };
    }
    case 'single_urgent_task':
      return {
        headline: context.task?.title || 'High-priority task today',
        body: '',
        primary_label: 'Open task',
      };
    default:
      return { headline: 'Something to look at', body: '', primary_label: 'Open' };
  }
}

// ── Action mapping (rendered tile shape) ─────────────────────────────────

function _actionsFor(candidate, primaryLabel) {
  const { candidate_type: type, items = [], context = {} } = candidate;
  const secondary = { label: 'Not now', action: 'defer' };
  const action = ((t) => {
    switch (t) {
      case 'overdue_tasks_batch':       return { label: primaryLabel, action: 'expand_overdue_tasks' };
      case 'close_the_loops_batch':     return { label: primaryLabel, action: 'expand_close_the_loops' };
      case 'upcoming_meeting_with_prep':return { label: primaryLabel, action: 'open_meeting_prep', target: context.event?.id };
      case 'meeting_just_ended':        return { label: primaryLabel, action: 'add_event_outcome', target: context.event?.id };
      case 'pending_confirmation':      return { label: primaryLabel, action: 'open_confirmation',   target: items[0]?.id };
      case 'draft_resume':              return { label: primaryLabel, action: 'resume_draft',        target: items[0]?.id };
      case 'daily_wrap_due':            return { label: primaryLabel, action: 'open_daily_wrap' };
      case 'critical_email_unacked':    return { label: primaryLabel, action: 'expand_critical_emails' };
      case 'single_urgent_task':        return { label: primaryLabel, action: 'open_task',           target: items[0]?.id };
      default:                           return { label: primaryLabel, action: 'open' };
    }
  })(type);
  return { primary_action: action, secondary_action: secondary };
}

function _itemsPreview(candidate) {
  const { candidate_type: type, items = [], context = {} } = candidate;
  // Compact, UI-friendly previews. Never emit full DB rows.
  switch (type) {
    case 'overdue_tasks_batch':
      return items.slice(0, 10).map((t) => ({ id: t.id, title: t.title, dueDate: t.dueDate || t.due_date, priority: t.priority }));
    case 'close_the_loops_batch':
      // db.getOpenCloseLoopItems aliases to camelCase (sourceType, sourceId,
      // titleSnapshot). Read those, fall back to snake_case for any future
      // caller that bypasses the alias path. Same defensive shape as
      // critical_email_unacked (FU1, 1537e88) — should be the universal
      // pattern for items_preview going forward.
      // 2026-05-08 outcome-capture redesign — also surface triggered_at
      // so the BulkCloseRow UI can apply smart defaults based on age
      // (>30d → ⊘ Cancelled, task >14d → ✓ Success, etc).
      // 2026-05-13 close-loop enrichment — surface sourceCreatedAt,
      // sourceStartTime, sourceDescription from db JOIN so each row can
      // render a primary date + inline task notes.
      return items.slice(0, 10).map((l) => ({
        id: l.id,
        source_type:        l.sourceType        || l.source_type,
        source_id:          l.sourceId          || l.source_id,
        title:              l.titleSnapshot     || l.title_snapshot,
        triggered_at:       l.triggeredAt       || l.triggered_at       || null,
        sourceCreatedAt:    l.sourceCreatedAt   || l.source_created_at  || null,
        sourceStartTime:    l.sourceStartTime   || l.source_start_time  || null,
        sourceDescription:  l.sourceDescription || l.source_description || null,
      }));
    case 'upcoming_meeting_with_prep':
      return [{ event: { id: context.event?.id, title: context.event?.title, startTime: context.event?.startTime || context.event?.start_time } },
              ...(context.related_tasks || []).slice(0, 5).map((t) => ({ id: t.id, title: t.title }))];
    case 'meeting_just_ended':
      return [{ event: { id: context.event?.id, title: context.event?.title, endTime: context.event?.endTime || context.event?.end_time } }];
    case 'pending_confirmation':
      return [{ id: items[0]?.id, tool_name: items[0]?.toolName, params: items[0]?.params }];
    case 'single_urgent_task':
      return [{ id: context.task?.id, title: context.task?.title, dueDate: context.task?.dueDate }];
    case 'critical_email_unacked':
      return items.slice(0, 10).map((it) => ({
        id: it.id,
        title: it.title || it.subject || '(no subject)',
        sender: it.sender || '',
        sourceId: it.sourceId || it.source_id || null,
        gmailLink: it.gmailLink || it.gmail_link || null,
      }));
    default:
      return [];
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

/**
 * Compose a single tile for a single candidate. Returns the rendered
 * tile shape; never throws. Caller is responsible for persisting via
 * db.upsertActiveZoneTile.
 */
async function composeTile(candidate, { firstName = 'there', localTime = '', userId }) {
  const bucket = _bucket5min(new Date());
  const cacheKey = _cacheKey(userId || 'anon', candidate.candidate_key, bucket);

  // 1. Redis cache.
  try {
    const cached = await rediGet(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      return { ..._buildTile(candidate, parsed), composer_source: 'cache' };
    }
  } catch { /* fall through to LLM */ }

  // 2. LLM (Haiku) with 3s timeout.
  const client = _client();
  if (client?.messages?.create) {
    try {
      const prompt = _promptFor(candidate, { firstName, localTime });
      // withRetry runs INSIDE the timeout race — fast-failing 529s
      // typically fit one retry attempt within the 3s budget. If
      // retries blow the budget, compose-timeout wins and the
      // deterministic fallback path runs (same shape as before).
      const resp = await Promise.race([
        withRetry(
          () => client.messages.create({
            model: COMPOSER_MODEL,
            max_tokens: 180,
            messages: [{ role: 'user', content: prompt }],
          }),
          'activeZone.tileComposer',
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error('compose-timeout')), LLM_TIMEOUT_MS)),
      ]);
      const text = resp?.content?.[0]?.text || '';
      const parsed = _safeJson(text);
      if (parsed && parsed.headline) {
        const tile = _buildTile(candidate, parsed);
        try { await rediSet(cacheKey, JSON.stringify(parsed), CACHE_TTL_SEC); } catch {}
        logger.info('activeZone.compose.llm', { userId, candidate_type: candidate.candidate_type });
        return { ...tile, composer_source: 'llm' };
      }
      // Fallthrough: unusable JSON → log + fall back.
      logger.warn('activeZone.compose.parseFailed', { userId, candidate_type: candidate.candidate_type });
    } catch (err) {
      logger.warn('activeZone.compose.llmFailed', {
        userId, candidate_type: candidate.candidate_type, error: err.message,
      });
    }
  } else {
    logger.warn('activeZone.compose.llmUnavailable', { userId, candidate_type: candidate.candidate_type });
  }

  // 3. Deterministic fallback.
  const tile = _buildTile(candidate, _fallbackFor(candidate));
  return { ...tile, composer_source: 'fallback' };
}

function _buildTile(candidate, copy) {
  const headline = String(copy.headline || '').slice(0, 80);
  const body     = String(copy.body || '').slice(0, 200);
  const primaryLabel = String(copy.primary_label || 'Open').slice(0, 20);
  const { primary_action, secondary_action } = _actionsFor(candidate, primaryLabel);
  return {
    tile_id: crypto.randomUUID(),
    candidate_type: candidate.candidate_type,
    candidate_key: candidate.candidate_key,
    priority_score: candidate.priority_score,
    urgency: candidate.urgency,
    headline, body,
    primary_action, secondary_action,
    items_preview: _itemsPreview(candidate),
  };
}

/**
 * Compose tiles for a list of candidates in parallel. Returns the
 * rendered array in the same order; per-tile failures fall back
 * (never throws past the boundary).
 */
async function composeTiles(candidates, ctx) {
  return Promise.all(candidates.map((c) => composeTile(c, ctx)));
}

module.exports = {
  composeTile,
  composeTiles,
  LLM_TIMEOUT_MS,
  CACHE_TTL_SEC,
};
