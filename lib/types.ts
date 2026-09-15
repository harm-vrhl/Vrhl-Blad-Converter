import type { StyleFragment } from './agents/styling';
export type { TypographySource } from './client/typography';
import type { TypographySource } from './client/typography';

// ─── The model ───────────────────────────────────────────────────────────────
// Per page, two AI runs and nothing more:
//   run 1  writes the page out in reading order, inserts, quotes and images
//          included, each in its place;
//   run 2  looks only at typography and replaces the styled words in run 1's
//          output.
// Mistral's word index is the check on both.

/**
 * The marks Vrhl-Blad MDX carries. Struck-through type is deliberately not one
 * of them - the format rules it out - so no run goes looking for it.
 */
export type InlineStyle = 'bold' | 'italic' | 'underline';

export type BlockType = 'paragraph' | 'subheading' | 'quote' | 'streamer' | 'image' | 'insert' | 'list';

/**
 * How wide the image is printed, relative to the text column of the reader.
 * Derived from the share of the page the bitmap covers, not from the model.
 */
export type ImageSize = 'small' | 'normal' | 'large' | 'xlarge';

/** One addressable unit of a page, as written by run 1. */
export interface Block {
  id: string; // p3-01
  page: number;
  type: BlockType;
  /** Paragraph, subheading, quote and streamer text; the title of an insert. */
  text: string;
  /**
   * Insert body: the blocks inside the box, in printed order. A box holds the
   * same kinds the page does - a heading, paragraphs, a list, a photo - so it
   * holds blocks rather than a flat run of paragraphs.
   */
  children?: PageBlock[];
  /** List body, one entry per item. */
  items?: string[];
  /** A numbered list rather than bullets. */
  ordered?: boolean;
  /** Where the box sits: beside the story, or after it. */
  placement?: 'inline' | 'end';
  caption?: string | null;
  credit?: string | null;
  /** Id of the bitmap ripped from the PDF, when run 1 named one. */
  ref?: string | null;
  file?: string | null;
  size?: ImageSize;
  /** Insert: the tint of the box and the colour of the type in it, as printed. */
  background?: string | null;
  ink?: string | null;
}

/**
 * A block before it is addressable. Run 1 writes the page and the boxes on it
 * with the same markers, so both are read into the same shape; only the page's
 * own blocks get an id, because that is what run 2 hangs its patches on.
 */
export type PageBlock = Omit<Block, 'id' | 'page'>;

/** Run 2's only output: a fragment of a block that carries inline styling. */
export interface StylePatch {
  op: 'style';
  target: string;
  find: string;
  style: InlineStyle[];
  /**
   * Which occurrence of `find` inside the target block, counted from 0 over its
   * styleable text in printed order. A run reading the page cannot count, so it
   * leaves this out and gets the first one; the OCR reads a known place on the
   * page and says exactly which.
   */
  nth?: number;
}

export type Patch = StylePatch;

// ─── Word index, Mistral decides which words exist ─────────────────────────

export interface WordIndex {
  page: number;
  counts: Record<string, number>;
  total: number;
}

export interface IndexCheck {
  /** Words in the output that the OCR never saw. Hallucination. */
  unknown: string[];
  /** Words used more often than the page contains them. Duplication. */
  overused: Array<{ word: string; used: number; available: number }>;
  /** Share of output words backed by the OCR. */
  score: number;
}

// ─── Images ripped straight out of the PDF ──────────────────────────────────

export interface ExtractedImage {
  id: string; // img-3-01
  page: number;
  file: string;
  thumb: string;
  /** Native pixel size of the bitmap inside the PDF. */
  width: number;
  height: number;
  /** Where it sits on the page, in PDF points. */
  placed: { x: number; y: number; w: number; h: number };
  areaPct: number;
  dpi: number;
  /** A picture that was sliced into this many bitmaps, merged again by rendering it from the page. */
  parts?: number;
  /**
   * A piece of such a picture: the id of the merged picture, or `tekst` when the
   * pieces were left out because merging them would have taken a text box along.
   */
  partOf?: string;
}

export type ImageKind = 'photo' | 'illustration' | 'portrait' | 'chart' | 'logo' | 'ornament' | 'rule' | 'advert' | 'other';

export interface ImageVerdict {
  id: string;
  keep: boolean;
  kind: ImageKind;
  reason: string;
}

// ─── OCR ─────────────────────────────────────────────────────────────────────

/** Where one of Mistral's blocks sits, in the pixel space of `OcrPage.dimensions`. */
export interface OcrBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type OcrBlockType = 'header' | 'footer' | 'title' | 'text' | 'list' | 'image' | 'caption' | 'table' | 'other';

/**
 * One block as Mistral laid the page out: where it sits, what kind it is, and
 * its content with the markdown emphasis markers still on. The boxes are already
 * column-aware, which is the one thing a page image cannot tell a model for free.
 */
export interface OcrBlock {
  type: OcrBlockType;
  content: string;
  box: OcrBox;
  imageId: string | null;
}

export interface OcrPage {
  page: number;
  markdown: string;
  /** Mistral's own layout blocks. Empty for a job run before these were kept. */
  blocks: OcrBlock[];
  /** The pixel space the boxes are measured in. Null when the OCR did not say. */
  dimensions: { dpi: number; width: number; height: number } | null;
}

// ─── Per page ────────────────────────────────────────────────────────────────

export interface Continuity {
  continuesFromPrevious: boolean;
  continuesOnNext: boolean;
}

export interface PageResult {
  page: number;
  /**
   * Waar de opmaak van deze pagina vandaan kwam. Een pagina zonder tekstlaag is
   * niet fout, maar hij is wel anders tot stand gekomen - en dat is precies wat
   * je wilt weten als er iets niet klopt aan zijn vet en cursief.
   */
  typography?: TypographySource;
  blocks: Block[];
  patches: Patch[];
  /** Indices into `patches` the applier refused. */
  dropped: number[];
  content: ContentNode[];
  continuity: Continuity;
  check: IndexCheck;
  warnings: string[];
}

// ─── Article ─────────────────────────────────────────────────────────────────

export type FrontmatterField = 'chapeau' | 'title' | 'subtitle' | 'intro';

/** A fragment of chapeau, title, subtitle or intro that is set in italic type. */
export interface FrontmatterItalic {
  field: FrontmatterField;
  text: string;
}

export interface Frontmatter {
  chapeau: string | null;
  title: string | null;
  subtitle: string | null;
  authors: string[];
  photographers: string[];
  illustrators: string[];
  date: string | null; // verbatim, exactly as printed
  intro: string | null;
  italics: FrontmatterItalic[];
}

export interface StyleSpan {
  text: string;
  style: InlineStyle[];
  /**
   * Which occurrence of `text` this means, counted from 0 within the paragraph
   * it belongs to. A word can appear twice in one block - a sidebar about the
   * kerndoelen opens on "Kerndoelen" and mentions them again three paragraphs
   * down - and without this the mark lands on whichever comes first, which is
   * only right half the time. Absent means the first, as it always did.
   */
  nth?: number;
}

export interface ListItem {
  content: string;
  styles: StyleSpan[];
}

export type ContentNode =
  | { type: 'paragraph'; content: string; styles: StyleSpan[] }
  | { type: 'subheading'; content: string }
  | { type: 'quote'; content: string }
  | { type: 'streamer'; content: string }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | {
      type: 'image';
      id: string;
      file: string | null;
      caption: string | null;
      credit: string | null;
      size: ImageSize;
    }
  | {
      type: 'insert';
      kind: string;
      title: string | null;
      /** The printed tint of the box, and the type colour on it. */
      background: string | null;
      ink: string | null;
      content: ContentNode[];
    };

/** The opening image of the article: the hero, not part of the running text. */
export interface ArticleHeader {
  id: string;
  file: string;
  alt: string | null;
}

export interface ArticleDocument {
  source: { file: string; pages: number[] };
  frontmatter: Frontmatter;
  header: ArticleHeader | null;
  content: ContentNode[];
}

// ─── Job & transport ─────────────────────────────────────────────────────────

export interface PageAsset {
  page: number;
  width: number;
  height: number;
  /**
   * The page's own size in points, the unit images are placed in. Older jobs have
   * none; it is then estimated from the images and the aspect of the render.
   */
  points?: { w: number; h: number };
  image: string;
  thumb: string;
  /** The page in quarters, what the styling run looks at. Older jobs have none. */
  tiles?: string[];
  /**
   * The typography as the PDF itself records it, read off its font table when
   * the page was rasterised. Where this exists it decides, because it is not a
   * reading of the page - it is what the page was set in.
   */
  styling?: StyleFragment[];
  /** Whether the PDF's own typography could be read, and if not, why not. */
  typography?: TypographySource;
  /**
   * Every word on the page as the PDF spells it. The OCR reads a picture and can
   * misread a diacritic; this is what settles those.
   */
  words?: string[];
}

export type JobStatus = 'uploading' | 'ready' | 'running' | 'done' | 'error';

export interface Job {
  id: string;
  filename: string;
  status: JobStatus;
  pageCount: number;
  pages: PageAsset[];
  createdAt: string;
  error: string | null;
  images: ExtractedImage[];
  document: ArticleDocument | null;
  /**
   * How many of the first pages make up the opening, when that is known: a
   * magazine scan says whether an article opens on a spread. Unknown for a PDF
   * dropped in on its own, and then the frontmatter looks at the first two.
   */
  opening?: number;
  /**
   * What the article is about, when a magazine scan said so. It lets the image
   * judgement tell the article's own pictures from an advert on the same page.
   */
  context?: ArticleContext;
}

export interface ArticleContext {
  title: string | null;
  rubric: string | null;
  about: string;
}

/**
 * Wat één verzoek aan de server kostte. De server telt niet meer over een hele
 * run heen, want die bestaat voor hem niet: de browser telt de stappen op.
 */
export interface RunUsage {
  calls: number;
  tokens: number;
  ocrPages: number;
  ai: number;
  ocr: number;
  currency: string;
  /** Wat Mistral deze sleutel per minuut toestaat, zodra het dat heeft gezegd. */
  mistralLimit: number | null;
}

export type RunEvent =
  | { type: 'status'; run: string; state: 'start' | 'ok' | 'fail'; page?: number; detail?: string }
  | { type: 'delta'; page: number; text: string }
  | { type: 'patch'; page: number; patch: Patch }
  /**
   * What run 2 read off the page, sent the moment it lands. It arrives while run
   * 1's text is still streaming, which is the point: the interface can set the
   * words as they appear instead of restyling the page once it is done.
   */
  | { type: 'styling'; page: number; fragments: StyleFragment[] }
  | { type: 'page'; page: number; result: PageResult }
  | { type: 'frontmatter'; frontmatter: Frontmatter }
  | { type: 'images'; verdicts: ImageVerdict[] }
  | {
      type: 'done';
      document: ArticleDocument;
      pages: PageResult[];
      runs: number;
      tokens: number;
      /**
       * What Mistral was asked to do. It bills per page it processes, and reading
       * a page block by block turns one page into fifty, so this is counted from
       * what Mistral itself reports rather than guessed at.
       */
      ocr: { calls: number; pages: number; euro: number };
      /**
       * The bill, at the providers' list prices. The model half is a ceiling:
       * cached input reads cost a fraction of a fresh one and the ledger cannot
       * tell which were which.
       */
      cost: { ai: number; ocr: number; total: number; currency: string };
      /** Wall clock of the whole run, in milliseconds. */
      ms: number;
    };
