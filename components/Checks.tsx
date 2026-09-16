'use client';

import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronRight, Info, LocateFixed, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from 'cn';
import { StoredImage, useStoredUrl } from '@/components/StoredImage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { Bevinding, Fragment as Bewijs, Oordeel } from '@/lib/controle';
import { groupPictures, type Picture } from '@/lib/pictures';
import type { ExtractedImage, ImageVerdict, PageResult, Patch } from '@/lib/types';

/**
 * De Controle-tab: één oordeel bovenaan, en daaronder wat er moet gebeuren, op
 * volgorde van ernst.
 *
 * Wat hier staat, rekent `lib/controle.ts` uit; dit tekent het alleen. Elk punt
 * zegt wat er is, waarom het ertoe doet, en laat het bewijs zien: de zin uit het
 * artikel naast de regel uit de PDF. Wie het heeft bekeken, vinkt het af; het
 * oordeel telt mee. De getallen per pagina, het beeldoverzicht en de technische
 * meldingen staan onderaan, ingeklapt: goed om te kunnen vinden, niet om elke keer
 * door te lezen.
 */
export function Checks({
  owner,
  pages,
  images,
  verdicts,
  bevindingen,
  oordeel,
  nagekeken,
  ocrBeschikbaar,
  onToggle,
  onNaarPlek
}: {
  /** De job waar de beelden bij horen, om ze uit de opslag te halen. */
  owner: string | null | undefined;
  pages: PageResult[];
  images: ExtractedImage[];
  verdicts: ImageVerdict[];
  bevindingen: Bevinding[];
  oordeel: Oordeel;
  nagekeken: ReadonlySet<string>;
  ocrBeschikbaar: boolean | null;
  onToggle: (id: string) => void;
  onNaarPlek: (zoek: string) => void;
}) {
  // The ripped bitmaps exist as soon as the PDF is read, before any run.
  if (!pages.length && !images.length) return null;

  const oplossen = bevindingen.filter((b) => b.ernst === 'oplossen');
  const nakijken = bevindingen.filter((b) => b.ernst === 'nakijken');
  const info = bevindingen.filter((b) => b.ernst === 'info');
  const beeldVan = new Map(images.map((image) => [image.id, image]));
  const kaart = (b: Bevinding) => (
    <Kaart
      key={b.id}
      b={b}
      af={nagekeken.has(b.id)}
      owner={owner}
      beeld={b.beeld ? beeldVan.get(b.beeld) : undefined}
      onToggle={onToggle}
      onNaarPlek={onNaarPlek}
    />
  );

  return (
    <div className="grid max-w-3xl gap-6">
      <OordeelBalk oordeel={oordeel} totaal={oplossen.length + nakijken.length} />

      {ocrBeschikbaar === false ? (
        <p className="-mt-3 text-sm text-muted-foreground">
          De OCR van dit artikel is niet bewaard. Ontbrekende tekst, woorden die niet in de PDF staan en de kop zijn
          daarom niet gecontroleerd.
        </p>
      ) : null}

      {oplossen.length ? (
        <Groep icoon={<AlertOctagon className="size-4 text-destructive" />} titel="Moet opgelost">
          {oplossen.map(kaart)}
        </Groep>
      ) : null}

      {nakijken.length ? (
        <Groep icoon={<AlertTriangle className="size-4 text-amber-600" />} titel="Nakijken">
          {nakijken.map(kaart)}
        </Groep>
      ) : null}

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
          <Info className="size-4" />
          Ter informatie
          <span className="font-normal">
            · dekking per pagina, beeld uit de PDF{info.length ? `, ${info.length} melding${info.length === 1 ? '' : 'en'}` : ''}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 grid gap-3">
          {info.length ? <ul className="grid gap-2">{info.map(kaart)}</ul> : null}
          <PerPagina pages={pages} />
          {images.length ? <Pictures owner={owner} images={images} verdicts={verdicts} pages={pages} /> : null}
          <Opmaak pages={pages} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

// ─── Oordeel ─────────────────────────────────────────────────────────────────

function OordeelBalk({ oordeel, totaal }: { oordeel: Oordeel; totaal: number }) {
  const open = oordeel.oplossen + oordeel.nakijken;
  const stand = {
    oplossen: {
      klasse: 'bg-destructive/10 text-destructive',
      icoon: <AlertOctagon className="size-5 shrink-0" />,
      titel: 'Nog niet versturen'
    },
    nakijken: {
      klasse: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200/60',
      icoon: <AlertTriangle className="size-5 shrink-0 text-amber-600" />,
      titel: 'Nakijken'
    },
    klaar: {
      klasse: 'bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200/60',
      icoon: <CheckCircle2 className="size-5 shrink-0 text-emerald-600" />,
      titel: 'Klaar om te versturen'
    }
  }[oordeel.stand];

  const regel =
    oordeel.stand === 'klaar'
      ? totaal
        ? 'Alles is nagekeken.'
        : 'Er is niets gevonden dat nagekeken moet worden.'
      : [
          oordeel.oplossen ? `${oordeel.oplossen} punt${oordeel.oplossen === 1 ? '' : 'en'} moet${oordeel.oplossen === 1 ? '' : 'en'} opgelost` : null,
          oordeel.nakijken ? `${oordeel.nakijken} punt${oordeel.nakijken === 1 ? '' : 'en'} om na te kijken` : null
        ]
          .filter(Boolean)
          .join(', ') + (open < totaal ? ` (${totaal - open} al nagekeken)` : '') + '.';

  return (
    <div className={cn('flex items-center gap-3 rounded-xl px-4 py-3', stand.klasse)} role="status">
      {stand.icoon}
      <div>
        <p className="text-sm font-medium">{stand.titel}</p>
        <p className="text-sm opacity-90">{regel}</p>
      </div>
    </div>
  );
}

function Groep({ icoon, titel, children }: { icoon: ReactNode; titel: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
        {icoon}
        {titel}
      </h3>
      <ul className="grid gap-2">{children}</ul>
    </section>
  );
}

// ─── Een punt ────────────────────────────────────────────────────────────────

function Kaart({
  b,
  af,
  owner,
  beeld,
  onToggle,
  onNaarPlek
}: {
  b: Bevinding;
  af: boolean;
  owner: string | null | undefined;
  beeld: ExtractedImage | undefined;
  onToggle: (id: string) => void;
  onNaarPlek: (zoek: string) => void;
}) {
  const knop = af ? 'Ongedaan maken' : b.ernst === 'oplossen' ? 'Toch accepteren' : b.soort === 'beeld-niet-geplaatst' ? 'Hoort er niet in' : 'Klopt zo';
  return (
    <li
      className={cn(
        'rounded-xl bg-white px-4 py-3 ring-1 ring-black/[0.06]',
        b.ernst === 'oplossen' && !af && 'ring-destructive/30',
        af && 'bg-transparent'
      )}
    >
      <div className="flex items-start gap-3">
        {beeld && !af ? (
          <StoredImage
            owner={owner}
            name={beeld.thumb}
            alt={beeld.nearby ?? beeld.id}
            className="h-14 w-20 shrink-0 rounded-md bg-white object-contain ring-1 ring-black/[0.06]"
          />
        ) : null}
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm font-medium', af && 'text-muted-foreground line-through decoration-black/25')}>
            {af ? <CheckCircle2 className="mr-1.5 inline size-3.5 -translate-y-px text-emerald-600" /> : null}
            {b.titel}
          </p>
          {af ? null : (
            <>
              <p className="mt-0.5 text-sm text-muted-foreground">{b.uitleg}</p>
              {b.bewijs.length ? (
                <div className="mt-2 grid gap-1.5">
                  {b.bewijs.map((fragment, i) => (
                    <BewijsRegel key={i} fragment={fragment} />
                  ))}
                </div>
              ) : null}
              {b.lijst?.length ? <Lijst regels={b.lijst} /> : null}
            </>
          )}
          {b.ernst !== 'info' || b.zoek ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {b.ernst !== 'info' ? (
                <Button type="button" size="sm" variant={af ? 'ghost' : 'outline'} className="h-7 text-xs" onClick={() => onToggle(b.id)}>
                  {af ? <RotateCcw className="size-3.5" /> : null}
                  {knop}
                </Button>
              ) : null}
              {b.zoek && !af ? (
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onNaarPlek(b.zoek!)}>
                  <LocateFixed className="size-3.5" />
                  Naar de plek
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function BewijsRegel({ fragment }: { fragment: Bewijs }) {
  return (
    <div className="rounded-lg bg-black/[0.035] px-3 py-2 text-sm leading-relaxed">
      <p className="text-xs text-muted-foreground">{fragment.label}</p>
      <p className="break-words">{gemarkeerd(fragment.tekst, fragment.markeer)}</p>
    </div>
  );
}

/** De woorden uit `markeer` in de tekst gemarkeerd, als hele woorden en ongeacht hoofdletters. */
function gemarkeerd(tekst: string, markeer: string[] | undefined): ReactNode {
  if (!markeer?.length) return tekst;
  const woorden = [...new Set(markeer)].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const patroon = new RegExp(`(?<![\\p{L}\\p{N}])(${woorden.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const delen = tekst.split(patroon);
  return delen.map((deel, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-amber-200/70 px-0.5 text-amber-950">
        {deel}
      </mark>
    ) : (
      deel
    )
  );
}

function Lijst({ regels }: { regels: string[] }) {
  if (regels.length <= 4) {
    return (
      <ul className="mt-2 grid gap-1 text-sm text-muted-foreground">
        {regels.map((r, i) => (
          <li key={i} className="break-words">
            {r}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <Collapsible className="mt-2">
      <CollapsibleTrigger className="group flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        {regels.length} regels tonen
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-1.5 grid gap-1 text-sm text-muted-foreground">
          {regels.map((r, i) => (
            <li key={i} className="break-words">
              {r}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Ter informatie ──────────────────────────────────────────────────────────

function PerPagina({ pages }: { pages: PageResult[] }) {
  if (!pages.length) return null;
  return (
    <section className="rounded-xl bg-black/[0.04] px-4 py-3">
      <h3 className="text-sm font-medium">Per pagina</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Het percentage is hoeveel van de geschreven woorden in de OCR van die pagina staan.
      </p>
      <ul className="mt-2 divide-y divide-black/[0.06]">
        {pages.map((page) => (
          <li key={page.page} className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5 text-sm">
            <span className="w-24 shrink-0 text-muted-foreground">Pagina {page.page}</span>
            <span className="w-12 shrink-0 tabular-nums">{Math.round(page.check.score * 100)}%</span>
            <span className="min-w-0 flex-1 text-muted-foreground">
              {page.blocks.length} blok{page.blocks.length === 1 ? '' : 'ken'} · {tally(page.patches)} ·{' '}
              {page.continuity.continuesFromPrevious ? 'loopt door van vorige' : 'nieuwe start'} ·{' '}
              {page.continuity.continuesOnNext ? 'loopt door' : 'sluit af'}
            </span>
            <Badge variant="secondary" className="border-0">
              {WAARVANDAAN[page.typography ?? 'onbekend']}
            </Badge>
          </li>
        ))}
      </ul>
      <p className="mt-1 pb-1 text-sm text-muted-foreground">{herkomst(pages)}</p>
    </section>
  );
}

function Opmaak({ pages }: { pages: PageResult[] }) {
  if (!pages.some((p) => p.patches.length)) return null;
  return (
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
