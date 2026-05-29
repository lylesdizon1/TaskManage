'use strict';

/**
 * server/lib/audioTranscription.cjs — OpenAI Whisper wrapper for inbound
 * voice notes (WhatsApp today; SMS/voice surfaces later).
 *
 * Whisper pricing: $0.006/min (≈$0.003 per 30s voice note).
 * The OpenAI account is shared infrastructure; per-user token budget
 * tracking treats minutes as a separate scope so we can attribute
 * spend if needed.
 *
 * Supported input formats (per OpenAI docs): mp3, mp4, mpeg, mpga, m4a,
 * wav, webm, ogg. WhatsApp voice notes arrive as audio/ogg (Opus codec)
 * which Whisper handles natively — no transcode needed.
 *
 * Fail-soft: any error returns { ok: false } and the caller falls back
 * to treating the message as media-only (the inbound WhatsApp handler
 * already has a graceful path for "couldn't process this media").
 */

const logger = require('../../guardrails/logger.cjs');
const { incrementDailyCounter } = require('./costTracker.cjs');

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const MODEL = 'whisper-1';

// Hard cap on audio size to avoid runaway costs from a maliciously-large
// upload. Whisper accepts up to 25MB. 5MB ≈ 5 minutes of ogg/opus voice —
// generous for normal use, defensive against the worst case.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/**
 * Transcribe an audio buffer via Whisper.
 *
 * @param {Buffer} bytes
 * @param {string} mimeType — e.g. 'audio/ogg', 'audio/mpeg'
 * @param {object} [opts]
 * @param {string} [opts.userId] — for cost tracking attribution
 * @param {string} [opts.filename] — sent to Whisper for content-type hint
 * @returns {Promise<{ ok: boolean, text?: string, error?: string }>}
 */
async function transcribeAudio(bytes, mimeType, opts = {}) {
  const { userId = 'anon', filename } = opts;

  if (!process.env.OPENAI_API_KEY) {
    return { ok: false, error: 'OPENAI_API_KEY not configured' };
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return { ok: false, error: 'empty audio' };
  }
  if (bytes.length > MAX_AUDIO_BYTES) {
    return { ok: false, error: `audio too large (${Math.round(bytes.length / 1024)}KB > ${MAX_AUDIO_BYTES / 1024}KB)` };
  }

  // Pick a filename Whisper can infer the codec from. WhatsApp voice
  // notes are ogg/opus; fall back generically when content-type is unknown.
  const inferredName = filename || (
    mimeType?.includes('ogg') ? 'voice.ogg' :
    mimeType?.includes('mpeg') || mimeType?.includes('mp3') ? 'voice.mp3' :
    mimeType?.includes('wav') ? 'voice.wav' :
    mimeType?.includes('mp4') || mimeType?.includes('m4a') ? 'voice.m4a' :
    mimeType?.includes('webm') ? 'voice.webm' :
    'voice.ogg'
  );

  const t0 = Date.now();
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType || 'audio/ogg' }), inferredName);
    form.append('model', MODEL);

    const resp = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      logger.error('whisper.transcribe.httpFail', { userId, status: resp.status, body: errBody.slice(0, 300) });
      return { ok: false, error: `whisper http ${resp.status}` };
    }

    const data = await resp.json();
    const text = typeof data?.text === 'string' ? data.text.trim() : '';
    const latencyMs = Date.now() - t0;

    // Cost tracking — bytes is a rough proxy for minutes (ogg/opus is
    // ~24kbps so 1 min ≈ 180KB). We don't get minute count back from
    // Whisper, so track bytes processed under 'transcription' scope.
    incrementDailyCounter(userId, 'transcription_bytes', { increment: bytes.length }).catch(() => {});
    incrementDailyCounter(userId, 'calls:transcription', { increment: 1 }).catch(() => {});
    incrementDailyCounter(userId, 'latency_ms:transcription', { increment: latencyMs }).catch(() => {});

    logger.info('whisper.transcribe.complete', {
      userId, audioBytes: bytes.length, transcriptChars: text.length, latencyMs,
    });

    if (!text) return { ok: false, error: 'empty transcription' };
    return { ok: true, text };
  } catch (err) {
    logger.error('whisper.transcribe.threw', { userId, error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { transcribeAudio, MAX_AUDIO_BYTES };
