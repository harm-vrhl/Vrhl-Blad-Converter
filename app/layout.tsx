import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Vrhl Blad Converter',
  description: 'Magazineartikel naar één betrouwbare verticale artikelstructuur.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}
