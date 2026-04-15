'use strict';

/**
 * server/lib/outlookMailScan.cjs — Outlook mail flag/summarise/store loop.
 *
 * Mirrors the Gmail scanOneAccount pipeline from server/routes/gmail.cjs:
 *   1. List recent inbox messages from Graph
 *   2. Flag VIP + trigger-keyword matches against the user's Gmail config
 *      (shared across providers in V1 — no separate Outlook config yet)
 *   3. Dedup against inbox_items by source_id
 *   4. Haiku-summarise new flagged messages
 *   5. INSERT into inbox_items with source='outlook'
 *
 * V1 deliberately shares the Gmail "Email Intelligence" config (vip/
 * keyword/exclusion rules) — the semantics are identical regardless of
 * provider, and there is no UX yet for per-provider tuning.
 */

const axios = require('axios');
const logger = require('../../guardrails/logger.cjs');
const { GRAPH_BASE, listOutlookAccounts, withFreshAccessToken } = require('../utils/outlook.cjs');
const { resolveOrCreateContact } = require('./contactIngestion.cjs');

const NOREPLY_PATTERN = /noreply|no-reply|donotreply|do-not-reply|notifications@|mailer@/i;

async function scanOneOutlookAccount({ userId, account, config, db, requestId }) {
  const { vipSenders = [], triggerKeywords = [], excludedSenders = [], autoExcludeNoreply = true, scanWindow = '24h' } = config;
  const hours = scanWindow === '6h' ? 6 : scanWindow === '48h' ? 48 : 24;
  const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();

  let tokens;
  try { tokens = await withFreshAccessToken(account, db, userId); }
  catch (e) {
    logger.warn('outlookScan.tokenRefresh.failed', { requestId, userId, accountEmail: account.accountEmail, error: e.message });
    return { newItems: 0, error: 'invalid_grant' };
  }

  const qs = new URLSearchParams({
    $select: 'id,subject,from,bodyPreview,receivedDateTime,webLink,conversationId',
    $top: '50',
    $orderby: 'receivedDateTime desc',
    $filter: `receivedDateTime ge ${sinceIso}`,
  });
  const url = `${GRAPH_BASE}/me/mailFolders/Inbox/messages?${qs.toString()}`;

  let messages;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error('outlookScan.fetch.failed', { requestId, userId, accountEmail: account.accountEmail, status: res.status, body: body.slice(0, 500) });
      return { newItems: 0, error: `http_${res.status}` };
    }
    const json = await res.json();
    messages = Array.isArray(json.value) ? json.value : [];
  } catch (err) {
    logger.error('outlookScan.fetch.threw', { requestId, userId, accountEmail: account.accountEmail, error: err.message });
    return { newItems: 0, error: err.message };
  }

  const flagged = [];
  for (const msg of messages) {
    const fromAddr = (msg.from?.emailAddress?.address || '').toLowerCase();
    const fromName = msg.from?.emailAddress?.name || '';
    const subject = msg.subject || '';
    const snippet = msg.bodyPreview || '';
    const searchText = `${subject} ${snippet}`.toLowerCase();

    if (autoExcludeNoreply && NOREPLY_PATTERN.test(fromAddr)) continue;
    if (excludedSenders.some((ex) => fromAddr.includes(ex.toLowerCase()))) continue;

    const isVip = vipSenders.some((v) => fromAddr.includes(v.toLowerCase()));
    const matchedKeyword = triggerKeywords.find((kw) => searchText.includes(kw.toLowerCase()));
    if (isVip) flagged.push({ msg, type: 'VIP', reason: `From VIP sender: ${fromName || fromAddr}`, fromName, fromAddr });
    else if (matchedKeyword) flagged.push({ msg, type: 'KEYWORD', reason: `Contains keyword: "${matchedKeyword}"`, fromName, fromAddr });
  }

  const newFlagged = [];
  for (const f of flagged) {
    const exists = await db.inboxItemExistsBySourceId(userId, f.msg.id);
    if (!exists) newFlagged.push(f);
  }
  if (!newFlagged.length) return { newItems: 0 };

  const apiKey = process.env.CLAUDE_API_KEY;
  let newCount = 0;
  for (let i = 0; i < newFlagged.length; i += 10) {
    const chunk = newFlagged.slice(i, i + 10);
    const summaries = await Promise.allSettled(chunk.map(async (f) => {
      const subject = f.msg.subject || '';
      const snippet = f.msg.bodyPreview || '';
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
          logger.error('outlookScan.summaryFailed', { requestId, userId, messageId: f.msg.id, error: err.message });
        }
      }
      return { ...f, summary };
    }));

    for (const result of summaries) {
      if (result.status !== 'fulfilled') continue;
      const f = result.value;
      const id = `inbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await db.createInboxItem({
        id, userId, type: f.type,
        title: f.msg.subject || '(no subject)',
        summary: f.summary,
        source: 'outlook',
        sourceId: f.msg.id,
        gmailThreadId: f.msg.conversationId || null,
        gmailLink: f.msg.webLink || null,
        sender: `${f.fromName || ''} <${f.fromAddr}>`.trim(),
      });
      // Fire-and-forget contact ingestion — never await, never block.
      resolveOrCreateContact(userId, {
        email: f.fromAddr,
        name: f.fromName,
        source: 'mail_scan',
        snippet: `${f.msg.subject || ''}\n${f.msg.bodyPreview || ''}`.trim(),
      }).catch((err) => console.error('[contactIngestion] mail:', err.message));
      newCount++;
    }
  }
  return { newItems: newCount };
}

async function scanOutlookMailForUser({ userId, db, requestId }) {
  const accounts = await listOutlookAccounts(userId, db);
  if (!accounts.length) return { error: 'not_connected', newItems: 0 };

  const config = (await db.getGmailConfigForUser(userId)) || {
    vipSenders: [], triggerKeywords: [],
    excludedSenders: [], autoExcludeNoreply: true,
    scanWindow: '24h',
  };

  let total = 0;
  const perAccount = [];
  for (const acct of accounts) {
    const r = await scanOneOutlookAccount({ userId, account: acct, config, db, requestId });
    perAccount.push({ accountEmail: acct.accountEmail || '', ...r });
    total += r.newItems || 0;
  }
  logger.info('outlookScan.complete', { requestId, userId, total, accounts: accounts.length });
  return { newItems: total, accounts: perAccount };
}

module.exports = { scanOutlookMailForUser };
