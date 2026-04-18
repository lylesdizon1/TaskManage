'use strict';

/**
 * server/routes/emailClean.cjs — policy CRUD + manual run.
 * Session 1: confirmation is ALWAYS required; execution is never auto-
 * triggered. confirmation_threshold is UI copy only — it does not gate
 * the backend.
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { runEmailClean } = require('../lib/emailCleanRunner.cjs');

const DEFAULT_POLICY = {
  archivePromos: false,      promosOlderThanH: 24,
  archiveNewsletters: false, newslettersOlderThanH: 48,
  archiveSocial: false,      socialOlderThanH: 24,
  confirmationThreshold: 20,
  active: true,
};

module.exports = function createEmailCleanRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/email-clean-policy', authenticateToken, async (req, res) => {
    try {
      const p = await db.getEmailCleanPolicy(req.user.id);
      res.json({ policy: p || { ...DEFAULT_POLICY, userId: req.user.id } });
    } catch (err) {
      logger.error('emailClean.policy.get.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/email-clean-policy', authenticateToken, async (req, res) => {
    try {
      const p = await db.upsertEmailCleanPolicy(req.user.id, req.body || {});
      res.json({ policy: p });
    } catch (err) {
      logger.error('emailClean.policy.save.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/email-clean-policy/run', authenticateToken, async (req, res) => {
    try {
      const { confirmed, policy: overridePolicy } = req.body || {};
      const saved = await db.getEmailCleanPolicy(req.user.id);
      const policy = overridePolicy ? { ...DEFAULT_POLICY, ...overridePolicy } : (saved || DEFAULT_POLICY);
      const doExecute = confirmed === true;
      const result = await runEmailClean(req.user.id, policy, doExecute, db);
      await db.logAgentAction({
        userId: req.user.id,
        eventType: doExecute ? 'tool_executed' : 'decision_created',
        toolName: 'bulk_archive_emails',
        input: { policy, confirmed: !!doExecute },
        output: result,
        status: 'success',
      }).catch(() => {});
      res.json(result);
    } catch (err) {
      logger.error('emailClean.run.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
