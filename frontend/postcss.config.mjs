/**
 * Tailwind v4 runs as a PostCSS plugin and needs no config file of its own —
 * the theme lives in `@theme` inside src/app/app.css.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
