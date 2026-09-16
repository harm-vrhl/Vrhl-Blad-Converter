'use client';

import { StoredImage, useStoredUrl } from '@/components/StoredImage';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { groupPictures, type Picture } from '@/lib/pictures';
import type { ExtractedImage, ImageVerdict, PageResult, Patch } from '@/lib/types';

/**
 * The word index is the only judge here: it knows which words the page holds.
 * Unknown words are inventions; overused words point at duplicated text.
 */
export function Checks({
  owner,
  pages,
  images,
  verdicts
}: {
  /** De job waar de beelden bij horen, om ze uit de opslag te halen. */
  owner: string | null | undefined;
  pages: PageResult[];
  images: ExtractedImage[];
  verdicts: ImageVerdict[];
}) {
  // The ripped bitmaps exist as soon as the PDF is read, before any run.
  if (!pages.length && !images.length) return null;

  return (
    <div className="grid max-w-3xl gap-3">
      {pages.length ? (
        <section className="rounded-xl bg-black/[0.04] px-4 py-3">
          <h3 className="text-sm font-medium">Per pagina</h3>
          <ul className="mt-2 divide-y divide-black/[0.06]">
            {pages.map((page) => (
              <li key={page.page} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-sm">
                <span className="w-24 shrink-0 text-muted-foreground">Pagina {page.page}</span>
                <span className="w-12 shrink-0 tabular-nums">{Math.round(page.check.score * 100)}%</span>
                <span className="min-w-0 flex-1 text-muted-foreground">
                  {page.blocks.length} alinea&apos;s · {tally(page.patches)} ·{' '}
                  {page.continuity.continuesFromPrevious ? 'loopt door van vorige' : 'nieuwe start'} ·{' '}
                  {page.continuity.continuesOnNext ? 'loopt door' : 'sluit af'}
                </span>
                <Badge
                  variant={page.typography === 'read' ? 'secondary' : 'destructive'}
                  className="border-0"
                >
                  {WAARVANDAAN[page.typography ?? 'onbekend']}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="mt-1 pb-1 text-sm text-muted-foreground">{herkomst(pages)}</p>
        </section>
      ) : null}

      {images.length ? <Pictures owner={owner} images={images} verdicts={verdicts} pages={pages} /> : null}

      {pages.some((p) => p.patches.length) ? (
        <section className="rounded-xl bg-black/[0.04] px-4 py-3">
          <h3 className="text-sm font-medium">Opmaak per fragment</h3>
          <p className="mt-1 text-sm text-muted-foreground">{overall(pages)}</p>
          <ul className="mt-2 divide-y divide-black/[0.06]">
            {pages.flatMap((page) =>
              page.patches.map((patch, i) => {
                const dropped = page.dropped.includes(i);
                return (
                  <li
                    key={`${page.page}-${i}`}
                    className={`flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-sm ${dropped ? 'opacity-50' : ''}`}
                  >
                    <span className="w-24 shrink-0 text-muted-foreground">
                      p{page.page} {patch.target}
                    </span>
                    <span className="w-24 shrink-0">{patch.style.join('+')}</span>
                    <span className={`min-w-0 flex-1 ${dropped ? 'text-muted-foreground line-through' : 'text-muted-foreground'}`}>
                      &ldquo;{clip(patch.find)}&rdquo;
                      {dropped ? ' · niet toegepast' : ''}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        </section>
      ) : null}

      {pages.some((p) => p.check.unknown.length) ? (
        <section className="rounded-xl bg-black/[0.04] px-4 py-3">
          <h3 className="text-sm font-medium">Woorden buiten de OCR-index</h3>
          <ul className="mt-2 grid gap-2">
            {pages
              .filter((p) => p.check.unknown.length)
              .map((p) => (
                <li key={p.page} className="text-sm text-muted-foreground">
                  <span className="mr-2 font-medium text-foreground">p{p.page}</span>
                  {p.check.unknown.join(' · ')}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {pages.some((p) => p.check.overused.length) ? (
        <section className="rounded-xl bg-black/[0.04] px-4 py-3">
          <h3 className="text-sm font-medium">Vaker gebruikt dan de pagina bevat</h3>
          <ul className="mt-2 grid gap-2">
            {pages
              .filter((p) => p.check.overused.length)
              .map((p) => (
                <li key={p.page} className="text-sm text-muted-foreground">
                  <span className="mr-2 font-medium text-foreground">p{p.page}</span>
                  {p.check.overused.map((o) => `${o.word} ${o.used}/${o.available}`).join(' · ')}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {pages.some((p) => p.warnings.length) ? (
        <section className="rounded-xl bg-black/[0.04] px-4 py-3">
          <h3 className="text-sm font-medium">Waarschuwingen</h3>
          <ul className="mt-2 grid gap-2">
            {pages.flatMap((p) =>
              p.warnings.map((w, i) => (
                <li key={`${p.page}-${i}`} className="text-sm text-muted-foreground">
                  <span className="mr-2 font-medium text-foreground">p{p.page}</span>
                  {w}
                </li>
              ))
            )}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Hoe de opmaak van een pagina tot stand kwam.
 *
 * Uit de PDF is het beste geval: het fontregister zegt wat vet en cursief is, en
 * dat antwoord is elke keer hetzelfde. Ontbreekt dat, een scan, een advertentie
 * die als beeld is geexporteerd, of fonts die "F1" heten in plaats van
 * "Antonia-Bold", dan kijkt er alsnog een model naar de page image. Dat werkt,
 * maar het is een oordeel en geen aflezing, dus het mag niet onzichtbaar blijven.
 */
const WAARVANDAAN: Record<string, string> = {
  read: 'opmaak uit de PDF',
  'no-text-layer': 'geen tekstlaag, van het beeld gelezen',
  'unnamed-fonts': 'fonts zonder bruikbare naam, van het beeld gelezen',
  onbekend: 'herkomst onbekend'
};

function herkomst(pages: PageResult[]): string {
  const uitPdf = pages.filter((p) => p.typography === 'read').length;
  const gelezen = pages.length - uitPdf;
  if (!gelezen) return `alle ${pages.length} pagina's uit het fontregister van de PDF`;
  if (!uitPdf) return `geen enkele pagina had een bruikbare tekstlaag; alles is van de page images gelezen`;
  const welke = pages.filter((p) => p.typography !== 'read').map((p) => `p${p.page}`);
  return `${uitPdf} van de ${pages.length} pagina's uit de PDF · ${welke.join(', ')} van het beeld gelezen`;
}

/**
 * Every mark the styling run reported, fragment by fragment. A count alone cannot be read
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

/**
 * Het beeld uit de PDF, om naar te kijken in plaats van over te lezen.
 *
 * De groepen komen uit `lib/pictures.ts`; hier staat alleen hoe ze eruitzien.
 * Stukken van een opgeknipt beeld staan apart en dichtgeklapt: dat zijn er soms
 * honderd, en ze zeggen alleen iets als je ze zoekt.
 */
function Pictures({
  owner,
  images,
  verdicts,
  pages
}: {
  owner: string | null | undefined;
  images: ExtractedImage[];
  verdicts: ImageVerdict[];
  pages: PageResult[];
}) {
  const { inArticle, kept, dropped, shards } = groupPictures(images, verdicts, pages);

  return (
    <section className="rounded-xl bg-black/[0.04] px-4 py-3">
      <h3 className="text-sm font-medium">Beeld uit de PDF</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {images.length} uit de PDF gerip{images.length === 1 ? 't' : 't'} &middot; {inArticle.length} in het artikel
        {kept.length ? ` \u00b7 ${kept.length} goedgekeurd maar nergens geplaatst` : ''}
        {dropped.length ? ` \u00b7 ${dropped.length} niet doorgekomen` : ''}
        {shards.length ? ` \u00b7 ${shards.length} stuk(ken) van opgeknipte beelden` : ''}
      </p>

      <Group title="In het artikel" pictures={inArticle} owner={owner} />
      <Group
        title="Goedgekeurd, maar nergens geplaatst"
        hint="De beeldbeoordeling liet deze door; de leesvolgorde-run heeft ze niet in de tekst gezet."
        pictures={kept}
        owner={owner}
        dimmed
      />
      <Group
        title="Niet doorgekomen"
        hint="Weggezet als logo, lijntje, ornament, advertentie of beeld van een ander stuk."
        pictures={dropped}
        owner={owner}
        dimmed
      />

      {shards.length ? (
        <Collapsible className="mt-4">
          <CollapsibleTrigger className="mt-4 text-sm font-medium underline-offset-4 hover:underline">
            Stukken van opgeknipte beelden ({shards.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-1 text-sm text-muted-foreground">
              Eén foto kan als honderd bitmaps in de PDF staan. Losse stukken worden nooit geplaatst; het hele beeld
              wordt van de pagina gerenderd, of het gaat er allemaal uit.
            </p>
            <Tiles pictures={shards} owner={owner} dimmed />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  );
}

function Group({
  title,
  hint,
  pictures,
  owner,
  dimmed
}: {
  title: string;
  hint?: string;
  pictures: Picture[];
  owner: string | null | undefined;
  dimmed?: boolean;
}) {
  if (!pictures.length) return null;
  return (
    <div className="mt-4">
      <h4 className="text-sm font-medium">
        {title} <span className="text-muted-foreground tabular-nums">({pictures.length})</span>
      </h4>
      {hint ? <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p> : null}
      <Tiles pictures={pictures} owner={owner} dimmed={dimmed} />
    </div>
  );
}

function Tiles({
  pictures,
  owner,
  dimmed
}: {
  pictures: Picture[];
  owner: string | null | undefined;
  dimmed?: boolean;
}) {
  return (
    <ul className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {pictures.map((picture) => (
        <Tile key={picture.image.id} picture={picture} owner={owner} dimmed={dimmed} />
      ))}
    </ul>
  );
}

/** Eén beeld: de thumbnail, waar het stond, en waarom het er wel of niet in zit. */
function Tile({
  picture,
  owner,
  dimmed
}: {
  picture: Picture;
  owner: string | null | undefined;
  dimmed?: boolean;
}) {
  const { image, note } = picture;
  // Het hele bestand, niet de thumbnail: wie twijfelt of een foto de goede is,
  // moet hem op ware grootte kunnen zien.
  const full = useStoredUrl(owner, image.file);
  const frame = (
    <StoredImage
      owner={owner}
      name={image.thumb}
      alt={image.nearby ?? image.id}
      className={`h-28 w-full rounded-lg bg-white object-contain ring-1 ring-black/[0.06] ${dimmed ? 'opacity-50 grayscale' : ''}`}
    />
  );

  return (
    <li className="min-w-0">
      {full ? (
        <a href={full} target="_blank" rel="noreferrer" title="Op ware grootte openen">
          {frame}
        </a>
      ) : (
        frame
      )}
      <div className="mt-1.5 grid gap-0.5 text-xs">
        <span className="font-medium">
          {image.id}
          {image.parts ? <span className="ml-1 font-normal text-muted-foreground">({image.parts} stukken)</span> : null}
        </span>
        <span className="text-muted-foreground tabular-nums">
          p{image.page} &middot; {image.width}&times;{image.height}px &middot; {image.dpi} dpi &middot; {image.areaPct}%
        </span>
        <span className="text-muted-foreground">{note}</span>
        {image.nearby ? <span className="text-muted-foreground italic">&ldquo;{clip(image.nearby)}&rdquo;</span> : null}
      </div>
    </li>
  );
}
