'use strict';

/**
 * server/lib/providers/googleEmailProvider.cjs — Gmail API v1 implementation
 * of the EmailProvider interface. No DB writes — all state lives in Gmail.
 */

const { google } = require('googleapis');
const { makeGmailOAuth2Client } = require('../../utils/google.cjs');
const { decryptTokens } = require('../../utils/crypto.cjs');

async function _gmailClient(db, userId, accountEmail) {
  const row = await db.getGmailIntegrationByEmail(userId, accountEmail);
  if (!row) throw new Error(`No Gmail tokens for ${accountEmail}`);
  const stored = row.config?.tokens;
  if (!stored) throw new Error(`No Gmail tokens for ${accountEmail}`);
  const tokens = stored._enc ? decryptTokens(stored._enc) : stored;

  const oauth2 = makeGmailOAuth2Client();
  if (!oauth2) throw new Error('Google OAuth not configured on server');
  oauth2.setCredentials(tokens);
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function _headerVal(headers, name) {
  if (!Array.isArray(headers)) return '';
  const h = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return h ? (h.value || '') : '';
}

function _extractBody(payload) {
  if (!payload) return '';
  // Prefer text/plain; fall back to text/html with tags stripped.
  const walk = (node, mime) => {
    if (!node) return null;
    if (node.mimeType === mime && node.body?.data) return node.body.data;
    if (Array.isArray(node.parts)) {
      for (const p of node.parts) {
        const hit = walk(p, mime);
        if (hit) return hit;
      }
    }
    return null;
  };
  const decode = (b64) => Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

  const plain = walk(payload, 'text/plain');
  if (plain) return decode(plain);
  const htmlRaw = walk(payload, 'text/html');
  if (htmlRaw) {
    return decode(htmlRaw)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  // Single-part with inline body
  if (payload.body?.data) return decode(payload.body.data);
  return '';
}

async function listThreads({ db, userId, accountEmail, maxResults, pageToken, query }) {
  const gmail = await _gmailClient(db, userId, accountEmail);
  const list = await gmail.users.threads.list({
    userId: 'me',
    maxResults: Math.min(maxResults || 20, 50),
    pageToken: pageToken || undefined,
    q: query || 'in:inbox',
  });
  const threadRefs = list.data.threads || [];

  const threads = await Promise.all(threadRefs.map(async (t) => {
    try {
      const { data: msg } = await gmail.users.messages.get({
        userId: 'me',
        id: t.id,                // thread id = first message id in gmail
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const labelIds = msg.labelIds || [];
      // threads.get is cheaper for count but metadata-only — do a second
      // call only when we need the count. Use threads.get for the count.
      let messageCount = 1;
      try {
        const t2 = await gmail.users.threads.get({ userId: 'me', id: t.id, format: 'metadata', metadataHeaders: ['From'] });
        messageCount = t2.data.messages?.length || 1;
      } catch { /* fall back to 1 */ }
      return {
        id: t.id,
        subject: _headerVal(msg.payload?.headers, 'Subject') || '(no subject)',
        snippet: msg.snippet || '',
        from: _headerVal(msg.payload?.headers, 'From') || '',
        date: _headerVal(msg.payload?.headers, 'Date') || '',
        isRead: !labelIds.includes('UNREAD'),
        messageCount,
      };
    } catch {
      return null;
    }
  }));

  return {
    threads: threads.filter(Boolean),
    nextPageToken: list.data.nextPageToken || null,
  };
}

async function getThread({ db, userId, accountEmail, threadId }) {
  const gmail = await _gmailClient(db, userId, accountEmail);
  const { data } = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  const messages = (data.messages || []).map((m) => {
    const headers = m.payload?.headers || [];
    return {
      id: m.id,
      threadId: m.threadId,
      from: _headerVal(headers, 'From'),
      to: _headerVal(headers, 'To'),
      subject: _headerVal(headers, 'Subject'),
      date: _headerVal(headers, 'Date'),
      body: _extractBody(m.payload),
      isRead: !(m.labelIds || []).includes('UNREAD'),
      labelIds: m.labelIds || [],
      snippet: m.snippet || '',
    };
  });
  return { id: data.id, messages };
}

async function markRead({ db, userId, accountEmail, messageId }) {
  const gmail = await _gmailClient(db, userId, accountEmail);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
  return { success: true };
}

async function archiveMessage({ db, userId, accountEmail, messageId }) {
  const gmail = await _gmailClient(db, userId, accountEmail);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['INBOX'] },
  });
  return { success: true };
}

module.exports = { listThreads, getThread, markRead, archiveMessage };
