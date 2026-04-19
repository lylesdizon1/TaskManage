'use strict';

/**
 * server/routes/quickbooks.cjs — Intuit QuickBooks OAuth shell (P0).
 *
 * Routes:
 *   GET    /api/quickbooks/connect?entityId=X[&environment=sandbox|production]
 *            → { url } — Intuit consent URL bound to this user+entity.
 *   GET    /api/quickbooks/callback
 *            → handles ?code, ?state, ?realmId; persists encrypted tokens;
 *              redirects to /?qb=connected.
 *   GET    /api/quickbooks/connections
 *            → all connections for the authed user, redacted.
 *   DELETE /api/quickbooks/connections/:id
 *            → disconnect one (no-op against Intuit; row hard-deleted).
 *   GET    /api/quickbooks/test/:id
 *            → call CompanyInfo against the live API to verify the
 *              connection round-trips. Refreshes tokens if expired.
 *
 * Authorization: every route uses authenticateToken; all DB lookups are
 * scoped to req.user.id. Entity access is verified via getEntitiesForUser
 * before minting a connect URL — prevents binding a connection to an
 * entity the user can't see.
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const {
  getClientConfig,
  defaultEnvironment,
  productionAllowed,
  buildAuthUrl,
  exchangeCodeForTokens,
  mintQbState,
  consumeQbState,
  packTokens,
  unpackTokens,
  withFreshAccessToken,
  fetchCompanyInfo,
} = require('../utils/quickbooks.cjs');

function redactConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityId: row.entityId,
    realmId: row.realmId,
    environment: row.environment,
    companyName: row.companyName || '',
    scope: row.scope,
    lastRefreshedAt: row.lastRefreshedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

module.exports = function createQuickbooksRouter({ authenticateToken, db }) {
  const router = express.Router();

  router.get('/api/quickbooks/connect', authenticateToken, async (req, res) => {
    if (!getClientConfig()) {
      return res.status(500).json({ error: 'QuickBooks OAuth not configured (set QB_CLIENT_ID, QB_CLIENT_SECRET)' });
    }
    const entityId = String(req.query.entityId || '').trim();
    if (!entityId) return res.status(400).json({ error: 'entityId is required' });

    const requestedEnv = String(req.query.environment || '').toLowerCase();
    let environment;
    if (requestedEnv === 'production') {
      if (!productionAllowed()) {
        return res.status(403).json({ error: 'Production QB connections are disabled (set QB_ALLOW_PRODUCTION=1 to enable)' });
      }
      environment = 'production';
    } else if (requestedEnv === 'sandbox') {
      environment = 'sandbox';
    } else {
      environment = defaultEnvironment();
    }

    // Verify the user can actually see this entity before binding tokens to it.
    // Uses the canonical membership-aware helper (same as entities.cjs) so a
    // user who only sees an entity via the legacy `shared = true` flag can NO
    // LONGER bind a QB realm against it — they need created_by, org-wide
    // visibility within their org, OR an explicit entity_members row.
    const entities = await db.getEntitiesForUserWithMembership(req.user.id, req.user.orgId || null);
    const owned = entities.find((e) => String(e.id) === entityId);
    if (!owned) return res.status(404).json({ error: 'Entity not found' });

    let state;
    try {
      state = await mintQbState({ userId: req.user.id, entityId, environment });
    } catch (e) {
      logger.error('quickbooks.connect.stateMint.failed', { userId: req.user.id, entityId, error: e.message });
      return res.status(503).json({ error: 'OAuth temporarily unavailable; please retry' });
    }

    const url = buildAuthUrl(state);
    if (!url) return res.status(500).json({ error: 'QuickBooks OAuth not configured' });
    res.json({ url });
  });

  router.get('/api/quickbooks/callback', async (req, res) => {
    const { code, state, realmId, error, error_description: errDesc } = req.query;
    if (error) return res.status(400).send(`QuickBooks auth failed: ${errDesc || error}`);
    if (!code || !state || !realmId) return res.status(400).send('Missing code, state, or realmId');
    if (!getClientConfig()) return res.status(500).send('QuickBooks OAuth not configured');

    const bound = await consumeQbState(state);
    if (!bound || !bound.userId || !bound.entityId) {
      logger.warn('quickbooks.callback.invalidState', { state: typeof state === 'string' ? state.slice(0, 8) : 'non-string' });
      return res.status(400).send('Invalid or expired OAuth state');
    }

    const environment = bound.environment === 'production' ? 'production' : 'sandbox';
    if (environment === 'production' && !productionAllowed()) {
      logger.warn('quickbooks.callback.productionBlocked', { userId: bound.userId });
      return res.status(403).send('Production connections are disabled');
    }

    try {
      const tokens = await exchangeCodeForTokens(code);

      // Best-effort fetch of company name for display. Don't block connect on it.
      let companyName = '';
      try {
        const info = await fetchCompanyInfo({
          realmId: String(realmId),
          environment,
          accessToken: tokens.access_token,
        });
        companyName = info?.CompanyName || info?.companyName || '';
      } catch (e) {
        logger.warn('quickbooks.callback.companyInfo.failed', { userId: bound.userId, error: e.message });
      }

      const id = await db.upsertQbConnection({
        userId: bound.userId,
        entityId: bound.entityId,
        realmId: String(realmId),
        environment,
        companyName,
        encryptedTokens: packTokens(tokens),
        scope: tokens.scope,
      });

      logger.info('quickbooks.connection.connected', {
        userId: bound.userId, entityId: bound.entityId, realmId: String(realmId), environment, connectionId: id,
      });
      return res.redirect(`/?qb=connected&entityId=${encodeURIComponent(bound.entityId)}`);
    } catch (err) {
      logger.error('quickbooks.callback.failed', { userId: bound.userId, error: err.message });
      return res.status(500).send('QuickBooks auth failed');
    }
  });

  router.get('/api/quickbooks/connections', authenticateToken, async (req, res) => {
    try {
      const rows = await db.getQbConnectionsByUser(req.user.id);
      res.json(rows.map(redactConnection));
    } catch (err) {
      logger.error('quickbooks.connections.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/quickbooks/connections/:id', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
      const row = await db.getQbConnectionById(id, req.user.id);
      if (!row) return res.status(404).json({ error: 'Connection not found' });
      await db.deleteQbConnectionById(id, req.user.id);
      logger.info('quickbooks.connection.disconnected', { userId: req.user.id, connectionId: id });
      res.json({ success: true });
    } catch (err) {
      logger.error('quickbooks.connections.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/quickbooks/test/:id', authenticateToken, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
      const conn = await db.getQbConnectionById(id, req.user.id);
      if (!conn) return res.status(404).json({ error: 'Connection not found' });

      const tokens = await withFreshAccessToken(conn, db);
      const info = await fetchCompanyInfo({
        realmId: conn.realmId,
        environment: conn.environment,
        accessToken: tokens.access_token,
      });
      const companyName = info?.CompanyName || info?.companyName || '';
      res.json({
        ok: true,
        connectionId: conn.id,
        realmId: conn.realmId,
        environment: conn.environment,
        companyName,
        legalName: info?.LegalName || '',
        country: info?.Country || '',
      });
    } catch (err) {
      logger.warn('quickbooks.test.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(502).json({ ok: false, error: err.message });
    }
  });

  return router;
};
