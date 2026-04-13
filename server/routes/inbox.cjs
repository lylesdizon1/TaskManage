'use strict';

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const googleProvider = require('../lib/providers/googleEmailProvider.cjs');
const { classifyEmail } = require('../lib/classificationEngine.cjs');

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
   * Returns all inbox_items for the authenticated user.
   */
  router.get('/api/inbox/items', authenticateToken, async (req, res) => {
    try {
      const items = await db.getInboxItemsForUser(req.user.id);
      res.json(items);
    } catch (err) {
      logger.error('inbox.fetch.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
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
      await db.updateInboxItemAction(req.params.id, action);
      res.json({ success: true });
    } catch (err) {
      logger.error('inbox.actionUpdate.failed', { requestId: req.requestId, userId: req.user?.id, itemId: req.params.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Provider-backed thread routes (no DB persistence) ──────────────────

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
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inbox/threads', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { account_email: accountEmail, query } = req.query;
      const maxResults = Math.min(parseInt(req.query.max_results, 10) || 20, 50);

      const allRows = await db.getUserIntegrationsByType(userId, 'gmail');
      const targets = accountEmail
        ? allRows.filter(r => (r.accountEmail || '').toLowerCase() === String(accountEmail).toLowerCase())
        : allRows;
      if (!targets.length) return res.json({ threads: [] });

      const results = await Promise.allSettled(targets.map(async (row) => {
        const provider = providerFor(row);
        if (!provider) return { threads: [] };
        const perAccountMax = accountEmail ? maxResults : Math.min(maxResults, 20);
        const r = await provider.listThreads({
          db, userId,
          accountEmail: row.accountEmail,
          maxResults: perAccountMax,
          query,
        });
        return (r.threads || []).map(t => ({
          ...t,
          accountEmail: row.accountEmail,
          provider: row.provider || 'google',
        }));
      }));

      const merged = [];
      for (const r of results) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) merged.push(...r.value);
        else if (r.status === 'rejected') {
          logger.error('inbox.listThreads.accountFailed', { requestId: req.requestId, userId, error: r.reason?.message });
        }
      }
      merged.sort((a, b) => parseDate(b.date) - parseDate(a.date));
      const finalThreads = merged.slice(0, maxResults);
      res.json({ threads: finalThreads });

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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/inbox/archive', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      // Bulk shape: { threads: [{ account_email, message_id }, ...] }
      if (Array.isArray(req.body?.threads)) {
        const jobs = req.body.threads.filter(t => t?.account_email && t?.message_id);
        if (!jobs.length) return res.json({ archived: 0 });
        const results = await Promise.allSettled(jobs.map(async (j) => {
          const row = await db.getGmailIntegrationByEmail(userId, j.account_email);
          if (!row) throw new Error('Account not found');
          const provider = providerFor(row);
          if (!provider) throw new Error('Unsupported provider');
          await provider.archiveMessage({ db, userId, accountEmail: row.accountEmail, messageId: j.message_id });
        }));
        const archived = results.filter(r => r.status === 'fulfilled').length;
        return res.json({ archived });
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
      res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
