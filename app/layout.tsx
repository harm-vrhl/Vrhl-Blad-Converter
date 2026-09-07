import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vrhl Blad Converter',
  description: 'Magazineartikel naar één betrouwbare verticale artikelstructuur.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <head>
        {/* Vrhl-Blad's own faces, so the article preview is set in the type the
            published page uses. The converter's own chrome stays monospace. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Merriweather:ital,wght@0,400;0,700;0,900;1,400;1,700&family=Merriweather+Sans:ital,wght@0,400;0,700;1,400;1,700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
