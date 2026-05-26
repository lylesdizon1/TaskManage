'use strict';

/**
 * server/utils/sourceChannel.cjs — Strict enum validation for the
 * `source_channel` column on memory_facts.
 *
 * Per memory-phase-2.md Q1: unknown values throw at write time. No
 * 'unknown' fallback. If a caller can't determine the channel, the
 * caller is wrong and must be fixed.
 *
 * The helper accepts undefined/null/'' as "no channel context, write
 * SQL NULL" — this is for callers that genuinely have no signal (e.g.
 * a legacy path that hasn't been migrated). It is NOT a typo-catch.
 * Typos (any non-empty string outside the enum) throw.
 *
 * Allowed values:
 *   web_chat           — agentic chat from web Command Center
 *   whatsapp           — agentic chat from WhatsApp inbound
 *   sms                — future SMS channel (reserved, not yet wired)
 *   journal            — journalEnrichment writes (daily wrap)
 *   outcome            — outcomeEnrichment writes (post-task/event notes)
 *   contact_note       — contactFactExtractor writes (notes about a person)
 *   explicit_remember  — remember_this tool invocations
 *
 * Adding a new value: extend ALLOWED below + update memory-phase-2.md.
 */

const ALLOWED = new Set([
  'web_chat',
  'whatsapp',
  'sms',
  'journal',
  'outcome',
  'contact_note',
  'explicit_remember',
]);

/**
 * Validate (and normalize) a source_channel value.
 * @param {string|null|undefined} value
 * @returns {string|null} the validated enum value, or null when input is empty
 * @throws {Error} when input is a non-empty string outside the enum
 */
function assertSourceChannel(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error(`source_channel must be a string, got ${typeof value}`);
  }
  if (!ALLOWED.has(value)) {
    throw new Error(`source_channel "${value}" not in allowed set (${[...ALLOWED].join(', ')})`);
  }
  return value;
}

module.exports = { assertSourceChannel, SOURCE_CHANNELS: ALLOWED };
