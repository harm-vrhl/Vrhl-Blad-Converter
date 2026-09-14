import { Merriweather, Merriweather_Sans } from 'next/font/google';

/**
 * Alleen de lezer gebruikt deze faces. De chrome heeft Geist via --font-sans;
 * hier heten de tokens --reader-serif en --reader-sans, zodat een UI-wijziging
 * de pagina niet meeneemt.
 */
export const readerSerif = Merriweather({
  subsets: ['latin'],
  weight: ['400', '700', '900'],
  style: ['normal', 'italic'],
  variable: '--reader-serif',
  display: 'swap'
});

export const readerSans = Merriweather_Sans({
  subsets: ['latin'],
  weight: ['400', '700'],
  style: ['normal', 'italic'],
  variable: '--reader-sans',
  display: 'swap'
});
