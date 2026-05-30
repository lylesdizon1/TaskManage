export const PILLAR_CONFIG = {
  // Categorical pillar colors: light unchanged; dark: variants added so chips
  // don't glare as light boxes in dark mode (hue identity preserved).
  hustle: { label: 'Hustle', bg: 'bg-blue-100 dark:bg-blue-500/15', text: 'text-blue-700 dark:text-blue-300', border: 'border-blue-200 dark:border-blue-500/25', dot: 'bg-blue-500', emoji: '\u{1F535}' },
  home: { label: 'Home', bg: 'bg-green-100 dark:bg-green-500/15', text: 'text-green-700 dark:text-green-300', border: 'border-green-200 dark:border-green-500/25', dot: 'bg-green-500', emoji: '\u{1F7E2}' },
  move: { label: 'Move', bg: 'bg-orange-100 dark:bg-orange-500/15', text: 'text-orange-700 dark:text-orange-300', border: 'border-orange-200 dark:border-orange-500/25', dot: 'bg-orange-500', emoji: '\u{1F7E0}' },
  grow: { label: 'Grow', bg: 'bg-purple-100 dark:bg-purple-500/15', text: 'text-purple-700 dark:text-purple-300', border: 'border-purple-200 dark:border-purple-500/25', dot: 'bg-purple-500', emoji: '\u{1F7E3}' },
};

export const PILLAR_KEYS = Object.keys(PILLAR_CONFIG);

export const VIEW_TO_PILLAR = {
  daily: 'hustle',
  priority: 'hustle',
};
