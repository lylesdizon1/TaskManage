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
const { userRateLimit } = require('../middleware/userRateLimit.cjs');

const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const uploadLimit = userRateLimit({ key: 'image-blobs-upload', limit: 50, windowSec: 3600 });

module.exports = function createImageBlobsRouter({ authenticateToken, db, imageUpload }) {
  const router = express.Router();

  // POST /api/image-blobs — desktop single-file upload. Lands bytes in
  // image_blobs and returns { blob_id } for the caller to attach (contact
  // avatar, document scan, etc.). Mirrors the multer config used by the
  // note-image path (memoryStorage, 10MB cap).
  router.post('/api/image-blobs', authenticateToken, uploadLimit, imageUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No image file provided (field name: file)' });
      if (!SUPPORTED_MIME.includes(req.file.mimetype)) {
        return res.status(400).json({ error: 'Unsupported image type. Use jpeg, png, gif, or webp.' });
      }
      const blobId = await db.insertImageBlob({
        userId: req.user.id,
        mimeType: req.file.mimetype,
        bytes: req.file.buffer,
        source: 'upload',
      });
      return res.json({ blob_id: blobId });
    } catch (err) {
      logger.error('imageBlobs.upload.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

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
