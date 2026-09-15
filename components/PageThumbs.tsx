'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, XIcon } from 'lucide-react';
import { useStoredUrl } from '@/components/StoredImage';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import type { PageAsset } from '@/lib/types';

/**
 * After upload the pages themselves are the view: a grid of the rasterised
 * spreads, filling in as pdf.js finishes each one. A click opens the page at
 * the size the runs look at, so a question about type or placement can be
 * checked against the source.
 *
 * De dialog is die van shadcn in plaats van het native <dialog>-element: die
 * regelt focus, scroll-lock en Escape zelf, dus dat hoeft hier niet meer met de
 * hand. De pijltjestoetsen blijven wel van ons, want bladeren is geen dialoog.
 *
 * Dit is een lightbox, geen formulierkaart. Een image viewer zet een donker,
 * dekkend canvas achter de foto (niet 10% zwart plus blur) zodat de pagina
 * erachter wegzakt, en geeft de pagina zelf een ondoorzichtige witte ondergrond:
 * bladpapier is wit, en een glasplaat eromheen laat de app erdoorheen schemeren.
 */
export function PageThumbs({
  thumbs,
  jobId,
  pages,
  pageCount
}: {
  thumbs: string[];
  jobId: string | null;
  pages: PageAsset[];
  pageCount: number;
}) {
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    setOpen(null);
  }, [jobId]);

  useEffect(() => {
    if (open == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') setOpen((n) => (n == null || n === 0 ? n : n - 1));
      if (event.key === 'ArrowRight') setOpen((n) => (n == null || n >= thumbs.length - 1 ? n : n + 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, thumbs.length]);

  // The page at the size the runs look at, once it is out of storage; the
  // thumbnail stands in until then.
  const large = useStoredUrl(jobId, open != null ? pages.find((page) => page.page === open + 1)?.image : null);

  const total = Math.max(pageCount, thumbs.length);
  if (!total) return null;

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-5">
        {Array.from({ length: total }, (_, i) =>
          thumbs[i] ? (
            <button
              key={i}
              type="button"
              className="group cursor-zoom-in text-left focus-visible:outline-none"
              aria-label={`Pagina ${i + 1} uitvergroten`}
              onClick={() => setOpen(i)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumbs[i]}
                alt=""
                className="w-full rounded-xl bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06)] transition-shadow group-hover:shadow-[0_0_0_1px_rgba(0,0,0,0.14),0_8px_24px_rgba(0,0,0,0.06)] group-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)]"
              />
              <span className="mt-2 block text-xs text-muted-foreground">Pagina {i + 1}</span>
            </button>
          ) : (
            <div key={i} aria-hidden>
              <div className="aspect-[1/1.414] w-full rounded-xl bg-muted/60" />
              <span className="mt-2 block text-xs text-muted-foreground">Pagina {i + 1}</span>
            </div>
          )
        )}
      </div>

      <Dialog open={open != null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent variant="lightbox" showCloseButton={false}>
          {open != null ? (
            <>
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between p-3 text-white">
                <DialogHeader className="pointer-events-auto min-w-0">
                  <DialogTitle className="text-white">
                    Pagina {open + 1}
                    <span className="ml-3 text-sm font-normal text-white/55">
                      {open + 1} / {thumbs.length}
                    </span>
                  </DialogTitle>
                </DialogHeader>
                <DialogClose asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="pointer-events-auto text-white hover:bg-white/10 hover:text-white"
                  >
                    <XIcon />
                    <span className="sr-only">Sluiten</span>
                  </Button>
                </DialogClose>
              </div>

              <div
                className="flex min-h-0 flex-1 cursor-zoom-out items-center justify-center p-4 pt-14 pb-16"
                onClick={() => setOpen(null)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={large ?? thumbs[open]}
                  alt={`Pagina ${open + 1}`}
                  className="max-h-[calc(100svh-7rem)] w-auto max-w-[min(90vw,72rem)] cursor-default rounded-lg bg-white object-contain"
                  onClick={(event) => event.stopPropagation()}
                />
              </div>

              <div className="absolute inset-x-0 bottom-0 flex justify-center gap-2 p-3">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={open === 0}
                  className="text-white hover:bg-white/10 hover:text-white disabled:text-white/35"
                  onClick={() => setOpen(open - 1)}
                >
                  <ChevronLeft />
                  vorige
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={open === thumbs.length - 1}
                  className="text-white hover:bg-white/10 hover:text-white disabled:text-white/35"
                  onClick={() => setOpen(open + 1)}
                >
                  volgende
                  <ChevronRight />
                </Button>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
