import { createHash } from 'node:crypto';
import { slug as slugify, type Artikel, type Blok, type BlokZonderKader, type LijstItem, type Pakket, type Tekst, type Titel } from '../canonical';

/**
 * Van het canonieke pakket naar de vorm waarin Sanity content opslaat.
 *
 * Dit is de enige plek die beide kanten kent, precies zoals canonical/README.md
 * het bedoelt. De specificatie staat in canonical/sanity/mapping.json en de
 * doelvorm in canonical/sanity/opslagvorm.json; wijk hier niet van af zonder
 * daar te kijken.
 *
 * Zonder I/O met opzet: alles wat hier gebeurt is rekenen. Het uploaden en
 * opzoeken staat in push.ts, zodat deze omzetting te controleren is zonder ook
 * maar iets naar Sanity te sturen.
 */

export interface SanityDoc {
  _id: string;
  _type: string;
  [field: string]: unknown;
}

/** Wat er al in Sanity staat of net is aangemaakt, per naam of pakket-id. */
export interface Resolved {
  /** pakket-asset-id -> Sanity asset-_id (`image-<hash>-<b>x<h>-<ext>`). */
  assets: Map<string, string>;
  /** `auteur:marijke de vries` -> document-_id. */
  credits: Map<string, string>;
  /** `taal` -> document-_id. */
  tags: Map<string, string>;
}

const ROLES = {
  auteurs: 'auteur',
  fotografen: 'fotograaf',
  illustratoren: 'illustrator'
} as const;

const MATEN: Record<string, string> = {
  klein: 'small',
  normaal: 'normal',
  groot: 'large',
  extraGroot: 'xlarge'
};

const DECORATORS: Record<string, string> = {
  vet: 'strong',
  cursief: 'em',
  onderstreept: 'underline',
  klein: 'small'
};

/**
 * Het document-id, afgeleid uit de externeId zodat een tweede run hetzelfde
 * document bijwerkt in plaats van een duplicaat te maken. Zie `identiteit` in
 * mapping.json.
 */
export function documentId(type: string, externeId: string | undefined, fallback: string): string {
  if (externeId) return `${type}-${createHash('sha1').update(externeId).digest('hex').slice(0, 24)}`;
  return `${type}-${fallback}`;
}

/** Een concept heeft hetzelfde id met `drafts.` ervoor. */
export function draftId(id: string): string {
  return `drafts.${id}`;
}

/** De sleutel waarop een naam wordt opgezocht: getrimd en in kleine letters. */
export function creditKey(role: string, naam: string): string {
  return `${role}:${naam.trim().toLowerCase()}`;
}

export function tagKey(naam: string): string {
  return naam.trim().toLowerCase();
}

/**
 * Elk item in een Sanity-array van objecten heeft een uniek `_key` nodig.
 * Deterministisch uit de positie, zodat een herimport dezelfde keys oplevert en
 * de diff in de studio klein blijft.
 */
function keyOf(prefix: string, index: number): string {
  return `${prefix}${index}`;
}

// ─── Tekst ──────────────────────────────────────────────────────────────────

interface Span {
  _type: 'span';
  _key: string;
  text: string;
  marks: string[];
}

interface MarkDef {
  _type: 'link';
  _key: string;
  href: string;
}

interface Block {
  _type: 'block';
  _key: string;
  style: string;
  markDefs: MarkDef[];
  children: Span[];
  listItem?: string;
  level?: number;
}

/** Een titelveld: één block, alleen `em` als mark, geen links. */
function titleInline(value: Titel, key: string): Block[] {
  const parts = typeof value === 'string' ? [{ tekst: value }] : value;
  const children: Span[] = parts
    .filter((deel) => deel.tekst !== '')
    .map((deel, i) => ({
      _type: 'span' as const,
      _key: `${key}s${i}`,
      text: deel.tekst,
      marks: 'stijlen' in deel && deel.stijlen?.length ? ['em'] : []
    }));
  if (!children.length) children.push({ _type: 'span', _key: `${key}s0`, text: '', marks: [] });
  return [{ _type: 'block', _key: key, style: 'normal', markDefs: [], children }];
}

/** De children van een gewoon tekstblok, inclusief links als markDef. */
function spansOf(value: Tekst, key: string): { children: Span[]; markDefs: MarkDef[] } {
  const parts = typeof value === 'string' ? [{ tekst: value }] : value;
  const markDefs: MarkDef[] = [];
  const children: Span[] = [];

  parts.forEach((deel, i) => {
    const marks = ('stijlen' in deel ? (deel.stijlen ?? []) : []).map((s) => DECORATORS[s]).filter(Boolean);
    const href = 'link' in deel ? deel.link : undefined;
    if (href) {
      const linkKey = `${key}l${markDefs.length}`;
      markDefs.push({ _type: 'link', _key: linkKey, href });
      marks.push(linkKey);
    }
    children.push({ _type: 'span', _key: `${key}s${i}`, text: deel.tekst, marks });
  });

  if (!children.length) children.push({ _type: 'span', _key: `${key}s0`, text: '', marks: [] });
  return { children, markDefs };
}

function textBlock(value: Tekst, key: string, style: string): Block {
  const { children, markDefs } = spansOf(value, key);
  return { _type: 'block', _key: key, style, markDefs, children };
}

/**
 * Portable Text kent geen geneste lijstobjecten: elk item wordt een eigen block
 * met `listItem` en een `level` dat de diepte aangeeft. De grens tussen twee
 * opeenvolgende lijsten van dezelfde soort verdwijnt daarmee; dat staat zo in
 * `verliezen` van de mapping.
 */
function listBlocks(items: LijstItem[], style: string, prefix: string, level: number, out: Block[]): void {
  for (const item of items) {
    const key = keyOf(prefix, out.length);
    const block = textBlock(item.inhoud, key, 'normal');
    block.listItem = style;
    block.level = level;
    out.push(block);
    if (item.items?.length) listBlocks(item.items, style, prefix, level + 1, out);
  }
}

// ─── Blokken ────────────────────────────────────────────────────────────────

function imageMember(
  asset: string,
  key: string,
  refs: Resolved,
  extras: { alt?: string; description?: string; grootte?: string }
): Record<string, unknown> | null {
  const ref = refs.assets.get(asset);
  if (!ref) return null;
  const out: Record<string, unknown> = {
    _type: 'image',
    _key: key,
    asset: { _type: 'reference', _ref: ref }
  };
  if (extras.alt) out.alt = extras.alt;
  if (extras.description) out.description = extras.description;
  if (extras.grootte) out.grootte = extras.grootte;
  return out;
}

function bodyMember(blok: Blok, key: string, refs: Resolved, out: unknown[], warnings: string[]): void {
  switch (blok.soort) {
    case 'alinea':
      out.push(textBlock(blok.inhoud, key, 'normal'));
      break;

    case 'kop':
      if (blok.niveau !== undefined && blok.niveau !== 3) {
        warnings.push(`kopniveau ${blok.niveau} is platgeslagen naar h3`);
      }
      out.push(textBlock(blok.inhoud, key, 'h3'));
      break;

    case 'quote':
      out.push(textBlock(blok.inhoud, key, 'blockquote'));
      break;

    case 'lijst': {
      const blocks: Block[] = [];
      listBlocks(blok.items, blok.stijl === 'nummering' ? 'number' : 'bullet', `${key}i`, 1, blocks);
      out.push(...blocks);
      break;
    }

    case 'afbeelding': {
      const member = imageMember(blok.asset, key, refs, {
        alt: blok.alt,
        description: blok.onderschrift,
        grootte: MATEN[blok.grootte ?? 'normaal'] ?? 'normal'
      });
      if (member) out.push(member);
      else warnings.push(`afbeelding '${blok.asset}' is overgeslagen; het asset is niet geupload`);
      break;
    }

    case 'video':
      out.push({
        _type: 'video',
        _key: key,
        url: blok.url,
        ...(blok.onderschrift ? { description: blok.onderschrift } : {}),
        grootte: MATEN[blok.grootte ?? 'normaal'] ?? 'normal'
      });
      break;

    case 'tekstkader': {
      const inner: unknown[] = [];
      blok.inhoud.forEach((child: BlokZonderKader, i) => bodyMember(child, `${key}c${i}`, refs, inner, warnings));
      out.push({
        _type: 'textFrame',
        _key: key,
        ...(blok.achtergrondKleur ? { backgroundColor: color(blok.achtergrondKleur) } : {}),
        ...(blok.tekstKleur ? { textColor: color(blok.tekstKleur) } : {}),
        content: inner
      });
      break;
    }
  }
}

function body(blocks: Blok[] | undefined, prefix: string, refs: Resolved, warnings: string[]): unknown[] | undefined {
  if (!blocks?.length) return undefined;
  const out: unknown[] = [];
  blocks.forEach((blok, i) => bodyMember(blok, keyOf(prefix, i), refs, out, warnings));
  return out.length ? out : undefined;
}

function color(hex: string): Record<string, unknown> {
  return { _type: 'color', hex, alpha: 1 };
}

// ─── Het artikel ────────────────────────────────────────────────────────────

function plain(value: Titel | undefined): string {
  if (!value) return '';
  return typeof value === 'string' ? value : value.map((deel) => deel.tekst).join('');
}

export interface BuildResult {
  documents: SanityDoc[];
  warnings: string[];
}

/**
 * Het pakket als Sanity-documenten, klaar om te muteren.
 *
 * Alles gaat als concept weg zolang `publicatie.klaar` niet `true` is, en deze
 * converter zet dat nooit op `true`: een machinale extractie hoort door een mens
 * gezien te zijn voordat hij live staat.
 */
export function toSanityDocuments(pakket: Pakket, refs: Resolved): BuildResult {
  const warnings: string[] = [];
  const documents: SanityDoc[] = [];

  for (const artikel of pakket.artikelen ?? []) {
    documents.push(artikelDocument(artikel, refs, warnings));
  }

  return { documents, warnings };
}

function artikelDocument(artikel: Artikel, refs: Resolved, warnings: string[]): SanityDoc {
  const titelTekst = plain(artikel.titel);
  const slugValue = artikel.slug ?? slugify(titelTekst);
  const base = documentId('artikel', artikel.externeId, slugValue || 'zonder-titel');
  const klaar = artikel.publicatie?.klaar === true;

  const doc: SanityDoc = {
    _id: klaar ? base : draftId(base),
    _type: 'artikel',
    artikelType: artikel.type,
    titel: titleInline(artikel.titel, 'tit0'),
    slug: { _type: 'slug', current: slugValue },
    klaarVoorPublicatie: klaar
  };

  if (artikel.rubriek) doc.categorie = titleInline(artikel.rubriek, 'cat0');
  if (artikel.ondertitel) doc.ondertitel = titleInline(artikel.ondertitel, 'ond0');

  // Header. Het formaat kent ook een achtergrond, maar deze converter levert die
  // nooit: uit een PDF komt beeld, geen verwijzing naar een gedeelde achtergrond.
  const headerAsset = artikel.header?.asset ? refs.assets.get(artikel.header.asset) : undefined;
  if (headerAsset) {
    doc.headerAfbeelding = {
      _type: 'image',
      asset: { _type: 'reference', _ref: headerAsset },
      ...(artikel.header?.alt ? { alt: artikel.header.alt } : {})
    };
    if (!artikel.header?.alt) {
      warnings.push('de headerafbeelding heeft geen alt-tekst; die staat niet in de PDF en wordt niet verzonnen');
    }
  } else if (artikel.header?.asset) {
    warnings.push('de headerafbeelding is overgeslagen; het asset is niet geupload');
  } else {
    warnings.push('dit artikel heeft geen header; de site heeft beeld of een achtergrond nodig');
  }

  // Credits als references naar documenten die op naam zijn opgezocht of gemaakt.
  for (const [veld, type] of Object.entries(ROLES) as Array<[keyof typeof ROLES, string]>) {
    const namen = artikel.credits?.[veld] ?? [];
    const verwijzingen = namen
      .map((naam, i) => {
        const id = refs.credits.get(creditKey(type, naam));
        if (!id) {
          warnings.push(`${type} '${naam}' kon niet worden opgezocht of aangemaakt`);
          return null;
        }
        return { _type: 'reference', _key: `${type.slice(0, 3)}${i}`, _ref: id };
      })
      .filter(Boolean);
    if (verwijzingen.length) doc[type] = verwijzingen;
  }
  if (artikel.credits?.bovenaan !== undefined) doc.creditsBovenaan = artikel.credits.bovenaan;

  if (artikel.datum) {
    doc.datum =
      typeof artikel.datum === 'string'
        ? datumObject(artikel.datum)
        : { _type: 'artikelDatum', ...artikel.datum };
  }

  const tags = (artikel.tags ?? [])
    .map((naam, i) => {
      const id = refs.tags.get(tagKey(naam));
      if (!id) {
        warnings.push(`tag '${naam}' kon niet worden opgezocht of aangemaakt`);
        return null;
      }
      return { _type: 'reference', _key: `tag${i}`, _ref: id };
    })
    .filter(Boolean);
  if (tags.length) doc.tags = tags;

  const intro = body(artikel.intro, 'int', refs, warnings);
  if (intro) doc.introBody = intro;
  const post = body(artikel.body, 'pb', refs, warnings);
  if (post) doc.postBody = post;

  return doc;
}

/** Een `YYYY-MM-DD` uit het pakket is volledige precisie. */
function datumObject(value: string): Record<string, unknown> {
  const [jaar, maand, dag] = value.split('-').map(Number);
  return { _type: 'artikelDatum', precisie: 'dagMaandJaar', dag, maand, jaar };
}

// ─── Referentiedocumenten ───────────────────────────────────────────────────

/** Een nieuw credit-document, met een id dat bij een tweede run hetzelfde is. */
export function creditDocument(type: string, naam: string): SanityDoc {
  return { _id: `${type}-${slugify(naam) || 'naamloos'}`, _type: type, naam };
}

export function tagDocument(naam: string, slugValue?: string): SanityDoc {
  const current = slugValue ?? slugify(naam);
  return {
    _id: `tag-${current || 'naamloos'}`,
    _type: 'tag',
    tagName: naam,
    slug: { _type: 'slug', current }
  };
}

/**
 * Een asset-verwijzing die er echt uitziet zonder dat er iets is geupload, voor
 * de droogloop. Zo kun je de uitvoer door canonical/sanity/validate.mjs halen
 * zonder je dataset aan te raken.
 */
export function fakeAssetRef(id: string, breedte = 1000, hoogte = 1000, extensie = 'jpg'): string {
  const hash = createHash('sha1').update(id).digest('hex');
  return `image-${hash}-${breedte}x${hoogte}-${extensie}`;
}
