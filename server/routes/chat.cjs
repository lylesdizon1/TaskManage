'use strict';

const express = require('express');

module.exports = function createChatRouter({ authenticateToken, db }) {
  const router = express.Router();

  // ── Chat history ─────────────────────────────────────────────────────────────

  router.get('/api/chat/history', authenticateToken, async (req, res) => {
    try {
      const messages = await db.getChatHistory(req.user.id, 50);
      return res.json(messages);
    } catch (err) {
      console.error('[chat] history read failed:', err.message);
      return res.json([]);
    }
  });

  router.post('/api/chat/message', authenticateToken, async (req, res) => {
    try {
      const { role, content, model } = req.body;
      if (!role || !content) {
        return res.status(400).json({ error: 'role and content are required' });
      }
      const msg = await db.saveChatMessage({ userId: req.user.id, role, content, model });
      return res.json(msg);
    } catch (err) {
      console.error('[chat] message save failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/chat/history', authenticateToken, async (req, res) => {
    try {
      await db.clearChatHistory(req.user.id);
      return res.json({ success: true });
    } catch (err) {
      console.error('[chat] history clear failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // ── Chat Conversations ──────────────────────────────────────────────────────

  router.get('/api/conversations', authenticateToken, async (req, res) => {
    try {
      const conversations = await db.getConversations(req.user.id);
      return res.json(conversations);
    } catch (err) {
      console.error('[conversations] list failed:', err.message);
      return res.json([]);
    }
  });

  router.post('/api/conversations', authenticateToken, async (req, res) => {
    try {
      const { model } = req.body;
      const conv = await db.createConversation(req.user.id, model || 'claude');
      return res.json(conv);
    } catch (err) {
      console.error('[conversations] create failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/conversations/:id', authenticateToken, async (req, res) => {
    try {
      await db.deleteConversation(parseInt(req.params.id), req.user.id);
      return res.json({ success: true });
    } catch (err) {
      console.error('[conversations] delete failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/conversations/:id', authenticateToken, async (req, res) => {
    try {
      const { title } = req.body;
      const updated = await db.updateConversationTitle(parseInt(req.params.id), req.user.id, title);
      if (!updated) return res.status(404).json({ error: 'Conversation not found' });
      return res.json(updated);
    } catch (err) {
      console.error('[conversations] update failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
    try {
      const messages = await db.getConversationMessages(parseInt(req.params.id), req.user.id);
      return res.json(messages);
    } catch (err) {
      console.error('[conversations] messages read failed:', err.message);
      return res.json([]);
    }
  });

  router.post('/api/conversations/:id/messages', authenticateToken, async (req, res) => {
    try {
      const { role, content, model } = req.body;
      if (!role || !content) return res.status(400).json({ error: 'role and content are required' });
      const msg = await db.addConversationMessage(parseInt(req.params.id), req.user.id, role, content, model);
      return res.json(msg);
    } catch (err) {
      console.error('[conversations] message save failed:', err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
