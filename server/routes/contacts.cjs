'use strict';

/**
 * server/routes/contacts.cjs — People Memory V1 contacts CRUD.
 *
 * All routes are user-scoped via req.user.id. There is no cross-user
 * access here — shared-access consumption lives behind a separate router
 * that gates through hasActiveGrant. Contacts are strictly personal.
 *
 * V1 "notes" storage reuses memory_facts rows with fact_type='note' so
 * we avoid a second table. The context endpoint splits memory_facts into
 * two buckets for the caller:
 *   • notes  = fact_type = 'note' (free-form user-authored entries)
 *   • facts  = fact_type ≠ 'note' (enrichment-derived patterns)
 */

const express = require('express');
const logger = require('../../guardrails/logger.cjs');
const { extractContactFacts } = require('../lib/contactFactExtractor.cjs');

module.exports = function createContactsRouter({ authenticateToken, db }) {
  const router = express.Router();

  // ── Collection ────────────────────────────────────────────────────────

  router.get('/api/contacts', authenticateToken, async (req, res) => {
    try {
      const contacts = await db.getContactsForUser(req.user.id);
      res.json({ contacts });
    } catch (err) {
      logger.error('contacts.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Typeahead used by EmailDraftCard's ContactPickerInput. Returns top
  // matches by confidence (display_name prefix/contains, then email
  // substring). Per-user scoping is enforced by searchContactsByName itself.
  router.get('/api/contacts/search', authenticateToken, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 5, 20));
      if (!q) return res.json([]);
      const rows = await db.searchContactsByName(req.user.id, q, limit);
      res.json(rows);
    } catch (err) {
      logger.error('contacts.search.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/contacts', authenticateToken, async (req, res) => {
    try {
      const {
        display_name: displayName,
        first_name: firstName,
        last_name: lastName,
        primary_email: primaryEmail,
        primary_phone: primaryPhone,
        company, role, notes,
        linked_user_id: linkedUserId,
        source,
        source_image_blob_id: sourceImageBlobId,
        raw_ocr_text: rawOcrText,
      } = req.body || {};
      // Spec acceptance rule: any one of {display_name, first_name+last_name,
      // company, email} is enough. UI's "+ New Contact" form still
      // requires display_name; OCR path may supply first/last only.
      let finalDisplay = displayName ? String(displayName).trim() : null;
      if (!finalDisplay) {
        const joined = [firstName, lastName].filter(Boolean).map(s => String(s).trim()).filter(Boolean).join(' ');
        if (joined) finalDisplay = joined;
        else if (company) finalDisplay = String(company).trim();
      }
      if (!finalDisplay) {
        return res.status(400).json({ error: 'Need at least display_name, first/last name, or company.' });
      }
      const contact = await db.createContact(req.user.id, {
        displayName: finalDisplay,
        firstName: firstName ? String(firstName).trim() : null,
        lastName:  lastName  ? String(lastName).trim()  : null,
        primaryEmail: primaryEmail || null,
        primaryPhone: primaryPhone || null,
        company: company || null,
        role: role || null,
        notes: notes || null,
        linkedUserId: linkedUserId || null,
        source: source || 'manual',
        sourceImageBlobId: sourceImageBlobId || null,
        rawOcrText: rawOcrText || null,
      });
      res.json({ contact });
    } catch (err) {
      // Unique-violation on (user_id, LOWER(primary_email)) → 409.
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A contact with this email already exists' });
      }
      logger.error('contacts.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Single contact ────────────────────────────────────────────────────

  // Map a DB identity row to the API shape. DB keeps kind/value (Option A);
  // the API exposes value/label/is_primary/source. kind selects the bucket.
  function toIdentity(r) {
    return { id: r.id, value: r.value, label: r.label || null, is_primary: !!r.isPrimary, source: r.source || null };
  }

  router.get('/api/contacts/:id', authenticateToken, async (req, res) => {
    try {
      const contact = await db.getContactById(req.params.id, req.user.id);
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
      const identities = await db.getContactIdentities(req.params.id);
      const emails = identities.filter((r) => r.kind === 'email').map(toIdentity);
      const phones = identities.filter((r) => r.kind === 'phone').map(toIdentity);
      res.json({ contact: { ...contact, emails, phones } });
    } catch (err) {
      logger.error('contacts.get.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/api/contacts/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getContactById(req.params.id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Contact not found' });
      const patch = {};
      const b = req.body || {};
      if (b.display_name !== undefined) patch.displayName = b.display_name;
      if (b.first_name !== undefined)   patch.firstName   = b.first_name || null;
      if (b.last_name !== undefined)    patch.lastName    = b.last_name || null;
      if (b.primary_email !== undefined) patch.primaryEmail = b.primary_email || null;
      if (b.primary_phone !== undefined) patch.primaryPhone = b.primary_phone || null;
      if (b.company !== undefined) patch.company = b.company || null;
      if (b.role !== undefined) patch.role = b.role || null;
      if (b.notes !== undefined) patch.notes = b.notes || null;
      if (b.linked_user_id !== undefined) patch.linkedUserId = b.linked_user_id || null;
      if (b.source !== undefined) patch.source = b.source || null;
      const contact = await db.updateContact(req.params.id, req.user.id, patch);
      res.json({ contact });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A contact with this email already exists' });
      }
      logger.error('contacts.update.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE is now soft delete — flips archived_at. Hard delete is
  // intentionally not exposed. Restore via the dedicated route below.
  // Existing UI consumers calling DELETE continue to work (the operation
  // returns the same 200 shape); they just see archived rows disappear
  // from list responses, same user-visible behavior as before.
  router.delete('/api/contacts/:id', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getContactById(req.params.id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Contact not found' });
      await db.deleteContact(req.params.id, req.user.id);
      res.json({ success: true });
    } catch (err) {
      logger.error('contacts.delete.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Explicit archive route (alias of DELETE for UI clarity — "Archive"
  // button calls this so the verb matches the user-visible action).
  router.post('/api/contacts/:id/archive', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getContactById(req.params.id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Contact not found' });
      await db.deleteContact(req.params.id, req.user.id);
      res.json({ success: true });
    } catch (err) {
      logger.error('contacts.archive.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/contacts/:id/restore', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getContactById(req.params.id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Contact not found' });
      const ok = await db.restoreContact(req.params.id, req.user.id);
      res.json({ success: ok });
    } catch (err) {
      logger.error('contacts.restore.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Notes (stored as memory_facts with fact_type='note') ──────────────

  router.get('/api/contacts/:id/notes', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getContactById(req.params.id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Contact not found' });
      const all = await db.getContactFacts(req.params.id, req.user.id);
      const notes = all.filter((f) => f.factType === 'note').slice(0, 50);
      res.json({ notes });
    } catch (err) {
      logger.error('contacts.notes.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/contacts/:id/notes', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getContactById(req.params.id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Contact not found' });
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      await db.addContactFact(req.user.id, req.params.id, text, 'note', 0.5);
      // Fire-and-forget fact extraction — never await, never block.
      extractContactFacts(req.user.id, req.params.id, existing.displayName, text)
        .catch((err) => logger.warn('contacts.factExtract.failed', { userId: req.user?.id, contactId: req.params.id, error: err.message }));
      res.json({ success: true });
    } catch (err) {
      logger.error('contacts.notes.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Facts (enrichment-derived, fact_type != 'note') ───────────────────

  router.get('/api/contacts/:id/facts', authenticateToken, async (req, res) => {
    try {
      const existing = await db.getContactById(req.params.id, req.user.id);
      if (!existing) return res.status(404).json({ error: 'Contact not found' });
      const all = await db.getContactFacts(req.params.id, req.user.id);
      const facts = all.filter((f) => f.factType !== 'note');
      res.json({ facts });
    } catch (err) {
      logger.error('contacts.facts.list.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Context (aggregate bundle for UI + Aria) ──────────────────────────

  router.get('/api/contacts/:id/context', authenticateToken, async (req, res) => {
    try {
      const contact = await db.getContactById(req.params.id, req.user.id);
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
      const [all, identities] = await Promise.all([
        db.getContactFacts(req.params.id, req.user.id),
        db.getContactIdentities(req.params.id),
      ]);
      const notes = all.filter((f) => f.factType === 'note').slice(0, 10);
      const facts = all.filter((f) => f.factType !== 'note');
      res.json({ contact, notes, facts, identities });
    } catch (err) {
      logger.error('contacts.context.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
};
