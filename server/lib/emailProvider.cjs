'use strict';

/**
 * server/lib/emailProvider.cjs — runtime interface for inbox providers.
 *
 * No DB tables, no persistent sync. Concrete providers (Gmail today,
 * IMAP/Microsoft later) are thin adapters over the external API.
 *
 * Required methods on any provider:
 *   async listThreads({ userId, accountEmail, maxResults, pageToken, query })
 *     → { threads: [{ id, subject, snippet, from, date, isRead, messageCount }], nextPageToken }
 *
 *   async getThread({ userId, accountEmail, threadId })
 *     → { id, messages: [{ id, from, to, subject, date, body, isRead, labelIds }] }
 *
 *   async markRead({ userId, accountEmail, messageId })
 *     → { success: true }
 *
 *   async archiveMessage({ userId, accountEmail, messageId })
 *     → { success: true }
 *
 * The router in server/routes/inbox.cjs resolves the provider for a
 * given account by looking at the account's integration provider
 * column and dispatching to the appropriate module.
 */

function notImplemented(method) {
  return async function () {
    throw new Error(`${method} not implemented on this provider`);
  };
}

// Base shape — concrete providers should export an object matching this.
const EmailProviderShape = {
  listThreads:    notImplemented('listThreads'),
  getThread:      notImplemented('getThread'),
  markRead:       notImplemented('markRead'),
  archiveMessage: notImplemented('archiveMessage'),
};

module.exports = { EmailProviderShape };
