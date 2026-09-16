import { obviouslyDecorative } from './imagefilter';
import { textOf } from './pagemarkup';
import { strayLetters } from './spelling';
import type { ArticleDocument, ContentNode, ExtractedImage, ImageVerdict, OcrPage, PageResult } from './types';
import { tokens } from './util';
import { buildIndex, checkAgainstIndex } from './wordindex';

/**
 * Wat de Controle-tab meldt, en hoe erg het is.
 *
 * Eén plek met alle regels, zonder React, zodat `npm run golden` voor elke oude
 * job vastlegt wat hij meldt. Het venster tekent alleen wat hier uitkomt.
 *
 * Drie niveaus, naar wat de redacteur moet doen en niet naar waar het vandaan
 * komt:
 * - `oplossen`: er ontbreekt tekst of een pagina is mislukt. Niet versturen.
 * - `nakijken`: kan kloppen, kan fout zijn; een mens moet kijken.
 * - `info`: goed om te weten, telt niet mee in het oordeel.
 *
 * De grenzen zijn gemeten op de 113 oude jobs, niet geschat. Van de 316
 * tekstpagina's hadden precies de 4 kapotte er minder dan de helft van hun tekst
 * terug, en geen enkele gewone pagina. "Vaker gebruikt dan de pagina bevat"
 * sloeg 301 keer aan, vooral op pull quotes die per definitie tekst herhalen;
 * dat is hier een dubbele passage van acht woorden of meer geworden, buiten de
 * quotes. Een melding die bij de helft van de artikelen afgaat, leert iedereen
 * haar te negeren, en dan is de controle niet foolproof maar stil.
 */

export type Ernst = 'oplossen' | 'nakijken' | 'info';

export type Soort =
  | 'pagina-mislukt'
  | 'tekst-ontbreekt'
  | 'onbekend-woord'
  | 'dubbele-passage'
  | 'naad'
  | 'kop-niet-in-pdf'
  | 'beeld-niet-geplaatst'
  | 'losse-letter'
  | 'opmaak-van-beeld'
  | 'opmaak-niet-toegepast'
  | 'technisch';

/** Een stuk tekst als bewijs, met de woorden die gemarkeerd moeten worden. */
export interface Fragment {
  label: string;
  tekst: string;
  markeer?: string[];
}

export interface Bevinding {
  /** Blijft gelijk zolang het probleem hetzelfde is, zodat "nagekeken" het overleeft. */
  id: string;
  ernst: Ernst;
  soort: Soort;
  pagina: number | null;
  titel: string;
  uitleg: string;
  bewijs: Fragment[];
  /** Een stuk tekst om in de Artikel-tab op te zoeken. */
  zoek?: string;
  /** Een beeld uit de PDF, bij id. */
  beeld?: string;
  /** Een lijst, voor een melding die meerdere dingen samenvat. */
  lijst?: string[];
}

export interface ControleInvoer {
  document: ArticleDocument | null;
  pages: PageResult[];
  /** Leeg als de OCR er niet (meer) is; dan vallen de metingen die hem nodig hebben weg. */
  ocr: OcrPage[];
  images: ExtractedImage[];
  verdicts: ImageVerdict[];
}

export interface Oordeel {
  stand: 'oplossen' | 'nakijken' | 'klaar';
  oplossen: number;
  nakijken: number;
}

// ─── Grenzen ─────────────────────────────────────────────────────────────────

/** Onder dit deel van de tekst van de pagina terug in het artikel: er ontbreekt tekst. */
const TERUG_MINIMAAL = 0.5;
/** Pas vanaf zoveel woorden in de OCR is de pagina een tekstpagina. */
const TEKSTPAGINA = 80;
/** Zoveel woorden achter elkaar die twee keer in het artikel staan, is een dubbele passage. */
const PASSAGE = 8;
/** Zoveel zinnen met onbekende woorden krijgen een eigen kaart; de rest wordt samengevat. */
const ZINNEN_PER_PAGINA = 6;
/** De openingspagina's, waar de frontmatter vandaan komt. */
const OPENING = 3;

// ─── Buiten ──────────────────────────────────────────────────────────────────

export function controleer(invoer: ControleInvoer): Bevinding[] {
  const { document, pages } = invoer;
  const ocrVan = new Map(invoer.ocr.map((o) => [o.page, o]));
  const opening = [...pages].sort((a, b) => a.page - b.page).slice(0, OPENING).map((p) => p.page);
  const artikelWoorden = document ? new Set(tokens(documentTekst(document, true))) : null;
  const uit: Bevinding[] = [];

  for (const pagina of [...pages].sort((a, b) => a.page - b.page)) {
    const ocr = ocrVan.get(pagina.page);
    uit.push(...paginaStatus(pagina, ocr, opening.includes(pagina.page) ? frontmatterTekst(document) : ''));
    uit.push(...onbekendeWoorden(pagina, ocr, artikelWoorden));
  }
  if (document) {
    uit.push(...losseLetters(document));
    uit.push(...naden(document));
    uit.push(...dubbelePassages(document));
    uit.push(...kopNietInPdf(document, opening.map((p) => ocrVan.get(p)).filter((o): o is OcrPage => !!o)));
    uit.push(...beeldNietGeplaatst(document, invoer.images, invoer.verdicts));
  }
  uit.push(...informatie(pages));

  const volgorde: Record<Ernst, number> = { oplossen: 0, nakijken: 1, info: 2 };
  return uit.sort((a, b) => volgorde[a.ernst] - volgorde[b.ernst] || (a.pagina ?? 0) - (b.pagina ?? 0));
}

/** Het oordeel over een artikel: wat nog open staat na aftrek van wat is nagekeken. */
export function oordeel(bevindingen: Bevinding[], nagekeken: ReadonlySet<string>): Oordeel {
  const open = bevindingen.filter((b) => !nagekeken.has(b.id));
  const oplossen = open.filter((b) => b.ernst === 'oplossen').length;
  const nakijken = open.filter((b) => b.ernst === 'nakijken').length;
  return { stand: oplossen ? 'oplossen' : nakijken ? 'nakijken' : 'klaar', oplossen, nakijken };
}

// ─── Pagina ──────────────────────────────────────────────────────────────────

function paginaStatus(pagina: PageResult, ocr: OcrPage | undefined, frontmatter: string): Bevinding[] {
  const reden = pagina.failed ?? oudeFout(pagina);
  const terug = ocr ? teruggevonden(ocr, textOf(pagina.blocks) + ' ' + frontmatter) : null;
  const ontbreekt = terug && terug.totaal >= TEKSTPAGINA && terug.deel < TERUG_MINIMAAL;
  if (!reden && !ontbreekt) return [];

  const begin = ocr ? eersteZinnen(ocr.markdown, 220) : '';
  const bewijs: Fragment[] = begin ? [{ label: `Op pagina ${pagina.page} van de PDF staat onder meer`, tekst: begin }] : [];
  if (reden) {
    return [
      {
        id: `mislukt:p${pagina.page}`,
        ernst: 'oplossen',
        soort: 'pagina-mislukt',
        pagina: pagina.page,
        titel: `Pagina ${pagina.page} is mislukt`,
        uitleg:
          `${gewoneTaal(reden)}${terug && terug.totaal >= TEKSTPAGINA ? ` Van de ${terug.totaal} woorden op de pagina staat ${procent(terug.deel)} in het artikel.` : ''} ` +
          'Zet het artikel opnieuw om, of vul de tekst zelf aan in de Artikel-tab.',
        bewijs
      }
    ];
  }
  return [
    {
      id: `ontbreekt:p${pagina.page}`,
      ernst: 'oplossen',
      soort: 'tekst-ontbreekt',
      pagina: pagina.page,
      titel: `Pagina ${pagina.page}: tekst ontbreekt`,
      uitleg:
        `Van de ${terug!.totaal} woorden op deze pagina staat maar ${procent(terug!.deel)} in het artikel. ` +
        'Staat er een advertentie of een ander artikel op de pagina, dan kan dat kloppen; anders is er tekst weggevallen.',
      bewijs
    }
  ];
}

/** Een job van vóór `failed`: dan staat de reden alleen in een waarschuwing. */
function oudeFout(pagina: PageResult): string | undefined {
  if (pagina.blocks.length) return undefined;
  return pagina.warnings.find((w) => /afgekapt|kwam niet terug|is not defined|mislukt|tijd op/i.test(w));
}

function gewoneTaal(reden: string): string {
  if (/tijd op/i.test(reden)) return 'De tijd die Vercel een stap geeft was op.';
  if (/afgekapt|length/i.test(reden)) return 'Het model stopte halverwege de pagina.';
  if (/is not defined|TypeError|ReferenceError/.test(reden)) return 'Er ging iets mis in de converter zelf.';
  if (/verbinding|network|fetch/i.test(reden)) return 'De verbinding viel weg.';
  return `Het uitlezen gaf een fout (${kort(reden, 120)}).`;
}

/** Hoeveel van de woorden op de pagina terugkomen in wat er geschreven is. */
function teruggevonden(ocr: OcrPage, geschreven: string): { totaal: number; deel: number } {
  const index = buildIndex(ocr.page, ocr.markdown);
  const uit = new Map<string, number>();
  for (const woord of tokens(geschreven)) uit.set(woord, (uit.get(woord) ?? 0) + 1);
  let totaal = 0;
  let terug = 0;
  for (const [woord, n] of Object.entries(index.counts)) {
    if (woord.length < 2) continue;
    totaal += n;
    terug += Math.min(n, uit.get(woord) ?? 0);
  }
  return { totaal, deel: totaal ? terug / totaal : 1 };
}

/**
 * Woorden die de run schreef en die niet op de pagina staan, per zin. Een woord
 * dat de redacteur intussen in de Artikel-tab heeft weggehaald, telt niet meer.
 */
function onbekendeWoorden(pagina: PageResult, ocr: OcrPage | undefined, artikel: Set<string> | null): Bevinding[] {
  const onbekend = pagina.check.unknown.filter((w) => !artikel || artikel.has(w));
  if (!onbekend.length) return [];

  const zinnen = zinnenVan(textOf(pagina.blocks));
  const perZin = new Map<string, string[]>();
  const los: string[] = [];
  for (const woord of onbekend) {
    const zin = zinnen.find((z) => tokens(z).includes(woord));
    if (!zin) {
      los.push(woord);
      continue;
    }
    perZin.set(zin, [...(perZin.get(zin) ?? []), woord]);
  }

  const regels = ocr ? ocr.markdown.split(/\n+/).map((r) => r.replace(/^[#>*\-\s]+/, '').trim()).filter(Boolean) : [];
  const uit: Bevinding[] = [];
  const kaarten = [...perZin];
  for (const [zin, woorden] of kaarten.slice(0, ZINNEN_PER_PAGINA)) {
    const pdf = besteRegel(zin, woorden, regels);
    uit.push({
      id: `onbekend:p${pagina.page}:${[...woorden].sort().join(',')}`,
      ernst: 'nakijken',
      soort: 'onbekend-woord',
      pagina: pagina.page,
      titel: woorden.length === 1 ? `Woord dat niet in de PDF staat: "${woorden[0]}"` : `${woorden.length} woorden die niet in de PDF staan`,
      uitleg: 'Mogelijk verzonnen of verbeterd, of de OCR las het niet. Vergelijk de twee regels.',
      bewijs: [
        { label: `Artikel, pagina ${pagina.page}`, tekst: kort(zin, 260), markeer: woorden },
        ...(pdf ? [{ label: `PDF, pagina ${pagina.page}`, tekst: kort(pdf, 260) }] : [])
      ],
      zoek: zoekstuk(zin, woorden[0])
    });
  }
  const rest = [...kaarten.slice(ZINNEN_PER_PAGINA).flatMap(([, w]) => w), ...los];
  if (rest.length) {
    uit.push({
      id: `onbekend:p${pagina.page}:rest:${[...rest].sort().join(',')}`,
      ernst: 'nakijken',
      soort: 'onbekend-woord',
      pagina: pagina.page,
      titel: `Nog ${rest.length} woord${rest.length === 1 ? '' : 'en'} op pagina ${pagina.page} die niet in de PDF staan`,
      uitleg: 'Veel onbekende woorden op één pagina wijzen vaker op een slecht leesbare pagina dan op losse fouten.',
      bewijs: [],
      lijst: rest
    });
  }
  return uit;
}

/**
 * Het stuk van de PDF dat het meest op de zin lijkt, zonder de verdachte woorden
 * mee te tellen. De OCR levert soms een hele alinea als één regel, dus wordt er in
 * zinnen gezocht. Lijkt niets er genoeg op, dan liever geen bewijs dan een
 * verkeerd stuk tekst dat de redacteur op het verkeerde been zet.
 */
function besteRegel(zin: string, verdacht: string[], regels: string[]): string | null {
  const woorden = new Set(tokens(zin).filter((w) => !verdacht.includes(w) && w.length > 2));
  if (woorden.size < 2) return null;
  let beste: string | null = null;
  let score = 0;
  for (const kandidaat of regels.flatMap((r) => zinnenVan(r))) {
    const n = new Set(tokens(kandidaat).filter((w) => woorden.has(w))).size;
    if (n > score) {
      score = n;
      beste = kandidaat;
    }
  }
  return score >= Math.min(3, woorden.size) && score / woorden.size >= 0.5 ? beste : null;
}

/**
 * Losse letters, in het artikel zoals het nu is. In kop, chapeau en intro is dat
 * nakijken: daar, in displayletter over een illustratie, las de OCR "Mama, weet j
 * mama" waar "je" stond. In de lopende tekst is het ter informatie: op de oude
 * jobs was elke losse letter daar terecht ("stam + t", "o shit").
 */
function losseLetters(document: ArticleDocument): Bevinding[] {
  const uit: Bevinding[] = [];
  const kop = strayLetters(frontmatterTekst(document));
  if (kop.length) {
    uit.push({
      id: `letter:kop:${hash(kop.join('|'))}`,
      ernst: 'nakijken',
      soort: 'losse-letter',
      pagina: null,
      titel: kop.length === 1 ? 'Losse letter in de kop' : `${kop.length} losse letters in de kop`,
      uitleg: 'Een letter die alleen staat, is in een kop vaak een woord dat half van het beeld is gelezen.',
      bewijs: kop.slice(0, 3).map((stuk) => ({ label: 'Kop', tekst: `…${stuk}…` })),
      zoek: kop[0]
    });
  }
  const tekst = strayLetters(documentTekst(document, false));
  if (tekst.length) {
    uit.push({
      id: `letter:tekst:${hash(tekst.join('|'))}`,
      ernst: 'info',
      soort: 'losse-letter',
      pagina: null,
      titel: tekst.length === 1 ? 'Losse letter in de tekst' : `${tekst.length} losse letters in de tekst`,
      uitleg: 'Meestal terecht, zoals in "stam + t". Staat er een halve zin, dan las de OCR een woord maar half.',
      bewijs: [],
      lijst: tekst.map((stuk) => `…${stuk}…`)
    });
  }
  return uit;
}

// ─── Het hele artikel ────────────────────────────────────────────────────────

/** Een alinea die met een kleine letter begint: een zin of woord is over een grens doorgeknipt. */
function naden(document: ArticleDocument): Bevinding[] {
  const uit: Bevinding[] = [];
  const loop = (nodes: ContentNode[]) => {
    let vorige = '';
    for (const node of nodes) {
      if (node.type === 'insert') {
        loop(node.content);
        vorige = '';
        continue;
      }
      if (node.type !== 'paragraph') {
        vorige = 'content' in node && typeof node.content === 'string' ? node.content : '';
        continue;
      }
      const tekst = node.content.trim();
      // Een webadres begint gewoon met een kleine letter.
      const adres = /^(https?:\/\/|www\.|[\p{Ll}\d-]+\.(nl|be|com|org|net|eu|nu|info|de)\b)/u.test(tekst);
      if (/^\p{Ll}/u.test(tekst) && !adres) {
        const eersteWoord = tekst.match(/^[\p{L}\p{N}'’-]+/u)?.[0] ?? tekst.slice(0, 12);
        uit.push({
          id: `naad:${hash(tekst.slice(0, 60))}`,
          ernst: 'nakijken',
          soort: 'naad',
          pagina: null,
          titel: 'Alinea begint midden in een zin of woord',
          uitleg: 'Een zin of een afgebroken woord over een pagina- of kolomgrens is niet aan elkaar gezet. Plak de alinea aan de vorige, of zet het woord recht.',
          bewijs: [
            ...(vorige ? [{ label: 'Einde van de alinea ervoor', tekst: `…${vorige.trim().slice(-90)}` }] : []),
            { label: 'Begin van deze alinea', tekst: `${tekst.slice(0, 120)}…`, markeer: [eersteWoord] }
          ],
          zoek: tekst.slice(0, 50)
        });
      }
      vorige = node.content;
    }
  };
  loop(document.content);
  return uit;
}

/**
 * Een stuk tekst van acht woorden of meer dat twee keer in het artikel staat.
 * Quotes en streamers tellen niet mee: die herhalen tekst met opzet.
 */
function dubbelePassages(document: ArticleDocument): Bevinding[] {
  const teksten: string[] = [];
  const verzamel = (nodes: ContentNode[]) => {
    for (const node of nodes) {
      if (node.type === 'paragraph' || node.type === 'subheading') teksten.push(node.content);
      else if (node.type === 'list') teksten.push(...node.items.map((i) => i.content));
      else if (node.type === 'insert') verzamel(node.content);
    }
  };
  verzamel(document.content);

  const woorden: Array<{ woord: string; tekst: number }> = [];
  teksten.forEach((tekst, i) => tokens(tekst).forEach((woord) => woorden.push({ woord, tekst: i })));

  const eerste = new Map<string, number>();
  const uit: Bevinding[] = [];
  const gemeld = new Set<string>();
  for (let i = 0; i + PASSAGE <= woorden.length; i++) {
    const sleutel = woorden.slice(i, i + PASSAGE).map((w) => w.woord).join(' ');
    const eerder = eerste.get(sleutel);
    if (eerder === undefined) {
      eerste.set(sleutel, i);
      continue;
    }
    if (i - eerder < PASSAGE || gemeld.has(sleutel)) continue;
    // Zo lang als hij doorloopt, zodat één passage één melding is.
    let lengte = PASSAGE;
    while (i + lengte < woorden.length && eerder + lengte < i && woorden[eerder + lengte].woord === woorden[i + lengte].woord) lengte++;
    for (let k = 0; k + PASSAGE <= lengte; k++) gemeld.add(woorden.slice(i + k, i + k + PASSAGE).map((w) => w.woord).join(' '));

    const passage = woorden.slice(i, i + lengte).map((w) => w.woord);
    const origineel = terugInTekst(teksten[woorden[i].tekst], passage) ?? passage.join(' ');
    uit.push({
      id: `dubbel:${hash(sleutel)}`,
      ernst: 'nakijken',
      soort: 'dubbele-passage',
      pagina: null,
      titel: 'Tekst staat twee keer in het artikel',
      uitleg: `${lengte} woorden achter elkaar komen twee keer voor. Vaak is een stuk van de vorige pagina herhaald, of staat een bijschrift ook in de lopende tekst.`,
      bewijs: [{ label: 'Tweede keer', tekst: kort(origineel, 260) }],
      zoek: kort(origineel, 50).replace(/…$/, '')
    });
    i += lengte - 1;
  }
  return uit;
}

/** Woorden van chapeau, titel, ondertitel of intro die niet op de openingspagina's staan. */
function kopNietInPdf(document: ArticleDocument, ocr: OcrPage[]): Bevinding[] {
  if (!ocr.length) return [];
  const index = buildIndex(0, ocr.map((o) => o.markdown).join('\n'));
  const velden: Array<[string, string | null]> = [
    ['Chapeau', document.frontmatter.chapeau],
    ['Titel', document.frontmatter.title],
    ['Ondertitel', document.frontmatter.subtitle],
    ['Intro', document.frontmatter.intro]
  ];
  const uit: Bevinding[] = [];
  for (const [naam, waarde] of velden) {
    if (!waarde) continue;
    const { unknown } = checkAgainstIndex(index, waarde);
    if (!unknown.length) continue;
    uit.push({
      id: `kop:${naam.toLowerCase()}:${[...unknown].sort().join(',')}`,
      ernst: 'nakijken',
      soort: 'kop-niet-in-pdf',
      pagina: null,
      titel: `${naam} bevat ${unknown.length === 1 ? 'een woord' : `${unknown.length} woorden`} die niet in de PDF staan`,
      uitleg:
        naam === 'Intro'
          ? 'De intro wordt anders nergens tegen de PDF gecontroleerd. Kijk of hij letterlijk is overgenomen, niet samengevat.'
          : 'Een kop is vaak getekend in plaats van getypt en dan van het beeld gelezen. Kijk of hij goed gelezen is.',
      bewijs: [{ label: naam, tekst: kort(waarde, 260), markeer: unknown }],
      zoek: kort(waarde, 50).replace(/…$/, '')
    });
  }
  return uit;
}

function beeldNietGeplaatst(document: ArticleDocument, images: ExtractedImage[], verdicts: ImageVerdict[]): Bevinding[] {
  const oordeelVan = new Map(verdicts.map((v) => [v.id, v]));
  // Een beeld in het artikel draagt het id van zijn blok (p3-02), niet dat van de
  // bitmap; wat ze delen is het bestand.
  const geplaatst = new Set<string>(document.header ? [document.header.file] : []);
  const loop = (nodes: ContentNode[]) => {
    for (const node of nodes) {
      if (node.type === 'image' && node.file) geplaatst.add(node.file);
      if (node.type === 'insert') loop(node.content);
    }
  };
  loop(document.content);

  return images
    .filter((image) => !image.partOf && !obviouslyDecorative(image))
    .filter((image) => oordeelVan.get(image.id)?.keep !== false && !geplaatst.has(image.file))
    .map((image) => ({
      id: `beeld:${image.id}`,
      ernst: 'nakijken' as const,
      soort: 'beeld-niet-geplaatst' as const,
      pagina: image.page,
      titel: `Beeld van pagina ${image.page} staat niet in het artikel`,
      uitleg: 'De beeldbeoordeling liet het door, maar het staat nergens in de tekst. Hoort het erbij, of is het terecht weggelaten?',
      bewijs: oordeelVan.get(image.id)?.reason ? [{ label: 'Beeldbeoordeling', tekst: oordeelVan.get(image.id)!.reason }] : [],
      beeld: image.id
    }));
}

// ─── Ter informatie ──────────────────────────────────────────────────────────

function informatie(pages: PageResult[]): Bevinding[] {
  const uit: Bevinding[] = [];
  const vanBeeld = pages.filter((p) => p.typography && p.typography !== 'read').map((p) => p.page);
  if (vanBeeld.length) {
    uit.push({
      id: 'info:opmaak-van-beeld',
      ernst: 'info',
      soort: 'opmaak-van-beeld',
      pagina: null,
      titel: `Vet en cursief van het beeld gelezen op ${vanBeeld.length === 1 ? `pagina ${vanBeeld[0]}` : `pagina ${vanBeeld.join(', ')}`}`,
      uitleg: 'De PDF zei hier zelf niet wat vet en cursief was, dus heeft een model het van de pagina gelezen. Dat is een oordeel, geen aflezing.',
      bewijs: []
    });
  }
  const geweigerd = pages.reduce((n, p) => n + p.dropped.length, 0);
  if (geweigerd) {
    uit.push({
      id: 'info:opmaak-niet-toegepast',
      ernst: 'info',
      soort: 'opmaak-niet-toegepast',
      pagina: null,
      titel: `${geweigerd} keer opmaak niet toegepast`,
      uitleg: 'Vet of cursief dat niet eenduidig in de tekst terug te vinden was, is weggelaten in plaats van gegokt.',
      bewijs: []
    });
  }
  const technisch = pages.flatMap((p) =>
    p.warnings.filter((w) => w !== p.failed && !/^losse letter/.test(w)).map((w) => `Pagina ${p.page}: ${w}`)
  );
  if (technisch.length) {
    uit.push({
      id: 'info:technisch',
      ernst: 'info',
      soort: 'technisch',
      pagina: null,
      titel: `${technisch.length} technische melding${technisch.length === 1 ? '' : 'en'}`,
      uitleg: 'Voor wie de converter onderhoudt. Wat ertoe doet voor het artikel staat hierboven.',
      bewijs: [],
      lijst: technisch
    });
  }
  return uit;
}

// ─── Tekst ───────────────────────────────────────────────────────────────────

/** Alle lopende tekst van het artikel, met de frontmatter als `metKop`. */
function documentTekst(document: ArticleDocument, metKop: boolean): string {
  const delen: string[] = metKop ? [frontmatterTekst(document)] : [];
  const loop = (nodes: ContentNode[]) => {
    for (const node of nodes) {
      if (node.type === 'list') delen.push(...node.items.map((i) => i.content));
      else if (node.type === 'image') delen.push(node.caption ?? '', node.credit ?? '');
      else if (node.type === 'insert') loop(node.content);
      else delen.push(node.content);
    }
  };
  loop(document.content);
  return delen.join('\n');
}

function frontmatterTekst(document: ArticleDocument | null): string {
  if (!document) return '';
  const fm = document.frontmatter;
  return [fm.chapeau, fm.title, fm.subtitle, fm.intro, fm.date, ...fm.authors, ...fm.photographers, ...fm.illustrators]
    .filter(Boolean)
    .join('\n');
}

function zinnenVan(tekst: string): string[] {
  return tekst
    .split(/\n+/)
    .flatMap((regel) => regel.split(/(?<=[.!?…])\s+(?=[\p{Lu}"“‘'(])/u))
    .map((z) => z.trim())
    .filter(Boolean);
}

function eersteZinnen(markdown: string, lengte: number): string {
  const schoon = markdown
    .split(/\n+/)
    .map((r) => r.replace(/^[#>*\-|\s]+/, '').trim())
    .filter((r) => r.length > 20)
    .join(' ');
  return kort(schoon, lengte);
}

/** Het stuk van een zin rond een woord, kort genoeg om in de Artikel-tab op te zoeken. */
function zoekstuk(zin: string, woord: string): string {
  const plek = zin.toLowerCase().indexOf(woord.toLowerCase());
  if (plek < 0) return zin.slice(0, 50);
  const begin = Math.max(0, zin.lastIndexOf(' ', Math.max(0, plek - 20)) + 1);
  return zin.slice(begin, begin + 50).trim();
}

/** De passage zoals hij gedrukt staat, met hoofdletters en leestekens, uit de genormaliseerde woorden. */
function terugInTekst(tekst: string, woorden: string[]): string | null {
  const vrij = woorden.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+');
  return tekst.match(new RegExp(vrij, 'iu'))?.[0] ?? null;
}

function kort(tekst: string, lengte: number): string {
  const regel = tekst.replace(/\s+/g, ' ').trim();
  return regel.length > lengte ? `${regel.slice(0, lengte).replace(/\s+\S*$/, '')}…` : regel;
}

function procent(deel: number): string {
  return `${Math.round(deel * 100)}%`;
}

/** Een korte, vaste sleutel voor een stuk tekst. Geen beveiliging, alleen herkenning. */
function hash(tekst: string): string {
  let h = 5381;
  for (let i = 0; i < tekst.length; i++) h = ((h << 5) + h + tekst.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
