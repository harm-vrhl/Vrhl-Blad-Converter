import { datumWeergave, type Artikel, type Asset, type Blok, type LijstItem, type Pakket, type Tekst, type Titel } from './canonical';
import { STYLE_ORDER } from './spans';
import type { InlineStyle } from './types';

/**
 * Vrhl-Blad MDX, geschreven vanuit het canonieke pakket.
 *
 * Het pakket is de bron en dit is een van zijn consumenten, net zoals een
 * Word- of Sanity-adapter dat zou zijn. Dat is het hele punt van een neutraal
 * formaat: deze schrijver kent `ArticleDocument` niet meer, alleen het pakket.
 *
 * Het formaat zelf is ongewijzigd, vastgelegd door vrhl-blad.example.mdx:
 *
 *   - YAML houdt de documentinstellingen; kicker, title en subtitle houden
 *     cursief en verder niets. De intro is GEEN YAML-sleutel, die opent de body.
 *   - Koppen in de body zijn altijd ###. Geen # en geen ##.
 *   - Een quote is een blockquote in krulquotes.
 *   - Beeld is <Image />, nooit ![](); een kader is een <Frame> met een tint.
 *
 * Twee dingen komen nu uit het pakket in plaats van uit het artikelobject: het
 * pad van een asset (`assets/<asset-id>.<ext>`, want zo heet het in het pakket)
 * en de datum, die als weergave uit het datumobject wordt herleid.
 */

/** Een kader zonder gedrukte tint krijgt er toch een: het lichte tag van de lezer. */
const FRAME_FALLBACK = '#EBE8E4';
const MAX_SLUG = 80;

/** Het formaat schrijft de maat in het Engels, ook onder een Nederlandse naam. */
const MATEN: Record<string, string> = {
  klein: 'small',
  normaal: 'normal',
  groot: 'large',
  extraGroot: 'xlarge'
};

const STIJLEN: Record<string, InlineStyle> = {
  vet: 'bold',
  cursief: 'italic',
  onderstreept: 'underline'
};

export function toMdx(pakket: Pakket): string {
  const artikel = pakket.artikelen?.[0];
  if (!artikel) return '';
  const assets = new Map((pakket.assets ?? []).map((item) => [item.id, item]));

  const body = [intro(artikel, assets), ...(artikel.body ?? []).map((blok) => block(blok, assets))]
    .filter(Boolean)
    .join('\n\n');
  return `${head(artikel, assets)}\n\n${body}\n`;
}

// ─── YAML ────────────────────────────────────────────────────────────────────

function head(artikel: Artikel, assets: Map<string, Asset>): string {
  const lines = [
    '---',
    `type: ${artikel.type}`,
    key('slug', artikel.slug ?? (plain(artikel.titel) ? slug(plain(artikel.titel)) : null)),
    key('date', datumWeergave(artikel.datum)),
    key('kicker', titel(artikel.rubriek)),
    key('title', titel(artikel.titel)),
    key('subtitle', titel(artikel.ondertitel)),
    ...header(artikel, assets),
    ...names('authors', artikel.credits?.auteurs),
    ...names('photographers', artikel.credits?.fotografen),
    ...names('illustrators', artikel.credits?.illustratoren),
    '---'
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

function header(artikel: Artikel, assets: Map<string, Asset>): Array<string | null> {
  const id = artikel.header?.asset;
  if (!id) return [];
  const item = assets.get(id);
  if (!item?.bestand) return [];
  const alt = artikel.header?.alt ?? item.alt ?? null;
  return ['header:', `  src: ${scalar(item.bestand)}`, alt ? `  alt: ${scalar(oneLine(alt))}` : null];
}

function key(name: string, value: string | null): string | null {
  return value ? `${name}: ${scalar(oneLine(value))}` : null;
}

/** Eén naam per regel, de blokvorm die de referentie voor elke creditlijst gebruikt. */
function names(name: string, values: string[] | undefined): Array<string | null> {
  if (!values?.length) return [];
  return [`${name}:`, ...values.map((value) => `  - ${scalar(oneLine(value))}`)];
}

/**
 * Een YAML-scalar. Kaal waar dat eenduidig is, JSON-quoted zodra de waarde een
 * :, #, quote of asterisk draagt, of als iets anders dan tekst gelezen kan worden.
 */
function scalar(value: string): string {
  const risky =
    /[:#"'*]/.test(value) ||
    value !== value.trim() ||
    value === '' ||
    /^[-?[\]{}&!|>%@`,]/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[\d.+-]+$/.test(value);
  return risky ? JSON.stringify(value) : value;
}

function slug(title: string): string {
  return strip(title)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
}

// ─── Body ────────────────────────────────────────────────────────────────────

function intro(artikel: Artikel, assets: Map<string, Asset>): string | null {
  const blocks = artikel.intro ?? [];
  if (!blocks.length) return null;
  const text = blocks.map((blok) => block(blok, assets)).filter(Boolean).join('\n\n');
  return text ? `<Intro>\n${text}\n</Intro>` : null;
}

function block(blok: Blok, assets: Map<string, Asset>): string {
  switch (blok.soort) {
    case 'alinea':
      return guard(inline(blok.inhoud));
    case 'kop':
      // Alleen ###, en het vet dat InDesign om een kop zet gaat eraf.
      return `### ${strip(plain(blok.inhoud))}`;
    case 'quote':
      return blockquote(plain(blok.inhoud));
    case 'lijst':
      return blok.items.map((item, i) => listItem(item, blok.stijl === 'nummering', i, 0)).join('\n');
    case 'afbeelding':
      return image(blok, assets);
    case 'video':
      // Het formaat van dit blad kent geen video; de converter levert er ook
      // geen, dus hier valt niets te schrijven in plaats van iets te verzinnen.
      return '';
    case 'tekstkader':
      return frame(blok, assets);
  }
}

/**
 * Een alinea die begint zoals markdown een lijst, een kop of een quote begint.
 *
 * Het blad drukt regels als "- Virolog Marc Van Ranst over taal in
 * crisissituaties" gewoon als lopende tekst, en run 1 schrijft ze ook als
 * alinea. Zonder ontsnapping leest die alinea straks terug als een lijst, en dan
 * is er een blok bij gekomen dat de pagina nooit had. Alleen aan het begin van
 * een regel, want alleen daar betekent zo'n teken iets.
 *
 * De asterisk wordt alleen ontsnapt als er een spatie achter staat: "* " is een
 * opsommingsteken, terwijl *cursief* nooit met een spatie opent.
 */
function guard(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s*)([-–•+*>](?=\s)|#{1,6}(?=\s))/, '$1\\$2')
        .replace(/^(\s*)(\d{1,2})([.)](?=\s))/, '$1$2\\$3')
    )
    .join('\n');
}

function blockquote(text: string): string {
  const bare = oneLine(text)
    .replace(/^[\s"'“”„«»‘’]+/, '')
    .replace(/[\s"'“”„«»‘’]+$/, '');
  return `> “${bare}”`;
}

function listItem(item: LijstItem, ordered: boolean, index: number, depth: number): string {
  const pad = '  '.repeat(depth);
  const line = `${pad}${ordered ? `${index + 1}.` : '-'} ${oneLine(inline(item.inhoud))}`;
  if (!item.items?.length) return line;
  const nested = item.items.map((child, i) => listItem(child, ordered, i, depth + 1)).join('\n');
  return `${line}\n${nested}`;
}

function image(blok: Extract<Blok, { soort: 'afbeelding' }>, assets: Map<string, Asset>): string {
  const item = assets.get(blok.asset);
  if (!item?.bestand) return '';
  // Het pakket houdt het bijschrift in `onderschrift` en de alt apart; het
  // formaat hier zet dezelfde regel op allebei, zoals het altijd deed.
  const caption = blok.onderschrift ?? item.onderschrift ?? blok.alt ?? item.alt ?? null;
  const attributes = [
    `src="${attr(item.bestand)}"`,
    caption ? `alt="${attr(caption)}"` : null,
    caption ? `caption="${attr(caption)}"` : null,
    `grootte="${MATEN[blok.grootte ?? 'normaal'] ?? 'normal'}"`
  ].filter((line): line is string => line !== null);

  return `<Image\n${attributes.map((line) => `  ${line}`).join('\n')}\n/>`;
}

function frame(blok: Extract<Blok, { soort: 'tekstkader' }>, assets: Map<string, Asset>): string {
  const attributes = [
    `  achtergrond="${attr(blok.achtergrondKleur ?? FRAME_FALLBACK)}"`,
    blok.tekstKleur ? `  tekst="${attr(blok.tekstKleur)}"` : null
  ].filter((line): line is string => line !== null);

  // De titel van het kader staat in het pakket als de eerste kop erin, dus die
  // rolt er vanzelf als ### uit; hier hoeft niets apart te gebeuren.
  const inner = blok.inhoud.map((child) => block(child, assets)).filter(Boolean).join('\n\n');
  return `<Frame\n${attributes.join('\n')}\n>\n${inner}\n</Frame>`;
}

// ─── Inline ──────────────────────────────────────────────────────────────────

interface Part {
  text: string;
  style: InlineStyle[];
  link?: string;
}

function parts(value: Tekst): Part[] {
  if (typeof value === 'string') return value ? [{ text: value, style: [] }] : [];
  return value.map((deel) => ({
    text: deel.tekst,
    style: (deel.stijlen ?? []).map((s) => STIJLEN[s]).filter(Boolean),
    link: deel.link
  }));
}

function inline(value: Tekst): string {
  return wrap(parts(value));
}

function titel(value: Titel | undefined): string | null {
  if (!value) return null;
  const out = wrap(
    typeof value === 'string'
      ? [{ text: value, style: [] }]
      : value.map((deel) => ({
          text: deel.tekst,
          style: (deel.stijlen ?? []).map(() => 'italic' as InlineStyle)
        }))
  );
  return out || null;
}

/**
 * Een stijl die elk deel van de reeks deelt omsluit de hele reeks één keer, zodat
 * een cursieve zin met een vette naam erin geschreven wordt zoals een mens hem
 * zou schrijven, *… **Jan Jansen** …*, en niet als drie aan elkaar geplakte
 * stukken nadruk.
 */
function wrap(items: Part[]): string {
  if (!items.length) return '';

  const common = STYLE_ORDER.filter((style) => items.every((part) => part.style.includes(style)));
  if (common.length && !items.some((part) => part.link)) {
    const inner = wrap(items.map((part) => ({ ...part, style: part.style.filter((s) => !common.includes(s)) })));
    // Een asterisk tegen een asterisk is dubbelzinnig in markdown; waar dat zou
    // gebeuren wordt de reeks deel voor deel gemarkeerd, wat altijd terugleest.
    if (!inner.startsWith('*') && !inner.endsWith('*')) return mark(inner, common);
  }

  return items.map((part) => mark(link(part), part.style)).join('');
}

/** Het adres staat in het pakket, dus hier valt niets meer te herkennen. */
function link(part: Part): string {
  if (!part.link) return part.text;
  const label = part.text.replace(/[[\]]/g, '\\$&');
  const target = /[()<>\s]/.test(part.link) ? `<${part.link}>` : part.link;
  return `[${label}](${target})`;
}

/**
 * De markeringen die het formaat toestaat, en alleen die. Witruimte blijft
 * buiten de markers, want *woord * is geen cursief in markdown maar een asterisk.
 */
function mark(text: string, style: InlineStyle[]): string {
  if (!style.length) return text;
  const core = text.trim();
  if (!core) return text;

  const at = text.indexOf(core);
  const lead = text.slice(0, at);
  const tail = text.slice(at + core.length);

  let out = core;
  if (style.includes('underline')) out = `<u>${out}</u>`;
  const bold = style.includes('bold');
  const italic = style.includes('italic');
  if (bold && italic) out = `***${out}***`;
  else if (bold) out = `**${out}**`;
  else if (italic) out = `*${out}*`;

  return `${lead}${out}${tail}`;
}

// ─── Tekst ───────────────────────────────────────────────────────────────────

/** De kale tekst van een tekst- of titelveld, zonder enige opmaak. */
function plain(value: Tekst | Titel | undefined): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.map((deel) => deel.tekst).join('');
}

function attr(value: string): string {
  return oneLine(value).replace(/"/g, '&quot;');
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').trim();
}

/** Nadruk die de opmaak om een hele kop of titel zette, er weer af gehaald. */
function strip(text: string): string {
  return oneLine(text).replace(/^\*{1,3}(.+?)\*{1,3}$/, '$1');
}
