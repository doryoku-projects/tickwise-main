/**
 * Accent palette, keyed by the dark-mode accent hex; `light` is the darker
 * variant used on the light canvas. `*Ink` = readable text colour on the accent.
 * The default (first entry) is applied unless a `tk-accent-key` was persisted.
 */
export const PALETTES: Array<{
  key: string;
  name: string;
  light: string;
  darkInk: string;
  lightInk: string;
}> = [
  { key: '#2ee6c9', name: 'Turquoise', light: '#0d9488', darkInk: '#03211b', lightInk: '#ffffff' },
  { key: '#818cf8', name: 'Indigo', light: '#4f46e5', darkInk: '#0a0b18', lightInk: '#ffffff' },
  { key: '#34d6ee', name: 'Cyan', light: '#0e8ba8', darkInk: '#03161b', lightInk: '#ffffff' },
  { key: '#fbbf24', name: 'Amber', light: '#c4790a', darkInk: '#1c1400', lightInk: '#ffffff' },
  { key: '#e879f9', name: 'Fuchsia', light: '#b524c9', darkInk: '#1e0826', lightInk: '#ffffff' },
];


/*
 * The `useDarkMode` hook that used to live here has been deleted.
 *
 * It was the OLDER of two theme writers — `components/theme-provider.tsx` is
 * the other — and two hooks racing to own `data-theme` and the accent variables
 * is a bug waiting for the first page that mounts both. Its only consumer was
 * `SiteHeader`, which only the admin realm rendered; that shell is now the
 * shared `MarketingHeader`, so nothing was left calling it.
 *
 * `PALETTES` stays: `ThemeProvider.applyTheme` reads it to keep the legacy
 * accent variables correct for whatever is still dressed by the Tickwise
 * stylesheets. It goes when they do.
 */
