'use strict';

/**
 * server/lib/textToSpeech.cjs — OpenAI TTS wrapper for outbound
 * voice replies on WhatsApp (and any future channel that accepts audio).
 *
 * OpenAI TTS pricing:
 *   tts-1     — $15/MTok input ≈ $0.015 per 1k chars  (fast, good quality)
 *   tts-1-hd  — $30/MTok input ≈ $0.030 per 1k chars  (better, ~2x slower)
 *
 * Default model is tts-1 — voice on WhatsApp doesn't need HD quality
 * and latency matters more than fidelity. Voice 'alloy' is a neutral
 * default; per-user voice preference could land later.
 *
 * Output format: mp3. UltraMsg's /messages/audio endpoint accepts mp3
 * base64-encoded without issue (verified against their docs).
 *
 * Fail-soft: any error returns { ok: false } and the caller can fall
 * back to text-only reply via sendWhatsApp.
 */

const logger = require('../../guardrails/logger.cjs');
const { incrementDailyCounter } = require('./costTracker.cjs');

const TTS_URL = 'https://api.openai.com/v1/audio/speech';
const DEFAULT_MODEL = 'tts-1';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_FORMAT = 'mp3';

// Hard cap on input text length to defend against runaway costs from a
// pathological huge reply. 2000 chars ≈ 1 minute of audio ≈ $0.03 worst
// case per generation. Aria's WhatsApp suffix caps responses at "max 3
// sentences" so 2000 is comfortable headroom.
const MAX_INPUT_CHARS = 2000;

/**
 * Generate speech audio from text.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.userId]
 * @param {string} [opts.voice]   — alloy | echo | fable | onyx | nova | shimmer
 * @param {string} [opts.model]   — 'tts-1' or 'tts-1-hd'
 * @param {string} [opts.format]  — 'mp3' | 'opus' | 'aac' | 'flac'
 * @returns {Promise<{ ok: boolean, bytes?: Buffer, mimeType?: string, error?: string }>}
 */
async function synthesizeSpeech(text, opts = {}) {
  const {
    userId = 'anon',
    voice = DEFAULT_VOICE,
    model = DEFAULT_MODEL,
    format = DEFAULT_FORMAT,
  } = opts;

  if (!process.env.OPENAI_API_KEY) return { ok: false, error: 'OPENAI_API_KEY not configured' };
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'empty text' };

  const input = text.slice(0, MAX_INPUT_CHARS).trim();
  const t0 = Date.now();
  try {
    const resp = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input,
        voice,
        response_format: format,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      logger.error('tts.synthesize.httpFail', { userId, status: resp.status, body: errBody.slice(0, 300) });
      return { ok: false, error: `tts http ${resp.status}` };
    }

    const arrayBuffer = await resp.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);
    const latencyMs = Date.now() - t0;

    incrementDailyCounter(userId, 'tts_chars', { increment: input.length }).catch(() => {});
    incrementDailyCounter(userId, 'calls:tts', { increment: 1 }).catch(() => {});
    incrementDailyCounter(userId, 'latency_ms:tts', { increment: latencyMs }).catch(() => {});

    const mimeType =
      format === 'opus' ? 'audio/ogg' :
      format === 'aac'  ? 'audio/aac' :
      format === 'flac' ? 'audio/flac' :
      'audio/mpeg';

    logger.info('tts.synthesize.complete', {
      userId, inputChars: input.length, audioBytes: bytes.length, latencyMs, voice, model,
    });
    return { ok: true, bytes, mimeType };
  } catch (err) {
    logger.error('tts.synthesize.threw', { userId, error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { synthesizeSpeech, MAX_INPUT_CHARS };
