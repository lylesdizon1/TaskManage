'use strict';

/**
 * server/routes/skills.cjs — REST surface for the Agents tab UI.
 *
 * Spec: docs/agents-foundation-v1.md §6 + §5d D2-D3.
 *
 * The agentic loop (Aria chat tools) and this route share the same
 * db helpers — the differences are dispatch (tool-call vs HTTP) and
 * the caller (Aria for chat, the user for UI).
 *
 * All endpoints user-scoped via req.user.id from JWT — never accept
 * userId from the client. requireOwnership runs against the path
 * skill_id + user_id; mismatched skill ids return 404 silently rather
 * than leaking existence.
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');

// Server-side translation of the chip-input keyword shape into the
// engine ext 2 predicate JSON. Mirrors tools.cjs::_composeSkillPredicate
// — kept duplicated here so the route doesn't have to require tools.cjs
// (heavy module). When the two diverge, the server-side intent is
// identical: chips → topics-contains OR predicate.
function composeSkillPredicate({ keywords, trigger_predicate }) {
  if (trigger_predicate !== undefined) return trigger_predicate;
  if (Array.isArray(keywords)) {
    const cleaned = Array.from(new Set(
      keywords
        .map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
        .filter((k) => k.length > 0),
    ));
    if (cleaned.length === 0) return null;
    return {
      input: {
        or: cleaned.map((k) => ({ field: 'topics', op: 'contains', value: k })),
      },
    };
  }
  return undefined;
}

function clampTokenCap(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 10000;
  return Math.max(1, Math.min(30000, Math.round(v)));
}

function clampPriority(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 5;
  return Math.max(0, Math.min(10, Math.round(v)));
}

function sanitizeStr(v, max) {
  if (typeof v !== 'string') return '';
  return v.slice(0, max);
}

module.exports = function createSkillsRouter({ authenticateToken, db }) {
  const router = express.Router();

  // ── List skills (UI list view + chat-tool list_skills both consume) ──
  router.get('/api/skills', authenticateToken, async (req, res) => {
    try {
      const includeInactive = req.query.include_inactive !== 'false';
      const skills = await db.listSkillsForUser(req.user.id, { includeInactive });
      // Augment with trust score for the tile telemetry row.
      const augmented = await Promise.all(skills.map(async (s) => {
        let trustScore = null;
        try {
          const trust = await db.getSkillTrust(req.user.id, s.id);
          trustScore = trust?.trustScore ?? null;
        } catch { /* fall through */ }
        return { ...s, trustScore };
      }));
      return res.json(augmented);
    } catch (err) {
      logger.error('skills.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Single skill detail ─────────────────────────────────────────────
  router.get('/api/skills/:id', authenticateToken, async (req, res) => {
    try {
      const skill = await db.getSkillById(req.params.id, req.user.id);
      if (!skill) return res.status(404).json({ error: 'Skill not found' });
      let trustScore = null;
      try {
        const trust = await db.getSkillTrust(req.user.id, skill.id);
        trustScore = trust?.trustScore ?? null;
      } catch {}
      return res.json({ ...skill, trustScore });
    } catch (err) {
      logger.error('skills.get.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Create skill (UI Save in blank-state edit view) ─────────────────
  router.post('/api/skills', authenticateToken, async (req, res) => {
    try {
      const {
        name, description, content,
        keywords, trigger_predicate,
        persona, token_cap, priority,
        is_active,
      } = req.body || {};
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name is required' });
      }
      // UI-driven create defaults to is_active=true (user-authored — the
      // user just clicked Save, they want it on). Aria-driven create
      // ships through the chat tool which forces is_active=false.
      const predicate = composeSkillPredicate({ keywords, trigger_predicate });
      const created = await db.createSkill(req.user.id, {
        name: sanitizeStr(name, 200),
        description: sanitizeStr(description || '', 1000),
        content: typeof content === 'string' ? content : '',
        triggerPredicate: predicate,
        persona: persona || null,
        tokenCap: clampTokenCap(token_cap),
        priority: clampPriority(priority),
        isActive: is_active !== false,
        source: 'user',
      });
      return res.json(created);
    } catch (err) {
      logger.error('skills.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // ── Update skill (UI Save in populated-state edit view) ─────────────
  router.patch('/api/skills/:id', authenticateToken, async (req, res) => {
    try {
      const fields = {};
      const b = req.body || {};
      if (b.name !== undefined)        fields.name        = sanitizeStr(b.name, 200);
      if (b.description !== undefined) fields.description = sanitizeStr(b.description, 1000);
      if (b.content !== undefined)     fields.content     = typeof b.content === 'string' ? b.content : '';
      if (b.persona !== undefined)     fields.persona     = b.persona || null;
      if (b.token_cap !== undefined)   fields.tokenCap    = clampTokenCap(b.token_cap);
      if (b.priority !== undefined)    fields.priority    = clampPriority(b.priority);
      if (b.is_active !== undefined)   fields.isActive    = !!b.is_active;
      if (b.keywords !== undefined || b.trigger_predicate !== undefined) {
        fields.triggerPredicate = composeSkillPredicate({
          keywords: b.keywords,
          trigger_predicate: b.trigger_predicate,
        });
      }
      const updated = await db.updateSkill(req.params.id, req.user.id, fields);
      if (!updated) return res.status(404).json({ error: 'Skill not found' });
      return res.json(updated);
    } catch (err) {
      logger.error('skills.update.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // ── Delete skill (irreversible) ─────────────────────────────────────
  router.delete('/api/skills/:id', authenticateToken, async (req, res) => {
    try {
      const ok = await db.deleteSkill(req.params.id, req.user.id);
      if (!ok) return res.status(404).json({ error: 'Skill not found' });
      return res.json({ success: true });
    } catch (err) {
      logger.error('skills.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Convenience activate / pause endpoints ─────────────────────────
  router.post('/api/skills/:id/activate', authenticateToken, async (req, res) => {
    try {
      const updated = await db.activateSkill(req.params.id, req.user.id);
      if (!updated) return res.status(404).json({ error: 'Skill not found' });
      return res.json(updated);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  router.post('/api/skills/:id/pause', authenticateToken, async (req, res) => {
    try {
      const updated = await db.pauseSkill(req.params.id, req.user.id);
      if (!updated) return res.status(404).json({ error: 'Skill not found' });
      return res.json(updated);
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  return router;
};
