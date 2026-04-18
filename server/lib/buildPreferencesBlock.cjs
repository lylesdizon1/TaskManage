'use strict';

/**
 * server/lib/buildPreferencesBlock.cjs — Phase 1 USER PREFERENCES context
 * block. Renders explicit preferences captured via the set_preference
 * tool into a fenced block that gets appended to Aria's system prompt.
 *
 * Format (per spec):
 *   ### USER PREFERENCES ###
 *   TASKS:
 *   - ASK_FIRST: Ask before deleting tasks [ABSOLUTE]
 *   EMAIL:
 *   - NEVER: Never archive Rose Motorcars emails (sender: Rose Motorcars) [ABSOLUTE]
 *
 * Strength tag mapping (per spec's PREFERENCE PRIORITY):
 *   5 → [ABSOLUTE]   hard stop
 *   4 → [STRONG]     confirm first
 *   3 → [NORMAL]     mention conflict
 *   2 → [WEAK]       proceed with note
 *   1 → [HINT]       barely a signal
 *
 * Hard cap at 800 chars + top 20 entries so this block doesn't crowd
 * the calendar / projects / journal blocks. Higher-strength entries are
 * preserved first when truncating.
 */

const PREFS_BLOCK_CHAR_CAP = 800;
const PREFS_BLOCK_TOP_N = 20;
const STRENGTH_TAG = { 5: 'ABSOLUTE', 4: 'STRONG', 3: 'NORMAL', 2: 'WEAK', 1: 'HINT' };

/**
 * @param {Array<{ category, preferenceType, description, context, strength, isActive }>} prefs
 *   Phase 1-shape preferences from db.getUserPreferences (strength as 1–5 int).
 * @returns {string} Empty string when no usable preferences.
 */
function buildPreferencesBlock(prefs) {
  if (!Array.isArray(prefs) || prefs.length === 0) return '';
  const active = prefs.filter((p) => p.isActive !== false && p.preferenceType);
  if (!active.length) return '';

  // Stable order: strength DESC, then category ASC for grouping.
  active.sort((a, b) => (b.strength || 0) - (a.strength || 0));
  const top = active.slice(0, PREFS_BLOCK_TOP_N);

  // Group by category (preserving the strength-DESC order within each).
  const groups = {};
  for (const p of top) {
    const cat = (p.category || 'general').toUpperCase();
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(p);
  }

  const lines = ['', '### USER PREFERENCES ###'];
  for (const cat of Object.keys(groups)) {
    lines.push(`${cat}:`);
    for (const p of groups[cat]) {
      const polarity = String(p.preferenceType || '').toUpperCase();
      const tag = STRENGTH_TAG[p.strength] || 'NORMAL';
      const ctx = p.context ? ` (${p.context})` : '';
      lines.push(`- ${polarity}: ${p.description}${ctx} [${tag}]`);
    }
  }

  // Hard char cap — drop trailing lines (they're the lowest-strength).
  let out = lines.join('\n');
  if (out.length > PREFS_BLOCK_CHAR_CAP) {
    // Trim line-by-line from the end until under cap.
    while (lines.length > 2 && out.length > PREFS_BLOCK_CHAR_CAP) {
      lines.pop();
      out = lines.join('\n');
    }
    out += '\n(…truncated)';
  }
  return '\n' + out;
}

module.exports = { buildPreferencesBlock };
