'use strict';

/**
 * server/lib/textToSpeech.cjs — TTS provider with ElevenLabs primary,
 * OpenAI fallback. Provider selection is automatic based on env:
 *
 *   ELEVENLABS_API_KEY set  → use ElevenLabs (preferred — better voice)
 *   else if OPENAI_API_KEY  → use OpenAI tts-1
 *   else                     → { ok: false }
 *
 * ElevenLabs config (all optional except the key):
 *   ELEVENLABS_API_KEY       — required to enable
 *   ELEVENLABS_VOICE_ID      — defaults to 'Rachel' (21m00Tcm4TlvDq8ikWAM)
 *   ELEVENLABS_MODEL         — defaults to 'eleven_turbo_v2_5' (fastest)
 *
 * ElevenLabs pricing (2026):
 *   Free            10k chars/mo
 *   Starter $5      30k chars/mo
 *   Creator $22     100k chars/mo
 *   Pro $99         500k chars/mo
 *   $0.30 per 1k chars on overages (Creator+).
 *
 * OpenAI fallback pricing:
 *   tts-1           $15/MTok input ≈ $0.015 per 1k chars
 *
 * Both return MP3 by default — UltraMsg's /messages/audio endpoint
 * accepts MP3 base64-encoded without issue.
 *
 * Fail-soft: any error returns { ok: false } and the caller can fall
 * back to text-only reply.
 */

const logger = require('../../guardrails/logger.cjs');
const { incrementDailyCounter } = require('./costTracker.cjs');

const OPENAI_URL = 'https://api.openai.com/v1/audio/speech';
const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM'; // 'Rachel' — neutral female default
const ELEVENLABS_DEFAULT_MODEL = 'eleven_turbo_v2_5';    // fast + good quality

// Hard cap on input text length to defend against runaway costs. 2000 chars
// ≈ 1 min audio. Aria's WhatsApp suffix already caps responses at "max 3
// sentences" so 2000 is comfortable headroom.
const MAX_INPUT_CHARS = 2000;

function pickProvider() {
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.OPENAI_API_KEY)     return 'openai';
  return null;
}

async function synthesizeViaElevenLabs(text, { userId }) {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || ELEVENLABS_DEFAULT_VOICE;
  const model = process.env.ELEVENLABS_MODEL || ELEVENLABS_DEFAULT_MODEL;
  const t0 = Date.now();

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: {
        stability: 0.5,        // 0=variable, 1=stable. 0.5 is the documented sweet spot.
        similarity_boost: 0.75, // how close to the cloned voice's timbre
      },
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    logger.error('tts.elevenlabs.httpFail', { userId, status: resp.status, body: body.slice(0, 300), voiceId, model });
    return { ok: false, error: `elevenlabs http ${resp.status}` };
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  const latencyMs = Date.now() - t0;
  incrementDailyCounter(userId, 'tts_chars',          { increment: text.length }).catch(() => {});
  incrementDailyCounter(userId, 'calls:tts',          { increment: 1 }).catch(() => {});
  incrementDailyCounter(userId, 'latency_ms:tts',     { increment: latencyMs }).catch(() => {});
  incrementDailyCounter(userId, 'tts_provider:elevenlabs', { increment: 1 }).catch(() => {});
  logger.info('tts.elevenlabs.complete', { userId, inputChars: text.length, audioBytes: bytes.length, latencyMs, voiceId, model });
  return { ok: true, bytes, mimeType: 'audio/mpeg' };
}

async function synthesizeViaOpenAI(text, { userId }) {
  const t0 = Date.now();
  const resp = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: 'alloy',
      response_format: 'mp3',
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    logger.error('tts.openai.httpFail', { userId, status: resp.status, body: body.slice(0, 300) });
    return { ok: false, error: `openai http ${resp.status}` };
  }
  const bytes = Buffer.from(await resp.arrayBuffer());
  const latencyMs = Date.now() - t0;
  incrementDailyCounter(userId, 'tts_chars',          { increment: text.length }).catch(() => {});
  incrementDailyCounter(userId, 'calls:tts',          { increment: 1 }).catch(() => {});
  incrementDailyCounter(userId, 'latency_ms:tts',     { increment: latencyMs }).catch(() => {});
  incrementDailyCounter(userId, 'tts_provider:openai', { increment: 1 }).catch(() => {});
  logger.info('tts.openai.complete', { userId, inputChars: text.length, audioBytes: bytes.length, latencyMs });
  return { ok: true, bytes, mimeType: 'audio/mpeg' };
}

/**
 * Generate speech audio from text via the best-available provider.
 * Returns { ok, bytes, mimeType, provider } on success.
 */
async function synthesizeSpeech(text, opts = {}) {
  const { userId = 'anon' } = opts;
  const provider = pickProvider();
  if (!provider) return { ok: false, error: 'no TTS provider configured (set ELEVENLABS_API_KEY or OPENAI_API_KEY)' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty text' };

  const input = text.slice(0, MAX_INPUT_CHARS).trim();
  try {
    const result = provider === 'elevenlabs'
      ? await synthesizeViaElevenLabs(input, { userId })
      : await synthesizeViaOpenAI(input, { userId });
    if (result.ok) result.provider = provider;
    return result;
  } catch (err) {
    logger.error('tts.synthesize.threw', { userId, provider, error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { synthesizeSpeech, pickProvider, MAX_INPUT_CHARS };
