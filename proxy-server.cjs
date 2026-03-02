/**
 * proxy-server.cjs
 *
 * Lightweight Express proxy that relays requests to:
 *   POST /api/claude  → https://api.anthropic.com/v1/messages
 *   POST /api/openai  → https://api.openai.com/v1/chat/completions
 *
 * The API key is passed in the request body and forwarded as the appropriate
 * auth header, so it is never stored or logged by this server.
 *
 * Start with: node proxy-server.cjs
 */

'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// Simple request logger (no keys logged)
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * Claude proxy
 * Body: { apiKey: string, ...anthropicPayload }
 */
app.post('/api/claude', async (req, res) => {
  const { apiKey, ...body } = req.body;

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing apiKey in request body' });
  }

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      body,
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 60_000,
      },
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const data = err.response?.data || { error: err.message };
    return res.status(status).json(data);
  }
});

/**
 * OpenAI proxy
 * Body: { apiKey: string, ...openaiPayload }
 */
app.post('/api/openai', async (req, res) => {
  const { apiKey, ...body } = req.body;

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing apiKey in request body' });
  }

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      body,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        timeout: 60_000,
      },
    );
    return res.status(response.status).json(response.data);
  } catch (err) {
    const status = err.response?.status || 502;
    const data = err.response?.data || { error: err.message };
    return res.status(status).json(data);
  }
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', port: PORT }));

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✓ TaskManage proxy running at http://localhost:${PORT}`);
  console.log('  POST /api/claude  → api.anthropic.com');
  console.log('  POST /api/openai  → api.openai.com');
  console.log('  GET  /health\n');
});
