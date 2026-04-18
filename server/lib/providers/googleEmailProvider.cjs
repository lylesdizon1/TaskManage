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

// Markdown-style link pattern that some mail clients leak into text/plain
// alternates — when it shows up, the HTML alternate renders cleaner.
const MD_LINK_RE = /\[[^\]]+\]\(https?:\/\/[^)]+\)/;
// Long, often tracking-heavy URLs that clutter plain text (Zillow, Amazon
// Music, etc.). Threshold: any http(s) URL longer than 60 chars.
const LONG_URL_RE = /https?:\/\/\S{60,}/;
// Separator lines of 3+ consecutive '=' characters on their own line.
const HEAVY_SEPARATOR_RE = /^\s*={3,}\s*$/m;

function _extractBody(payload) {
  if (!payload) return '';
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

  const plainB64 = walk(payload, 'text/plain');
  const htmlB64  = walk(payload, 'text/html');

  // Prefer plain ONLY when it looks like real plain text. Marketing /
  // system emails (Zillow, Amazon Music, …) often ship plain-text
  // alternates that are really link dumps or separator-line noise —
  // fall back to HTML whenever any of these show up.
  if (plainB64) {
    const plain = decode(plainB64);
    const looksNoisy =
         MD_LINK_RE.test(plain)
      || LONG_URL_RE.test(plain)
      || HEAVY_SEPARATOR_RE.test(plain);
    if (!looksNoisy || !htmlB64) return plain;
  }
  if (htmlB64) return decode(htmlB64);
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
      // Single threads.get gets us count + the last message id + the
      // latest message's headers/labels — no separate messages.get needed.
      const t2 = await gmail.users.threads.get({
        userId: 'me', id: t.id, format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });
      const msgs = t2.data?.messages || [];
      if (!msgs.length) return null;
      const last = msgs[msgs.length - 1];
      const labelIds = last.labelIds || [];
      return {
        id: t.id,
        latestMessageId: last.id,
        subject: _headerVal(last.payload?.headers, 'Subject') || '(no subject)',
        snippet: last.snippet || '',
        from: _headerVal(last.payload?.headers, 'From') || '',
        date: _headerVal(last.payload?.headers, 'Date') || '',
        isRead: !labelIds.includes('UNREAD'),
        labelIds,
        messageCount: msgs.length,
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
    // Surface headers the engine cares about (List-Unsubscribe,
    // Precedence, Auto-Submitted) without dragging along the full set.
    const HEADERS_OF_INTEREST = ['list-unsubscribe', 'precedence', 'auto-submitted'];
    const extractedHeaders = headers
      .filter(h => HEADERS_OF_INTEREST.includes(String(h.name || '').toLowerCase()))
      .map(h => ({ name: h.name, value: h.value }));
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
      headers: extractedHeaders,
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

async function starMessage({ db, userId, accountEmail, messageId, starred }) {
  const gmail = await _gmailClient(db, userId, accountEmail);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: starred
      ? { addLabelIds: ['STARRED'] }
      : { removeLabelIds: ['STARRED'] },
  });
  return { success: true, starred };
}

/**
 * Move a message to a label and remove it from INBOX. Returns the From
 * header so the caller (route) can extract sender/domain for filing
 * pattern recording without a second round-trip.
 */
async function moveMessage({ db, userId, accountEmail, messageId, targetLabelId }) {
  const gmail = await _gmailClient(db, userId, accountEmail);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      addLabelIds: [targetLabelId],
      removeLabelIds: ['INBOX'],
    },
  });
  let fromHeader = '';
  try {
    const msg = await gmail.users.messages.get({
      userId: 'me', id: messageId, format: 'metadata', metadataHeaders: ['From'],
    });
    fromHeader = (msg.data.payload?.headers || []).find(h => h.name?.toLowerCase() === 'from')?.value || '';
  } catch { /* fromHeader stays empty — pattern record will skip */ }
  return { success: true, fromHeader };
}

/**
 * Sync the user's Gmail labels into user_email_labels.
 * Skips system labels (INBOX, SPAM, IMPORTANT, …) — only user-created
 * labels carry filing intent and benefit from semantic mapping.
 *
 * Idempotent — every call upserts and bumps last_seen_at.
 * Returns the count of labels touched, or 0 on any failure (never throws).
 */
async function syncLabels({ db, userId, accountEmail }) {
  try {
    const gmail = await _gmailClient(db, userId, accountEmail);
    const { data } = await gmail.users.labels.list({ userId: 'me' });
    const labels = (data.labels || []).filter((l) => l.type !== 'system');
    for (const l of labels) {
      try { await db.upsertEmailLabel(userId, accountEmail, 'gmail', l.id, l.name); }
      catch { /* per-label failures are isolated; keep going */ }
    }
    return labels.length;
  } catch {
    return 0;
  }
}

module.exports = { listThreads, getThread, markRead, archiveMessage, starMessage, moveMessage, syncLabels };
