export const PILLAR_CONFIG = {
  hustle: { label: 'Hustle', bg: 'bg-blue-100', text: 'text-blue-700', border: 'border-blue-200', dot: 'bg-blue-500', emoji: '\u{1F535}' },
  home: { label: 'Home', bg: 'bg-green-100', text: 'text-green-700', border: 'border-green-200', dot: 'bg-green-500', emoji: '\u{1F7E2}' },
  move: { label: 'Move', bg: 'bg-orange-100', text: 'text-orange-700', border: 'border-orange-200', dot: 'bg-orange-500', emoji: '\u{1F7E0}' },
  grow: { label: 'Grow', bg: 'bg-purple-100', text: 'text-purple-700', border: 'border-purple-200', dot: 'bg-purple-500', emoji: '\u{1F7E3}' },
};

export const PILLAR_KEYS = Object.keys(PILLAR_CONFIG);

export const VIEW_TO_PILLAR = {
  daily: 'hustle',
  priority: 'hustle',
};
