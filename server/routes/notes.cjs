'use strict';

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../../guardrails/logger.cjs');

module.exports = function createNotesRouter({ authenticateToken, requireOwnership, db, imageUpload }) {
  const router = express.Router();

  // ── Notes ─────────────────────────────────────────────────────────────────────

  router.get('/api/notes/categories', authenticateToken, async (req, res) => {
    try {
      await db.seedNoteCategoriesIfEmpty(req.user.id);
      const cats = await db.getNoteCategories(req.user.id);
      return res.json(cats);
    } catch (err) {
      logger.error('notes.categories.readFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  router.post('/api/notes/categories', authenticateToken, async (req, res) => {
    try {
      const { name, parentId, pillar, color } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      const id = `ncat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const cat = await db.createNoteCategory({ id, userId: req.user.id, name, parentId, pillar, color });
      return res.json(cat);
    } catch (err) {
      logger.error('notes.category.createFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/notes/search', authenticateToken, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q || q.length < 2) return res.json([]);
      const results = await db.searchNotes(req.user.id, q);
      return res.json(results);
    } catch (err) {
      logger.error('notes.search.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  router.post('/api/notes/daily-digest', authenticateToken, async (req, res) => {
    try {
      const tz = req.user.timezone;
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const forceRegen = req.body.force === true;

      // Check if digest already exists for today (skip if force regenerate)
      const notes = await db.getNotesForUser(req.user.id);
      const existing = notes.find((n) => n.type === 'digest' && n.createdAt && new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(n.createdAt)) === today);
      if (existing && !forceRegen) return res.json(existing);
      if (existing && forceRegen) await db.deleteNote(existing.id, req.user.id);

      // Gather context for the AI
      const tasks = await db.getTasksForUser(req.user.id, req.user.entityIds || []);
      const activeTasks = (Array.isArray(tasks) ? tasks : []).filter((t) => !t.completed);
      const recentNotes = notes.slice(0, 10);

      const apiKey = req.body.apiKey || process.env.CLAUDE_API_KEY;
      if (!apiKey) {
        // No API key — create a simple summary without AI
        const overdue = activeTasks.filter((t) => t.dueDate && t.dueDate < today).length;
        const high = activeTasks.filter((t) => t.priority === 'high').length;
        const content = `**Daily Summary — ${today}**\n\nYou have ${activeTasks.length} active tasks${overdue > 0 ? `, ${overdue} overdue` : ''}${high > 0 ? `, ${high} high priority` : ''}.\n\nStay focused and tackle the most important items first.`;
        const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const digest = await db.createNote({
          id, userId: req.user.id, title: `Daily Digest — ${today}`, content, type: 'digest', pillar: 'grow',
        });
        return res.json(digest);
      }

      // Build AI prompt
      const taskSummary = activeTasks.slice(0, 15).map((t) =>
        `- [${t.priority}] ${t.title}${t.dueDate ? ` (due: ${t.dueDate})` : ''}`
      ).join('\n');
      const noteSummary = recentNotes.slice(0, 5).map((n) =>
        `- ${n.title || '(untitled)'}: ${(n.content || '').slice(0, 80)}`
      ).join('\n');

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 512,
          system: 'You are a concise personal productivity assistant. Write a brief daily digest (3-5 short paragraphs) summarizing priorities, flagging overdue items, and offering one actionable tip. Use markdown formatting. Be warm but direct.',
          messages: [{
            role: 'user',
            content: `Today is ${today}. Here are my active tasks:\n${taskSummary || '(none)'}\n\nRecent notes:\n${noteSummary || '(none)'}\n\nWrite my daily digest.`,
          }],
        },
        {
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          timeout: 30_000,
        },
      );

      const aiContent = response.data.content?.[0]?.text || 'No digest could be generated.';
      const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const digest = await db.createNote({
        id, userId: req.user.id, title: `Daily Digest — ${today}`, content: aiContent, type: 'digest', pillar: 'grow',
      });
      return res.json(digest);
    } catch (err) {
      logger.error('notes.digest.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json({ digest: null });
    }
  });

  router.get('/api/notes', authenticateToken, async (req, res) => {
    try {
      // Seed categories on first note-related API call
      await db.seedNoteCategoriesIfEmpty(req.user.id);
      const filters = {};
      if (req.query.pillar) filters.pillar = req.query.pillar;
      if (req.query.entityId) filters.entityId = req.query.entityId;
      if (req.query.category) filters.category = req.query.category;
      if (req.query.archived) filters.archived = req.query.archived === 'true';
      if (req.query.pinned) filters.pinned = req.query.pinned === 'true';
      const notes = await db.getNotesForUser(req.user.id, filters);
      return res.json(notes);
    } catch (err) {
      logger.error('notes.read.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  router.post('/api/notes', authenticateToken, async (req, res) => {
    try {
      const { title, content, type, pillar, category, subcategory, tags, entityId } = req.body;
      const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const note = await db.createNote({
        id, userId: req.user.id, title, content, type, pillar, category, subcategory, tags, entityId,
      });
      return res.json(note);
    } catch (err) {
      logger.error('notes.create.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/notes/:id', authenticateToken, async (req, res) => {
    try {
      const note = await db.getNoteById(req.params.id, req.user.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      if (!requireOwnership(note, req)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const updated = await db.updateNote(req.params.id, req.user.id, req.body);
      if (!updated) return res.status(404).json({ error: 'Note not found' });
      return res.json(updated);
    } catch (err) {
      logger.error('notes.update.failed', { requestId: req.requestId, userId: req.user?.id, noteId: req.params.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/notes/:id', authenticateToken, async (req, res) => {
    try {
      const note = await db.getNoteById(req.params.id, req.user.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      if (!requireOwnership(note, req)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      await db.deleteNote(req.params.id, req.user.id);
      return res.json({ success: true });
    } catch (err) {
      logger.error('notes.delete.failed', { requestId: req.requestId, userId: req.user?.id, noteId: req.params.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/notes/:id/pin', authenticateToken, async (req, res) => {
    try {
      const note = await db.getNoteById(req.params.id, req.user.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });
      if (!requireOwnership(note, req)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const updated = await db.updateNote(req.params.id, req.user.id, { pinned: !note.pinned });
      return res.json(updated);
    } catch (err) {
      logger.error('notes.pin.failed', { requestId: req.requestId, userId: req.user?.id, noteId: req.params.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/notes/:id/suggest-pillar', authenticateToken, async (req, res) => {
    try {
      const { content, apiKey: bodyKey } = req.body;
      if (!content || content.trim().split(/\s+/).length < 10) {
        return res.json({ pillar: null, category: null, confidence: 0 });
      }
      const apiKey = (bodyKey && !bodyKey.includes('****')) ? bodyKey : process.env.CLAUDE_API_KEY;
      if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

      // Build the category list from the user's own note categories so
      // the classifier never suggests another user's categories.
      const userCats = await db.getNoteCategories(req.user.id).catch(() => []);
      const byPillar = { hustle: [], home: [], move: [], grow: [] };
      for (const c of userCats) {
        if (c.parentId && byPillar[c.pillar]) byPillar[c.pillar].push(c.name);
      }
      const catLines = Object.entries(byPillar)
        .map(([p, names]) => `  ${p} → ${names.length ? names.join(', ') : '(none yet)'}`)
        .join('\n');

      const prompt = `Based on this note content, suggest the most appropriate pillar and category.
Pillars: hustle, home, move, grow
Categories:
${catLines}

Note content: ${content.slice(0, 500)}

Respond in JSON only:
{"pillar": "hustle", "category": "<category-name>", "confidence": 0.95, "reason": "<brief reason>"}`;

      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 30000,
        },
      );

      const text = response.data?.content?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return res.json({
          pillar: parsed.pillar || null,
          category: parsed.category || null,
          confidence: parseFloat(parsed.confidence) || 0,
          reason: parsed.reason || '',
        });
      }
      return res.json({ pillar: null, category: null, confidence: 0 });
    } catch (err) {
      logger.error('notes.suggestPillar.failed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json({ pillar: null, category: null, confidence: 0 });
    }
  });

  // ── Note Images ──────────────────────────────────────────────────────────────

  router.get('/api/notes/:id/images', authenticateToken, async (req, res) => {
    try {
      const images = await db.getNoteImages(req.params.id, req.user.id);
      return res.json(images);
    } catch (err) {
      logger.error('notes.images.listFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.json([]);
    }
  });

  router.post('/api/notes/:id/images', authenticateToken, imageUpload.single('image'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No image file provided' });
      const noteId = req.params.id;
      // Verify note belongs to user
      const note = await db.getNoteById(noteId, req.user.id);
      if (!note) return res.status(404).json({ error: 'Note not found' });

      const imageId = `nimg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const ext = req.file.originalname.split('.').pop() || 'jpg';
      const filename = `${imageId}.${ext}`;

      // Try filesystem storage first (Railway volume), fall back to base64 in DB
      const uploadDir = path.join(__dirname, '..', '..', 'uploads', 'notes', req.user.id, noteId);
      let url;
      try {
        fs.mkdirSync(uploadDir, { recursive: true });
        fs.writeFileSync(path.join(uploadDir, filename), req.file.buffer);
        url = `/uploads/notes/${req.user.id}/${noteId}/${filename}`;
      } catch {
        // Fallback: store as data URI (base64)
        const base64 = req.file.buffer.toString('base64');
        url = `data:${req.file.mimetype};base64,${base64}`;
      }

      const image = await db.createNoteImage({
        id: imageId, noteId, userId: req.user.id,
        filename, originalName: req.file.originalname,
        mimeType: req.file.mimetype, size: req.file.size, url,
      });
      return res.json(image);
    } catch (err) {
      logger.error('notes.image.uploadFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/notes/:id/images/:imageId', authenticateToken, async (req, res) => {
    try {
      const deleted = await db.deleteNoteImage(req.params.imageId, req.user.id);
      if (deleted && deleted.url && !deleted.url.startsWith('data:')) {
        // Try to remove file from disk
        const filePath = path.join(__dirname, '..', '..', deleted.url);
        try { fs.unlinkSync(filePath); } catch {}
      }
      return res.json({ success: true });
    } catch (err) {
      logger.error('notes.image.deleteFailed', { requestId: req.requestId, userId: req.user?.id, error: err.message });
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
