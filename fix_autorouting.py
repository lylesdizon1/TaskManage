import os

# Step 1: Create personaRouter.js
router_content = """// src/lib/context-engine/personaRouter.js
// Maps detected intent to the best persona for that domain

const INTENT_TO_PERSONA = {
  FINANCIAL: 'cfo',
  TASK:      'coo',
  CALENDAR:  'coo',
  FAMILY:    'home',
  HEALTH:    'health',
  JOURNAL:   'lifecoach',
  ENTITY:    'aria',
  GENERAL:   'aria',
};

export function routePersona(intent) {
  return INTENT_TO_PERSONA[intent] ?? 'aria';
}
"""

os.makedirs("src/lib/context-engine", exist_ok=True)
with open("src/lib/context-engine/personaRouter.js", "w") as f:
    f.write(router_content)
print("Done! Created personaRouter.js")

# Step 2: Patch App.jsx — add import for detectIntent + routePersona
app_path = "src/App.jsx"
with open(app_path, "r") as f:
    content = f.read()

# Add imports after buildContext import
old_import = "import { buildContext } from './lib/context-engine/buildContext';"
new_import = """import { buildContext } from './lib/context-engine/buildContext';
import { detectIntent } from './lib/context-engine/intentDetector';
import { routePersona } from './lib/context-engine/personaRouter';"""

if old_import not in content:
    print("ERROR: buildContext import not found")
else:
    content = content.replace(old_import, new_import, 1)
    print("Done! Added imports")

# Step 3: Add autoPersona state near chatLoading state
old_state = "    setChatLoading(true);"
new_state = """    // Auto-route to best persona for this message
    const detectedIntent = detectIntent(text);
    const routedPersonaId = routePersona(detectedIntent);
    const { getPersonaById: _getPersonaById } = await import('./config/personas');
    const routedPersona = _getPersonaById(routedPersonaId);
    const effectivePersona = routedPersona ?? activePersona;
    setChatLoading(true);"""

if old_state not in content:
    print("ERROR: setChatLoading(true) target not found")
else:
    content = content.replace(old_state, new_state, 1)
    print("Done! Added auto-routing logic")

# Step 4: Use effectivePersona in buildContext
old_build = "    const sysPrompt = buildContext({ message: text, tasks, entities: userEntities, financials: financialTransactions, notes: allNotes, calendarEvents: chatCalendarEvents, personaSystemPrompt: activePersona.systemPrompt });"
new_build = "    const sysPrompt = buildContext({ message: text, tasks, entities: userEntities, financials: financialTransactions, notes: allNotes, calendarEvents: chatCalendarEvents, personaSystemPrompt: effectivePersona.systemPrompt, autoPersonaEmoji: effectivePersona.emoji, autoPersonaName: effectivePersona.defaultName });"

if old_build not in content:
    print("ERROR: buildContext call not found")
else:
    content = content.replace(old_build, new_build, 1)
    print("Done! Wired effectivePersona into buildContext")

with open(app_path, "w") as f:
    f.write(content)

print("\nAll done! Verify with:")
print("grep -n 'detectIntent\\|routePersona\\|effectivePersona' src/App.jsx | head -10")
