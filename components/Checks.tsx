'use client';

import type { ExtractedImage, ImageVerdict, PageResult, Patch } from '@/lib/types';

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
              {page.blocks.length} alinea&apos;s · {tally(page.patches)} ·{' '}
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

      {pages.some((p) => p.patches.length) ? (
        <>
          <hr className="rule" />
          <span className="label">Opmaak per fragment</span>
          <p className="note">{overall(pages)}</p>
          <ul className="checks marks">
            {pages.flatMap((page) =>
              page.patches.map((patch, i) => (
                <li key={`${page.page}-${i}`} data-dropped={page.dropped.includes(i)}>
                  <span className="name">p{page.page} {patch.target}</span>
                  <span className="score">{patch.style.join('+')}</span>
                  <span className="note">
                    &ldquo;{clip(patch.find)}&rdquo;
                    {page.dropped.includes(i) ? ' · niet toegepast' : ''}
                  </span>
                </li>
              ))
            )}
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

/**
 * Every mark run 2 reported, fragment by fragment. A count alone cannot be read
 * against the page; this can, which is the point of a check.
 */
function tally(patches: Patch[]): string {
  return patches.length ? `${patches.length} opmaak` : 'geen opmaak';
}

function overall(pages: PageResult[]): string {
  const all = pages.flatMap((page) => page.patches);
  const dropped = pages.reduce((n, page) => n + page.dropped.length, 0);
  return `${tally(all)}${dropped ? ` · ${dropped} niet toegepast` : ''}`;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
