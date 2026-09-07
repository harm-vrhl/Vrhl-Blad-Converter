'use client';

import { useEffect, useState } from 'react';
import type { OcrPage } from '@/lib/types';

/**
 * What Mistral actually returned, before anything downstream touched it.
 *
 * The OCR no longer decides anything about typography - the PDF's own font table
 * does that - but it is still the text run 1 is given and the word index every
 * run is checked against. So when a word comes out wrong, or a run drifts, this
 * is where you look to see what it was working from.
 *
 * It is fetched rather than streamed: the OCR artifact is written the moment the
 * OCR call returns, long before the page runs finish, and it is far too large to
 * push down the event stream for the sake of a tab that may never be opened.
 */
export function Ocr({ jobId }: { jobId: string | null }) {
  const [pages, setPages] = useState<OcrPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let live = true;
    setPages(null);
    setError(null);

    fetch(`/api/jobs/${jobId}/artifact/ocr.json`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: OcrPage[]) => live && setPages(data))
      .catch(() => live && setError('nog niet gelezen'));

    return () => {
      live = false;
    };
  }, [jobId]);

  if (!jobId) return <p className="empty">Nog geen document geladen.</p>;
  if (error) {
    return <p className="empty">De OCR heeft deze pagina&apos;s nog niet gelezen. Start de run, of open dit tabblad opnieuw.</p>;
  }
  if (!pages) return <p className="empty">Bezig met ophalen…</p>;

  return (
    <div className="stream">
      {pages.map((page) => {
        return (
          <section className="pane" key={page.page}>
            <header>
              <span className="label">Pagina {page.page}</span>
              <span className="pulse">{describe(page)}</span>
            </header>
            <pre className="json ocr">{page.markdown}</pre>
          </section>
        );
      })}
    </div>
  );
}

function describe(page: OcrPage): string {
  const size = page.dimensions ? `${page.dimensions.width}×${page.dimensions.height} bij ${page.dimensions.dpi} dpi` : '';
  return [`${(page.blocks ?? []).length} blokken`, `${page.markdown.length} tekens`, size].filter(Boolean).join(' · ');
}
