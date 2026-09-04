'use client';

import type { ExtractedImage, ImageVerdict, PageResult } from '@/lib/types';

/**
 * The word index is the only judge here: it knows which words the page holds.
 * Unknown words are inventions; overused words point at duplicated text.
 */
export function Checks({
  pages,
  images,
  verdicts,
}: {
  pages: PageResult[];
  images: ExtractedImage[];
  verdicts: ImageVerdict[];
}) {
  // The ripped bitmaps exist as soon as the PDF is read, before any run.
  if (!pages.length && !images.length) return null;
  const byId = new Map(verdicts.map((v) => [v.id, v]));

  return (
    <section>
      <ul className="checks">
        {pages.map((page) => (
          <li key={page.page}>
            <span className="name">Pagina {page.page}</span>
            <span className="score">{Math.round(page.check.score * 100)}%</span>
            <span className="note">
              {page.blocks.length} alinea&apos;s · {page.patches.length} patches ·{' '}
              {page.continuity.continuesFromPrevious ? 'loopt door van vorige' : 'nieuwe start'} ·{' '}
              {page.continuity.continuesOnNext ? 'loopt door' : 'sluit af'}
            </span>
          </li>
        ))}
      </ul>

      {images.length ? (
        <>
          <hr className="rule" />
          <span className="label">Beeld uit de PDF</span>
          <ul className="checks">
            {images.map((image) => {
              const verdict = byId.get(image.id);
              return (
                <li key={image.id} data-dropped={verdict ? !verdict.keep : false}>
                  <span className="name">{image.id}</span>
                  <span className="score">{image.dpi} dpi</span>
                  <span className="note">
                    {image.width}&times;{image.height}px, {image.areaPct}% van pagina {image.page} &middot;{" "}
                    {verdict ? `${verdict.kind}: ${verdict.reason}` : "niet beoordeeld"}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {pages.some((p) => p.check.unknown.length) ? (
        <>
          <hr className="rule" />
          <span className="label">Woorden buiten de OCR-index</span>
          {pages
            .filter((p) => p.check.unknown.length)
            .map((p) => (
              <p key={p.page} className="note">
                <span className="step">p{p.page}</span> {p.check.unknown.join(' · ')}
              </p>
            ))}
        </>
      ) : null}

      {pages.some((p) => p.check.overused.length) ? (
        <>
          <hr className="rule" />
          <span className="label">Vaker gebruikt dan de pagina bevat</span>
          {pages
            .filter((p) => p.check.overused.length)
            .map((p) => (
              <p key={p.page} className="note">
                <span className="step">p{p.page}</span>{' '}
                {p.check.overused.map((o) => `${o.word} ${o.used}/${o.available}`).join(' · ')}
              </p>
            ))}
        </>
      ) : null}

      {pages.some((p) => p.warnings.length) ? (
        <ul className="warnings">
          {pages.flatMap((p) =>
            p.warnings.map((w, i) => (
              <li key={`${p.page}-${i}`}>
                <span className="step">p{p.page}</span>
                {w}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </section>
  );
}
