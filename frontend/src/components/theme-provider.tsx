'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { PALETTES } from '../lib/theme';

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'tk-theme';

/*
 * Dark is the default rather than the OS preference, deliberately. The palette
 * is dark-first — `:root` in app.css is the dark set — and following
 * prefers-color-scheme would flip the site to light for the majority of
 * visitors whose OS is light. That is a product decision, so it is not made
 * here. Setting `data-theme` explicitly also means the attribute is always
 * present, which keeps the CSS selectors unambiguous.
 */
export const DEFAULT_THEME: Theme = 'dark';

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

type ThemeContextValue = { theme: Theme; setTheme: (next: Theme) => void; toggle: () => void };

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Writes the attribute AND the legacy accent variables.
 *
 * The accent pair is what the not-yet-converted Tickwise routes colour
 * themselves with (`--tk-accent` / `--tk-accent-ink` in globals.css), and they
 * differ per theme — the dark hex is too bright on a white canvas. Applying
 * only `data-theme` would leave a legacy page in light mode with its dark
 * accent, so the two are set together here rather than in two places that can
 * disagree. The Tickwise palette does not read them; this is purely to keep the
 * unconverted half of the site correct while both exist.
 */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);

  let key = PALETTES[0].key;
  try {
    key = window.localStorage.getItem('tk-accent-key') || PALETTES[0].key;
  } catch {
    /* storage unavailable — the default palette is correct */
  }
  const palette = PALETTES.find((p) => p.key === key) ?? PALETTES[0];
  const accent = theme === 'dark' ? palette.key : palette.light;
  const ink = theme === 'dark' ? palette.darkInk : palette.lightInk;
  root.style.setProperty('--tk-accent', accent);
  root.style.setProperty('--tk-accent-ink', ink);

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    window.localStorage.setItem('tk-accent', accent);
    window.localStorage.setItem('tk-accent-ink', ink);
  } catch {
    // Private browsing or a full quota. The theme still applies for this
    // session; only persistence is lost, which is not worth surfacing.
  }
}

/**
 * Owns `data-theme` after hydration.
 *
 * The attribute is already correct at first paint — the inline bootstrap in
 * layout.tsx replays it from localStorage before the browser paints — so this
 * provider reads the stored value rather than defaulting and overwriting it.
 * Initialising from DEFAULT_THEME would undo a persisted light choice on every
 * load.
 *
 * No context is required for the theme to WORK: every component follows the CSS
 * custom properties and re-renders in the new palette with no React
 * involvement. The context exists so a control can read and change it.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      /* storage unavailable; fall through to the default */
    }
    const resolved = isTheme(stored) ? stored : DEFAULT_THEME;
    setThemeState(resolved);
    applyTheme(resolved);
  }, []);

  // Cross-tab sync. Fires only in OTHER tabs, so it can never loop with the
  // write in `applyTheme`.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY || !isTheme(e.newValue)) return;
      setThemeState(e.newValue);
      applyTheme(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
  }, []);

  const toggle = useCallback(
    () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    [theme, setTheme],
  );

  return <ThemeContext.Provider value={{ theme, setTheme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
