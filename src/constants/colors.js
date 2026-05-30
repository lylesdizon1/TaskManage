// Color presets for entities — maps color name to Tailwind classes
export const COLOR_PRESETS = {
  indigo: { bg: 'bg-accent-surface', text: 'text-primary', border: 'border-primary', ring: 'ring-primary', dot: 'bg-primary' },
  pink:   { bg: 'bg-pink-100',   text: 'text-pink-700',   border: 'border-pink-200',   ring: 'ring-pink-400',   dot: 'bg-pink-500' },
  amber:  { bg: 'bg-warning-surface',  text: 'text-warning',  border: 'border-warning',  ring: 'ring-warning',  dot: 'bg-warning' },
  teal:   { bg: 'bg-teal-100',   text: 'text-teal-700',   border: 'border-teal-200',   ring: 'ring-teal-400',   dot: 'bg-teal-500' },
  slate:  { bg: 'bg-surface-container',  text: 'text-on-surface-variant',  border: 'border-outline-variant',  ring: 'ring-outline-variant',  dot: 'bg-outline' },
  red:    { bg: 'bg-danger-surface',    text: 'text-danger',    border: 'border-danger',    ring: 'ring-danger',    dot: 'bg-danger' },
  green:  { bg: 'bg-success-surface',  text: 'text-success',  border: 'border-success',  ring: 'ring-success',  dot: 'bg-success' },
  blue:   { bg: 'bg-accent-surface',   text: 'text-primary',   border: 'border-primary',   ring: 'ring-primary',   dot: 'bg-primary' },
  purple: { bg: 'bg-accent-surface', text: 'text-primary', border: 'border-primary', ring: 'ring-primary', dot: 'bg-primary' },
  orange: { bg: 'bg-warning-surface', text: 'text-warning', border: 'border-warning', ring: 'ring-warning', dot: 'bg-warning' },
};

export const AVAILABLE_COLORS = Object.keys(COLOR_PRESETS);

export function getEntityStyle(colorName) {
  return COLOR_PRESETS[colorName] || COLOR_PRESETS.slate;
}

export function getTagStyle(tagName, entities) {
  const entity = entities.find((e) => e.name === tagName);
  return getEntityStyle(entity?.color);
}

export const PRIORITY_BORDER = {
  high:   'border-l-4 border-l-danger',
  medium: 'border-l-4 border-l-warning',
  low:    'border-l-4 border-l-success',
};

export const PRIORITY_BADGE = {
  high:   'bg-danger-surface   text-danger',
  medium: 'bg-warning-surface text-warning',
  low:    'bg-success-surface text-success',
};
