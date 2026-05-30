import { createContext, useContext, useState, useEffect, useCallback } from 'react';

/**
 * Theme state: 'system' | 'light' | 'dark'.
 *
 * - Applies the resolved theme to <html data-theme> (the CSS token layer
 *   in index.css keys off this attribute).
 * - Mirrors the preference to localStorage('dizon-theme') so the pre-mount
 *   script in index.html can paint the right theme with no FOUC next load.
 * - Server is the source of truth: App reconciles via setThemePref() after
 *   loading /api/preferences; the Settings toggle persists the change back.
 */
const ThemeContext = createContext(null);
const STORAGE_KEY = 'dizon-theme';
const VALID = ['system', 'light', 'dark'];

function prefersDark() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}
function resolve(pref) {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return prefersDark() ? 'dark' : 'light';
}
function applyToDom(pref) {
  const r = resolve(pref);
  document.documentElement.setAttribute('data-theme', r);
  return r;
}

export function ThemeProvider({ children }) {
  const [themePref, setThemePrefState] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || 'system'; } catch { return 'system'; }
  });
  const [resolved, setResolved] = useState(() => resolve(themePref));

  const setThemePref = useCallback((pref) => {
    const next = VALID.includes(pref) ? pref : 'system';
    setThemePrefState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
    setResolved(applyToDom(next));
  }, []);

  // Keep the DOM in sync on mount (covers state/localStorage divergence).
  useEffect(() => { setResolved(applyToDom(themePref)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow OS changes live while in 'system'.
  useEffect(() => {
    if (themePref !== 'system' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(applyToDom('system'));
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themePref]);

  return (
    <ThemeContext.Provider value={{ themePref, resolved, setThemePref }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
