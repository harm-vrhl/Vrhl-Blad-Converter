'use client';

import { AlertOctagon, AlertTriangle, CheckCircle2, ChevronRight, CircleHelp, Eye, Info, RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from 'cn';
import {
  plekVanOpmaak,
  beeldLabel,
  beeldMaat,
  beeldToelichting,
  opmaakTelling,
  patchPlek,
  stijlLabel
} from '@/components/article/checkLabels';
import { StoredImage, useStoredUrl } from '@/components/StoredImage';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { woordTelling, type Bevinding, type Fragment as Bewijs, type Oordeel, type Overeenkomst } from '@/lib/controle';
import { groupPictures, type Picture } from '@/lib/pictures';
import type { ArticleDocument, ContentNode, ExtractedImage, ImageVerdict, OcrPage, PageResult } from '@/lib/types';

type NaarPlek = (zoek: string, markeer?: string, nth?: number) => void;

/**
 * De Controle-tab: hoe goed de omzetting lijkt te zijn gegaan, wat aandacht
 * verdient, en waar dat in het artikel staat.
 *
 * Wat hier staat, rekent `lib/controle.ts` uit; dit tekent het alleen. Elk punt
 * zegt wat er is, waarom het ertoe doet, en laat het bewijs zien. Woorden en
 * fragmenten zijn aanklikbaar: ze brengen je naar de plek in de Artikel-tab.
 * Wie een punt heeft bekeken, vinkt het af. De automatische inschatting is geen
 * vonnis; de redacteur besluit.
 */
export function Checks({
  owner,
  pages,
  images,
  verdicts,
  bevindingen,
  oordeel,
  overeenkomst,
  nagekeken,
  ocrBeschikbaar,
  onToggle,
  onNaarPlek,
  current,
  ocr = []
}: {
  /** De job waar de beelden bij horen, om ze uit de opslag te halen. */
  owner: string | null | undefined;
  pages: PageResult[];
  images: ExtractedImage[];
  verdicts: ImageVerdict[];
  bevindingen: Bevinding[];
  oordeel: Oordeel;
  overeenkomst: Overeenkomst | null;
  nagekeken: ReadonlySet<string>;
  ocrBeschikbaar: boolean | null;
  onToggle: (id: string) => void;
  onNaarPlek: NaarPlek;
  /** Het artikel zoals het nu op het scherm staat, om opmaak op dezelfde plek te vinden. */
  current?: ArticleDocument | null;
  ocr?: OcrPage[];
}) {
  // The ripped bitmaps exist as soon as the PDF is read, before any run.
  if (!pages.length && !images.length && !bevindingen.length) return null;

  const oplossen = bevindingen.filter((b) => b.ernst === 'oplossen');
  const nakijken = bevindingen.filter((b) => b.ernst === 'nakijken');
  const opvallend = bevindingen.filter((b) => b.ernst === 'info' && b.soort !== 'technisch');
  const technisch = bevindingen.filter((b) => b.soort === 'technisch');
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
      <Samenvatting
        oordeel={oordeel}
        overeenkomst={overeenkomst}
        totaal={oplossen.length + nakijken.length}
        onNaarPlek={onNaarPlek}
      />

      {ocrBeschikbaar === false ? (
        <p className="-mt-3 text-sm text-muted-foreground">
          {pages.length
            ? "De gelezen tekst van de PDF is voor dit artikel niet bewaard. Ontbrekende tekst, woorden die niet in de PDF staan en de kop zijn daarom niet gecontroleerd."
            : "Dit artikel is uit een pakket geopend, zonder de originele PDF. De controle tegen de pagina's valt hier weg; wat je ziet is het artikel zelf."}
        </p>
      ) : null}

      {oplossen.length ? (
        <Groep icoon={<AlertOctagon className="size-4 text-destructive" />} titel="Eerst oplossen">
          {oplossen.map(kaart)}
        </Groep>
      ) : null}

      {nakijken.length ? (
        <Groep icoon={<AlertTriangle className="size-4 text-amber-600" />} titel="Na te kijken">
          {nakijken.map(kaart)}
        </Groep>
      ) : null}

      {opvallend.length ? (
        <Groep icoon={<Info className="size-4 text-sky-700" />} titel="Opvallendheden">
          {opvallend.map(kaart)}
        </Groep>
      ) : null}

      <PerPagina pages={pages} ocr={ocr} onNaarPlek={onNaarPlek} />
      {images.length ? (
        <Pictures
          owner={owner}
          images={images}
          verdicts={verdicts}
          pages={pages}
          current={current}
          onNaarPlek={onNaarPlek}
        />
      ) : null}

      {technisch.length || pages.some((p) => p.patches.length) ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" />
            Meer details
            <span className="font-normal">
              {technisch.length ? ` · ${technisch.length} technische melding${technisch.length === 1 ? '' : 'en'}` : ''}
              {pages.some((p) => p.patches.length) ? ' · opmaak per fragment' : ''}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 grid gap-3">
            {technisch.length ? <ul className="grid gap-2">{technisch.map(kaart)}</ul> : null}
            <Opmaak pages={pages} content={current?.content ?? []} onNaarPlek={onNaarPlek} />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

// ─── Samenvatting ────────────────────────────────────────────────────────────

function Samenvatting({
  oordeel,
  overeenkomst,
  totaal,
  onNaarPlek
}: {
  oordeel: Oordeel;
  overeenkomst: Overeenkomst | null;
  totaal: number;
  onNaarPlek: NaarPlek;
}) {
  const open = oordeel.oplossen + oordeel.nakijken;
  const stand = {
    oplossen: {
      klasse: 'bg-destructive/10 text-destructive',
      icoon: <AlertOctagon className="size-5 shrink-0" />
    },
    nakijken: {
      klasse: 'bg-amber-50 text-amber-900 ring-1 ring-amber-200/60',
      icoon: <AlertTriangle className="size-5 shrink-0 text-amber-600" />
    },
    klaar: {
      klasse: 'bg-black/[0.04] text-foreground ring-1 ring-black/[0.06]',
      icoon: <CheckCircle2 className="size-5 shrink-0 text-muted-foreground" />
    }
  }[oordeel.stand];

  const aandacht =
    oordeel.stand === 'klaar'
      ? totaal
        ? 'De openstaande punten zijn nagekeken. Controleer zelf of het artikel klopt.'
        : 'De automatische controle vond geen duidelijke problemen. Controleer zelf of het artikel klopt.'
      : [
          oordeel.oplossen
            ? `${oordeel.oplossen} punt${oordeel.oplossen === 1 ? '' : 'en'} moet${oordeel.oplossen === 1 ? '' : 'en'} eerst opgelost`
            : null,
          oordeel.nakijken
            ? `${oordeel.nakijken} punt${oordeel.nakijken === 1 ? '' : 'en'} om na te kijken`
            : null
        ]
          .filter(Boolean)
          .join(', ') + (open < totaal ? ` (${totaal - open} al nagekeken)` : '') + '.';

  return (
    <div className={cn('flex items-center gap-4 rounded-xl px-4 py-4', stand.klasse)} role="status">
      {overeenkomst !== null ? <Meter telling={overeenkomst} /> : stand.icoon}

      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          Woorden uit het artikel in de PDF
          <Hulp tekst="Elk woord uit het artikel dat de PDF ook bevat. Hoe vaak het herhaald wordt (citaat, bijschrift) maakt niet uit: de woordindex zegt of het op de pagina voorkomt. Alleen een woord dat nergens in de PDF staat, ontbreekt in de telling." />
        </p>
        {overeenkomst !== null ? (
          <>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {overeenkomst.totaal
                ? `${overeenkomst.klopt} van ${overeenkomst.totaal} woorden uit het artikel staan in de PDF.`
                : "Op deze pagina's staat geen lopende tekst om te tellen."}
              {overeenkomst.ontbreekt.length ? ' Deze staan er niet in:' : null}
            </p>
            {overeenkomst.ontbreekt.length ? (
              <AfwijkendeWoorden woorden={overeenkomst.ontbreekt} onNaarPlek={onNaarPlek} />
            ) : null}
          </>
        ) : null}
        <p className="mt-1.5 text-sm font-medium">{aandacht}</p>
      </div>
    </div>
  );
}

/** Hoefijzer tot de telling: 270 graden, opening onder. In het midden klopt/totaal, geen percentage. */
function Meter({ telling }: { telling: Overeenkomst }) {
  const pct = telling.totaal ? Math.max(0, Math.min(100, (100 * telling.klopt) / telling.totaal)) : 0;
  const span = 75;
  const kleur = telling.procent >= 90 ? 'text-emerald-600' : telling.procent >= 70 ? 'text-amber-600' : 'text-destructive';
  const groot = telling.totaal >= 1000;
  return (
    <div
      className={cn('relative size-[5.5rem] shrink-0', kleur)}
      aria-label={
        telling.totaal
          ? `${telling.klopt} van ${telling.totaal} woorden uit het artikel staan in de PDF`
          : 'Geen lopende tekst om te tellen'
      }
    >
      <svg viewBox="0 0 88 88" className="size-full rotate-[135deg]" aria-hidden="true">
        <circle
          cx="44"
          cy="44"
          r="37"
          fill="none"
          stroke="currentColor"
          strokeWidth="5.5"
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray={`${span} ${100 - span}`}
          className="opacity-20"
        />
        {pct > 0 ? (
          <circle
            cx="44"
            cy="44"
            r="37"
            fill="none"
            stroke="currentColor"
            strokeWidth="5.5"
            strokeLinecap="round"
            pathLength="100"
            strokeDasharray={`${(pct / 100) * span} 100`}
          />
        ) : null}
      </svg>
      <p className="absolute inset-0 grid place-items-center px-2 text-center">
        {telling.totaal ? (
          <span className={cn('font-semibold tabular-nums leading-none tracking-tight', groot ? 'text-sm' : 'text-lg')}>
            {telling.klopt}
            <span className="text-[0.65rem] font-medium opacity-80">/{telling.totaal}</span>
          </span>
        ) : (
          <span className="text-xs font-medium opacity-80">geen tekst</span>
        )}
      </p>
    </div>
  );
}

/** Een vraagteken naast een kop; de uitleg verschijnt bij hover. */
function Hulp({ tekst }: { tekst: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-transparent p-0 text-current/55 hover:text-current cursor-help"
        aria-label="Uitleg"
      >
        <CircleHelp className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left text-pretty">
        {tekst}
      </TooltipContent>
    </Tooltip>
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
  onNaarPlek: NaarPlek;
}) {
  const knop = af
    ? 'Ongedaan maken'
    : b.ernst === 'oplossen'
      ? 'Toch accepteren'
      : b.soort === 'beeld-niet-geplaatst'
        ? 'Hoort er niet in'
        : 'Klopt zo';
  const naarPlek = b.zoek || b.bewijs.find((fragment) => inArtikel(fragment))?.tekst;
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
            alt={beeld.nearby ?? beeldLabel(beeld)}
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
                    <BewijsRegel key={i} fragment={fragment} onNaarPlek={onNaarPlek} />
                  ))}
                </div>
              ) : null}
              {b.lijst?.length ? (
                <Lijst regels={b.lijst} onNaarPlek={b.soort === 'technisch' ? undefined : onNaarPlek} />
              ) : null}
            </>
          )}
          {b.ernst !== 'info' || naarPlek ? (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {b.ernst !== 'info' ? (
                <Button type="button" size="sm" variant={af ? 'ghost' : 'outline'} className="h-7 text-xs" onClick={() => onToggle(b.id)}>
                  {af ? <RotateCcw className="size-3.5" /> : null}
                  {knop}
                </Button>
              ) : null}
              {naarPlek && !af ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => onNaarPlek(b.zoek ?? naarPlek, b.bewijs.find((f) => f.markeer?.length)?.markeer?.[0])}
                >
                  <Eye className="size-3.5" />
                  Toon in artikel
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function inArtikel(fragment: Bewijs): boolean {
  return !/^(PDF|Waarom dit beeld|Niet in het artikel)/i.test(fragment.label);
}

function BewijsRegel({
  fragment,
  onNaarPlek
}: {
  fragment: Bewijs;
  onNaarPlek: NaarPlek;
}) {
  const klikbaar = inArtikel(fragment);
  return (
    <div className="rounded-lg bg-black/[0.035] px-3 py-2 text-sm leading-relaxed">
      <p className="text-xs text-muted-foreground">{fragment.label}</p>
      <p className="break-words">
        {gemarkeerd(fragment.tekst, fragment.markeer, klikbaar ? (woord) => onNaarPlek(fragment.tekst, woord) : undefined)}
      </p>
    </div>
  );
}

/** De woorden uit `markeer` in de tekst gemarkeerd, als hele woorden en ongeacht hoofdletters. */
function gemarkeerd(tekst: string, markeer: string[] | undefined, onKlik?: (woord: string) => void): ReactNode {
  if (!markeer?.length) {
    if (!onKlik) return tekst;
    return (
      <button
        type="button"
        className="rounded text-left underline-offset-2 hover:bg-amber-100/80 hover:underline cursor-pointer"
        onClick={() => onKlik(tekst)}
        title="Toon in het artikel"
      >
        {tekst}
      </button>
    );
  }
  const woorden = [...new Set(markeer)].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const patroon = new RegExp(`(?<![\\p{L}\\p{N}])(${woorden.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  const delen = tekst.split(patroon);
  return delen.map((deel, i) => {
    if (i % 2 === 1) {
      if (!onKlik) {
        return (
          <mark key={i} className="rounded bg-amber-200/70 px-0.5 text-amber-950">
            {deel}
          </mark>
        );
      }
      return (
        <button
          key={i}
          type="button"
          className="rounded bg-amber-200/70 px-0.5 text-amber-950 underline-offset-2 hover:bg-amber-300/80 hover:underline cursor-pointer"
          onClick={() => onKlik(deel)}
          title="Toon in het artikel"
        >
          {deel}
        </button>
      );
    }
    return deel;
  });
}

function AfwijkendeWoorden({
  woorden,
  onNaarPlek
}: {
  woorden: string[];
  onNaarPlek: NaarPlek;
}) {
  const tonen = woorden.slice(0, 12);
  const rest = woorden.length - tonen.length;
  return (
    <div>
      <Lijst regels={tonen} onNaarPlek={onNaarPlek} />
      {rest > 0 ? <p className="mt-1 text-sm text-muted-foreground">en nog {rest}</p> : null}
    </div>
  );
}

function Lijst({
  regels,
  onNaarPlek
}: {
  regels: string[];
  onNaarPlek?: (zoek: string, markeer?: string) => void;
}) {
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {regels.map((r, i) => (
        <li key={i} className="min-w-0 max-w-full">
          {onNaarPlek ? (
            <button
              type="button"
              className="max-w-full truncate rounded-md bg-black/[0.05] px-2 py-1 text-left text-sm text-foreground hover:bg-amber-100/80 cursor-pointer"
              onClick={() => onNaarPlek(r, r)}
              title="Toon in het artikel"
            >
              {r}
            </button>
          ) : (
            <span className="max-w-full break-words rounded-md bg-black/[0.05] px-2 py-1 text-sm text-muted-foreground">
              {r}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

// ─── Per pagina ──────────────────────────────────────────────────────────────

function PerPagina({
  pages,
  ocr,
  onNaarPlek
}: {
  pages: PageResult[];
  ocr: OcrPage[];
  onNaarPlek: NaarPlek;
}) {
  if (!pages.length) return null;
  const ocrVan = new Map(ocr.map((o) => [o.page, o]));
  return (
    <section className="rounded-xl bg-black/[0.04] px-4 py-3">
      <h3 className="text-sm font-medium">Woorden per pagina in de PDF</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Van de woorden die de omzetting voor die pagina schreef, hoeveel daarvan
        komen in de PDF voor. Herhaling telt mee: de woordindex zegt of het woord
        mag, niet hoe vaak.
      </p>
      <ul className="mt-2 divide-y divide-black/[0.06]">
        {pages.map((page) => {
          const telling = woordTelling(page, ocrVan.get(page.page));
          return (
            <li key={page.page} className="py-2.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="w-24 shrink-0 text-muted-foreground">Pagina {page.page}</span>
                <span className="w-28 shrink-0 tabular-nums">
                  {telling.totaal ? `${telling.klopt} / ${telling.totaal}` : 'geen tekst'}
                </span>
                <span className="min-w-0 flex-1 text-muted-foreground">
                  {opmaakTelling(page.patches.length)}
                  {' · '}
                  {page.continuity.continuesFromPrevious ? 'loopt door van de vorige pagina' : 'begint hier'}
                  {' · '}
                  {page.continuity.continuesOnNext ? 'loopt door op de volgende' : 'eindigt hier'}
                </span>
                <span className="text-xs text-muted-foreground">{WAARVANDAAN[page.typography ?? 'onbekend']}</span>
              </div>
              {telling.ontbreekt.length ? (
                <AfwijkendeWoorden woorden={telling.ontbreekt} onNaarPlek={onNaarPlek} />
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 pb-1 text-sm text-muted-foreground">{herkomst(pages)}</p>
    </section>
  );
}

function Opmaak({
  pages,
  content,
  onNaarPlek
}: {
  pages: PageResult[];
  content: ArticleDocument['content'];
  onNaarPlek: NaarPlek;
}) {
  if (!pages.some((p) => p.patches.length)) return null;
  return (
    <section className="rounded-xl bg-black/[0.04] px-4 py-3">
      <h3 className="text-sm font-medium">Opmaak per tekstfragment</h3>
      <p className="mt-1 text-sm text-muted-foreground">{overall(pages)}</p>
      <ul className="mt-2 divide-y divide-black/[0.06]">
        {pages.flatMap((page) =>
          page.patches.map((patch, i) => {
            const dropped = page.dropped.includes(i);
            return (
              <li
                key={`${page.page}-${i}`}
                className={`flex items-center gap-x-4 gap-y-1 py-2.5 text-sm ${dropped ? 'opacity-50' : ''}`}
              >
                <CodeUitleg code={patch.target} label={patchPlek(patch, page.page, page.blocks)} />
                <span className="w-28 shrink-0">{stijlLabel(patch.style)}</span>
                <span className={`min-w-0 flex-1 truncate ${dropped ? 'text-muted-foreground line-through' : 'text-muted-foreground'}`}>
                  &ldquo;{clip(patch.find)}&rdquo;
                  {dropped ? ' · niet toegepast' : ''}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 shrink-0 px-0"
                  onClick={() => {
                    const block = page.blocks.find((b) => b.id === patch.target);
                    const plek = plekVanOpmaak(block, patch.find, patch.nth, content);
                    onNaarPlek(plek.zoek, plek.markeer, plek.nth);
                  }}
                  title="Toon in het artikel"
                  aria-label="Toon in het artikel"
                >
                  <Eye className="size-3.5" />
                </Button>
              </li>
            );
          })
        )}
      </ul>
    </section>
  );
}

function CodeUitleg({ code, label }: { code: string; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger className="w-44 shrink-0 truncate bg-transparent p-0 text-left text-muted-foreground">
        {label}
      </TooltipTrigger>
      <TooltipContent>Interne code: {code}</TooltipContent>
    </Tooltip>
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
  read: 'vet en cursief uit de PDF',
  'no-text-layer': 'vet en cursief van de paginascan',
  'unnamed-fonts': 'vet en cursief van de paginascan',
  onbekend: 'herkomst van de opmaak onbekend'
};

function herkomst(pages: PageResult[]): string {
  const uitPdf = pages.filter((p) => p.typography === 'read').length;
  const gelezen = pages.length - uitPdf;
  if (!gelezen) return `Op alle ${pages.length} pagina's komt de opmaak uit de PDF zelf.`;
  if (!uitPdf) return 'Geen enkele pagina had bruikbare opmaak in de PDF; vet en cursief zijn van de paginascan gelezen.';
  const welke = pages.filter((p) => p.typography !== 'read').map((p) => `pagina ${p.page}`);
  return `${uitPdf} van de ${pages.length} pagina's uit de PDF · ${welke.join(', ')} van de paginascan gelezen.`;
}

function overall(pages: PageResult[]): string {
  const all = pages.flatMap((page) => page.patches);
  const dropped = pages.reduce((n, page) => n + page.dropped.length, 0);
  return `${opmaakTelling(all.length)}${dropped ? ` · ${dropped} niet toegepast` : ''}`;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function picturesFromDocument(
  images: ExtractedImage[],
  current: ArticleDocument | null | undefined
): ReturnType<typeof groupPictures> {
  const files = new Set<string>();
  if (current?.header?.file) files.add(current.header.file);
  const walk = (nodes: ContentNode[]) => {
    for (const node of nodes) {
      if (node.type === 'image' && node.file) files.add(node.file);
      if (node.type === 'insert') walk(node.content);
    }
  };
  if (current) walk(current.content);
  const of = (image: ExtractedImage): Picture => ({ image, note: 'uit het pakket' });
  return {
    inArticle: images.filter((image) => files.has(image.file)).map(of),
    kept: images.filter((image) => !files.has(image.file)).map(of),
    dropped: [],
    shards: []
  };
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
  pages,
  current,
  onNaarPlek
}: {
  owner: string | null | undefined;
  images: ExtractedImage[];
  verdicts: ImageVerdict[];
  pages: PageResult[];
  current?: ArticleDocument | null;
  onNaarPlek: NaarPlek;
}) {
  const { inArticle, kept, dropped, shards } = pages.length
    ? groupPictures(images, verdicts, pages)
    : picturesFromDocument(images, current);
  const uitPakket = !pages.length;

  return (
    <section className="rounded-xl bg-black/[0.04] px-4 py-3">
      <h3 className="text-sm font-medium">{uitPakket ? 'Beelden in het pakket' : 'Beelden uit de PDF'}</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {images.length} beeld{images.length === 1 ? '' : 'en'}
        {uitPakket ? ' in het pakket' : ' in de PDF'} &middot; {inArticle.length} in het artikel
        {kept.length ? ` \u00b7 ${kept.length} goedgekeurd maar nergens geplaatst` : ''}
        {dropped.length ? ` \u00b7 ${dropped.length} weggelaten` : ''}
        {shards.length ? ` \u00b7 ${shards.length} stuk${shards.length === 1 ? '' : 'ken'} van opgeknipte beelden` : ''}
      </p>

      <Group title="In het artikel" pictures={inArticle} owner={owner} onNaarPlek={onNaarPlek} />
      <Group
        title="Goedgekeurd, maar nergens geplaatst"
        hint="De converter vond dit beeld relevant, maar heeft het niet in de tekst gezet."
        pictures={kept}
        owner={owner}
        onNaarPlek={onNaarPlek}
        dimmed
      />
      <Group
        title="Niet in het artikel gezet"
        hint="Weggezet als logo, lijntje, versiering, advertentie of beeld van een ander stuk."
        pictures={dropped}
        owner={owner}
        onNaarPlek={onNaarPlek}
        dimmed
      />

      {shards.length ? (
        <Collapsible className="mt-4">
          <div className="flex items-center gap-1.5">
            <CollapsibleTrigger className="text-sm font-medium underline-offset-4 hover:underline">
              Stukken van opgeknipte beelden ({shards.length})
            </CollapsibleTrigger>
            <Hulp tekst="Eén foto kan als honderd losse stukjes in de PDF staan. Die stukjes worden nooit apart geplaatst; het hele beeld wordt van de pagina gehaald, of het gaat er allemaal uit." />
          </div>
          <CollapsibleContent>
            <Tiles pictures={shards} owner={owner} onNaarPlek={onNaarPlek} dimmed />
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
  onNaarPlek,
  dimmed
}: {
  title: string;
  hint?: string;
  pictures: Picture[];
  owner: string | null | undefined;
  onNaarPlek: NaarPlek;
  dimmed?: boolean;
}) {
  if (!pictures.length) return null;
  return (
    <div className="mt-4">
      <h4 className="flex items-center gap-1.5 text-sm font-medium">
        {title}
        {hint ? <Hulp tekst={hint} /> : null}
        <span className="text-muted-foreground tabular-nums">({pictures.length})</span>
      </h4>
      <Tiles pictures={pictures} owner={owner} onNaarPlek={onNaarPlek} dimmed={dimmed} />
    </div>
  );
}

function Tiles({
  pictures,
  owner,
  onNaarPlek,
  dimmed
}: {
  pictures: Picture[];
  owner: string | null | undefined;
  onNaarPlek: NaarPlek;
  dimmed?: boolean;
}) {
  return (
    <ul className="mt-2 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {pictures.map((picture) => (
        <Tile key={picture.image.id} picture={picture} owner={owner} onNaarPlek={onNaarPlek} dimmed={dimmed} />
      ))}
    </ul>
  );
}

/** Eén beeld: de thumbnail, waar het stond, en waarom het er wel of niet in zit. */
function Tile({
  picture,
  owner,
  onNaarPlek,
  dimmed
}: {
  picture: Picture;
  owner: string | null | undefined;
  onNaarPlek: NaarPlek;
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
      alt={image.nearby ?? beeldLabel(image)}
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
        <Tooltip>
          <TooltipTrigger className="truncate bg-transparent p-0 text-left font-medium">
            {beeldLabel(image)}
            {image.parts ? <span className="ml-1 font-normal text-muted-foreground">({image.parts} stukken)</span> : null}
          </TooltipTrigger>
          <TooltipContent>Interne code: {image.id}</TooltipContent>
        </Tooltip>
        <span className="text-muted-foreground">
          Pagina {image.page} &middot; {beeldMaat(image)} beeld
        </span>
        <span className="text-muted-foreground">{beeldToelichting(note)}</span>
        {image.nearby ? (
          <button
            type="button"
            className="truncate text-left text-muted-foreground italic hover:text-foreground hover:underline"
            onClick={() => onNaarPlek(image.nearby!)}
            title="Toon bijbehorende tekst in het artikel"
          >
            &ldquo;{clip(image.nearby)}&rdquo;
          </button>
        ) : null}
      </div>
    </li>
  );
}
