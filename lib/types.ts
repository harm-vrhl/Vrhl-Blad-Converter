// ─── The model ───────────────────────────────────────────────────────────────
// Per page, two AI runs and nothing more:
//   run 1  writes the page out in reading order, inserts, quotes and images
//          included, each in its place;
//   run 2  looks only at typography and replaces the styled words in run 1's
//          output.
// Mistral's word index is the check on both.

export type InlineStyle = 'bold' | 'italic' | 'underline' | 'strikethrough';

export type BlockType = 'paragraph' | 'subheading' | 'quote' | 'streamer' | 'image' | 'insert';

/** One addressable unit of a page, as written by run 1. */
export interface Block {
  id: string; // p3-01
  page: number;
  type: BlockType;
  /** Paragraph, subheading, quote and streamer text; the title of an insert. */
  text: string;
  /** Insert body, one entry per paragraph. */
  paragraphs?: string[];
  /** Where the box sits: beside the story, or after it. */
  placement?: 'inline' | 'end';
  caption?: string | null;
  credit?: string | null;
  /** Id of the bitmap ripped from the PDF, when run 1 named one. */
  ref?: string | null;
  file?: string | null;
}

/** Run 2's only output: a fragment of a block that carries inline styling. */
export interface StylePatch {
  op: 'style';
  target: string;
  find: string;
  style: InlineStyle[];
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
}

export type ImageKind = 'photo' | 'illustration' | 'portrait' | 'chart' | 'logo' | 'ornament' | 'rule' | 'other';

export interface ImageVerdict {
  id: string;
  keep: boolean;
  kind: ImageKind;
  reason: string;
}

// ─── OCR ─────────────────────────────────────────────────────────────────────

export interface OcrPage {
  page: number;
  markdown: string;
}

// ─── Per page ────────────────────────────────────────────────────────────────

export interface Continuity {
  continuesFromPrevious: boolean;
  continuesOnNext: boolean;
}

export interface PageResult {
  page: number;
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
}

export type ContentNode =
  | { type: 'paragraph'; content: string; styles: StyleSpan[] }
  | { type: 'subheading'; content: string }
  | { type: 'quote'; content: string }
  | { type: 'streamer'; content: string }
  | { type: 'image'; id: string; file: string | null; caption: string | null; credit: string | null }
  | { type: 'insert'; kind: string; title: string | null; content: ContentNode[] };

export interface ArticleDocument {
  source: { file: string; pages: number[] };
  frontmatter: Frontmatter;
  content: ContentNode[];
}

// ─── Job & transport ─────────────────────────────────────────────────────────

export interface PageAsset {
  page: number;
  width: number;
  height: number;
  image: string;
  thumb: string;
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
}

export type RunEvent =
  | { type: 'status'; run: string; state: 'start' | 'ok' | 'fail'; page?: number; detail?: string }
  | { type: 'delta'; page: number; text: string }
  | { type: 'patch'; page: number; patch: Patch }
  | { type: 'page'; page: number; result: PageResult }
  | { type: 'frontmatter'; frontmatter: Frontmatter }
  | { type: 'images'; verdicts: ImageVerdict[] }
  | { type: 'done'; document: ArticleDocument; pages: PageResult[]; runs: number; tokens: number };
