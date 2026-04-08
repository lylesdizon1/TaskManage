'use strict';

const express = require('express');
const axios = require('axios');

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

module.exports = function createGmailRouter({ authenticateToken, db, makeGmailOAuth2Client, saveGmailTokens, loadGmailTokens, google }) {
  const router = express.Router();

  /**
   * GET /api/gmail/auth-url
   * Returns the Google OAuth consent URL for Gmail readonly access.
   */
  router.get('/api/gmail/auth-url', authenticateToken, (req, res) => {
    const oauth2 = makeGmailOAuth2Client();
    if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)' });

    const userId = req.user.id;

    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GMAIL_SCOPES,
      state: userId,
    });
    res.json({ url });
  });

  /**
   * GET /api/gmail/callback?code=...&state=userId
   * Google redirects here after consent. Exchanges code for tokens and stores them.
   */
  router.get('/api/gmail/callback', async (req, res) => {
    const oauth2 = makeGmailOAuth2Client();
    if (!oauth2) return res.status(500).send('Google OAuth not configured');

    const { code, state: userId } = req.query;
    if (!code || !userId) return res.status(400).send('Missing code or state');

    try {
      const { tokens } = await oauth2.getToken(code);
      await saveGmailTokens(userId, tokens);
      console.log(`[gmail] Stored tokens for ${userId}`);
      res.redirect('/?gmail=connected');
    } catch (err) {
      console.error('[gmail] Token exchange failed:', err.message);
      res.status(500).send(`Gmail auth failed: ${err.message}`);
    }
  });

  /**
   * GET /api/gmail/status
   * Returns { connected: bool, email?: string }
   */
  router.get('/api/gmail/status', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    const tokens = await loadGmailTokens(userId);
    if (!tokens) return res.json({ connected: false });

    const oauth2 = makeGmailOAuth2Client();
    if (!oauth2) return res.json({ connected: false });

    oauth2.setCredentials(tokens);
    oauth2.on('tokens', async (newTokens) => {
      const existing = await loadGmailTokens(userId);
      await saveGmailTokens(userId, { ...existing, ...newTokens });
    });

    try {
      const gmail = google.gmail({ version: 'v1', auth: oauth2 });
      const { data } = await gmail.users.getProfile({ userId: 'me' });
      res.json({ connected: true, email: data.emailAddress });
    } catch (err) {
      console.error('[gmail] status check failed:', err.message);
      await db.deleteGmailTokensForUser(userId);
      res.json({ connected: false });
    }
  });

  /**
   * DELETE /api/gmail/disconnect
   * Removes stored Gmail tokens for the user.
   */
  router.delete('/api/gmail/disconnect', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    await db.deleteGmailTokensForUser(userId);
    console.log(`[gmail] Disconnected ${userId}`);
    res.json({ success: true });
  });

  /**
   * GET /api/gmail/config
   * Returns the user's Email Intelligence config.
   */
  router.get('/api/gmail/config', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    const config = await db.getGmailConfigForUser(userId);
    res.json(config || { vipSenders: [], triggerKeywords: [], commitmentDetection: true, excludedSenders: [], autoExcludeNoreply: true });
  });

  /**
   * PUT /api/gmail/config
   * Body: { config: { vipSenders, triggerKeywords, commitmentDetection } }
   */
  router.put('/api/gmail/config', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    const { config } = req.body;
    if (!config) return res.status(400).json({ error: 'config required' });

    await db.setGmailConfigForUser(userId, config);
    console.log(`[gmail] Saved config for ${userId}`);
    res.json({ success: true });
  });

  /**
   * POST /api/gmail/scan
   * Scans recent emails, flags VIP/keyword/commitment matches, summarises with Claude,
   * and writes new inbox_items (deduplicated by gmail message ID).
   * Returns { newItems: number }
   */
  router.post('/api/gmail/scan', authenticateToken, async (req, res) => {
    const userId = req.user.id;

    const tokens = await loadGmailTokens(userId);
    if (!tokens) return res.status(401).json({ error: 'Gmail not connected' });

    const config = (await db.getGmailConfigForUser(userId)) || { vipSenders: [], triggerKeywords: [], commitmentDetection: true, excludedSenders: [], autoExcludeNoreply: true };
    const { vipSenders, triggerKeywords, commitmentDetection, excludedSenders = [], autoExcludeNoreply = true } = config;

    const oauth2 = makeGmailOAuth2Client();
    if (!oauth2) return res.status(500).json({ error: 'Google OAuth not configured' });

    oauth2.setCredentials(tokens);
    oauth2.on('tokens', async (newTokens) => {
      const existing = await loadGmailTokens(userId);
      await saveGmailTokens(userId, { ...existing, ...newTokens });
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2 });

    try {
      // ── Fetch inbox messages ──
      const inboxList = await gmail.users.messages.list({ userId: 'me', maxResults: 50, q: 'in:inbox' });
      const inboxIds = (inboxList.data.messages || []).map((m) => m.id);

      const inboxMessages = await Promise.all(
        inboxIds.map((id) =>
          gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
            .then((r) => r.data)
            .catch(() => null),
        ),
      );

      // ── Fetch sent messages (if commitment detection) ──
      let sentMessages = [];
      if (commitmentDetection) {
        const sentList = await gmail.users.messages.list({ userId: 'me', maxResults: 20, q: 'in:sent' });
        const sentIds = (sentList.data.messages || []).map((m) => m.id);
        sentMessages = await Promise.all(
          sentIds.map((id) =>
            gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['To', 'Subject', 'Date'] })
              .then((r) => r.data)
              .catch(() => null),
          ),
        );
      }

      // ── Helper: extract header value ──
      const getHeader = (msg, name) => {
        const h = (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
        return h ? h.value : '';
      };

      // ── Flag inbox messages ──
      const flagged = [];

      const NOREPLY_PATTERN = /noreply|no-reply|donotreply|do-not-reply|notifications@|mailer@/i;

      for (const msg of inboxMessages) {
        if (!msg) continue;
        const from = getHeader(msg, 'From').toLowerCase();
        const subject = getHeader(msg, 'Subject');
        const snippet = msg.snippet || '';
        const searchText = `${subject} ${snippet}`.toLowerCase();

        // Skip excluded senders
        if (autoExcludeNoreply && NOREPLY_PATTERN.test(from)) continue;
        const isExcluded = excludedSenders.some((ex) => {
          const el = ex.toLowerCase();
          return el.startsWith('@') ? from.includes(el) : from.includes(el);
        });
        if (isExcluded) continue;

        // Check VIP
        const isVip = vipSenders.some((v) => {
          const vl = v.toLowerCase();
          return vl.startsWith('@') ? from.includes(vl) : from.includes(vl);
        });

        // Check keywords
        const matchedKeyword = triggerKeywords.find((kw) => searchText.includes(kw.toLowerCase()));

        if (isVip) {
          flagged.push({ msg, type: 'VIP', reason: `From VIP sender: ${getHeader(msg, 'From')}` });
        } else if (matchedKeyword) {
          flagged.push({ msg, type: 'KEYWORD', reason: `Contains keyword: "${matchedKeyword}"` });
        }
      }

      // ── Flag sent messages for commitments ──
      const commitmentPattern = /\bI'll\b|\bI will\b|\bsending over\b|\bI can have\b|\bI'll get\b|\bwill send\b|\bI promise\b/i;

      if (commitmentDetection) {
        for (const msg of sentMessages) {
          if (!msg) continue;
          const snippet = msg.snippet || '';
          if (commitmentPattern.test(snippet)) {
            flagged.push({ msg, type: 'COMMITMENT', reason: `Commitment detected in sent email` });
          }
        }
      }

      // ── Deduplicate against existing inbox items ──
      const newFlagged = [];
      for (const f of flagged) {
        const exists = await db.inboxItemExistsBySourceId(userId, f.msg.id);
        if (!exists) newFlagged.push(f);
      }

      if (newFlagged.length === 0) {
        return res.json({ newItems: 0 });
      }

      // ── Summarise with Claude (in chunks of 10) ──
      const apiKey = process.env.CLAUDE_API_KEY;
      const chunks = [];
      for (let i = 0; i < newFlagged.length; i += 10) {
        chunks.push(newFlagged.slice(i, i + 10));
      }

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
                  {
                    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
                    timeout: 15_000,
                  },
                );
                const text = resp.data?.content?.[0]?.text;
                if (text) summary = text.trim();
              } catch (err) {
                console.error(`[gmail-scan] Claude summary failed for ${f.msg.id}:`, err.message);
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
            id,
            userId,
            type: f.type,
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

      console.log(`[gmail-scan] ${newCount} new items for ${userId}`);
      res.json({ newItems: newCount });
    } catch (err) {
      console.error('[gmail-scan] failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
