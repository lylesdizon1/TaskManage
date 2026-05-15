'use strict';

/**
 * server/routes/imageBlobs.cjs — Owner-scoped retrieval of persisted
 * capture images.
 *
 * Backs the "view the source photo later" UX for downstream features
 * (business cards, document scans, etc.). Food log entries don't
 * persist images and therefore never reference this route.
 *
 * Auth: standard JWT via authenticateToken. The DB helper enforces
 * ownership; a request for someone else's blob returns 404 with the
 * same shape as a missing blob (no existence leak).
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');

module.exports = function createImageBlobsRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/image-blobs/:id', authenticateToken, async (req, res) => {
    try {
      const blob = await db.getImageBlobForOwner(req.params.id, req.user.id);
      if (!blob) return res.status(404).json({ error: 'Not found' });
      // 1-hour browser cache. Bytes never change; only the row's lifecycle
      // does (deletion happens via user-purge or expires_at sweep).
      res.setHeader('Content-Type', blob.mimeType || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return res.send(blob.bytes);
    } catch (err) {
      logger.error('imageBlobs.fetch.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
