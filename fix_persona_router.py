path = "src/lib/context-engine/personaRouter.js"

new_content = """// src/lib/context-engine/personaRouter.js
// Aria handles most things. Specialists only for deep domain requests.

const INTENT_TO_PERSONA = {
  FINANCIAL: 'cfo',      // explicit money/finance analysis
  FAMILY:    'home',     // liz, kids, household
  HEALTH:    'health',   // workouts, sleep, nutrition
  JOURNAL:   'lifecoach', // reflection, habits, growth
  TASK:      'aria',     // casual task questions → Aria
  CALENDAR:  'aria',     // schedule questions → Aria
  ENTITY:    'aria',     // contacts/companies → Aria
  GENERAL:   'aria',     // everything else → Aria
};

export function routePersona(intent) {
  return INTENT_TO_PERSONA[intent] ?? 'aria';
}
"""

with open(path, "w") as f:
    f.write(new_content)
print("Done!")
