"use client";

import { useEffect, useRef } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startTour, tourBezig, uitlegGezien, type TourCtx } from "@/components/article/tour";
import "driver.js/dist/driver.css";
import "./tour.css";

/**
 * Rondleiding bij het huidige scherm. Op een lege browser start hij een keer
 * vanzelf; daarna alleen via deze knop.
 */
export function UitlegKnop({
  auto,
  openSidebar,
  naarArtikel,
}: {
  auto?: boolean;
  openSidebar?: () => void;
  naarArtikel?: () => void;
}) {
  const ctx = useRef<TourCtx>({ openSidebar, naarArtikel });
  ctx.current = { openSidebar, naarArtikel };

  useEffect(() => {
    if (!auto || uitlegGezien()) return;
    const wacht = window.setTimeout(() => {
      if (tourBezig() || uitlegGezien()) return;
      startTour(ctx.current);
    }, 700);
    return () => window.clearTimeout(wacht);
  }, [auto]);

  return (
    <Button
      variant="ghost"
      size="sm"
      data-tour="uitleg"
      className="text-muted-foreground hover:text-foreground"
      title="Rondleiding"
      aria-label="Uitleg"
      onClick={() => startTour(ctx.current)}
    >
      <CircleHelp />
      <span className="hidden sm:inline">Uitleg</span>
    </Button>
  );
}
