'use client';

import { useEffect, useRef, useState } from 'react';
import type { PageAsset } from '@/lib/types';

/**
 * After upload the pages themselves are the view: a grid of the rasterised
 * spreads, filling in as pdf.js finishes each one. A click opens the page at
 * the size the runs look at, so a question about type or placement can be
 * checked against the source.
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
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open == null) {
      if (el.open) el.close();
      return;
    }
    if (!el.open) el.showModal();
  }, [open]);

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

  const total = Math.max(pageCount, thumbs.length);
  if (!total) return null;

  const src = (index: number) => {
    const asset = pages.find((page) => page.page === index + 1);
    if (jobId && asset?.image) return `/api/jobs/${jobId}/artifact/${asset.image}`;
    return thumbs[index];
  };

  return (
    <>
      <div className="pages">
        {Array.from({ length: total }, (_, i) =>
          thumbs[i] ? (
            <button
              key={i}
              type="button"
              className="page"
              aria-label={`Pagina ${i + 1} uitvergroten`}
              onClick={() => setOpen(i)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbs[i]} alt="" />
              <span className="n">Pagina {i + 1}</span>
            </button>
          ) : (
            <div key={i} className="waiting" aria-hidden>
              <span className="n">Pagina {i + 1}</span>
            </div>
          )
        )}
      </div>

      <dialog
        ref={dialog}
        className="page-peek"
        onClose={() => setOpen(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(null);
        }}
      >
        {open != null ? (
          <>
            <header>
              <span className="label">Pagina {open + 1}</span>
              <span className="meta">
                {open + 1} / {thumbs.length}
              </span>
              <button type="button" onClick={() => setOpen(null)}>
                sluiten
              </button>
            </header>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src(open)} alt={`Pagina ${open + 1}`} />
            <nav>
              <button type="button" disabled={open === 0} onClick={() => setOpen(open - 1)}>
                vorige
              </button>
              <button type="button" disabled={open === thumbs.length - 1} onClick={() => setOpen(open + 1)}>
                volgende
              </button>
            </nav>
          </>
        ) : null}
      </dialog>
    </>
  );
}
