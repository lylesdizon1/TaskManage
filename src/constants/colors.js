// Color presets for entities — maps color name to Tailwind classes
export const COLOR_PRESETS = {
  indigo: { bg: 'bg-indigo-100', text: 'text-indigo-700', border: 'border-indigo-200', ring: 'ring-indigo-400', dot: 'bg-indigo-500' },
  pink:   { bg: 'bg-pink-100',   text: 'text-pink-700',   border: 'border-pink-200',   ring: 'ring-pink-400',   dot: 'bg-pink-500' },
  amber:  { bg: 'bg-amber-100',  text: 'text-amber-700',  border: 'border-amber-200',  ring: 'ring-amber-400',  dot: 'bg-amber-500' },
  teal:   { bg: 'bg-teal-100',   text: 'text-teal-700',   border: 'border-teal-200',   ring: 'ring-teal-400',   dot: 'bg-teal-500' },
  slate:  { bg: 'bg-slate-100',  text: 'text-slate-600',  border: 'border-slate-200',  ring: 'ring-slate-400',  dot: 'bg-slate-500' },
  red:    { bg: 'bg-red-100',    text: 'text-red-700',    border: 'border-red-200',    ring: 'ring-red-400',    dot: 'bg-red-500' },
  green:  { bg: 'bg-green-100',  text: 'text-green-700',  border: 'border-green-200',  ring: 'ring-green-400',  dot: 'bg-green-500' },
  blue:   { bg: 'bg-blue-100',   text: 'text-blue-700',   border: 'border-blue-200',   ring: 'ring-blue-400',   dot: 'bg-blue-500' },
  purple: { bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200', ring: 'ring-purple-400', dot: 'bg-purple-500' },
  orange: { bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200', ring: 'ring-orange-400', dot: 'bg-orange-500' },
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
  high:   'border-l-4 border-l-red-500',
  medium: 'border-l-4 border-l-amber-400',
  low:    'border-l-4 border-l-green-500',
};

export const PRIORITY_BADGE = {
  high:   'bg-red-50   text-red-500',
  medium: 'bg-amber-50 text-amber-500',
  low:    'bg-green-50 text-green-600',
};
