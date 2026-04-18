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
 * @param {Array<{ patternType, category, ruleText, contextData, strength, signalCount }>} [inferred]
 *   Phase 2-shape inferred rules from db.getInferredRulesForUser (strength as 0.0–1.0 float).
 * @returns {string} Empty string when no usable rules.
 */
function buildPreferencesBlock(prefs, inferred = []) {
  const active = Array.isArray(prefs) ? prefs.filter((p) => p.isActive !== false && p.preferenceType) : [];
  const inferredActive = Array.isArray(inferred) ? inferred.filter((r) => r.isActive !== false && r.strength >= 0.3) : [];
  if (!active.length && !inferredActive.length) return '';

  const lines = ['', '### USER PREFERENCES ###'];

  // Explicit preferences — grouped by category, strength DESC within each.
  if (active.length) {
    active.sort((a, b) => (b.strength || 0) - (a.strength || 0));
    const top = active.slice(0, PREFS_BLOCK_TOP_N);
    const groups = {};
    for (const p of top) {
      const cat = (p.category || 'general').toUpperCase();
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(p);
    }
    for (const cat of Object.keys(groups)) {
      lines.push(`${cat}:`);
      for (const p of groups[cat]) {
        const polarity = String(p.preferenceType || '').toUpperCase();
        const tag = STRENGTH_TAG[p.strength] || 'NORMAL';
        const ctx = p.context ? ` (${p.context})` : '';
        lines.push(`- ${polarity}: ${p.description}${ctx} [${tag}]`);
      }
    }
  }

  // Phase 2 inferred patterns — separate sub-section so the model can
  // distinguish "user said X" from "we observed X". Float strength
  // displayed directly (no integer scale) since these are observed
  // probabilities, not user-stated levels.
  if (inferredActive.length) {
    inferredActive.sort((a, b) => (b.strength || 0) - (a.strength || 0));
    const topInferred = inferredActive.slice(0, PREFS_BLOCK_TOP_N);
    lines.push('');
    lines.push('INFERRED PATTERNS (observed, not stated):');
    for (const r of topInferred) {
      const cat = (r.category || 'general').toLowerCase();
      const strengthStr = (r.strength || 0).toFixed(2);
      const sigStr = r.signalCount ? `, ${r.signalCount} signals` : '';
      lines.push(`- [${cat}] ${r.ruleText} (strength ${strengthStr}${sigStr})`);
    }
  }

  // Hard char cap — drop trailing lines (they're the lowest-strength).
  let out = lines.join('\n');
  if (out.length > PREFS_BLOCK_CHAR_CAP) {
    while (lines.length > 2 && out.length > PREFS_BLOCK_CHAR_CAP) {
      lines.pop();
      out = lines.join('\n');
    }
    out += '\n(…truncated)';
  }
  return '\n' + out;
}

module.exports = { buildPreferencesBlock };
