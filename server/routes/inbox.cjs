'use strict';

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const googleProvider = require('../lib/providers/googleEmailProvider.cjs');
const { classifyEmail } = require('../lib/classificationEngine.cjs');
const { processClassificationFeedback } = require('../lib/classificationFeedback.cjs');

// Resolve the provider implementation for a given integration row.
// Single-provider today — Gmail. Future-ready lookup table.
function providerFor(integration) {
  const p = integration?.provider || 'google';
  if (p === 'google') return googleProvider;
  return null;
}

function parseDate(s) {
  const t = Date.parse(s || '');
  return Number.isFinite(t) ? t : 0;
}

module.exports = function createInboxRouter({ authenticateToken, db }) {
  const router = express.Router();

  /**
   * GET /api/inbox/items
   * Returns all inbox_items for the authenticated user (AI-flagged
   * triage items only — the live thread list is /api/inbox/threads).
   */
  router.get('/api/inbox/items', authenticateToken, async (req, res) => {
    try {
      const items = await db.getInboxItemsForUser(req.user.id);
      res.json(items);
    } catch (err) {
      logger.error('inbox.fetch.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/inbox/search?q=...
   * ILIKE search against inbox_items (AI-flagged triage rows). The live
   * full-text search across the user's actual inbox happens via
   * /api/inbox/threads?query=... which forwards to Gmail's native search.
   */
  router.get('/api/inbox/search', authenticateToken, async (req, res) => {
    try {
      const q = (req.query.q || '').toString().trim();
      if (!q || q.length < 2) return res.json({ items: [] });
      const items = await db.searchInboxItems(req.user.id, q);
      res.json({ items });
    } catch (err) {
      logger.error('inbox.search.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * PATCH /api/inbox/items/:id
   * Body: { action } — e.g. 'dismissed'
   * Sets action_taken on the inbox item.
   */
  router.patch('/api/inbox/items/:id', authenticateToken, async (req, res) => {
    const { action } = req.body;
    if (!action) return res.status(400).json({ error: 'action required' });

    try {
      const items = await db.getInboxItemsForUser(req.user.id);
      const item = items.find(i => i.id === req.params.id);
      if (!item) return res.status(404).json({ error: 'Item not found or access denied' });
      await db.updateInboxItemAction(req.params.id, action, req.user.id);
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.actionUpdate.failed', { requestId: req.requestId, userId: req.user?.id, itemId: req.params.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * PATCH /api/inbox/items/:id/flag
   * Body: { reason?: string } — defaults to 'manual'
   */
  router.patch('/api/inbox/items/:id/flag', authenticateToken, async (req, res) => {
    try {
      const { reason } = req.body || {};
      const ok = await db.flagInboxItem(req.params.id, req.user.id, reason || 'manual');
      if (!ok) return res.status(404).json({ error: 'Item not found' });
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.flag.failed', { requestId: req.requestId, userId: req.user?.id, itemId: req.params.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * PATCH /api/inbox/items/:id/unflag
   */
  router.patch('/api/inbox/items/:id/unflag', authenticateToken, async (req, res) => {
    try {
      const ok = await db.unflagInboxItem(req.params.id, req.user.id);
      if (!ok) return res.status(404).json({ error: 'Item not found' });
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.unflag.failed', { requestId: req.requestId, userId: req.user?.id, itemId: req.params.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * PATCH /api/inbox/items/:id/ack
   * Marks a flagged item as acknowledged. Idempotent; only updates if flagged.
   */
  router.patch('/api/inbox/items/:id/ack', authenticateToken, async (req, res) => {
    try {
      const ok = await db.ackInboxItem(req.params.id, req.user.id);
      if (!ok) return res.status(404).json({ error: 'Item not found or not flagged' });
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.ack.failed', { requestId: req.requestId, userId: req.user?.id, itemId: req.params.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * PATCH /api/inbox/items/:id/unack
   * Puts a flagged item back into the unacked queue.
   */
  router.patch('/api/inbox/items/:id/unack', authenticateToken, async (req, res) => {
    try {
      const ok = await db.unackInboxItem(req.params.id, req.user.id);
      if (!ok) return res.status(404).json({ error: 'Item not found' });
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.unack.failed', { requestId: req.requestId, userId: req.user?.id, itemId: req.params.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/inbox/flagged
   * Returns flagged inbox items + count.
   * ?include_acked=true returns all flagged; default returns unacked only.
   */
  router.get('/api/inbox/flagged', authenticateToken, async (req, res) => {
    try {
      const includeAcked = req.query.include_acked === 'true';
      const opts = { includeAcked };
      const [items, count, unackedCount] = await Promise.all([
        db.getFlaggedInboxItems(req.user.id, opts),
        db.getFlaggedInboxCount(req.user.id, opts),
        includeAcked ? db.getFlaggedInboxCount(req.user.id, { includeAcked: false }) : null,
      ]);
      res.json({ items, count, unackedCount: unackedCount ?? count });
    } catch (err) {
      logger.error('inbox.flagged.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Provider-backed thread routes (no DB persistence) ────���─────────────

  /**
   * POST /api/inbox/flag-thread
   * Body: { thread_id, account_email, subject, sender, snippet, reason? }
   * Upserts an inbox_item for the thread and flags it.
   */
  router.post('/api/inbox/flag-thread', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { thread_id, account_email, subject, sender, snippet, reason } = req.body;
      if (!thread_id) return res.status(400).json({ error: 'thread_id required' });

      const exists = await db.inboxItemExistsBySourceId(userId, thread_id);
      if (!exists) {
        const id = `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        await db.createInboxItem({
          id, userId, type: 'EMAIL',
          title: subject || '(no subject)',
          summary: snippet || '',
          source: (account_email || '').includes('outlook') ? 'outlook' : 'gmail',
          sourceId: thread_id,
          gmailThreadId: thread_id,
          gmailLink: `https://mail.google.com/mail/u/0/#inbox/${thread_id}`,
          sender: sender || null,
        });
      }

      const { rows } = await db.pool.query(
        'SELECT id FROM inbox_items WHERE user_id = $1 AND source_id = $2',
        [userId, thread_id],
      );
      if (rows[0]) {
        await db.flagInboxItem(rows[0].id, userId, reason || 'manual');
      }
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.flagThread.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/inbox/unflag-thread
   * Body: { thread_id }
   */
  router.post('/api/inbox/unflag-thread', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { thread_id } = req.body;
      if (!thread_id) return res.status(400).json({ error: 'thread_id required' });

      const { rows } = await db.pool.query(
        'SELECT id FROM inbox_items WHERE user_id = $1 AND source_id = $2',
        [userId, thread_id],
      );
      if (rows[0]) {
        await db.unflagInboxItem(rows[0].id, userId);
      }
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.unflagThread.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Classification feedback ──────────────────────────────────────────────

  /**
   * POST /api/inbox/items/:id/feedback
   * Logs a thumbs-up/down signal for the classification on this inbox item.
   * Thumbs-down without corrections: generic negative + unflag.
   * Thumbs-down with corrections: applies specific dimension corrections.
   */
  router.post('/api/inbox/items/:id/feedback', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const inboxItemId = req.params.id;
      const { feedback_type, corrections, message_id, sender, subject, classification } = req.body;

      if (!feedback_type || !['thumbs_up', 'thumbs_down'].includes(feedback_type)) {
        return res.status(400).json({ error: 'feedback_type must be thumbs_up or thumbs_down' });
      }

      // Idempotency: skip if feedback already exists for this message
      if (message_id) {
        const exists = await db.hasExistingFeedback(userId, message_id);
        if (exists) return res.json({ success: true, deduplicated: true });
      }

      // Extract sender domain for pattern matching
      const senderEmail = (sender || '').toLowerCase().trim();
      const domainMatch = senderEmail.match(/@([^>]+)/);
      const senderDomain = domainMatch ? domainMatch[1] : null;
      const subjectSnippet = (subject || '').slice(0, 100);

      // Build classification snapshot from what the caller sends
      const classificationSnapshot = classification || null;

      await db.insertClassificationFeedback(userId, {
        inboxItemId,
        messageId: message_id || null,
        feedbackType: feedback_type,
        classificationSnapshot,
        correctionDimensions: corrections || null,
        senderEmail: senderEmail || null,
        senderDomain,
        subjectSnippet,
      });

      // Fire-and-forget Phase 4 pipeline: check for pattern matches → inferred rules
      processClassificationFeedback(db, userId, {
        feedbackType: feedback_type,
        senderEmail: senderEmail || null,
        senderDomain,
        correctionDimensions: corrections || null,
      }).catch(() => {});

      // Immediate state corrections for thumbs_down
      if (feedback_type === 'thumbs_down') {
        if (!corrections) {
          // Generic thumbs-down: unflag the email
          await db.unflagInboxItem(inboxItemId, userId).catch(() => {});
        } else {
          // Dimension-specific corrections
          if (corrections.not_critical || corrections.not_financial || corrections.not_otp) {
            await db.unflagInboxItem(inboxItemId, userId).catch(() => {});
          }
          // Update classification if message_id provided
          if (message_id) {
            const updates = {};
            if (corrections.wrong_priority) updates.importance = corrections.wrong_priority;
            if (corrections.not_financial) updates.category = 'general';
            if (corrections.wrong_entity !== undefined) updates.entityId = corrections.wrong_entity || null;
            if (Object.keys(updates).length > 0) {
              const sets = [];
              const vals = [userId, message_id];
              let idx = 3;
              if (updates.importance) { sets.push(`importance = $${idx}`); vals.push(updates.importance); idx++; }
              if (updates.category) { sets.push(`category = $${idx}`); vals.push(updates.category); idx++; }
              if (updates.entityId !== undefined) { sets.push(`entity_id = $${idx}`); vals.push(updates.entityId); idx++; }
              if (sets.length) {
                await db.pool.query(
                  `UPDATE email_classifications SET ${sets.join(', ')}, classified_at = NOW()
                   WHERE user_id = $1 AND message_id = $2`,
                  vals,
                ).catch(() => {});
              }
            }
          }
        }
      }

      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.feedback.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Provider-backed thread routes ──────────────────────────────────────

  router.get('/api/inbox/accounts', authenticateToken, async (req, res) => {
    try {
      const rows = await db.getUserIntegrationsByType(req.user.id, 'gmail');
      const accounts = rows.map((r) => ({
        id: r.id,
        account_email: r.accountEmail || '',
        provider: r.provider || 'google',
        created_at: r.createdAt,
      }));
      res.json(accounts);
    } catch (err) {
      logger.error('inbox.accounts.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * Decode a compound pagination cursor into a per-account pageToken map.
   * Cursor format: base64-encoded JSON object { "<accountEmail>": "<pageToken>" }.
   * Empty / missing / malformed cursor → {} (page 1 from each account).
   */
  function decodeCursor(raw) {
    if (!raw || typeof raw !== 'string') return {};
    try {
      const json = Buffer.from(raw, 'base64').toString('utf8');
      const parsed = JSON.parse(json);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch { return {}; }
  }

  /**
   * Build a compound cursor from a {email -> nextPageToken} map. Returns
   * null when all accounts are exhausted (no more pages anywhere).
   */
  function encodeCursor(perAccountTokens) {
    const filtered = {};
    for (const [email, token] of Object.entries(perAccountTokens)) {
      if (token) filtered[email] = token;
    }
    if (Object.keys(filtered).length === 0) return null;
    return Buffer.from(JSON.stringify(filtered)).toString('base64');
  }

  router.get('/api/inbox/threads', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { account_email: accountEmail, query, cursor } = req.query;
      const maxResults = Math.min(parseInt(req.query.max_results, 10) || 25, 50);
      const tokenMap = decodeCursor(cursor);

      const allRows = await db.getUserIntegrationsByType(userId, 'gmail');
      const targets = accountEmail
        ? allRows.filter(r => (r.accountEmail || '').toLowerCase() === String(accountEmail).toLowerCase())
        : allRows;
      if (!targets.length) return res.json({ threads: [], nextCursor: null });

      const results = await Promise.allSettled(targets.map(async (row) => {
        const provider = providerFor(row);
        if (!provider) return { accountEmail: row.accountEmail, threads: [], nextPageToken: null };
        const perAccountMax = accountEmail ? maxResults : Math.min(maxResults, 20);
        const r = await provider.listThreads({
          db, userId,
          accountEmail: row.accountEmail,
          maxResults: perAccountMax,
          pageToken: tokenMap[row.accountEmail] || undefined,
          query,
        });
        return {
          accountEmail: row.accountEmail,
          provider: row.provider || 'google',
          threads: (r.threads || []).map(t => ({
            ...t,
            accountEmail: row.accountEmail,
            provider: row.provider || 'google',
          })),
          nextPageToken: r.nextPageToken || null,
        };
      }));

      const merged = [];
      const nextTokens = {};
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          merged.push(...r.value.threads);
          if (r.value.nextPageToken) nextTokens[r.value.accountEmail] = r.value.nextPageToken;
        } else if (r.status === 'rejected') {
          logger.error('inbox.listThreads.accountFailed', { requestId: req.requestId, userId, error: r.reason?.message });
        }
      }
      merged.sort((a, b) => parseDate(b.date) - parseDate(a.date));
      const finalThreads = merged.slice(0, maxResults);
      const nextCursor = encodeCursor(nextTokens);
      res.json({ threads: finalThreads, nextCursor });

      // Fire-and-forget: classify any thread we don't already have a
      // classification for. Uses snippet as body source and keys off
      // latestMessageId (falls back to thread id if missing).
      (async () => {
        try {
          const ids = finalThreads.map(t => t.latestMessageId || t.id).filter(Boolean);
          const existing = await db.batchGetClassifications(userId, ids).catch(() => ({}));
          for (const t of finalThreads) {
            const mid = t.latestMessageId || t.id;
            if (!mid || existing[mid]) continue;
            classifyEmail({
              userId, messageId: mid, threadId: t.id,
              accountEmail: t.accountEmail,
              from: t.from, subject: t.subject, body: t.snippet,
              isRead: !!t.isRead,
              labelIds: t.labelIds || [],
              headers: [], // not available at list level
              db,
            }).catch(() => {});
          }
        } catch { /* swallow */ }
      })();
    } catch (err) {
      logger.error('inbox.threads.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/inbox/threads/:threadId', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { account_email: accountEmail } = req.query;
      if (!accountEmail) return res.status(400).json({ error: 'account_email required' });

      const row = await db.getGmailIntegrationByEmail(userId, accountEmail);
      if (!row) return res.status(404).json({ error: 'Account not found' });
      const provider = providerFor(row);
      if (!provider) return res.status(400).json({ error: 'Unsupported provider' });

      const thread = await provider.getThread({ db, userId, accountEmail: row.accountEmail, threadId: req.params.threadId });

      // Mark latest unread message as read (best-effort).
      const lastUnread = [...(thread.messages || [])].reverse().find(m => !m.isRead);
      if (lastUnread) {
        provider.markRead({ db, userId, accountEmail: row.accountEmail, messageId: lastUnread.id })
          .catch((err) => logger.error('inbox.autoMarkRead.failed', { requestId: req.requestId, userId, threadId: req.params.threadId, error: err.message }));
      }

      res.json({ thread: { ...thread, accountEmail: row.accountEmail, provider: row.provider || 'google' } });

      // Fire-and-forget: upgrade snippet-based classification using full
      // body of the latest message. labelIds + headers feed the label
      // map and sender-heuristic stages of the engine.
      const latest = thread.messages?.[thread.messages.length - 1];
      if (latest) {
        classifyEmail({
          userId, messageId: latest.id, threadId: thread.id,
          accountEmail: row.accountEmail,
          from: latest.from, subject: latest.subject, body: latest.body,
          isRead: !!latest.isRead,
          labelIds: latest.labelIds || [],
          headers: latest.headers || [],
          db,
        }).catch(() => {});
      }
    } catch (err) {
      logger.error('inbox.thread.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/inbox/archive', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      // Bulk shape: { threads: [{ account_email, message_id }, ...] }
      if (Array.isArray(req.body?.threads)) {
        const jobs = req.body.threads.filter(t => t?.account_email && t?.message_id);
        if (!jobs.length) return res.json({ archived: 0, failed: [] });
        const results = await Promise.allSettled(jobs.map(async (j) => {
          const row = await db.getGmailIntegrationByEmail(userId, j.account_email);
          if (!row) throw new Error('Account not found');
          const provider = providerFor(row);
          if (!provider) throw new Error('Unsupported provider');
          await provider.archiveMessage({ db, userId, accountEmail: row.accountEmail, messageId: j.message_id });
        }));
        const archived = results.filter(r => r.status === 'fulfilled').length;
        // Surface failed thread IDs so the UI can show "7 archived, 3 stuck"
        // instead of silently leaving the user wondering why some items
        // remained in the inbox. Each failed entry includes the job index
        // (so the client can reconcile) and a short reason.
        const failed = [];
        results.forEach((r, idx) => {
          if (r.status === 'rejected') {
            const reason = r.reason?.message || String(r.reason);
            failed.push({ message_id: jobs[idx].message_id, account_email: jobs[idx].account_email, reason });
            logger.warn('inbox.archive.itemFailed', { userId, messageId: jobs[idx].message_id, accountEmail: jobs[idx].account_email, reason });
          }
        });
        return res.json({ archived, failed });
      }

      // Single-thread shape (backward compat).
      const { account_email, message_id } = req.body || {};
      if (!account_email || !message_id) return res.status(400).json({ error: 'account_email and message_id required' });
      const row = await db.getGmailIntegrationByEmail(userId, account_email);
      if (!row) return res.status(404).json({ error: 'Account not found' });
      const provider = providerFor(row);
      if (!provider) return res.status(400).json({ error: 'Unsupported provider' });
      await provider.archiveMessage({ db, userId, accountEmail: row.accountEmail, messageId: message_id });
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.archive.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/inbox/mark-read', authenticateToken, async (req, res) => {
    try {
      const { account_email, message_id } = req.body || {};
      if (!account_email || !message_id) return res.status(400).json({ error: 'account_email and message_id required' });
      const row = await db.getGmailIntegrationByEmail(req.user.id, account_email);
      if (!row) return res.status(404).json({ error: 'Account not found' });
      const provider = providerFor(row);
      if (!provider) return res.status(400).json({ error: 'Unsupported provider' });
      await provider.markRead({ db, userId: req.user.id, accountEmail: row.accountEmail, messageId: message_id });
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.markRead.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/inbox/labels
   * Returns the user's Gmail labels + Outlook folders for use in the
   * "Move to..." picker. Newest-known labels first.
   */
  router.get('/api/inbox/labels', authenticateToken, async (req, res) => {
    try {
      const labels = await db.getEmailLabelsForUser(req.user.id);
      // Sort by message count desc as a rough proxy for "labels the user actually files into"
      labels.sort((a, b) => (Number(b.messageCount) || 0) - (Number(a.messageCount) || 0));
      res.json({ labels });
    } catch (err) {
      logger.error('inbox.labels.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/inbox/star
   * body: { account_email, message_id, starred: bool }
   * Toggles the Gmail STARRED label. The frontend passes the desired
   * post-state explicitly so optimistic UI doesn't have to read first.
   */
  router.post('/api/inbox/star', authenticateToken, async (req, res) => {
    try {
      const { account_email, message_id, starred } = req.body || {};
      if (!account_email || !message_id) return res.status(400).json({ error: 'account_email and message_id required' });
      const row = await db.getGmailIntegrationByEmail(req.user.id, account_email);
      if (!row) return res.status(404).json({ error: 'Account not found' });
      const provider = providerFor(row);
      if (!provider || !provider.starMessage) return res.status(400).json({ error: 'Unsupported provider' });
      await provider.starMessage({ db, userId: req.user.id, accountEmail: row.accountEmail, messageId: message_id, starred: starred !== false });
      res.json({ success: true, starred: starred !== false });
    } catch (err) {
      logger.error('inbox.star.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/inbox/move
   * body: { account_email, message_id, target_label_id, target_label_name,
   *         scope: 'thread'|'sender'|'domain' }
   * Adds target label, removes INBOX. When scope extends beyond this thread,
   * upserts an email_filing_patterns row (Aria suggests automation at 0.8+).
   */
  router.post('/api/inbox/move', authenticateToken, async (req, res) => {
    try {
      const { account_email, message_id, target_label_id, target_label_name, scope } = req.body || {};
      if (!account_email || !message_id || !target_label_id) {
        return res.status(400).json({ error: 'account_email, message_id, and target_label_id required' });
      }
      const validScopes = new Set(['thread', 'sender', 'domain']);
      const useScope = validScopes.has(scope) ? scope : 'thread';

      const row = await db.getGmailIntegrationByEmail(req.user.id, account_email);
      if (!row) return res.status(404).json({ error: 'Account not found' });
      const provider = providerFor(row);
      if (!provider || !provider.moveMessage) return res.status(400).json({ error: 'Unsupported provider' });

      const result = await provider.moveMessage({
        db, userId: req.user.id, accountEmail: row.accountEmail,
        messageId: message_id, targetLabelId: target_label_id,
      });

      let pattern = null;
      if (useScope === 'sender' || useScope === 'domain') {
        const fromHeader = result?.fromHeader || '';
        const emailMatch = fromHeader.match(/<([^>]+)>/);
        const senderEmail = (emailMatch ? emailMatch[1] : fromHeader).trim().toLowerCase();
        const matchValue = useScope === 'sender'
          ? senderEmail
          : (senderEmail.split('@')[1] || senderEmail);
        if (matchValue) {
          try {
            pattern = await db.upsertFilingPattern({
              userId: req.user.id, accountEmail: row.accountEmail,
              matchType: useScope, matchValue,
              targetLabelId: target_label_id,
              targetLabelName: target_label_name || target_label_id,
            });
          } catch (e) {
            logger.warn('inbox.move.patternUpsert.failed', { requestId: req.requestId, userId: req.user.id, error: e.message });
          }
        }
      }

      res.json({
        success: true,
        moved_to: target_label_name || target_label_id,
        scope: useScope,
        pattern_confidence: pattern?.confidence ?? null,
        pattern_times_applied: pattern?.times_applied ?? null,
      });
    } catch (err) {
      logger.error('inbox.move.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
