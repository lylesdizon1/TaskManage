'use strict';

/**
 * server/routes/outlook.cjs — Microsoft OAuth + calendar/mail status.
 *
 * Mirrors the Google combo route (gcal.cjs + gmail.cjs) with a single
 * integration_type='outlook' row in user_integrations. V1 routes:
 *
 *   GET    /api/outlook/auth-url   — consent URL
 *   GET    /api/outlook/callback   — code exchange + account_email capture
 *   GET    /api/outlook/status     — { connected, email, accounts[] }
 *   GET    /api/outlook/accounts   — array of connected Microsoft accounts
 *   DELETE /api/outlook/accounts/:id — disconnect one
 *   DELETE /api/outlook/disconnect — disconnect all
 *   POST   /api/outlook/scan       — trigger mail scan for this user
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const {
  buildAuthUrl, exchangeCodeForTokens, fetchUserProfile,
  saveOutlookAccount, listOutlookAccounts, getClientConfig,
} = require('../utils/outlook.cjs');

module.exports = function createOutlookRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/outlook/auth-url', authenticateToken, (req, res) => {
    const url = buildAuthUrl(req.user.id);
    if (!url) return res.status(500).json({ error: 'Outlook OAuth not configured (set OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET)' });
    res.json({ url });
  });

  router.get('/api/outlook/callback', async (req, res) => {
    const { code, state: userId, error, error_description: errDesc } = req.query;
    if (error) return res.status(400).send(`Outlook auth failed: ${errDesc || error}`);
    if (!code || !userId) return res.status(400).send('Missing code or state');
    if (!getClientConfig()) return res.status(500).send('Outlook OAuth not configured');

    try {
      const tokens = await exchangeCodeForTokens(code);
      const profile = await fetchUserProfile(tokens.access_token);
      const accountEmail = profile.email || `unknown-${Date.now()}`;

      // Dedup placeholder-email rows (empty account_email) for this user.
      const placeholder = await db.getUserIntegration(userId, 'outlook', '');
      if (placeholder) {
        await db.deleteUserIntegrationById(placeholder.id, userId).catch(() => {});
      }
      await saveOutlookAccount(userId, accountEmail, tokens, db);

      logger.info('outlook.account.connected', { userId, accountEmail });
      res.redirect('/?outlook=connected');
    } catch (err) {
      logger.error('outlook.tokenExchange.failed', { userId, error: err.message });
      res.status(500).send(`Outlook auth failed: ${err.message}`);
    }
  });

  router.get('/api/outlook/status', authenticateToken, async (req, res) => {
    const accounts = await listOutlookAccounts(req.user.id, db);
    if (!accounts.length) return res.json({ connected: false, accounts: [] });
    const primary = accounts[0];
    res.json({
      connected: true,
      email: primary.accountEmail || null,
      accounts: accounts.map((a) => ({ id: a.id, email: a.accountEmail || '', createdAt: a.createdAt })),
    });
  });

  router.get('/api/outlook/accounts', authenticateToken, async (req, res) => {
    try {
      const rows = await db.getUserIntegrationsByType(req.user.id, 'outlook');
      res.json(rows.map((r) => ({
        id: r.id,
        account_email: r.accountEmail || '',
        provider: r.provider || 'microsoft',
        created_at: r.createdAt,
      })));
    } catch (err) {
      logger.error('outlook.accounts.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/outlook/accounts/:id', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
      const row = await db.getUserIntegrationById(id, req.user.id);
      if (!row || row.type !== 'outlook') return res.status(404).json({ error: 'Account not found' });
      await db.deleteUserIntegrationById(id, req.user.id);
      logger.info('outlook.account.disconnected', { userId: req.user.id, accountEmail: row.accountEmail });
      res.json({ success: true });
    } catch (err) {
      logger.error('outlook.account.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/outlook/disconnect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const rows = await db.getUserIntegrationsByType(userId, 'outlook');
      for (const r of rows) await db.deleteUserIntegrationById(r.id, userId);
      logger.info('outlook.disconnected.all', { requestId: req.requestId, userId, count: rows.length });
      res.json({ success: true });
    } catch (err) {
      logger.error('outlook.disconnect.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // Manual trigger — runs BOTH calendar sync and mail scan since one
  // Outlook integration bundles both feeds. Useful for forcing a refresh
  // after first connect without waiting for the next 15-min cron tick.
  router.post('/api/outlook/scan', authenticateToken, async (req, res) => {
    try {
      const { scanOutlookMailForUser } = require('../lib/outlookMailScan.cjs');
      const { syncOutlookForUser } = require('../lib/outlookCalSync.cjs');
      const tz = req.user.timezone || 'America/Los_Angeles';

      // Calendar sync runs first — never throws (internal try/catch).
      await syncOutlookForUser(req.user.id, tz, db);

      // Then mail scan.
      const mailResult = await scanOutlookMailForUser({ userId: req.user.id, db, requestId: req.requestId });
      if (mailResult.error === 'not_connected') {
        return res.status(401).json({ error: 'Outlook not connected' });
      }
      return res.json({ calendar: 'synced', mail: mailResult });
    } catch (err) {
      logger.error('outlook.scan.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
