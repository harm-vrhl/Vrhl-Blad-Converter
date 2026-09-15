import { normalizeForCompare } from '../util';
import type {
  BoundaryCheck,
  ContentCheck,
  ContentQuestion,
  MagazineMap,
  MagazinePage,
  MapArticle,
  OffsetSegment,
  PageKind,
  PagePiece,
  PageScan,
  TocEntry
} from './types';

/**
 * From what every page said about itself to a list of articles. Rules, not a
 * model: the model already judged each page, and putting those judgements in a
 * row is arithmetic that should come out the same every time.
 */

/** Pages that carry no article, whatever pieces a run thought it saw on them. */
const NOT_EDITORIAL: PageKind[] = ['omslag', 'inhoudsopgave', 'advertentie', 'colofon'];
/** A PDF page this much wider than tall holds two magazine pages. */
const SPREAD_RATIO = 1.15;

export function isSpread(page: { width: number; height: number } | undefined): boolean {
  return Boolean(page && page.width > page.height * SPREAD_RATIO);
}

// ─── Page numbers ────────────────────────────────────────────────────────────

/** The first whole number in a folio: "24-25" is 24, "p. 7" is 7, "iv" is nothing. */
export function folioNumber(folio: string | null | undefined): number | null {
  const match = /\d+/.exec(folio ?? '');
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) && n > 0 && n < 10000 ? n : null;
}

/**
 * How printed numbers relate to PDF pages. Every page that shows a number casts a
 * vote for `printed - pdf`; a run of pages that agree is a segment. A lone page
 * that disagrees with its neighbours is a misread, not a new offset. A second run
 * that agrees with itself is real: an inserted supplement, or numbering that
 * restarts.
 */
export function fitOffsets(
  scans: PageScan[],
  pages: MagazinePage[]
): { segments: OffsetSegment[]; notes: string[] } {
  const notes: string[] = [];
  const byPdf = new Map(pages.map((p) => [p.pdf, p]));
  const spreads = pages.filter((p) => isSpread(p)).length;
  const step: 1 | 2 = spreads > pages.length / 2 ? 2 : 1;

  const votes = scans
    .map((scan) => {
      const label = byPdf.get(scan.pdf)?.label ?? null;
      const n = folioNumber(scan.folio) ?? (label && /^\d+$/.test(label.trim()) ? folioNumber(label) : null);
      return n == null ? null : { pdf: scan.pdf, n, offset: n - scan.pdf * step };
    })
    .filter((v): v is { pdf: number; n: number; offset: number } => v !== null)
    .sort((a, b) => a.pdf - b.pdf);

  if (!votes.length) {
    notes.push('Op geen enkele pagina is een paginanummer gevonden; gedrukte nummers zijn onbekend.');
    return { segments: [], notes };
  }

  // Runs of consecutive votes that agree.
  const runs: Array<{ offset: number; from: number; to: number; support: number }> = [];
  for (const vote of votes) {
    const last = runs[runs.length - 1];
    if (last && last.offset === vote.offset) {
      last.to = vote.pdf;
      last.support++;
    } else {
      runs.push({ offset: vote.offset, from: vote.pdf, to: vote.pdf, support: 1 });
    }
  }

  const minimum = votes.length >= 4 ? 2 : 1;
  const strong = runs.filter((r) => r.support >= minimum);
  for (const run of runs) {
    if (run.support < minimum) {
      const vote = votes.find((v) => v.pdf === run.from);
      notes.push(`PDF-pagina ${run.from}: paginanummer "${vote?.n}" gelezen, dat past niet bij de buren en is genegeerd.`);
    }
  }
  if (!strong.length) {
    notes.push('De paginanummers spreken elkaar tegen; gedrukte nummers zijn onbekend.');
    return { segments: [], notes };
  }

  // Merge what the misreads had split, then let each segment reach up to the next.
  const merged: typeof strong = [];
  for (const run of strong) {
    const last = merged[merged.length - 1];
    if (last && last.offset === run.offset) {
      last.to = run.to;
      last.support += run.support;
    } else merged.push({ ...run });
  }
  const segments: OffsetSegment[] = merged.map((run, i) => ({
    from: i === 0 ? 1 : run.from,
    to: i === merged.length - 1 ? Math.max(run.to, ...pages.map((p) => p.pdf)) : merged[i + 1].from - 1,
    step,
    offset: run.offset,
    support: run.support
  }));
  if (segments.length > 1) {
    notes.push(
      `De paginanummering verspringt: ${segments
        .map((s) => `PDF ${s.from} tot ${s.to} (${describeOffset(s)})`)
        .join(', ')}.`
    );
  }
  return { segments, notes };
}

function describeOffset(segment: OffsetSegment): string {
  if (segment.step === 2) return 'spreads';
  if (segment.offset === 0) return 'gelijk aan de PDF';
  return segment.offset < 0 ? `gedrukt = PDF - ${-segment.offset}` : `gedrukt = PDF + ${segment.offset}`;
}

export function folioOf(segments: OffsetSegment[], pdf: number): string | null {
  const segment = segments.find((s) => pdf >= s.from && pdf <= s.to);
  if (!segment) return null;
  const n = pdf * segment.step + segment.offset;
  if (n < 1) return null;
  return segment.step === 2 ? `${n}-${n + 1}` : String(n);
}

export function pdfOf(segments: OffsetSegment[], folio: string | null | undefined): number | null {
  const n = folioNumber(folio);
  if (n == null) return null;
  for (const segment of segments) {
    const pdf = Math.floor((n - segment.offset) / segment.step);
    if (pdf >= segment.from && pdf <= segment.to) return pdf;
  }
  return null;
}

// ─── Spreads ─────────────────────────────────────────────────────────────────

/**
 * Which pages face each other. Every page run said which neighbour its page
 * faces, having seen all three; two pages that say it of each other are a
 * spread. Where they disagree, the printed number settles it: in a magazine the
 * left-hand page carries the even number.
 */
export function pairSpreads(
  scans: PageScan[],
  pages: MagazinePage[],
  segments: OffsetSegment[],
  notes: string[]
): Array<[number, number]> {
  const byPdf = new Map(scans.map((s) => [s.pdf, s]));
  const sizes = new Map(pages.map((p) => [p.pdf, p]));
  const pairs: Array<[number, number]> = [];
  const taken = new Set<number>();

  for (const scan of [...scans].sort((a, b) => a.pdf - b.pdf)) {
    const next = byPdf.get(scan.pdf + 1);
    if (!next || taken.has(scan.pdf)) continue;
    if (isSpread(sizes.get(scan.pdf)) || isSpread(sizes.get(next.pdf))) continue;

    const left = !scan.error && scan.facing === 'volgende';
    const right = !next.error && next.facing === 'vorige';
    if (!left && !right) continue;

    if (left && right) {
      pairs.push([scan.pdf, next.pdf]);
      taken.add(scan.pdf).add(next.pdf);
      continue;
    }

    const folio = folioNumber(folioOf(segments, scan.pdf));
    if (folio != null && folio % 2 === 0) {
      pairs.push([scan.pdf, next.pdf]);
      taken.add(scan.pdf).add(next.pdf);
      notes.push(
        `PDF ${scan.pdf} en ${next.pdf}: de pagina's waren het oneens of ze tegenover elkaar liggen; het even paginanummer links zegt van wel.`
      );
    } else {
      notes.push(
        `PDF ${scan.pdf} en ${next.pdf}: de pagina's waren het oneens of ze tegenover elkaar liggen; ${
          folio == null ? 'zonder paginanummer niet te beslissen, dus los gehouden' : 'het paginanummer zegt van niet'
        }.`
      );
    }
  }
  return pairs;
}

// ─── Articles ────────────────────────────────────────────────────────────────

/** Minder regels dan dit en de inhoudsopgave is te mager om op te bouwen. */
const MIN_TOC_ENTRIES = 3;

export function stitch(scans: PageScan[], pages: MagazinePage[]): MagazineMap {
  const ordered = [...scans].sort((a, b) => a.pdf - b.pdf);
  const { segments, notes } = fitOffsets(ordered, pages);
  const spreads = pairSpreads(ordered, pages, segments, notes);
  const toc = uniqueToc(ordered.flatMap((s) => s.toc));

  // De inhoudsopgave is leidend: wat de redactie een artikel noemt, is er een.
  // Pas zonder bruikbare inhoudsopgave worden de artikelen uit de pagina's zelf
  // afgeleid.
  const contents = byContents(toc, ordered, pages, segments, notes);
  let map: MagazineMap;
  if (contents) {
    map = {
      basis: 'inhoudsopgave',
      segments,
      spreads,
      articles: contents.articles,
      toc,
      skipped: contents.skipped,
      boundaries: [],
      questions: contents.questions,
      contents: [],
      notes
    };
  } else {
    const found = byPages(ordered, segments, spreads, notes);
    matchToc(found.articles, toc, segments, notes);
    map = {
      basis: 'paginas',
      segments,
      spreads,
      articles: found.articles,
      toc,
      skipped: found.skipped,
      boundaries: [],
      questions: [],
      contents: [],
      notes
    };
  }
  refresh(map);
  return map;
}

function create(
  articles: MapArticle[],
  title: string | null,
  rubric: string | null,
  sources: MapArticle['sources']
): MapArticle {
  const article: MapArticle = {
    id: `a${articles.length + 1}`,
    title,
    rubric,
    about: '',
    pages: [],
    folios: [],
    shared: [],
    opening: [],
    sources: [...sources],
    notes: [],
    certain: true
  };
  articles.push(article);
  return article;
}

/** Dezelfde regel twee keer gelezen, van twee inhoudsopgavepagina's of twee kolommen. */
function uniqueToc(entries: TocEntry[]): TocEntry[] {
  const out: TocEntry[] = [];
  for (const entry of entries) {
    if (!entry.title?.trim()) continue;
    const twin = out.find((e) => folioNumber(e.page) === folioNumber(entry.page) && similar(e.title, entry.title));
    if (!twin) out.push(entry);
  }
  return out;
}

/**
 * De artikelen zoals de inhoudsopgave ze noemt.
 *
 * Elke regel opent een artikel op de pagina die hij noemt, en de pagina's tot de
 * volgende regel horen erbij, advertenties en colofon niet meegerekend. Wat daar
 * staat en duidelijk bij het artikel hoort (doorlopende tekst, een kader met
 * dezelfde rubriek, een reeks korte berichten onder de kop van de rubriek) gaat
 * zonder vragen mee. Een stuk met een eigen kop en een andere rubriek misschien
 * niet: die pagina wordt een vraag, en de inhoudscontrole beslist.
 *
 * Zo wordt een rubriek als Personalia één artikel met al zijn namen, in plaats van
 * een artikel per persoon.
 */
function byContents(
  toc: TocEntry[],
  scans: PageScan[],
  pages: MagazinePage[],
  segments: OffsetSegment[],
  notes: string[]
): { articles: MapArticle[]; questions: ContentQuestion[]; skipped: MagazineMap['skipped'] } | null {
  if (!toc.length) return null;
  if (!segments.length) {
    notes.push(
      "Er is een inhoudsopgave, maar zonder paginanummers is die niet naast de pagina's te leggen; de artikelen komen uit de pagina's zelf."
    );
    return null;
  }

  const scanOf = new Map(scans.map((s) => [s.pdf, s]));
  const lastPdf = Math.max(...pages.map((p) => p.pdf));
  const placed: Array<{ entry: TocEntry; pdf: number }> = [];
  for (const entry of toc) {
    const pdf = pdfOf(segments, entry.page);
    if (pdf == null || !scanOf.has(pdf)) {
      notes.push(`Inhoudsopgave: "${entry.title}" op pagina ${entry.page} valt buiten dit PDF-bestand.`);
      continue;
    }
    placed.push({ entry, pdf });
  }
  if (placed.length < MIN_TOC_ENTRIES) {
    notes.push(
      `De inhoudsopgave heeft maar ${placed.length} bruikbare regel(s); de artikelen komen uit de pagina's zelf.`
    );
    return null;
  }

  // Eén regel die als twee is gelezen: een kop met zijn beschrijving eronder
  // ("DROOGTE" en dan een zin over de droogte). Meer regels op een pagina dan er
  // koppen op staan, dan zijn de regels die bij geen kop passen de beschrijving.
  for (const pdf of new Set(placed.map((p) => p.pdf))) {
    const here = placed.filter((p) => p.pdf === pdf);
    if (here.length < 2) continue;
    const heads = (scanOf.get(pdf)?.pieces ?? []).filter((piece) => piece.starts && piece.title);
    let keep = here.filter(
      (p) => !here.some((other) => other !== p && p.entry.rubric && similar(p.entry.rubric, other.entry.title))
    );
    if (keep.length > Math.max(1, heads.length)) {
      const matching = keep.filter((p) => heads.some((h) => similar(h.title as string, p.entry.title)));
      keep = matching.length ? matching.slice(0, Math.max(1, heads.length)) : keep.slice(0, 1);
    }
    for (const dropped of here.filter((p) => !keep.includes(p))) {
      placed.splice(placed.indexOf(dropped), 1);
      notes.push(`Inhoudsopgave: "${dropped.entry.title}" op pagina ${dropped.entry.page} is de beschrijving bij een andere regel, geen eigen artikel.`);
    }
  }

  // In leesvolgorde: op pagina, en op één pagina op de plek van de kop.
  const rank = ({ entry, pdf }: { entry: TocEntry; pdf: number }) => {
    const pieces = scanOf.get(pdf)?.pieces ?? [];
    const at = pieces.findIndex((p) => p.starts && p.title && similar(p.title, entry.title));
    return at < 0 ? pieces.length : at;
  };
  placed.sort((a, b) => a.pdf - b.pdf || rank(a) - rank(b));

  const articles: MapArticle[] = [];
  const questions: ContentQuestion[] = [];

  placed.forEach(({ entry, pdf }, i) => {
    const scan = scanOf.get(pdf) as PageScan;
    const sharing = placed.filter((p) => p.pdf === pdf).length;
    const lastOnPage = !placed.slice(i + 1).some((p) => p.pdf === pdf);
    const nextStart = placed.find((p) => p.pdf > pdf)?.pdf ?? lastPdf + 1;

    const heading = headlineFor(entry, scan, sharing);
    const article = create(articles, heading.title, heading.rubric, ['inhoudsopgave', 'pagina']);
    article.toc = entry;
    article.about = heading.about;
    if (heading.note) article.notes.push(heading.note);
    add(article, pdf);
    if (scan.error) {
      article.notes.push(`De beginpagina kon niet worden bekeken: ${scan.error}`);
      article.certain = false;
    } else if (scan.kind !== 'artikel') {
      article.notes.push(`De beginpagina is volgens de paginascan: ${scan.kind}.`);
    }

    // Twee regels op één pagina: de pagina's erna gaan naar de laatste in leesvolgorde.
    if (!lastOnPage) {
      article.notes.push('Deelt de beginpagina met een ander artikel uit de inhoudsopgave.');
      return;
    }

    let doubted = false;
    for (let p = pdf + 1; p < nextStart; p++) {
      const page = scanOf.get(p);
      if (!page) continue;
      if (page.error) {
        add(article, p);
        article.notes.push(`PDF-pagina ${p} kon niet worden bekeken en is voor de zekerheid meegenomen.`);
        article.certain = false;
        continue;
      }
      if (NOT_EDITORIAL.includes(page.kind)) {
        article.notes.push(`PDF-pagina ${p} (${page.kind}) overgeslagen.`);
        doubted = false;
        continue;
      }
      if (!page.pieces.length) {
        // A photo page inside the article.
        add(article, p);
        continue;
      }
      // Doorlopende tekst hoort bij wat ervoor liep. Liep daar iets anders dan
      // het artikel, dan is ook de doorloop een vraag.
      const doubtful = page.pieces.filter((piece) => (piece.starts || doubted) && !belongsTo(piece, article, entry));
      add(article, p, page.pieces.find((piece) => !doubtful.includes(piece))?.about);
      if (doubtful.length) {
        questions.push({ id: `q${questions.length + 1}`, article: article.id, pdf: p, pieces: doubtful });
      }
      doubted = doubtful.length > 0;
    }

    // The last paragraphs can stand on the page where the next article opens.
    const next = scanOf.get(nextStart);
    if (next && !next.error) {
      const opens = next.pieces.findIndex((piece) => piece.starts);
      if (opens > 0 && next.pieces.slice(0, opens).every((piece) => !piece.starts)) {
        add(article, nextStart);
        article.notes.push(`Eindigt op PDF-pagina ${nextStart}, waar het volgende artikel begint.`);
      }
    }

    // "lees verder op pagina 64"
    for (const page of [...article.pages]) {
      for (const piece of scanOf.get(page)?.pieces ?? []) {
        const target = pdfOf(segments, piece.continuesOn);
        if (target == null || article.pages.includes(target)) continue;
        add(article, target);
        article.notes.push(`Loopt verder op pagina ${piece.continuesOn} (PDF ${target}).`);
      }
    }
  });

  // Vóór de eerste regel: wat daar redactioneel is, staat niet in de inhoudsopgave.
  const first = placed[0].pdf;
  let extra: MapArticle | null = null;
  for (const scan of scans) {
    if (scan.pdf >= first) break;
    if (scan.error || NOT_EDITORIAL.includes(scan.kind) || !scan.pieces.length) continue;
    for (const piece of scan.pieces) {
      if (piece.starts || !extra) {
        extra = create(articles, piece.title, piece.rubric, ['pagina']);
        extra.about = piece.about;
        extra.notes.push('Staat niet in de inhoudsopgave.');
        extra.certain = false;
      }
      add(extra, scan.pdf);
    }
  }

  const taken = new Set(articles.flatMap((a) => a.pages));
  const skipped = scans.filter((s) => !taken.has(s.pdf)).map((s) => ({ pdf: s.pdf, kind: s.kind }));
  articles.sort((a, b) => (a.pages[0] ?? 0) - (b.pages[0] ?? 0));
  notes.push(
    `De inhoudsopgave is leidend: ${placed.length} regels.${
      questions.length ? ` Op ${questions.length} pagina('s) staat iets waarvan nog wordt bekeken of het erbij hoort.` : ''
    }`
  );
  return { articles, questions, skipped };
}

/** De kop zoals de pagina hem drukt, als die bij de regel uit de inhoudsopgave past. */
function headlineFor(
  entry: TocEntry,
  scan: PageScan,
  sharing: number
): { title: string | null; rubric: string | null; about: string; note: string | null } {
  const starting = scan.pieces.filter((p) => p.starts && p.title);
  const match = starting.find((p) => similar(p.title as string, entry.title));
  const fromToc = `In de inhoudsopgave: "${entry.title}".`;
  if (match) {
    const same = normalizeForCompare(match.title as string) === normalizeForCompare(entry.title);
    return { title: match.title, rubric: match.rubric ?? entry.rubric, about: match.about, note: same ? null : fromToc };
  }
  // Eén kop op de pagina en één regel die ernaar wijst: dat is hem, ook in andere woorden.
  if (sharing === 1 && starting.length === 1) {
    return { title: starting[0].title, rubric: starting[0].rubric ?? entry.rubric, about: starting[0].about, note: fromToc };
  }
  return { title: entry.title, rubric: entry.rubric, about: scan.pieces[0]?.about ?? '', note: null };
}

/** Of een stuk zonder twijfel bij dit artikel hoort: dezelfde kop, of dezelfde rubriek. */
function belongsTo(piece: PagePiece, article: MapArticle, entry: TocEntry): boolean {
  const titles = [entry.title, article.title].filter((t): t is string => Boolean(t));
  if (piece.title && titles.some((t) => similar(piece.title as string, t))) return true;
  const rubrics = [entry.rubric, article.rubric, entry.title].filter((r): r is string => Boolean(r));
  return Boolean(piece.rubric && rubrics.some((r) => similar(piece.rubric as string, r)));
}

/** De artikelen uit de pagina's zelf, voor een magazine zonder bruikbare inhoudsopgave. */
function byPages(
  ordered: PageScan[],
  segments: OffsetSegment[],
  spreads: Array<[number, number]>,
  notes: string[]
): { articles: MapArticle[]; skipped: MagazineMap['skipped'] } {
  const partner = partners(spreads);
  const articles: MapArticle[] = [];
  const skipped: MagazineMap['skipped'] = [];
  /** "lees verder op pagina 64": which article the page it names belongs to. */
  const jumps = new Map<number, MapArticle>();
  let current: MapArticle | null = null;
  /**
   * De rubriek die als geheel een artikel is: geopend door een kop die de rubriek
   * zelf is (Personalia), of door een stuk zonder eigen kop. Korte berichten met
   * die rubriek horen erbij, ook als er iets anders tussen staat.
   */
  let section = null as MapArticle | null;

  const open = (title: string | null, rubric: string | null): MapArticle => {
    const article = create(articles, title, rubric, ['pagina']);
    if (rubric && (!title || similar(title, rubric))) section = article;
    return article;
  };

  for (const scan of ordered) {
    if (scan.error) {
      notes.push(`PDF-pagina ${scan.pdf} kon niet worden bekeken: ${scan.error}`);
      if (current) {
        // Better in the article and marked than silently missing from it.
        add(current, scan.pdf);
        current.notes.push(`PDF-pagina ${scan.pdf} kon niet worden bekeken en is voor de zekerheid meegenomen.`);
        current.certain = false;
      }
      continue;
    }

    if (NOT_EDITORIAL.includes(scan.kind) || !scan.pieces.length) {
      skipped.push({ pdf: scan.pdf, kind: scan.kind });
      continue;
    }

    // The article that was running when this page began. A piece that runs on
    // from before, listed after a piece that opens here, belongs to that one.
    const before: MapArticle | null = current;
    let openedHere = false;

    for (const piece of scan.pieces) {
      const from = pdfOf(segments, piece.continuedFrom);
      const jumped = jumps.get(scan.pdf);

      if (!piece.starts && from != null) {
        const target = articles.find((a) => a.pages.includes(from));
        if (target) {
          add(target, scan.pdf, piece.about);
          target.notes.push(`Vervolg op PDF-pagina ${scan.pdf} ("vervolg van pagina ${piece.continuedFrom}").`);
          continue;
        }
      }

      if (!piece.starts && jumped) {
        add(jumped, scan.pdf, piece.about);
        continue;
      }

      // Een kort bericht onder de kop van een rubriek (Personalia, Nieuws in het
      // kort) is een deel van die rubriek, geen artikel op zich.
      // Dat is te zien aan de rubriek van het bericht, en aan een rubriek die kort
      // daarvoor als geheel werd geopend.
      const underSection = Boolean(
        piece.starts &&
          section &&
          piece.rubric &&
          similar(piece.rubric, section.rubric ?? section.title ?? '') &&
          section.pages.some((p) => scan.pdf - p <= 2)
      );

      let owner: MapArticle;
      if (underSection) {
        owner = current = section!;
      } else if (piece.starts || !current) {
        owner = current = open(piece.title, piece.rubric);
        openedHere = true;
        if (!piece.starts) {
          owner.notes.push('Begint zonder kop: doorlopende tekst waar geen artikel aan voorafging.');
          owner.certain = false;
        }
      } else if (openedHere && before) {
        owner = before;
      } else {
        owner = current;
        if (!owner.rubric && piece.rubric) owner.rubric = piece.rubric;
      }
      add(owner, scan.pdf, piece.about);

      if (piece.continuesOn) {
        const target = pdfOf(segments, piece.continuesOn);
        if (target != null) jumps.set(target, owner);
        owner.notes.push(`Loopt verder op pagina ${piece.continuesOn}${target != null ? ` (PDF ${target})` : ''}.`);
      }
    }
  }

  // A page of the article with nothing to read on it, a full-page photo that faces
  // the headline or closes the story, belongs with the page it faces.
  for (const skip of [...skipped]) {
    if (skip.kind !== 'artikel') continue;
    const facing = partner.get(skip.pdf);
    if (facing == null) continue;
    const owner = articles.find((a) => a.pages[0] === facing) ?? articles.find((a) => a.pages.includes(facing));
    if (!owner) continue;
    add(owner, skip.pdf);
    owner.notes.push(`PDF-pagina ${skip.pdf} heeft geen tekst en hoort bij PDF-pagina ${facing} ertegenover.`);
    skipped.splice(skipped.indexOf(skip), 1);
  }

  // Adverts in the middle of an article are left out of it, and said so.
  for (const article of articles) {
    for (let i = 1; i < article.pages.length; i++) {
      for (let pdf = article.pages[i - 1] + 1; pdf < article.pages[i]; pdf++) {
        const skip = skipped.find((s) => s.pdf === pdf);
        if (skip) article.notes.push(`PDF-pagina ${pdf} (${skip.kind}) overgeslagen.`);
      }
    }
  }

  return { articles, skipped };
}

function add(article: MapArticle, pdf: number, about?: string): void {
  if (!article.pages.includes(pdf)) article.pages.push(pdf);
  if (about && !article.about) article.about = about;
}

/**
 * The table of contents as a second, independent witness. Where it names the page
 * an article was found to start on, the finding is confirmed. Where it names a
 * page that did not look like a start, somebody should look.
 */
function matchToc(articles: MapArticle[], toc: TocEntry[], segments: OffsetSegment[], notes: string[]): void {
  if (!toc.length) return;
  if (!segments.length) {
    notes.push('Er is een inhoudsopgave, maar zonder paginanummers is die niet naast de artikelen te leggen.');
    return;
  }

  for (const entry of toc) {
    const pdf = pdfOf(segments, entry.page);
    if (pdf == null) {
      notes.push(`Inhoudsopgave: "${entry.title}" op pagina ${entry.page} valt buiten dit PDF-bestand.`);
      continue;
    }
    const starting = articles.find((a) => a.pages[0] === pdf);
    if (starting) {
      if (!starting.sources.includes('inhoudsopgave')) starting.sources.push('inhoudsopgave');
      if (!starting.title) {
        starting.title = entry.title;
        starting.notes.push('Titel uit de inhoudsopgave; op de pagina zelf is geen kop gevonden.');
      } else if (!similar(starting.title, entry.title)) {
        starting.notes.push(`De inhoudsopgave noemt dit "${entry.title}".`);
      }
      if (!starting.rubric && entry.rubric) starting.rubric = entry.rubric;
      continue;
    }

    const containing = articles.find((a) => a.pages.includes(pdf));
    if (containing) {
      containing.notes.push(
        `Volgens de inhoudsopgave begint "${entry.title}" op pagina ${entry.page} (PDF ${pdf}), maar daar is geen nieuw begin gezien.`
      );
      containing.certain = false;
    } else {
      notes.push(`Inhoudsopgave: "${entry.title}" op pagina ${entry.page} (PDF ${pdf}) hoort bij geen gevonden artikel.`);
    }
  }
}

function similar(a: string, b: string): boolean {
  const left = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const right = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return false;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size) >= 0.5;
}

// ─── Boundaries ──────────────────────────────────────────────────────────────

/**
 * The transitions worth a second look: every article that follows another. Met de
 * inhoudsopgave als basis liggen de grenzen al vast; daar is de inhoudscontrole de
 * tweede blik.
 */
export function transitions(map: MagazineMap): Array<{ from: MapArticle; to: MapArticle }> {
  if (map.basis === 'inhoudsopgave') return [];
  const byStart = [...map.articles].filter((a) => a.pages.length).sort((a, b) => a.pages[0] - b.pages[0]);
  const out: Array<{ from: MapArticle; to: MapArticle }> = [];
  for (let i = 1; i < byStart.length; i++) {
    // Two items that open on the same page (a news page) have no boundary
    // between them that a page can settle.
    if (byStart[i - 1].pages[0] === byStart[i].pages[0]) continue;
    out.push({ from: byStart[i - 1], to: byStart[i] });
  }
  return out;
}

/** What the boundary check found, laid over the list. */
export function applyBoundary(map: MagazineMap, check: BoundaryCheck): void {
  const from = map.articles.find((a) => a.id === check.from);
  const to = map.articles.find((a) => a.id === check.to);
  if (!from || !to || !to.pages.length) return;
  const start = to.pages[0];
  if (!from.sources.includes('grenscontrole')) from.sources.push('grenscontrole');

  switch (check.verdict) {
    case 'eindigt-ervoor':
      if (from.pages.includes(start) && from.pages[0] !== start) {
        from.pages = from.pages.filter((p) => p !== start);
        from.notes.push(`PDF-pagina ${start} hoort toch niet bij dit artikel: ${check.reason}`);
      }
      break;
    case 'eindigt-op-beginpagina':
      if (!from.pages.includes(start)) {
        from.pages.push(start);
        from.notes.push(`Eindigt op PDF-pagina ${start}, waar "${to.title ?? to.id}" begint: ${check.reason}`);
      }
      break;
    case 'loopt-verder': {
      const target = pdfOf(map.segments, check.continuesOn);
      // Already found by the page scan: the two agree and there is nothing to add.
      if (target != null && from.pages.includes(target)) break;
      if (target != null) {
        from.pages.push(target);
        from.notes.push(`Loopt verder op PDF-pagina ${target}, wat de paginascan niet zag: ${check.reason}`);
      } else {
        from.notes.push(`Loopt verder, maar niet duidelijk waar: ${check.reason}`);
      }
      from.certain = false;
      break;
    }
    case 'onduidelijk':
      from.notes.push(`Niet duidelijk waar dit artikel ophoudt: ${check.reason}`);
      from.certain = false;
      break;
  }
  map.boundaries = [...map.boundaries.filter((b) => !(b.from === check.from && b.to === check.to)), check];
  refresh(map);
}

/**
 * Wat de inhoudscontrole zei over een pagina, over de lijst gelegd. Alle
 * antwoorden worden op volgorde van pagina toegepast, zodat een stuk dat over twee
 * pagina's loopt bij hetzelfde losse artikel terechtkomt.
 */
export function applyContent(map: MagazineMap, check: ContentCheck): void {
  const article = map.articles.find((a) => a.id === check.article);
  const question = (map.questions ?? []).find((q) => q.id === check.question);
  if (!article || !question) return;
  if (!article.sources.includes('inhoudscontrole')) article.sources.push('inhoudscontrole');
  const pdf = question.pdf;

  switch (check.verdict) {
    case 'hoort-erbij':
      break;
    case 'deels': {
      const outside = question.pieces.filter(
        (piece) => !check.belonging.some((title) => piece.title && similar(piece.title, title))
      );
      separate(map, pdf, outside, `Staat op PDF-pagina ${pdf} naast "${article.title ?? article.id}": ${check.reason}`);
      article.notes.push(`Deelt PDF-pagina ${pdf} met iets dat niet in de inhoudsopgave staat: ${check.reason}`);
      break;
    }
    case 'hoort-er-niet-bij':
      if (article.pages[0] !== pdf) article.pages = article.pages.filter((p) => p !== pdf);
      separate(map, pdf, question.pieces, check.reason);
      article.notes.push(`PDF-pagina ${pdf} hoort niet bij dit artikel: ${check.reason}`);
      break;
    case 'onduidelijk':
      article.notes.push(`Niet duidelijk of alles op PDF-pagina ${pdf} erbij hoort: ${check.reason}`);
      article.certain = false;
      break;
  }
  map.contents = [...(map.contents ?? []).filter((c) => c.question !== check.question), check];
  map.articles.sort((a, b) => (a.pages[0] ?? 0) - (b.pages[0] ?? 0));
  map.skipped = map.skipped.filter((s) => !map.articles.some((a) => a.pages.includes(s.pdf)));
  refresh(map);
}

/** Stukken die niet bij hun artikel horen, als eigen artikel, gemarkeerd als buiten de inhoudsopgave. */
function separate(map: MagazineMap, pdf: number, pieces: PagePiece[], reason: string): void {
  for (const piece of pieces) {
    // Loopt het door van een los stuk op de pagina ervoor, dan hoort het daarbij.
    const prior = !piece.starts ? map.articles.find((a) => !a.toc && a.pages.includes(pdf - 1)) : undefined;
    if (prior) {
      add(prior, pdf);
      continue;
    }
    const extra = create(map.articles, piece.title, piece.rubric, ['pagina', 'inhoudscontrole']);
    extra.about = piece.about;
    add(extra, pdf);
    extra.notes.push('Staat niet in de inhoudsopgave.', reason);
    extra.certain = false;
  }
}

function partners(spreads: Array<[number, number]>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [left, right] of spreads) {
    out.set(left, right);
    out.set(right, left);
  }
  return out;
}

/** Shared pages, printed numbers and the opening follow from the pages; recomputed after every change. */
function refresh(map: MagazineMap): void {
  const partner = partners(map.spreads ?? []);
  const owners = new Map<number, number>();
  for (const article of map.articles) {
    // A jump goes forward in the magazine, so file order is reading order.
    article.pages.sort((a, b) => a - b);
    for (const pdf of article.pages) owners.set(pdf, (owners.get(pdf) ?? 0) + 1);
  }
  for (const article of map.articles) {
    article.shared = article.pages.filter((pdf) => (owners.get(pdf) ?? 0) > 1);
    article.folios = article.pages.map((pdf) => folioOf(map.segments, pdf));
    // Opens on a spread only when the start is a left-hand page and the page it
    // faces is part of the article. Starting on a right-hand page, the page after
    // it is already the next spread.
    const start = article.pages[0];
    const facing = start == null ? undefined : partner.get(start);
    article.opening =
      start == null ? [] : facing === start + 1 && article.pages[1] === facing ? [start, facing] : [start];
  }
}
