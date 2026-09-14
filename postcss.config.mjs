/**
 * Tailwind 4 draait als PostCSS-plugin, en dat is de hele opzet: er is geen
 * tailwind.config.ts meer. Wat vroeger in dat configbestand stond (kleuren,
 * maten, thema) staat in v4 in de CSS zelf, in een @theme-blok.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {}
  }
};

export default config;
