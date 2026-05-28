'use strict';

/**
 * server/routes/chatDraft.cjs — Commit 1 of the email-draft architecture.
 *
 * Replaces the agentic loop's send_email tile path for users on
 * VITE_DRAFT_NEW=true. Two endpoints:
 *
 * POST /api/chat/draft           — Haiku classify + contact/account
 *                                  resolve; returns a persisted action_card
 *                                  ready for the EmailDraftCard component
 *                                  to render, or {type:'default_chat'} if
 *                                  the message isn't email-shaped.
 *
 * POST /api/chat/execute-draft   — execute the resolved card via the
 *                                  existing send_email tool; streams
 *                                  card_status_update events over SSE on
 *                                  the same protocol /api/chat/execute uses.
 *
 * Card persistence lives in chat_messages with role='action_card' and
 * card_id set (Commit 1 migration). Status changes UPDATE the same row so
 * navigation away + back reloads cards intact from getConversationMessages.
 *
 * Scope: email-only for Commit 1. Task/event/project migrations follow in
 * Commits 2-3. Old parseActionDraft + agentic-loop confirm card paths
 * stay live for non-email intents (and email when flag is off).
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { withRetry } = require('../lib/anthropicRetry.cjs');
const logger = require('../../guardrails/logger.cjs');
const { DEFAULT_TIMEZONE } = require('../utils/timezone.cjs');
const { executeTool } = require('../tools.cjs');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CARD_DRAFT_TIMEOUT_MS = 8000;
const AUTO_RESOLVE_CONFIDENCE = 0.9;          // Phase 3 spec Q3
const VALID_STATUSES = new Set(['drafted','executing','sent_ok','failed','cancelled','expired']);

let _anthropic = null;
function _client() {
  if (_anthropic) return _anthropic;
  if (!process.env.CLAUDE_API_KEY) return null;
  _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropic;
}

function _safeParse(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function _newCardId() {
  return `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function createChatDraftRouter({ authenticateToken, db }) {
  const router = express.Router();

  // ── POST /api/chat/draft ──────────────────────────────────────────────
  router.post('/api/chat/draft', authenticateToken, async (req, res) => {
    const t0 = Date.now();
    const userId = req.user.id;
    const message = String(req.body?.message || '').trim();
    const conversationId = parseInt(req.body?.conversation_id, 10);

    if (!message) return res.json({ type: 'default_chat' });
    if (!Number.isFinite(conversationId)) {
      return res.status(400).json({ error: 'conversation_id required' });
    }
    // 2026-05-28 — validate the conversation exists AND belongs to
    // this user before any persistence. Pre-fix, a stale conversation_id
    // sent from the client would silently land an action_card row as
    // an orphan. Existence-leak-safe via getConversation's owner scope.
    const conversation = await db.getConversation(conversationId, userId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const client = _client();
    if (!client?.messages?.create) return res.json({ type: 'default_chat' });

    // Run Haiku classification + DB resolution in parallel so total
    // latency is bounded by the slowest of the three, not their sum.
    const haikuTask = _classifyEmailIntent(client, message);
    const accountsTask = db.getHealthyGmailAccounts(userId);

    let classification, accounts;
    try {
      [classification, accounts] = await Promise.all([haikuTask, accountsTask]);
    } catch (err) {
      logger.warn('chat.draft.parallel.failed', { requestId: req.requestId, error: err.message });
      return res.json({ type: 'default_chat' });
    }

    if (!classification || classification.type !== 'email') {
      return res.json({ type: 'default_chat' });
    }

    // ── Resolve `to` field ──────────────────────────────────────────
    let toResolved = null;
    let toCandidates = [];
    const toHint = String(classification.to_hint || '').trim();
    if (EMAIL_REGEX.test(toHint)) {
      // Already a full email — no resolution needed.
      toResolved = { email: toHint, display_name: toHint, confidence: 1.0 };
    } else if (toHint) {
      const candidates = await db.searchContactsByName(userId, toHint, 5).catch(() => []);
      toCandidates = candidates;
      const top = candidates[0];
      if (top && Number(top.confidence) >= AUTO_RESOLVE_CONFIDENCE) {
        toResolved = {
          email: top.primaryEmail,
          display_name: top.displayName,
          confidence: Number(top.confidence),
        };
      }
    }

    // ── Default account: primary first, healthy only ─────────────────
    const defaultAccount = accounts[0] || null;

    // ── Build the card payload ──────────────────────────────────────
    const cardId = _newCardId();
    const unresolved = [];
    if (!toResolved) unresolved.push('to');
    if (!defaultAccount) unresolved.push('from');

    const payload = {
      card_id: cardId,
      type: 'email',
      status: 'drafted',
      resolved: {
        to: toResolved,
        from: defaultAccount ? {
          account_email: defaultAccount.accountEmail,
          auth_status: defaultAccount.authStatus,
        } : null,
        subject: String(classification.subject || '').slice(0, 200),
        body: String(classification.body || '').slice(0, 10000),
      },
      unresolved,
      candidates_for: toCandidates.length ? { to: toCandidates } : null,
      available_accounts: accounts.map(a => ({
        account_email: a.accountEmail,
        auth_status: a.authStatus,
        is_default: a === defaultAccount,
      })),
      blocking_reason: accounts.length === 0 ? 'no_healthy_accounts' : null,
      created_at: new Date().toISOString(),
    };

    try {
      await db.createActionCardMessage({ conversationId, userId, cardId, payload });
    } catch (err) {
      logger.error('chat.draft.persist.failed', { requestId: req.requestId, userId, error: err.message });
      return res.status(500).json({ error: 'Failed to persist draft card' });
    }

    const latencyMs = Date.now() - t0;
    logger.info('chat.draft.card_drafted', {
      requestId: req.requestId, userId, cardId,
      type: 'email', unresolved_count: unresolved.length, latency_ms: latencyMs,
    });

    return res.json(payload);
  });

  // ── POST /api/chat/execute-draft ─────────────────────────────────────
  // SSE response, same event protocol as /api/chat/execute.
  router.post('/api/chat/execute-draft', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const cardId = String(req.body?.card_id || '');
    const resolved = req.body?.resolved || {};

    if (!cardId) return res.status(400).json({ error: 'card_id required' });

    // SSE headers — match /api/chat/execute pattern exactly.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const card = await db.getActionCardByIdForUser(cardId, userId);
    if (!card) {
      send('error', { message: 'card not found or not yours' });
      res.end();
      return;
    }

    const currentStatus = card.payload?.status;
    if (currentStatus !== 'drafted') {
      // Idempotency / re-execution guard. Card is already past draft state.
      send('card_status_update', { card_id: cardId, status: currentStatus });
      res.end();
      return;
    }

    // Frontend send the final user-edited values; trust them after server
    // re-validates. Account_email must be one of the user's healthy ones.
    const to = String(resolved.to || '').trim();
    const fromAccount = String(resolved.from_account || '').trim();
    const subject = String(resolved.subject || '').slice(0, 500);
    const body = String(resolved.body || '').slice(0, 50000);

    if (!EMAIL_REGEX.test(to)) {
      await _writeFailure({ db, cardId, userId, card, reason: 'validation', message: `Invalid recipient address "${to}"` });
      send('card_status_update', { card_id: cardId, status: 'failed', error_reason: 'validation' });
      res.end();
      return;
    }

    const healthy = await db.getHealthyGmailAccounts(userId);
    const accountOk = healthy.find(a => a.accountEmail.toLowerCase() === fromAccount.toLowerCase());
    if (!accountOk) {
      await _writeFailure({ db, cardId, userId, card, reason: 'auth', message: `Account ${fromAccount} is not healthy or not yours` });
      send('card_status_update', { card_id: cardId, status: 'failed', error_reason: 'auth' });
      res.end();
      return;
    }

    // Transition: drafted → executing
    const executingPayload = { ...card.payload, status: 'executing', resolved: { ...card.payload.resolved, to: { ...(card.payload.resolved?.to || {}), email: to }, from: { account_email: accountOk.accountEmail, auth_status: accountOk.authStatus }, subject, body } };
    await db.updateActionCardPayload({ cardId, userId, payload: executingPayload }).catch(() => {});
    send('card_status_update', { card_id: cardId, status: 'executing' });

    // Run send_email via the existing tool path. tz + entityIds aren't used
    // by send_email; pass safe defaults.
    let result;
    try {
      result = await executeTool('send_email',
        { to, subject, body, account_email: accountOk.accountEmail },
        userId, req.user.entityIds || [], db, req.user.timezone || DEFAULT_TIMEZONE);
    } catch (err) {
      result = { success: false, error: err.message, reason: 'unknown' };
    }

    if (result?.success) {
      const sentAt = new Date().toISOString();
      const successPayload = {
        ...executingPayload,
        status: 'sent_ok',
        result_metadata: {
          message_id: result.message_id,
          thread_id: result.thread_id,
          account_email: result.account_email,
          sent_at: sentAt,
        },
      };
      await db.updateActionCardPayload({ cardId, userId, payload: successPayload }).catch(() => {});
      send('card_status_update', {
        card_id: cardId, status: 'sent_ok',
        message_id: result.message_id, sent_at: sentAt,
      });
      logger.info('chat.draft.card_executed_ok', { requestId: req.requestId, userId, cardId });
    } else {
      const reason = result?.reason || _inferReason(result?.error || '');
      const failedPayload = {
        ...executingPayload,
        status: 'failed',
        error_reason: reason,
        error_message: result?.error || 'unknown error',
      };
      await db.updateActionCardPayload({ cardId, userId, payload: failedPayload }).catch(() => {});
      // For 'auth' failures, surface a retry hint with the next healthy
      // account so the card can offer one-click retry without Aria
      // silently retrying behind the user's back.
      let retryWith = null;
      if (reason === 'auth') {
        retryWith = healthy.find(a => a.accountEmail.toLowerCase() !== accountOk.accountEmail.toLowerCase());
      }
      send('card_status_update', {
        card_id: cardId, status: 'failed',
        error_reason: reason, error_message: result?.error || 'unknown error',
        ...(retryWith ? { retry_available_with: retryWith.accountEmail } : {}),
      });
      logger.warn('chat.draft.card_executed_failed', { requestId: req.requestId, userId, cardId, reason });
    }

    res.end();
  });

  return router;
};

// ── Helpers ──────────────────────────────────────────────────────────

async function _classifyEmailIntent(client, message) {
  const system = 'You classify a single user message. Output ONLY one JSON object. No prose.';
  const prompt = `Classify this user message. If it is asking to send/write/reply to an email or message, return:
{"type":"email","to_hint":<recipient as user said it — name OR full email, never invent>,"subject":<inferred or empty>,"body":<inferred body or short rewrite of message>}

If it is NOT email-shaped, return: {"type":"default_chat"}

Rules:
- NEVER fabricate an email address. If the user said "leo", to_hint is "leo" — not "leo@example.com". Resolution happens server-side.
- Body should be a natural rewrite of what the user wants to say; do not add a sign-off they didn't ask for.
- If subject isn't clear, leave it empty — the client will prompt the user.

User message: ${message}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CARD_DRAFT_TIMEOUT_MS);
  try {
    const resp = await withRetry(
      () => client.messages.create(
        { model: HAIKU_MODEL, max_tokens: 400, system, messages: [{ role: 'user', content: prompt }] },
        { signal: controller.signal },
      ),
      'chatDraft.email',
    );
    clearTimeout(timeout);
    const text = resp?.content?.[0]?.text || '';
    const parsed = _safeParse(text);
    if (!parsed) return null;
    if (parsed.type !== 'email' && parsed.type !== 'default_chat') return null;
    return parsed;
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}

function _inferReason(errorMessage) {
  const m = String(errorMessage || '').toLowerCase();
  if (m.includes('invalid_grant') || m.includes('auth') || m.includes('reconnect')) return 'auth';
  if (m.includes('network') || m.includes('timeout') || m.includes('econnreset')) return 'network';
  if (m.includes('invalid') || m.includes('malformed') || m.includes('required')) return 'validation';
  return 'unknown';
}

async function _writeFailure({ db, cardId, userId, card, reason, message }) {
  const failedPayload = {
    ...card.payload,
    status: 'failed',
    error_reason: reason,
    error_message: message,
  };
  await db.updateActionCardPayload({ cardId, userId, payload: failedPayload }).catch(() => {});
}

// Exported for tests
module.exports._test = { _inferReason, _safeParse, AUTO_RESOLVE_CONFIDENCE };
