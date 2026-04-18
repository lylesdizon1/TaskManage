'use strict';

/**
 * server/routes/connections.cjs — person-to-person "I know this user"
 * graph. Separate from entity_members (operational workspace access)
 * and from shared_access_grants (explicit read permissions). A connection
 * is a semantic relationship assertion — accepting one does NOT confer
 * any access rights.
 *
 * V1 rules:
 *   • Invitation resolves peer by email server-side. Never trust a
 *     client-supplied peer_user_id.
 *   • Accept can only be called by the invited peer (user_id on the
 *     peer's own row — see createConnection contract below).
 *   • Block and delete require involvement (initiator or peer).
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');

const VALID_STATUSES = new Set(['pending', 'accepted', 'blocked']);

module.exports = function createConnectionsRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/connections', authenticateToken, async (req, res) => {
    try {
      const connections = await db.getConnectionsForUser(req.user.id);
      res.json({ connections });
    } catch (err) {
      logger.error('connections.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/connections/invite', authenticateToken, async (req, res) => {
    try {
      const { peer_email: peerEmail, relationship } = req.body || {};
      if (!peerEmail || !String(peerEmail).trim()) return res.status(400).json({ error: 'peer_email required' });

      // NOTE: getUserByIdentifier ILIKE-matches username OR email (see
      // shared-access route for full invariant). UX implies email-only.
      const peer = await db.getUserByIdentifier(String(peerEmail).trim());
      if (!peer) return res.status(404).json({ error: 'User not on platform' });
      if (peer.id === req.user.id) return res.status(400).json({ error: 'Cannot connect to yourself' });

      const existing = await db.getConnectionByPeer(req.user.id, peer.id);
      if (existing) return res.status(409).json({ error: 'Connection already exists', connection: existing });

      try {
        const connection = await db.createConnection(req.user.id, peer.id, null, relationship || null);
        logger.info('connections.invited', { userId: req.user.id, peerUserId: peer.id });
        return res.json({ connection });
      } catch (e) {
        if (e.code === '23505') {
          return res.status(409).json({ error: 'Connection already exists' });
        }
        throw e;
      }
    } catch (err) {
      logger.error('connections.invite.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/connections/:id/accept', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

      // Accept is a mirror-write: the invited peer accepts by creating
      // their own accepted row pointing back at the initiator. The DB
      // scopes update by user_id, so we first locate the row where the
      // current user is the peer_user_id, then flip their own row (or
      // create it) to 'accepted'.
      const { rows } = await db.pool.query(
        `SELECT id, user_id AS "userId", peer_user_id AS "peerUserId"
         FROM connections WHERE id = $1 LIMIT 1`,
        [id],
      );
      const row = rows[0];
      // Collapse 403/404 into a single 404 so a caller enumerating
      // connection IDs can't learn which ones exist (H-1 hardening).
      if (!row || row.peerUserId !== req.user.id) {
        return res.status(404).json({ error: 'Connection not found' });
      }

      // Flip initiator's row to accepted so both sides see the update.
      const initiatorRow = await db.updateConnectionStatus(id, row.userId, 'accepted');

      // Create (or upsert-accept) the mirror row owned by the acceptor.
      let mirror = await db.getConnectionByPeer(req.user.id, row.userId);
      if (!mirror) {
        mirror = await db.createConnection(req.user.id, row.userId, null, null);
      }
      await db.updateConnectionStatus(mirror.id, req.user.id, 'accepted');

      res.json({ connection: initiatorRow, mirror });
    } catch (err) {
      logger.error('connections.accept.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/connections/:id/block', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });

      const { rows } = await db.pool.query(
        `SELECT id, user_id AS "userId", peer_user_id AS "peerUserId"
         FROM connections WHERE id = $1 LIMIT 1`,
        [id],
      );
      const row = rows[0];
      // Collapse 403/404 into a single 404 so a caller enumerating
      // connection IDs can't learn which ones exist (H-1 hardening).
      if (!row || (row.userId !== req.user.id && row.peerUserId !== req.user.id)) {
        return res.status(404).json({ error: 'Connection not found' });
      }
      // The row owned by the blocker is the one they can flip via
      // updateConnectionStatus (scoped by user_id).
      const ownRowId = row.userId === req.user.id ? row.id : null;
      if (ownRowId) {
        const updated = await db.updateConnectionStatus(ownRowId, req.user.id, 'blocked');
        return res.json({ connection: updated });
      }
      // If the current user is only the peer, find or create their own
      // row pointing back and flip it to blocked.
      let mine = await db.getConnectionByPeer(req.user.id, row.userId);
      if (!mine) mine = await db.createConnection(req.user.id, row.userId, null, null);
      const updated = await db.updateConnectionStatus(mine.id, req.user.id, 'blocked');
      res.json({ connection: updated });
    } catch (err) {
      logger.error('connections.block.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/connections/:id', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
      const { rows } = await db.pool.query(
        `SELECT id, user_id AS "userId", peer_user_id AS "peerUserId"
         FROM connections WHERE id = $1 LIMIT 1`,
        [id],
      );
      const row = rows[0];
      // Collapse 403/404 into a single 404 so a caller enumerating
      // connection IDs can't learn which ones exist (H-1 hardening).
      if (!row || (row.userId !== req.user.id && row.peerUserId !== req.user.id)) {
        return res.status(404).json({ error: 'Connection not found' });
      }
      // Delete only the row owned by the current user. Mirror row (if
      // any) remains until the other side cleans it up — same semantics
      // as social graph "unfollow" behaviors.
      if (row.userId === req.user.id) {
        await db.pool.query(`DELETE FROM connections WHERE id = $1 AND user_id = $2`, [id, req.user.id]);
      } else {
        const mine = await db.getConnectionByPeer(req.user.id, row.userId);
        if (mine) {
          await db.pool.query(`DELETE FROM connections WHERE id = $1 AND user_id = $2`, [mine.id, req.user.id]);
        }
      }
      res.json({ success: true });
    } catch (err) {
      logger.error('connections.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};

// Expose for tests that want to assert the scope whitelist without
// coupling to the router builder.
module.exports.VALID_STATUSES = VALID_STATUSES;
