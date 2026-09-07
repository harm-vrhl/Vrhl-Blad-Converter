'use client';

import { useEffect, useRef, useState } from 'react';
import type { PageAsset } from '@/lib/types';

/**
 * The strip in the rail is only a reminder of which pages are in. A click
 * opens the page as it was rasterised, the same image the runs look at, so a
 * question about type or placement can be checked against the source.
 */
export function PageThumbs({
  thumbs,
  jobId,
  pages
}: {
  thumbs: string[];
  jobId: string | null;
  pages: PageAsset[];
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

  if (!thumbs.length) return null;

  const src = (index: number) => {
    const asset = pages.find((page) => page.page === index + 1);
    if (jobId && asset?.image) return `/api/jobs/${jobId}/artifact/${asset.image}`;
    return thumbs[index];
  };

  return (
    <>
      <div className="thumbs">
        {thumbs.map((thumb, i) => (
          <button key={i} type="button" className="thumb" aria-label={`Pagina ${i + 1} uitvergroten`} onClick={() => setOpen(i)}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumb} alt="" />
          </button>
        ))}
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
