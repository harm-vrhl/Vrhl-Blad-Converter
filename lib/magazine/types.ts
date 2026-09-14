/**
 * A whole magazine, and the list of articles found in it.
 *
 * `pdf` is the page's place in the file, counted from 1, and it is what every
 * artefact is named by. `folio` is the number printed on the paper. The two
 * differ by the cover and whatever else comes before page 1, and the reader and
 * the table of contents only ever speak of the second.
 */

export interface MagazinePage {
  pdf: number;
  width: number;
  height: number;
  image: string;
  thumb: string;
  /** The text layer as pdf.js reads it. Empty for a scanned page. */
  text: string;
  /** The page label the PDF itself carries, if the producer wrote one. */
  label: string | null;
}

export interface Magazine {
  id: string;
  kind: 'magazine';
  filename: string;
  pageCount: number;
  pages: MagazinePage[];
  createdAt: string;
  status: 'uploading' | 'ready' | 'running' | 'done' | 'error';
  error: string | null;
  map: MagazineMap | null;
}

export type PageKind = 'omslag' | 'inhoudsopgave' | 'artikel' | 'advertentie' | 'colofon' | 'overig';

/**
 * Which neighbour this page faces in the printed magazine. A reader sees spreads,
 * not pages: a headline on the left and its intro on the right are one opening.
 * `geen` is a page on its own: the cover, or a PDF page that is a spread already.
 */
export type Facing = 'vorige' | 'volgende' | 'geen';

/** One piece of editorial content as it shows on one page. */
export interface PagePiece {
  /** True where this piece opens on this page; false where it runs on from before. */
  starts: boolean;
  title: string | null;
  rubric: string | null;
  /** One sentence on what the piece is about, as far as this page shows. */
  about: string;
  /** "lees verder op pagina 64": the printed page it jumps to. */
  continuesOn: string | null;
  /** "vervolg van pagina 12": the printed page it came from. */
  continuedFrom: string | null;
}

export interface TocEntry {
  title: string;
  rubric: string | null;
  page: string;
}

/** What the per-page run said about one page. */
export interface PageScan {
  pdf: number;
  kind: PageKind;
  /** Which neighbour the run saw this page face. */
  facing: Facing;
  /** The printed page number as read off the page, verbatim. */
  folio: string | null;
  pieces: PagePiece[];
  toc: TocEntry[];
  /** Set when the run failed; the page then counts as unknown, not as empty. */
  error?: string;
}

export type BoundaryVerdict = 'eindigt-ervoor' | 'eindigt-op-beginpagina' | 'loopt-verder' | 'onduidelijk';

export interface BoundaryCheck {
  /** The article that ends here, and the one that starts. */
  from: string;
  to: string;
  verdict: BoundaryVerdict;
  /** For `loopt-verder`: the printed page it continues on. */
  continuesOn: string | null;
  reason: string;
  /** Which model gave the final word: the cheap one, or the second look. */
  model: string;
}

export interface MapArticle {
  id: string;
  title: string | null;
  rubric: string | null;
  about: string;
  /** In reading order. Not necessarily contiguous: an advert can sit in between. */
  pages: number[];
  /** Printed numbers for those pages, derived from the offset. */
  folios: (string | null)[];
  /** Pages this article shares with another one. */
  shared: number[];
  /**
   * The pages its headline, intro and credits can be on: the start page, and the
   * page facing it when the article opens on a spread. Always the first pages of
   * `pages`, which is what lets the article run be told how many to look at.
   */
  opening: number[];
  /** Where the finding came from. */
  sources: Array<'pagina' | 'inhoudsopgave' | 'grenscontrole'>;
  /** Everything a person should look at before trusting this entry. */
  notes: string[];
  /** False when a note means the pages themselves may be wrong. */
  certain: boolean;
}

export interface OffsetSegment {
  /** First and last PDF page this offset applies to. */
  from: number;
  to: number;
  /** folio = pdf * step + offset. Step is 2 when each PDF page is a spread. */
  step: 1 | 2;
  offset: number;
  /** How many pages carried a number that agrees. */
  support: number;
}

export interface MagazineMap {
  segments: OffsetSegment[];
  /** Pairs of PDF pages that face each other, as the page runs and the rules agreed. */
  spreads: Array<[number, number]>;
  articles: MapArticle[];
  toc: TocEntry[];
  /** Pages that belong to no article, and why. */
  skipped: Array<{ pdf: number; kind: PageKind }>;
  boundaries: BoundaryCheck[];
  notes: string[];
}

export type MagazineEvent =
  | { type: 'status'; run: string; state: 'start' | 'ok' | 'fail'; page?: number; detail?: string }
  | { type: 'scan'; scan: PageScan }
  | { type: 'map'; map: MagazineMap }
  | { type: 'boundary'; check: BoundaryCheck }
  | {
      type: 'done';
      map: MagazineMap;
      runs: number;
      tokens: number;
      cost: { total: number; currency: string };
      ms: number;
    };
