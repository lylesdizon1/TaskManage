export function detectIntent(message) {
  const m = message.toLowerCase();
  if (/transaction|spend|money|cost|budget|revenue|profit|invoice|expense|payment/.test(m)) return 'FINANCIAL';
  if (/task|todo|complete|project|deadline|priority|backlog|assign/.test(m)) return 'TASK';
  if (/meeting|schedule|event|calendar|appointment|today|tomorrow|week/.test(m)) return 'CALENDAR';
  if (/liz|kids|family|home|dinner|school|house/.test(m)) return 'FAMILY';
  if (/workout|run|gym|sleep|weight|steps|health|exercise|calories/.test(m)) return 'HEALTH';
  if (/feel|think|reflect|mood|journal|grateful|stress|anxiety|happy/.test(m)) return 'JOURNAL';
  if (/contact|person|company|relationship|client|partner|vendor/.test(m)) return 'ENTITY';
  return 'GENERAL';
}
