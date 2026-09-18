import { linkify } from './links';
import { bijschrift, delen, eersteArtikel, kaal } from './pakketlezen';
import { places, segments } from './spans';
import type {
  ArticleDocument,
  ContentNode,
  ExtractedImage,
  Frontmatter,
  FrontmatterField,
  ImageSize,
  InlineStyle,
  ListItem,
  PageResult,
  StyleSpan
} from './types';

/**
 * Vrhl Content Package 1.0, het canonieke uitwisselformaat.
 *
 * Dit bestand is de enige plek die het formaat kent. Het weet niets van Sanity,
 * niets van MDX en niets van Word: die zijn alledrie consument van wat hier uit
 * komt. De andere kant op, van pakket naar artikelobject, is `fromPackage`: dat
 * is hoe een eerder gedownload pakket weer in de converter komt. Zie
 * canonical/README.md voor het contract en canonical/validate.mjs voor de
 * controle erop.
 *
 * Wat hier gebeurt is een vertaling, geen oordeel. Alles wat de converter niet
 * uit de PDF kan weten (tags, editie, SEO, video) blijft weg in plaats van
 * verzonnen te worden, precies zoals het formaat vraagt.
 */

// ─── Het formaat ─────────────────────────────────────────────────────────────

export type CanonicalStijl = 'cursief' | 'vet' | 'onderstreept' | 'klein';

export interface TekstDeel {
  tekst: string;
  stijlen?: CanonicalStijl[];
  link?: string;
}

/** Een titelveld kent alleen cursief en geen links. */
export interface TitelDeel {
  tekst: string;
  stijlen?: 'cursief'[];
}

export type Tekst = string | TekstDeel[];
export type Titel = string | TitelDeel[];

export type Grootte = 'klein' | 'normaal' | 'groot' | 'extraGroot';

export interface LijstItem {
  inhoud: Tekst;
  items?: LijstItem[];
}

export type BlokZonderKader =
  | { soort: 'alinea'; inhoud: Tekst }
  | { soort: 'kop'; niveau?: number; inhoud: Tekst }
  | { soort: 'quote'; inhoud: Tekst }
  | { soort: 'lijst'; stijl?: 'opsomming' | 'nummering'; items: LijstItem[] }
  | { soort: 'afbeelding'; asset: string; alt?: string; onderschrift?: string; grootte?: Grootte }
  | { soort: 'video'; url: string; onderschrift?: string; grootte?: Grootte };

export type Blok =
  | BlokZonderKader
  | {
      soort: 'tekstkader';
      achtergrondKleur?: string;
      tekstKleur?: string;
      inhoud: BlokZonderKader[];
    };

export interface Bron {
  soort?: 'pdf' | 'docx' | 'html' | 'handmatig' | 'overig';
  bestand?: string;
  sha256?: string;
  paginas?: number[];
  tool?: string;
  betrouwbaarheid?: number;
  controleren?: string[];
  opmerkingen?: string;
}

export interface Asset {
  id: string;
  soort?: 'afbeelding' | 'bestand';
  bestand?: string;
  url?: string;
  mimeType?: string;
  breedte?: number;
  hoogte?: number;
  alt?: string;
  onderschrift?: string;
  credit?: string;
  bron?: Bron;
}

/**
 * Alleen nodig als de producent de slug van een tag zelf wil bepalen. Deze
 * converter levert ze niet, want uit een PDF komen geen tags; het formaat kent
 * ze wel, en dit bestand beschrijft het formaat en niet alleen wat wij ervan
 * gebruiken.
 */
export interface Tag {
  naam: string;
  slug?: string;
}

export type Datum =
  | string
  | { precisie: 'dagMaandJaar' | 'maandJaar' | 'maand'; dag?: number; maand: number; jaar?: number };

export interface Credits {
  auteurs?: string[];
  fotografen?: string[];
  illustratoren?: string[];
  bovenaan?: boolean;
}

export interface Artikel {
  id: string;
  externeId?: string;
  type: 'single' | 'shorts';
  slug?: string;
  rubriek?: Titel;
  titel: Titel;
  ondertitel?: Titel;
  header?: { asset?: string; achtergrond?: string; alt?: string; vierkant?: boolean; tekstVerbergen?: boolean };
  credits?: Credits;
  datum?: Datum;
  tags?: string[];
  intro?: Blok[];
  body?: Blok[];
  publicatie?: { klaar?: boolean };
  bron?: Bron;
}

export interface Pakket {
  vrhlContent: '1.0';
  pakketId?: string;
  gegenereerdOp?: string;
  bron?: Bron;
  assets?: Asset[];
  tags?: Tag[];
  artikelen?: Artikel[];
}

/** Wat er als producent in `bron.tool` komt te staan. */
export const TOOL = 'vrhl-blad-converter 1.0';

/**
 * Onder deze woorddekking vraagt de producent om controle. Dezelfde drempel die
 * canonical/validate.mjs aanhoudt voor `betrouwbaarheid`, zodat een pakket dat
 * hier door de controle komt daar ook geen waarschuwing oplevert.
 */
const REVIEW_BELOW = 0.7;

// ─── Van artikel naar pakket ────────────────────────────────────────────────

export interface PackageOptions {
  /** De bitmaps uit de PDF. Zonder deze lijst komt er geen enkel asset mee. */
  images?: ExtractedImage[];
  /** De paginaresultaten, voor woorddekking en waarschuwingen. */
  pages?: PageResult[];
  /** De naam van het bronbestand; valt terug op wat het document zelf weet. */
  filename?: string;
  /** Vast te zetten voor een herhaalbare uitvoer; anders het moment van nu. */
  generatedAt?: string;
}

export function toPackage(doc: ArticleDocument, options: PackageOptions = {}): Pakket {
  const filename = options.filename ?? doc.source.file;
  const paginas = doc.source.pages ?? [];
  const images = options.images ?? [];
  const pages = options.pages ?? [];

  // Alleen het beeld dat het artikel echt gebruikt komt mee: de validator
  // waarschuwt over een asset waar niets naar verwijst, en terecht.
  const used = new Map<string, Asset>();
  const byFile = new Map(images.map((image) => [image.file, image]));
  const claim = (file: string | null): string | undefined => {
    if (!file) return undefined;

    const image = byFile.get(file);
    if (image) {
      used.set(image.id, asset(image));
      return image.id;
    }

    // Een job van voor het rippen van bitmaps heeft geen `ExtractedImage`, maar
    // het bestand staat er wel degelijk nog. Het beeld stilletjes laten vallen
    // zou het artikel uitkleden; een asset met alleen een `bestand` is geldig,
    // en breedte en hoogte zijn optioneel, dus die blijven weg in plaats van
    // verzonnen te worden.
    const id = looseId(file);
    if (!id) return undefined;
    used.set(id, looseAsset(id, file));
    return id;
  };

  const header = doc.header ? claim(doc.header.file) : undefined;
  const body = blocks(doc.content, claim);
  const artikel: Artikel = {
    id: 'art-1',
    externeId: externeId(filename, paginas),
    type: 'single',
    titel: titel(doc.frontmatter, 'title') ?? 'Zonder titel',
    // Een machinale extractie is per definitie nog niet nagekeken; de importer
    // hoort dit als concept te behandelen tot een mens er naar heeft gekeken.
    publicatie: { klaar: false },
    bron: bron(filename, paginas, pages)
  };

  const rubriek = titel(doc.frontmatter, 'chapeau');
  if (rubriek) artikel.rubriek = rubriek;
  const ondertitel = titel(doc.frontmatter, 'subtitle');
  if (ondertitel) artikel.ondertitel = ondertitel;
  if (header) {
    artikel.header = { asset: header };
    if (doc.header?.alt) artikel.header.alt = doc.header.alt;
  }
  const wie = credits(doc.frontmatter);
  if (wie) artikel.credits = wie;
  const wanneer = datum(doc.frontmatter.date);
  if (wanneer) artikel.datum = wanneer;
  const opening = intro(doc.frontmatter);
  if (opening) artikel.intro = opening;
  if (body.length) artikel.body = body;

  const pakket: Pakket = {
    vrhlContent: '1.0',
    pakketId: slug(filename.replace(/\.pdf$/i, '')) || 'pakket',
    gegenereerdOp: options.generatedAt ?? new Date().toISOString(),
    bron: bron(filename, paginas, pages),
    artikelen: [artikel]
  };

  const assets = [...used.values()];
  if (assets.length) pakket.assets = assets;

  return pakket;
}

/** Wat `fromPackage` teruggeeft: het artikel, en waar het beeld in de job moet staan. */
export interface FromPackage {
  document: ArticleDocument;
  images: ExtractedImage[];
  /** Pad in het pakket, naam in de job-opslag. */
  files: Array<{ path: string; name: string }>;
}

/**
 * Een pakket terug naar het artikelobject. De omgekeerde vertaling van
 * `toPackage`: geen oordeel, geen ontbrekende velden verzinnen.
 *
 * Wat het formaat niet kan dragen, komt niet terug. Een streamer is in het
 * pakket een quote, een credit die aan het bijschrift is geplakt blijft één
 * bijschrift, en een link is in het artikelobject geen eigen veld. Beeld zonder
 * bestand in het pakket wordt wel genoemd, maar heeft geen bytes.
 */
export function fromPackage(pakket: Pakket): FromPackage {
  const gelezen = eersteArtikel(pakket);
  if (!gelezen) throw new Error('in dit pakket staat geen artikel');
  const { artikel, assets } = gelezen;

  const usedNames = new Set<string>();
  const files: Array<{ path: string; name: string }> = [];
  const images: ExtractedImage[] = [];
  const byAsset = new Map<string, string>();

  const take = (id: string | undefined): string | null => {
    if (!id) return null;
    const known = byAsset.get(id);
    if (known) return known;
    const item = assets.get(id);
    if (!item) return null;
    const name = assetFileName(item, usedNames);
    byAsset.set(id, name);
    if (item.bestand) files.push({ path: item.bestand, name });
    images.push(extracted(item, name));
    return name;
  };

  const headerFile = take(artikel.header?.asset);
  const introBlokken = artikel.intro ?? [];
  const eersteAlinea = introBlokken.find((blok) => blok.soort === 'alinea');
  const restIntro = introBlokken.filter((blok) => blok !== eersteAlinea);
  const opening = eersteAlinea ? fromTekst(eersteAlinea.inhoud) : { content: '', styles: [] as StyleSpan[] };
  const body = [...nodesOf(restIntro, take, assets), ...nodesOf(artikel.body, take, assets)];

  const rubriek = titelVeld(artikel.rubriek, 'chapeau');
  const titel = titelVeld(artikel.titel, 'title');
  const ondertitel = titelVeld(artikel.ondertitel, 'subtitle');
  const bron = artikel.bron ?? pakket.bron;

  const document: ArticleDocument = {
    source: {
      file: bron?.bestand ?? 'pakket.json',
      pages: bron?.paginas ? [...bron.paginas] : []
    },
    frontmatter: {
      chapeau: rubriek.text,
      title: titel.text,
      subtitle: ondertitel.text,
      authors: [...(artikel.credits?.auteurs ?? [])],
      photographers: [...(artikel.credits?.fotografen ?? [])],
      illustrators: [...(artikel.credits?.illustratoren ?? [])],
      date: datumWeergave(artikel.datum),
      intro: opening.content || null,
      italics: [
        ...rubriek.italics,
        ...titel.italics,
        ...ondertitel.italics,
        ...italicsOfStyles('intro', opening.styles)
      ]
    },
    header:
      headerFile && artikel.header?.asset
        ? {
            id: artikel.header.asset,
            file: headerFile,
            alt: artikel.header.alt ?? assets.get(artikel.header.asset)?.alt ?? null
          }
        : null,
    content: body
  };

  return { document, images, files };
}

/**
 * Minimale controle: het is JSON, het zegt 1.0, en er zit een artikel in.
 * De rest van het schema is aan de validator van het formaat; hier is een
 * onbekend veld geen reden om te weigeren.
 */
export function parsePakket(json: string): Pakket {
  let raw: unknown;
  try {
    raw = JSON.parse(json.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('dit bestand is geen geldige JSON');
  }
  if (!raw || typeof raw !== 'object' || (raw as Pakket).vrhlContent !== '1.0') {
    throw new Error('dit is geen Vrhl-pakket (verwacht vrhlContent 1.0)');
  }
  const pakket = raw as Pakket;
  if (!pakket.artikelen?.length) throw new Error('in dit pakket staat geen artikel');
  return pakket;
}

function nodesOf(
  blokken: Blok[] | undefined,
  take: (id: string | undefined) => string | null,
  assets: Map<string, Asset>
): ContentNode[] {
  const out: ContentNode[] = [];
  for (const blok of blokken ?? []) {
    const made = fromBlok(blok, take, assets);
    if (made) out.push(made);
  }
  return out;
}

function fromBlok(
  blok: Blok,
  take: (id: string | undefined) => string | null,
  assets: Map<string, Asset>
): ContentNode | null {
  switch (blok.soort) {
    case 'alinea': {
      const { content, styles } = fromTekst(blok.inhoud);
      return content ? { type: 'paragraph', content, styles } : null;
    }
    case 'kop': {
      const content = kaal(blok.inhoud);
      return content ? { type: 'subheading', content } : null;
    }
    case 'quote': {
      const content = kaal(blok.inhoud);
      return content ? { type: 'quote', content } : null;
    }
    case 'lijst': {
      const items = listItems(blok.items ?? []);
      return items.length ? { type: 'list', ordered: blok.stijl === 'nummering', items } : null;
    }
    case 'afbeelding': {
      const item = assets.get(blok.asset);
      const caption = bijschrift(blok, item);
      const credit = item?.credit && caption && !caption.includes(item.credit) ? item.credit : null;
      return {
        type: 'image',
        id: blok.asset,
        file: take(blok.asset),
        caption,
        credit,
        size: fromGrootte(blok.grootte)
      };
    }
    case 'video': {
      const url = blok.url?.trim();
      if (!url) return null;
      const bij = blok.onderschrift?.trim();
      return { type: 'paragraph', content: bij ? `${bij} ${url}` : url, styles: [] };
    }
    case 'tekstkader': {
      const inner = nodesOf(blok.inhoud, take, assets);
      if (!inner.length) return null;
      return {
        type: 'insert',
        kind: 'box',
        background: blok.achtergrondKleur ?? null,
        ink: blok.tekstKleur ?? null,
        content: inner
      };
    }
  }
}

function listItems(items: LijstItem[]): ListItem[] {
  const out: ListItem[] = [];
  const walk = (item: LijstItem) => {
    const { content, styles } = fromTekst(item.inhoud);
    if (content) out.push({ content, styles });
    item.items?.forEach(walk);
  };
  items.forEach(walk);
  return out;
}

const VAN_STIJL: Partial<Record<CanonicalStijl, InlineStyle>> = {
  vet: 'bold',
  cursief: 'italic',
  onderstreept: 'underline'
};

const VAN_GROOTTE: Record<Grootte, ImageSize> = {
  klein: 'small',
  normaal: 'normal',
  groot: 'large',
  extraGroot: 'xlarge'
};

function fromGrootte(waarde: Grootte | undefined): ImageSize {
  return (waarde && VAN_GROOTTE[waarde]) || 'normal';
}

function fromTekst(
  waarde: Tekst | Titel | undefined,
  allowed: InlineStyle[] = ['bold', 'italic', 'underline']
): { content: string; styles: StyleSpan[] } {
  const parts = delen(waarde);
  const content = parts.map((deel) => deel.tekst).join('');
  const styles: StyleSpan[] = [];
  let at = 0;
  for (const part of parts) {
    const style = (part.stijlen ?? [])
      .map((stijl) => VAN_STIJL[stijl])
      .filter((stijl): stijl is InlineStyle => !!stijl && allowed.includes(stijl));
    if (part.tekst && style.length) {
      const nth = places(content, part.tekst).indexOf(at);
      if (nth >= 0) styles.push({ text: part.tekst, style, ...(nth > 0 ? { nth } : {}) });
    }
    at += part.tekst.length;
  }
  return { content, styles };
}

function titelVeld(
  waarde: Titel | undefined,
  field: FrontmatterField
): { text: string | null; italics: Frontmatter['italics'] } {
  if (!waarde) return { text: null, italics: [] };
  const { content, styles } = fromTekst(waarde, ['italic']);
  return { text: content || null, italics: italicsOfStyles(field, styles) };
}

function italicsOfStyles(field: FrontmatterField, styles: StyleSpan[]): Frontmatter['italics'] {
  return styles.filter((span) => span.style.includes('italic')).map((span) => ({ field, text: span.text }));
}

function assetFileName(item: Asset, used: Set<string>): string {
  const fromPath = (item.bestand ?? '').replace(/^.*\//, '');
  const ext = fromPath.includes('.')
    ? fromPath.slice(fromPath.lastIndexOf('.'))
    : item.mimeType === 'image/png'
      ? '.png'
      : '.jpeg';
  const base = (fromPath.replace(/\.[^.]+$/, '') || item.id || 'beeld').slice(0, 120);
  let name = `${base}${ext}`;
  let n = 2;
  while (used.has(name)) {
    name = `${base}-${n}${ext}`;
    n++;
  }
  used.add(name);
  return name;
}

/**
 * Een asset als bitmap in de job. Breedte, hoogte en plek op de pagina kent het
 * pakket maar half; wat ontbreekt wordt niet verzonnen als meetwaarde van de
 * PDF, maar wel zo ingevuld dat de beeldregels het niet als een lijntje
 * wegzetten. Het is beeld uit het pakket, geen scan.
 */
function extracted(item: Asset, name: string): ExtractedImage {
  const width = item.breedte && item.breedte > 0 ? item.breedte : 100;
  const height = item.hoogte && item.hoogte > 0 ? item.hoogte : 100;
  return {
    id: item.id,
    page: item.bron?.paginas?.[0] ?? 1,
    file: name,
    thumb: name,
    width,
    height,
    placed: { x: 0, y: 0, w: width, h: height },
    areaPct: 10,
    dpi: 72
  };
}

/**
 * De bestanden die bij dit pakket horen: het pad in het archief en de naam die
 * het bestand in de job heeft.
 *
 * De koppeling loopt over het asset-id en niet over het pad, want die twee zijn
 * niet hetzelfde: in de job heet een bitmap `img-p01-01.jpeg` en in het pakket
 * `assets/img-1-01.jpeg`. Het id is wat beide kanten delen, en het overleeft ook
 * een pakket dat als JSON is rondgereisd.
 */
export function packageFiles(pakket: Pakket, images: ExtractedImage[]): Array<{ path: string; source: string }> {
  const byId = new Map(images.map((image) => [image.id, image]));
  const out: Array<{ path: string; source: string }> = [];
  for (const item of pakket.assets ?? []) {
    if (!item.bestand) continue;
    const image = byId.get(item.id);
    // Een asset zonder bekende bitmap draagt de oorspronkelijke bestandsnaam in
    // zijn pad, juist zodat hij ook zonder die lijst terug te vinden is.
    out.push({ path: item.bestand, source: image ? image.file : item.bestand.replace(/^assets\//, '') });
  }
  return out;
}

function asset(image: ExtractedImage): Asset {
  const extension = image.file.split('.').pop()?.toLowerCase() ?? 'jpg';
  return {
    id: image.id,
    soort: 'afbeelding',
    bestand: `assets/${image.id}.${extension}`,
    mimeType: extension === 'png' ? 'image/png' : 'image/jpeg',
    breedte: image.width,
    hoogte: image.height,
    bron: { soort: 'pdf', paginas: [image.page] }
  };
}

/** Een pakket-lokale id uit een bestandsnaam: kleine letters, cijfers, punt, streepje. */
function looseId(file: string): string {
  return (
    file
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .slice(0, 128) || 'beeld'
  );
}

/**
 * Een asset waarvan we alleen het bestand kennen. Het pad houdt de
 * oorspronkelijke naam, zodat wie het pakket wegschrijft het bestand terugvindt
 * zonder een aparte tabel.
 */
function looseAsset(id: string, file: string): Asset {
  const extension = file.split('.').pop()?.toLowerCase() ?? 'jpg';
  return {
    id,
    soort: 'afbeelding',
    bestand: `assets/${file}`,
    mimeType: extension === 'png' ? 'image/png' : 'image/jpeg',
    bron: { soort: 'pdf' }
  };
}

// ─── Blokken ────────────────────────────────────────────────────────────────

type Claim = (file: string | null) => string | undefined;

function blocks(nodes: ContentNode[], claim: Claim): Blok[] {
  return nodes.map((node) => blok(node, claim)).filter((b): b is Blok => b !== null);
}

function blok(node: ContentNode, claim: Claim): Blok | null {
  switch (node.type) {
    case 'paragraph':
      return { soort: 'alinea', inhoud: tekst(node.content, node.styles) };

    case 'subheading':
      // Vrhl Blad rendert in de body een kopniveau, en dat is 3.
      return { soort: 'kop', niveau: 3, inhoud: node.content };

    // Een streamer is in dit formaat een quote. De zeven bloksoorten kennen geen
    // aparte streamer, en het schema staat geen eigen velden toe, dus er is geen
    // plek om het onderscheid te bewaren.
    case 'quote':
    case 'streamer':
      return { soort: 'quote', inhoud: bare(node.content) };

    case 'list':
      if (!node.items?.length) return null;
      return {
        soort: 'lijst',
        stijl: node.ordered ? 'nummering' : 'opsomming',
        items: node.items.map((item) => ({ inhoud: tekst(item.content, item.styles) }))
      };

    case 'image': {
      const id = claim(node.file);
      if (!id) return null; // een plaatje zonder bitmap is geen verwijzing waard
      const out: Extract<Blok, { soort: 'afbeelding' }> = {
        soort: 'afbeelding',
        asset: id,
        grootte: grootte(node.size)
      };
      // Het onderschrift is wat er gedrukt staat; alt verzinnen we niet.
      const onderschrift = [node.caption, node.credit].filter(Boolean).join(' · ');
      if (onderschrift) out.onderschrift = onderschrift;
      if (node.caption) out.alt = node.caption;
      return out;
    }

    case 'insert': {
      // Een tekstkader heeft geen eigen titelveld; zijn kop is een blok erin, en
      // dat is het in het artikelobject ook.
      const inner: BlokZonderKader[] = [];
      for (const child of node.content) {
        const made = blok(child, claim);
        if (!made) continue;
        // Kaders kunnen niet genest worden. De parser maakt ze niet, maar een
        // kader dat er toch in zit wordt uitgepakt in plaats van weggegooid.
        if (made.soort === 'tekstkader') inner.push(...made.inhoud);
        else inner.push(made);
      }
      if (!inner.length) return null;

      const out: Extract<Blok, { soort: 'tekstkader' }> = { soort: 'tekstkader', inhoud: inner };
      if (node.background) out.achtergrondKleur = node.background;
      if (node.ink) out.tekstKleur = node.ink;
      return out;
    }
  }
}

const GROOTTES: Record<ImageSize, Grootte> = {
  small: 'klein',
  normal: 'normaal',
  large: 'groot',
  xlarge: 'extraGroot'
};

/** Oudere jobs hebben nog geen formaat op een afbeelding; dan geldt de standaard. */
function grootte(size: ImageSize | undefined): Grootte {
  return (size && GROOTTES[size]) || 'normaal';
}

// ─── Tekst ──────────────────────────────────────────────────────────────────

const STIJLEN: Record<InlineStyle, CanonicalStijl> = {
  bold: 'vet',
  italic: 'cursief',
  underline: 'onderstreept'
};

/**
 * Opmaak wordt per stuk tekst gezet, niet als markering met tekenposities. Het
 * verven zelf gebeurt met dezelfde `segments` die de preview en de MDX gebruiken,
 * zodat alle drie hetzelfde resultaat geven.
 */
function tekst(content: string, spans: StyleSpan[]): Tekst {
  const parts: TekstDeel[] = [];

  for (const segment of segments(content, spans ?? [])) {
    const stijlen = segment.style.map((style) => STIJLEN[style]).filter(Boolean);
    // Een gedrukt adres is een patroon, geen oordeel: linkify vindt het en de
    // zichtbare tekst blijft staan zoals de pagina hem drukt.
    for (const piece of linkify(segment.text)) {
      if (!piece.text) continue;
      const deel: TekstDeel = { tekst: piece.text };
      if (stijlen.length) deel.stijlen = stijlen;
      if (piece.href) deel.link = piece.href;
      parts.push(deel);
    }
  }

  if (!parts.length) return content;
  // Geen opmaak en geen link: dan is een gewone string wat het formaat vraagt.
  if (parts.length === 1 && !parts[0].stijlen && !parts[0].link) return parts[0].tekst;
  return parts;
}

/** Een titelveld: alleen cursief, geen links, geen vet. */
function titelTekst(content: string, spans: StyleSpan[]): Titel {
  const parts: TitelDeel[] = [];
  for (const segment of segments(content, spans ?? [])) {
    if (!segment.text) continue;
    const deel: TitelDeel = { tekst: segment.text };
    if (segment.style.includes('italic')) deel.stijlen = ['cursief'];
    parts.push(deel);
  }
  if (!parts.length) return content;
  if (parts.length === 1 && !parts[0].stijlen) return parts[0].tekst;
  return parts;
}

function titel(fm: Frontmatter, field: FrontmatterField): Titel | null {
  const value = fm[field];
  if (!value) return null;
  return titelTekst(value, italicsOf(fm, field));
}

/**
 * Wat op schijf staat is ouder dan het type dat het beschrijft. Een job van voor
 * de cursief-herkenning heeft geen `italics`, ook al belooft `Frontmatter` van
 * wel, en dat geldt voor elk veld dat later is bijgekomen. Alles wat hier uit een
 * bewaarde job komt wordt daarom gelezen alsof het er niet hoeft te zijn.
 */
function italicsOf(fm: Frontmatter, field: FrontmatterField): StyleSpan[] {
  return (fm.italics ?? [])
    .filter((entry) => entry.field === field)
    .map((entry) => ({ text: entry.text, style: ['italic' as InlineStyle] }));
}

/** De intro is een eigen opening voor de body, met zijn eigen cursief. */
function intro(fm: Frontmatter): Blok[] | null {
  if (!fm.intro) return null;
  return [{ soort: 'alinea', inhoud: tekst(fm.intro, italicsOf(fm, 'intro')) }];
}

/** Een quote staat in het blad tussen aanhalingstekens; die horen niet in de tekst. */
function bare(text: string): string {
  return text.replace(/^[\s"'“”„«»‘’]+/, '').replace(/[\s"'“”„«»‘’]+$/, '');
}

// ─── Credits, datum, herkomst ───────────────────────────────────────────────

function credits(fm: Frontmatter): Credits | null {
  const out: Credits = {};
  if (fm.authors?.length) out.auteurs = [...fm.authors];
  if (fm.photographers?.length) out.fotografen = [...fm.photographers];
  if (fm.illustrators?.length) out.illustratoren = [...fm.illustrators];
  return Object.keys(out).length ? out : null;
}

const MAANDEN = [
  'januari',
  'februari',
  'maart',
  'april',
  'mei',
  'juni',
  'juli',
  'augustus',
  'september',
  'oktober',
  'november',
  'december'
];

/**
 * De datum staat in de frontmatter zoals hij gedrukt is. Het formaat kent
 * instelbare precisie, dus wat er niet staat wordt niet verzonnen: een blad dat
 * alleen "september 2026" drukt levert `maandJaar` op en geen gegokte dag.
 */
export function datum(printed: string | null): Datum | null {
  if (!printed) return null;
  const text = printed.trim().toLowerCase();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return printed.trim();

  const maandVan = (naam: string): number => MAANDEN.findIndex((m) => m.startsWith(naam.slice(0, 3))) + 1;

  const vol = /^(\d{1,2})\s+([a-zé]+)\s+(\d{4})$/.exec(text);
  if (vol) {
    const maand = maandVan(vol[2]);
    if (maand) return { precisie: 'dagMaandJaar', dag: Number(vol[1]), maand, jaar: Number(vol[3]) };
  }

  const maandJaar = /^([a-zé]+)\s+(\d{4})$/.exec(text);
  if (maandJaar) {
    const maand = maandVan(maandJaar[1]);
    if (maand) return { precisie: 'maandJaar', maand, jaar: Number(maandJaar[2]) };
  }

  const alleenMaand = /^([a-zé]+)$/.exec(text);
  if (alleenMaand) {
    const maand = maandVan(alleenMaand[1]);
    if (maand) return { precisie: 'maand', maand };
  }

  // Onleesbaar is geen reden om iets te verzinnen; de datum blijft dan weg.
  return null;
}

/**
 * De datum terug in Nederlandse weergave, voor consumenten die een regel tekst
 * willen in plaats van een object.
 *
 * De maandnaam krijgt een kleine letter als er een dag voor staat en een
 * hoofdletter als hij vooraan komt: "9 september 2026", maar "September 2026".
 */
export function datumWeergave(value: Datum | undefined | null): string | null {
  if (!value) return null;

  if (typeof value === 'string') {
    const [jaar, maand, dag] = value.split('-').map(Number);
    const naam = MAANDEN[maand - 1];
    return naam ? `${dag} ${naam} ${jaar}` : value;
  }

  const naam = MAANDEN[value.maand - 1];
  if (!naam) return null;
  const hoofdletter = `${naam[0].toUpperCase()}${naam.slice(1)}`;

  if (value.precisie === 'dagMaandJaar' && value.dag && value.jaar) {
    return `${value.dag} ${naam} ${value.jaar}`;
  }
  if (value.precisie === 'maandJaar' && value.jaar) return `${hoofdletter} ${value.jaar}`;
  return hoofdletter;
}

/**
 * Waar dit vandaan komt en hoe zeker we het weten.
 *
 * De betrouwbaarheid is de laagste woorddekking van alle pagina's, niet het
 * gemiddelde: een artikel is zo goed als zijn slechtste pagina, en een pagina
 * die is weggezakt hoort niet weggemiddeld te worden door vijf die klopten.
 */
function bron(filename: string, paginas: number[], pages: PageResult[]): Bron {
  const out: Bron = { soort: 'pdf', tool: TOOL };
  if (filename) out.bestand = filename;
  if (paginas.length) out.paginas = [...paginas];
  if (!pages.length) return out;

  const scores = pages.map((page) => page.check?.score ?? 0).filter((n) => Number.isFinite(n));
  if (scores.length) out.betrouwbaarheid = Math.round(Math.min(...scores) * 100) / 100;

  const controleren: string[] = [];
  const zwak = pages.filter((page) => (page.check?.score ?? 1) < REVIEW_BELOW);
  if (zwak.length) controleren.push('body');
  if (pages.some((page) => (page.check?.unknown?.length ?? 0) > 0)) controleren.push('woorden');
  if (controleren.length) out.controleren = controleren;

  const opmerkingen: string[] = [];
  for (const page of pages) {
    for (const warning of page.warnings ?? []) opmerkingen.push(`p${page.page}: ${warning}`);
  }
  if (opmerkingen.length) out.opmerkingen = opmerkingen.join(' | ').slice(0, 2000);

  return out;
}

/**
 * Een stabiele id uit het bronsysteem. Dezelfde PDF met hetzelfde paginabereik
 * moet bij een tweede run dezelfde id opleveren, anders maakt de importer een
 * duplicaat in plaats van bij te werken. Dus afgeleid van de naam en de
 * pagina's, nooit van een teller of een tijdstip.
 */
function externeId(filename: string, paginas: number[]): string {
  const range = paginas.length ? `#p${paginas[0]}-${paginas[paginas.length - 1]}` : '';
  return `pdf:${fingerprint(filename)}${range}`;
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Dezelfde slugify als canonical/validate.mjs, zodat elke consument op dezelfde
 * slug uitkomt. Wijk hier niet van af zonder daar ook te kijken.
 */
export function slug(input: string): string {
  return String(input)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/&/g, ' en ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96)
    .replace(/-+$/g, '');
}
