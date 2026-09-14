import type { Metadata } from 'next';
import './globals.css';
import { Geist } from "next/font/google";
// Rechtstreeks uit "cn", zoals elk component in components/ui/ het ook doet.
// lib/utils.ts is een doorgeefluik dat init erbij zette en dat hier niets toevoegt.
import { cn } from "cn";
// Tooltip werkt alleen binnen een provider; die hoort om de hele app heen.
import { TooltipProvider } from "@/components/ui/tooltip";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: 'Vrhl Blad Converter',
  description: 'Magazineartikel naar één betrouwbare verticale artikelstructuur.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl" className={cn("font-sans antialiased", geist.variable)}>
      <body className="min-h-svh bg-background text-foreground">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
