'use strict';

const express = require('express');
const axios = require('axios');
const logger = require('../../guardrails/logger.cjs');
const { encryptTokens, decryptTokens, ENCRYPTION_KEY } = require('../utils/crypto.cjs');

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

// Wrap raw tokens for storage (encrypt if key is set).
function wrapTokens(tokens) {
  if (ENCRYPTION_KEY) return { _enc: encryptTokens(tokens) };
  return tokens;
}

// Unwrap stored tokens back to plain object.
function unwrapTokens(stored) {
  if (!stored) return null;
  if (stored._enc) return decryptTokens(stored._enc);
  return stored;
}

module.exports = function createGmailRouter({ authenticateToken, db, makeGmailOAuth2Client, google }) {
  const router = express.Router();

  // ── Gmail account helpers (backed by user_integrations rows) ───────────────

  async function listGmailAccounts(userId) {
    const rows = await db.getUserIntegrationsByType(userId, 'gmail');
    return rows.map((r) => ({
      id: r.id,
      accountEmail: r.accountEmail || '',
      tokens: unwrapTokens(r.config?.tokens),
      createdAt: r.createdAt,
    }));
  }

  async function saveGmailAccount(userId, accountEmail, tokens) {
    return db.upsertUserIntegration(
      userId,
      'gmail',
      { tokens: wrapTokens(tokens) },
      true,
      accountEmail || '',
    );
  }

  /**
   * GET /api/gmail/auth-url — Google OAuth consent URL (readonly scope).
   */
  router.get('/api/gmail/auth-url', authenticateToken, (req, res) => {
    const oauth2 = makeGmailOAuth2Client();
    if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)' });

    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GMAIL_SCOPES,
      state: req.user.id,
    });
    res.json({ url });
  });

  /**
   * GET /api/gmail/callback?code=...&state=userId
   * Exchanges code for tokens, fetches the connected Google email, and
   * stores one row per (user_id, 'gmail', account_email) in user_integrations.
   * Reconnecting the same account updates tokens only; never overwrites a
   * different account's row.
   */
  router.get('/api/gmail/callback', async (req, res) => {
    const oauth2 = makeGmailOAuth2Client();
    if (!oauth2) return res.status(500).send('Google OAuth not configured');

    const { code, state: userId } = req.query;
    if (!code || !userId) return res.status(400).send('Missing code or state');

    try {
      const { tokens } = await oauth2.getToken(code);
      oauth2.setCredentials(tokens);
      const gmail = google.gmail({ version: 'v1', auth: oauth2 });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const accountEmail = profile.data.emailAddress;
      if (!accountEmail) throw new Error('Failed to resolve Google account email');

      // Merge any legacy placeholder row (account_email='') into the real one
      // by first clearing the placeholder if the real row already exists.
      const existing = await db.getUserIntegration(userId, 'gmail', accountEmail);
      if (existing) {
        await saveGmailAccount(userId, accountEmail, tokens);
      } else {
        // Promote placeholder if present; else insert new row.
        const placeholder = await db.getUserIntegration(userId, 'gmail', '');
        if (placeholder) {
          await db.deleteUserIntegrationById(placeholder.id, userId).catch(() => {});
        }
        await saveGmailAccount(userId, accountEmail, tokens);
      }

      logger.info('gmail.account.connected', { userId, accountEmail });
      res.redirect('/?gmail=connected');
    } catch (err) {
      logger.error('gmail.tokenExchange.failed', { userId, error: err.message });
      res.status(500).send(`Gmail auth failed: ${err.message}`);
    }
  });

  /**
   * GET /api/gmail/accounts — all connected Gmail accounts for the user.
   * Shape: [{ id, account_email, created_at }]
   */
  router.get('/api/gmail/accounts', authenticateToken, async (req, res) => {
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
      logger.error('gmail.accounts.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/gmail/accounts/:id — remove a single connected Gmail account.
   * The row must belong to req.user.id.
   */
  router.delete('/api/gmail/accounts/:id', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

      const row = await db.getUserIntegrationById(id, req.user.id);
      if (!row || row.type !== 'gmail') return res.status(404).json({ error: 'Account not found' });

      await db.deleteUserIntegrationById(id, req.user.id);
      logger.info('gmail.account.disconnected', { userId: req.user.id, accountEmail: row.accountEmail });
      res.json({ success: true });
    } catch (err) {
      logger.error('gmail.account.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/gmail/status
   * Backward-compat: returns { connected: bool, email?: string } where
   * `email` is the first connected account (if any). For multi-account UI
   * use GET /api/gmail/accounts.
   */
  router.get('/api/gmail/status', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const accounts = await listGmailAccounts(userId);
    if (!accounts.length) return res.json({ connected: false });

    // Prefer a row that already has a real account_email; otherwise upgrade
    // the placeholder by calling getProfile once and saving.
    let named = accounts.find((a) => a.accountEmail);
    if (!named) {
      const placeholder = accounts[0];
      const oauth2 = makeGmailOAuth2Client();
      if (!oauth2 || !placeholder.tokens) return res.json({ connected: false });

      oauth2.setCredentials(placeholder.tokens);
      try {
        const gmail = google.gmail({ version: 'v1', auth: oauth2 });
        const { data } = await gmail.users.getProfile({ userId: 'me' });
        const email = data.emailAddress;
        if (email) {
          await saveGmailAccount(userId, email, placeholder.tokens);
          await db.deleteUserIntegrationById(placeholder.id, userId).catch(() => {});
          named = { accountEmail: email };
        }
      } catch (err) {
        logger.error('gmail.status.upgradeFailed', { requestId: req.requestId, userId, error: err.message });
        // Placeholder tokens no longer work — remove so the user can reconnect.
        await db.deleteUserIntegrationById(placeholder.id, userId).catch(() => {});
        return res.json({ connected: false });
      }
    }

    res.json({ connected: true, email: named?.accountEmail || '' });
  });

  /**
   * DELETE /api/gmail/disconnect — remove all Gmail accounts for the user.
   * Kept for backward compatibility; prefer DELETE /api/gmail/accounts/:id.
   */
  router.delete('/api/gmail/disconnect', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const rows = await db.getUserIntegrationsByType(userId, 'gmail');
      for (const r of rows) await db.deleteUserIntegrationById(r.id, userId);
      logger.info('gmail.disconnected.all', { requestId: req.requestId, userId, count: rows.length });
      res.json({ success: true });
    } catch (err) {
      logger.error('gmail.disconnect.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/gmail/config — Email Intelligence config including scan cadence.
   */
  router.get('/api/gmail/config', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const config = await db.getGmailConfigForUser(userId);
    res.json(config || {
      vipSenders: [], triggerKeywords: [], commitmentDetection: true,
      excludedSenders: [], autoExcludeNoreply: true,
      scanFrequency: '1h', scanWindow: '24h',
    });
  });

  /**
   * PUT /api/gmail/config — full replace of the config blob.
   */
  router.put('/api/gmail/config', authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id;
      const { config } = req.body;
      if (!config) return res.status(400).json({ error: 'config required' });

      await db.setGmailConfigForUser(userId, config);
      logger.info('gmail.config.saved', { requestId: req.requestId, userId });
      res.json({ success: true });
    } catch (err) {
      logger.error('gmail.config.save.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  // ── Single-account scan logic, factored so /scan can run it per account ──
  async function scanOneAccount({ userId, account, config, requestId }) {
    const { vipSenders = [], triggerKeywords = [], commitmentDetection = true,
            excludedSenders = [], autoExcludeNoreply = true, scanWindow = '24h' } = config;

    const oauth2 = makeGmailOAuth2Client();
    if (!oauth2 || !account.tokens) return { newItems: 0, error: 'oauth_unavailable' };
    oauth2.setCredentials(account.tokens);
    oauth2.on('tokens', async (newTokens) => {
      const merged = { ...account.tokens, ...newTokens };
      await saveGmailAccount(userId, account.accountEmail || '', merged);
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2 });

    // Scan-window filter (Gmail query uses `newer_than:Nh|d`).
    const windowQ = scanWindow === '6h' ? 'newer_than:6h'
      : scanWindow === '48h' ? 'newer_than:2d'
      : 'newer_than:1d';

    try {
      const inboxList = await gmail.users.messages.list({ userId: 'me', maxResults: 50, q: `in:inbox ${windowQ}` });
      const inboxIds = (inboxList.data.messages || []).map((m) => m.id);
      const inboxMessages = await Promise.all(
        inboxIds.map((id) =>
          gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
            .then((r) => r.data).catch(() => null),
        ),
      );

      let sentMessages = [];
      if (commitmentDetection) {
        const sentList = await gmail.users.messages.list({ userId: 'me', maxResults: 20, q: `in:sent ${windowQ}` });
        const sentIds = (sentList.data.messages || []).map((m) => m.id);
        sentMessages = await Promise.all(
          sentIds.map((id) =>
            gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['To', 'Subject', 'Date'] })
              .then((r) => r.data).catch(() => null),
          ),
        );
      }

      const getHeader = (msg, name) => {
        const h = (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : '';
      };

      const NOREPLY_PATTERN = /noreply|no-reply|donotreply|do-not-reply|notifications@|mailer@/i;
      const flagged = [];

      for (const msg of inboxMessages) {
        if (!msg) continue;
        const from = getHeader(msg, 'From').toLowerCase();
        const subject = getHeader(msg, 'Subject');
        const snippet = msg.snippet || '';
        const searchText = `${subject} ${snippet}`.toLowerCase();

        if (autoExcludeNoreply && NOREPLY_PATTERN.test(from)) continue;
        const isExcluded = excludedSenders.some((ex) => from.includes(ex.toLowerCase()));
        if (isExcluded) continue;

        const isVip = vipSenders.some((v) => from.includes(v.toLowerCase()));
        const matchedKeyword = triggerKeywords.find((kw) => searchText.includes(kw.toLowerCase()));

        if (isVip) flagged.push({ msg, type: 'VIP', reason: `From VIP sender: ${getHeader(msg, 'From')}` });
        else if (matchedKeyword) flagged.push({ msg, type: 'KEYWORD', reason: `Contains keyword: "${matchedKeyword}"` });
      }

      const commitmentPattern = /\bI'll\b|\bI will\b|\bsending over\b|\bI can have\b|\bI'll get\b|\bwill send\b|\bI promise\b/i;
      if (commitmentDetection) {
        for (const msg of sentMessages) {
          if (!msg) continue;
          const snippet = msg.snippet || '';
          if (commitmentPattern.test(snippet)) {
            flagged.push({ msg, type: 'COMMITMENT', reason: 'Commitment detected in sent email' });
          }
        }
      }

      const newFlagged = [];
      for (const f of flagged) {
        const exists = await db.inboxItemExistsBySourceId(userId, f.msg.id);
        if (!exists) newFlagged.push(f);
      }
      if (newFlagged.length === 0) return { newItems: 0 };

      const apiKey = process.env.CLAUDE_API_KEY;
      const chunks = [];
      for (let i = 0; i < newFlagged.length; i += 10) chunks.push(newFlagged.slice(i, i + 10));

      let newCount = 0;
      for (const chunk of chunks) {
        const summaries = await Promise.allSettled(
          chunk.map(async (f) => {
            const subject = getHeader(f.msg, 'Subject');
            const snippet = f.msg.snippet || '';
            let summary = `${subject} — ${snippet}`.slice(0, 200);
            if (apiKey) {
              try {
                const resp = await axios.post(
                  'https://api.anthropic.com/v1/messages',
                  {
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 150,
                    messages: [{
                      role: 'user',
                      content: `Summarize this email in exactly 2 sentences. Subject: "${subject}". Preview: "${snippet}". Flagged as ${f.type} because: ${f.reason}. Return only the summary, nothing else.`,
                    }],
                  },
                  { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 15_000 },
                );
                const text = resp.data?.content?.[0]?.text;
                if (text) summary = text.trim();
              } catch (err) {
                logger.error('gmailScan.summaryFailed', { requestId, userId, messageId: f.msg.id, error: err.message });
              }
            }
            return { ...f, summary };
          }),
        );

        for (const result of summaries) {
          if (result.status !== 'fulfilled') continue;
          const f = result.value;
          const subject = getHeader(f.msg, 'Subject');
          const id = `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          await db.createInboxItem({
            id, userId, type: f.type,
            title: subject || '(no subject)',
            summary: f.summary,
            source: 'gmail',
            sourceId: f.msg.id,
            gmailThreadId: f.msg.threadId || null,
            gmailLink: `https://mail.google.com/mail/u/0/#inbox/${f.msg.id}`,
            sender: f.type !== 'COMMITMENT' ? getHeader(f.msg, 'From') : null,
          });
          newCount++;
        }
      }
      return { newItems: newCount };
    } catch (err) {
      if (err.message?.includes('invalid_grant') || err.response?.data?.error === 'invalid_grant') {
        logger.warn('gmail.invalidGrant', { requestId, userId, accountEmail: account.accountEmail });
        return { newItems: 0, error: 'invalid_grant' };
      }
      logger.error('gmailScan.failed', { requestId, userId, accountEmail: account.accountEmail, error: err.message });
      return { newItems: 0, error: err.message };
    }
  }

  /**
   * POST /api/gmail/scan — iterate all connected Gmail accounts, run the
   * flag/summarise/store pipeline against each, merge results.
   */
  router.post('/api/gmail/scan', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const accounts = await listGmailAccounts(userId);
    if (!accounts.length) return res.status(401).json({ error: 'Gmail not connected' });

    const config = (await db.getGmailConfigForUser(userId)) || {
      vipSenders: [], triggerKeywords: [], commitmentDetection: true,
      excludedSenders: [], autoExcludeNoreply: true,
      scanFrequency: '1h', scanWindow: '24h',
    };

    const perAccount = [];
    let total = 0;
    let anyInvalidGrant = false;

    for (const acct of accounts) {
      const r = await scanOneAccount({ userId, account: acct, config, requestId: req.requestId });
      perAccount.push({ accountEmail: acct.accountEmail || '', ...r });
      total += r.newItems || 0;
      if (r.error === 'invalid_grant') anyInvalidGrant = true;
    }

    logger.info('gmailScan.complete', { requestId: req.requestId, userId, total, accounts: accounts.length });
    if (anyInvalidGrant && total === 0) {
      return res.status(401).json({ error: 'One or more Gmail accounts need reconnecting.', accounts: perAccount });
    }
    res.json({ newItems: total, accounts: perAccount });
  });

  return router;
};
