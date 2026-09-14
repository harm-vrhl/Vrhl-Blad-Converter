import { normalizeForCompare } from '../util';
import type {
  BoundaryCheck,
  MagazineMap,
  MagazinePage,
  MapArticle,
  OffsetSegment,
  PageKind,
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

export function stitch(scans: PageScan[], pages: MagazinePage[]): MagazineMap {
  const ordered = [...scans].sort((a, b) => a.pdf - b.pdf);
  const { segments, notes } = fitOffsets(ordered, pages);
  const spreads = pairSpreads(ordered, pages, segments, notes);
  const partner = partners(spreads);
  const articles: MapArticle[] = [];
  const skipped: MagazineMap['skipped'] = [];
  /** "lees verder op pagina 64": which article the page it names belongs to. */
  const jumps = new Map<number, MapArticle>();
  let current: MapArticle | null = null;

  const open = (title: string | null, rubric: string | null): MapArticle => {
    const article: MapArticle = {
      id: `a${articles.length + 1}`,
      title,
      rubric,
      about: '',
      pages: [],
      folios: [],
      shared: [],
      opening: [],
      sources: ['pagina'],
      notes: [],
      certain: true
    };
    articles.push(article);
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

      let owner: MapArticle;
      if (piece.starts || !current) {
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

  const toc = ordered.flatMap((s) => s.toc);
  matchToc(articles, toc, segments, notes);

  const map: MagazineMap = { segments, spreads, articles, toc, skipped, boundaries: [], notes };
  refresh(map);
  return map;
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

/** The transitions worth a second look: every article that follows another. */
export function transitions(map: MagazineMap): Array<{ from: MapArticle; to: MapArticle }> {
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
