// src/lib/context-engine/personaRouter.js
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
