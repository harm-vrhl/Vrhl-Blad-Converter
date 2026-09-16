import { datumWeergave, type Asset, type Blok, type LijstItem, type Pakket } from './canonical';
import { altTekst, bijschrift, creditRegel, delen, eersteArtikel, kaal, veiligeLink, type Deel } from './pakketlezen';
import { zip, type ZipEntry } from './zip';

/**
 * Het artikel als Word-document (.docx), geschreven vanuit het pakket.
 *
 * Een consument zoals MDX en HTML. Zonder dependency: een .docx is een ZIP met
 * een handvol XML-bestanden, en de ZIP-schrijver staat er al (`lib/zip.ts`, zonder
 * compressie, wat Word gewoon leest). Een bibliotheek als `docx` zou honderden
 * kilobytes aan de browser toevoegen voor wat hier een paar honderd regels is.
 *
 * Wat Word ervan maakt:
 * - rubriek, titel, ondertitel en creditregel met eigen stijlen bovenaan; de titel
 *   en koppen zijn Words eigen `Title` en `heading 2/3`, zodat het navigatievenster
 *   en een inhoudsopgave ze vinden;
 * - een kader als tabel van één cel met de gedrukte tint. Dat is de enige vorm die
 *   Word, Google Docs en LibreOffice alle drie hetzelfde tonen;
 * - lijsten als echte Word-nummering, geen getypte bolletjes, en een genummerde
 *   lijst begint bij elke lijst opnieuw bij 1;
 * - beeld in de tekst, zo breed als het gedrukt stond, in verhouding.
 *
 * Wat de volgorde van elementen in de XML bepaalt, is het schema, niet de smaak:
 * Word noemt een document met `<w:u>` vóór `<w:b>` onleesbaar. Houd die volgorde
 * aan als je iets toevoegt.
 */

export interface DocxBeeld {
  data: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg';
}

export type DocxBeeldBron = (asset: Asset) => DocxBeeld | null;

// ─── Maten ───────────────────────────────────────────────────────────────────

/** A4 staand, marges van 2,54 cm. In twips: 1440 per inch. */
const PAGINA = { breedte: 11906, hoogte: 16838, marge: 1440 };
const TEKSTBREEDTE = PAGINA.breedte - 2 * PAGINA.marge;
const TEKSTHOOGTE = PAGINA.hoogte - 2 * PAGINA.marge;
const EMU_PER_TWIP = 635;
/** Binnenmarge van een kader, links en rechts. */
const KADERMARGE = 284;

/** Hoeveel van de tekstbreedte een beeld krijgt, naar hoe breed het gedrukt stond. */
const BREEDTE: Record<string, number> = { klein: 0.5, normaal: 0.75, groot: 1, extraGroot: 1 };

const KADER_TINT = 'EBE8E4';
const ZACHT = '6B6760';

// ─── Namespaces ─────────────────────────────────────────────────────────────

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types'
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ─── Buiten ──────────────────────────────────────────────────────────────────

/** Het .docx-bestand. `nu` alleen om een herhaalbare uitvoer vast te zetten. */
export function toDocx(pakket: Pakket, bron: DocxBeeldBron, nu = new Date()): Uint8Array {
  return zip(docxDelen(pakket, bron, nu), nu);
}

/** De losse delen van het document, zodat `npm run golden` de XML kan narekenen. */
export function docxDelen(pakket: Pakket, bron: DocxBeeldBron, nu = new Date()): ZipEntry[] {
  const schrijver = new Schrijver(bron);
  const document = schrijver.document(pakket);
  const tekst = (pad: string, inhoud: string): ZipEntry => ({ path: pad, data: new TextEncoder().encode(inhoud) });

  return [
    tekst('[Content_Types].xml', contentTypes(schrijver.media)),
    tekst('_rels/.rels', RELS),
    tekst('docProps/core.xml', core(pakket, nu)),
    tekst('word/document.xml', document),
    tekst('word/styles.xml', STYLES),
    tekst('word/numbering.xml', schrijver.numbering()),
    tekst('word/_rels/document.xml.rels', schrijver.relaties()),
    ...schrijver.media.map((m) => ({ path: `word/${m.pad}`, data: m.data }))
  ];
}

// ─── Het document ───────────────────────────────────────────────────────────

interface Media {
  id: string;
  pad: string;
  data: Uint8Array;
  mimeType: string;
}

class Schrijver {
  readonly media: Media[] = [];
  private readonly links: Array<{ id: string; doel: string }> = [];
  private readonly beeldVan = new Map<string, string>();
  private readonly genummerd: number[] = [];
  private tekeningen = 0;
  private assets = new Map<string, Asset>();

  constructor(private readonly bron: DocxBeeldBron) {}

  document(pakket: Pakket): string {
    const gelezen = eersteArtikel(pakket);
    const inhoud: string[] = [];
    if (gelezen) {
      const { artikel } = gelezen;
      this.assets = gelezen.assets;

      if (artikel.rubriek) inhoud.push(this.alinea(delen(artikel.rubriek), { stijl: 'Rubriek' }));
      inhoud.push(this.alinea(delen(artikel.titel), { stijl: 'Title' }));
      if (artikel.ondertitel) inhoud.push(this.alinea(delen(artikel.ondertitel), { stijl: 'Subtitle' }));
      const meta = [creditRegel(artikel), datumWeergave(artikel.datum)].filter(Boolean).join(' · ');
      if (meta) inhoud.push(this.alinea([{ tekst: meta, stijlen: [] }], { stijl: 'Meta' }));

      const header = artikel.header?.asset ? this.assets.get(artikel.header.asset) : undefined;
      if (header) {
        const beeld = this.beeld(header, artikel.header?.alt ?? header.alt ?? '', 1, TEKSTBREEDTE);
        if (beeld) inhoud.push(`<w:p>${beeld}</w:p>`);
      }

      for (const blok of artikel.intro ?? []) inhoud.push(this.blok(blok, TEKSTBREEDTE, true));
      for (const blok of artikel.body ?? []) inhoud.push(this.blok(blok, TEKSTBREEDTE, false));
    }

    const sectie =
      `<w:sectPr><w:pgSz w:w="${PAGINA.breedte}" w:h="${PAGINA.hoogte}"/>` +
      `<w:pgMar w:top="${PAGINA.marge}" w:right="${PAGINA.marge}" w:bottom="${PAGINA.marge}" w:left="${PAGINA.marge}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;

    return (
      XML +
      `<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}">` +
      `<w:body>${inhoud.filter(Boolean).join('')}${sectie}</w:body></w:document>`
    );
  }

  private blok(blok: Blok, breedte: number, intro: boolean, kleur?: string): string {
    switch (blok.soort) {
      case 'alinea':
        return this.alinea(delen(blok.inhoud), { stijl: intro ? 'Intro' : undefined, kleur });
      case 'kop':
        // Een kop in een kader is een niveau lager dan een kop in de tekst.
        return this.alinea(delen(blok.inhoud), { stijl: breedte < TEKSTBREEDTE ? 'Heading3' : 'Heading2', kleur });
      case 'quote':
        return this.alinea(delen(blok.inhoud), { stijl: 'Quote', kleur });
      case 'lijst':
        return this.lijst(blok.items, blok.stijl === 'nummering', kleur);
      case 'afbeelding': {
        const item = this.assets.get(blok.asset);
        if (!item) return '';
        const beeld = this.beeld(item, altTekst(blok, item), BREEDTE[blok.grootte ?? 'normaal'] ?? 0.75, breedte);
        if (!beeld) return '';
        const onder = bijschrift(blok, item);
        return (
          `<w:p><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr>${beeld}</w:p>` +
          (onder ? this.alinea([{ tekst: onder, stijlen: [] }], { stijl: 'Caption', kleur }) : '')
        );
      }
      case 'video':
        // Word kan geen video tonen; het adres wel.
        return this.alinea([{ tekst: blok.onderschrift ?? blok.url, stijlen: [], link: veiligeLink(blok.url) }], { kleur });
      case 'tekstkader':
        return this.kader(blok);
    }
  }

  private kader(blok: Extract<Blok, { soort: 'tekstkader' }>): string {
    const tint = hex(blok.achtergrondKleur) ?? KADER_TINT;
    const kleur = hex(blok.tekstKleur);
    const binnen = TEKSTBREEDTE - 2 * KADERMARGE;
    const inhoud = blok.inhoud.map((kind) => this.blok(kind, binnen, false, kleur)).filter(Boolean);
    // Een cel moet met een alinea eindigen, ook als het kader leeg of alleen beeld is.
    if (!inhoud.length || !inhoud[inhoud.length - 1].endsWith('</w:p>')) inhoud.push('<w:p/>');
    const geen = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((kant) => `<w:${kant} w:val="nil"/>`).join('');
    const marges = `<w:top w:w="200" w:type="dxa"/><w:left w:w="${KADERMARGE}" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="${KADERMARGE}" w:type="dxa"/>`;
    return (
      '<w:tbl><w:tblPr>' +
      `<w:tblW w:w="${TEKSTBREEDTE}" w:type="dxa"/>` +
      `<w:tblBorders>${geen}</w:tblBorders>` +
      '<w:tblLayout w:type="fixed"/>' +
      `<w:tblCellMar>${marges}</w:tblCellMar>` +
      `</w:tblPr><w:tblGrid><w:gridCol w:w="${TEKSTBREEDTE}"/></w:tblGrid>` +
      // De marge ook op de cel: niet elke lezer (Quick Look, Google Docs) neemt die van de tabel over.
      `<w:tr><w:tc><w:tcPr><w:tcW w:w="${TEKSTBREEDTE}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${tint}"/><w:tcMar>${marges}</w:tcMar></w:tcPr>` +
      `${inhoud.join('')}</w:tc></w:tr></w:tbl>` +
      // Twee tabellen direct na elkaar smelt Word samen tot één; deze alinea houdt ze los.
      '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
    );
  }

  private lijst(items: LijstItem[], genummerd: boolean, kleur: string | undefined): string {
    // Elke genummerde lijst een eigen nummering, anders telt de tweede lijst door.
    const numId = genummerd ? this.nieuweNummering() : 1;
    const schrijf = (item: LijstItem, niveau: number): string =>
      this.alinea(delen(item.inhoud), {
        stijl: 'ListParagraph',
        kleur,
        nummer: { numId, niveau: Math.min(niveau, 8) }
      }) + (item.items ?? []).map((kind) => schrijf(kind, niveau + 1)).join('');
    return items.map((item) => schrijf(item, 0)).join('');
  }

  private nieuweNummering(): number {
    const numId = 2 + this.genummerd.length;
    this.genummerd.push(numId);
    return numId;
  }

  private alinea(
    stukken: Deel[],
    { stijl, kleur, nummer }: { stijl?: string; kleur?: string; nummer?: { numId: number; niveau: number } } = {}
  ): string {
    const pPr = [
      stijl ? `<w:pStyle w:val="${stijl}"/>` : '',
      nummer ? `<w:numPr><w:ilvl w:val="${nummer.niveau}"/><w:numId w:val="${nummer.numId}"/></w:numPr>` : ''
    ].join('');
    const runs = stukken.map((stuk) => this.run(stuk, kleur)).join('');
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
  }

  private run({ tekst, stijlen, link }: Deel, kleur: string | undefined): string {
    // De volgorde binnen rPr ligt vast in het schema: rStyle, b, i, color, sz, u.
    const rPr = [
      link ? '<w:rStyle w:val="Hyperlink"/>' : '',
      stijlen.includes('vet') ? '<w:b/>' : '',
      stijlen.includes('cursief') ? '<w:i/>' : '',
      kleur && !link ? `<w:color w:val="${kleur}"/>` : '',
      stijlen.includes('klein') ? '<w:sz w:val="18"/>' : '',
      stijlen.includes('onderstreept') && !link ? '<w:u w:val="single"/>' : ''
    ].join('');
    const r = `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}${tekstInhoud(tekst)}</w:r>`;
    if (!link) return r;
    const id = `rIdLink${this.links.length + 1}`;
    this.links.push({ id, doel: link });
    return `<w:hyperlink r:id="${id}" w:history="1">${r}</w:hyperlink>`;
  }

  /** Een beeld in de regel, `deel` van de beschikbare breedte, in zijn eigen verhouding. */
  private beeld(item: Asset, alt: string, deel: number, beschikbaar: number): string {
    const rId = this.embed(item);
    if (!rId) return '';
    const verhouding = item.breedte && item.hoogte ? item.hoogte / item.breedte : 0.75;
    let breedte = Math.round(beschikbaar * deel);
    let hoogte = Math.round(breedte * verhouding);
    // Een staande foto mag niet langer worden dan de pagina.
    if (hoogte > TEKSTHOOGTE * 0.8) {
      hoogte = Math.round(TEKSTHOOGTE * 0.8);
      breedte = Math.round(hoogte / verhouding);
    }
    const cx = breedte * EMU_PER_TWIP;
    const cy = hoogte * EMU_PER_TWIP;
    const n = ++this.tekeningen;
    const naam = attr(item.id);
    return (
      '<w:r><w:drawing>' +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${cx}" cy="${cy}"/>` +
      '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
      `<wp:docPr id="${n}" name="Afbeelding ${n}" descr="${attr(alt)}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="${NS.pic}">` +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${naam}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
    );
  }

  /** Het beeld één keer in het document, ook als het twee keer gebruikt wordt. */
  private embed(item: Asset): string | null {
    const bestaand = this.beeldVan.get(item.id);
    if (bestaand) return bestaand;
    const beeld = this.bron(item);
    if (!beeld) return null;
    const rId = `rIdBeeld${this.media.length + 1}`;
    const extensie = beeld.mimeType === 'image/png' ? 'png' : 'jpeg';
    const veilig = item.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.media.push({ id: rId, pad: `media/${veilig}.${extensie}`, data: beeld.data, mimeType: beeld.mimeType });
    this.beeldVan.set(item.id, rId);
    return rId;
  }

  relaties(): string {
    const regels = [
      `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`,
      `<Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>`,
      ...this.media.map((m) => `<Relationship Id="${m.id}" Type="${REL}/image" Target="${m.pad}"/>`),
      ...this.links.map(
        (l) => `<Relationship Id="${l.id}" Type="${REL}/hyperlink" Target="${attr(l.doel)}" TargetMode="External"/>`
      )
    ];
    return `${XML}<Relationships xmlns="${NS.rel}">${regels.join('')}</Relationships>`;
  }

  numbering(): string {
    const niveaus = (genummerd: boolean) =>
      Array.from({ length: 9 }, (_, niveau) => {
        const inspring = 360 + niveau * 360;
        const formaat = genummerd
          ? `<w:numFmt w:val="decimal"/><w:lvlText w:val="%${niveau + 1}."/>`
          : `<w:numFmt w:val="bullet"/><w:lvlText w:val="${niveau % 2 ? '◦' : '•'}"/>`;
        return (
          `<w:lvl w:ilvl="${niveau}"><w:start w:val="1"/>${formaat}<w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="${inspring}" w:hanging="360"/></w:pPr></w:lvl>`
        );
      }).join('');
    const nums = [
      '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
      ...this.genummerd.map(
        (numId) =>
          `<w:num w:numId="${numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`
      )
    ];
    return (
      `${XML}<w:numbering xmlns:w="${NS.w}">` +
      `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${niveaus(false)}</w:abstractNum>` +
      `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${niveaus(true)}</w:abstractNum>` +
      `${nums.join('')}</w:numbering>`
    );
  }
}

// ─── Tekst naar XML ─────────────────────────────────────────────────────────

/** Tekst in een run: een regelafbreking wordt `<w:br/>`, een tab `<w:tab/>`. */
function tekstInhoud(tekst: string): string {
  return schoon(tekst)
    .split(/(\n|\t)/)
    .map((stuk) => {
      if (stuk === '\n') return '<w:br/>';
      if (stuk === '\t') return '<w:tab/>';
      return stuk ? `<w:t xml:space="preserve">${escape(stuk)}</w:t>` : '';
    })
    .join('');
}

/** Tekens die XML niet toestaat. Eén ervan en Word noemt het hele document onleesbaar. */
function schoon(tekst: string): string {
  // eslint-disable-next-line no-control-regex
  return tekst.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

function escape(tekst: string): string {
  return schoon(tekst).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(tekst: string): string {
  return escape(tekst).replace(/"/g, '&quot;').replace(/\n/g, ' ');
}

/** "#333" of "#333333" naar "333333"; al het andere wordt niets. */
function hex(kleur: string | undefined): string | undefined {
  const waarde = kleur?.trim().replace(/^#/, '');
  if (!waarde) return undefined;
  if (/^[0-9a-f]{3}$/i.test(waarde)) return waarde.split('').map((c) => c + c).join('').toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(waarde)) return waarde.toUpperCase();
  return undefined;
}

// ─── Vaste delen ────────────────────────────────────────────────────────────

function contentTypes(media: Media[]): string {
  const extensies = new Set(media.map((m) => m.pad.split('.').pop()));
  return (
    `${XML}<Types xmlns="${NS.ct}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (extensies.has('png') ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    (extensies.has('jpeg') ? '<Default Extension="jpeg" ContentType="image/jpeg"/>' : '') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>'
  );
}

const RELS =
  `${XML}<Relationships xmlns="${NS.rel}">` +
  `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '</Relationships>';

function core(pakket: Pakket, nu: Date): string {
  const artikel = pakket.artikelen?.[0];
  const auteurs = artikel?.credits?.auteurs?.join(', ');
  const moment = `${nu.toISOString().slice(0, 19)}Z`;
  return (
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escape(kaal(artikel?.titel) || 'Artikel')}</dc:title>` +
    (auteurs ? `<dc:creator>${escape(auteurs)}</dc:creator>` : '') +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${moment}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${moment}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

/**
 * De stijlen. Title, Subtitle, heading 2/3, Quote, caption, List Paragraph en
 * Hyperlink zijn Words eigen namen, zodat Word ze herkent en vertaalt; Rubriek,
 * Meta en Intro zijn van het blad.
 */
const STYLES =
  `${XML}<w:styles xmlns:w="${NS.w}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:eastAsia="Georgia" w:cs="Georgia"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="nl-NL"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  stijl('Rubriek', 'Rubriek', '<w:spacing w:after="80"/>', `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:caps/><w:color w:val="${ZACHT}"/><w:spacing w:val="20"/><w:sz w:val="17"/><w:szCs w:val="17"/>`) +
  stijl('Title', 'Title', '<w:keepNext/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/>', '<w:b/><w:sz w:val="52"/><w:szCs w:val="52"/>') +
  stijl('Subtitle', 'Subtitle', '<w:spacing w:after="160"/>', `<w:color w:val="${ZACHT}"/><w:sz w:val="28"/><w:szCs w:val="28"/>`) +
  stijl('Meta', 'Meta', '<w:spacing w:after="360"/>', `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:color w:val="${ZACHT}"/><w:sz w:val="18"/><w:szCs w:val="18"/>`) +
  stijl('Intro', 'Intro', '<w:spacing w:after="200"/>', '<w:b/><w:sz w:val="24"/><w:szCs w:val="24"/>') +
  stijl('Heading2', 'heading 2', '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="28"/><w:szCs w:val="28"/>') +
  stijl('Heading3', 'heading 3', '<w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/>', '<w:b/><w:sz w:val="24"/><w:szCs w:val="24"/>') +
  stijl('Quote', 'Quote', '<w:spacing w:before="240" w:after="240"/><w:ind w:left="567"/>', '<w:i/><w:sz w:val="28"/><w:szCs w:val="28"/>') +
  stijl('Caption', 'caption', '<w:spacing w:after="240"/>', `<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:color w:val="${ZACHT}"/><w:sz w:val="17"/><w:szCs w:val="17"/>`) +
  stijl('ListParagraph', 'List Paragraph', '<w:spacing w:after="60"/><w:contextualSpacing/>', '') +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F4E79"/><w:u w:val="single"/></w:rPr></w:style>' +
  '</w:styles>';

function stijl(id: string, naam: string, pPr: string, rPr: string): string {
  return (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${naam}"/><w:basedOn w:val="Normal"/>` +
    `<w:next w:val="Normal"/><w:qFormat/>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}</w:style>`
  );
}
