'use client';

import type { StyleFragment } from '../agents/styling';
import type { InlineStyle } from '../types';

/**
 * The typography, read out of the PDF instead of guessed off a picture of it.
 *
 * A print PDF carries a font per run of characters, and the font's own name says
 * what it is: AntoniaText-Regular for the body, AntoniaText-Bold for the
 * interviewer's questions, DoverSansText-Italic for the book titles. That is not
 * an estimate of the typography, it is the typography - the same table the RIP
 * used to put ink on paper.
 *
 * So where a text layer exists this is what decides, and the run that looks at
 * the page image is kept only for the documents that have none: a scan, or an
 * export that flattened its text into pixels. A model reading a page at ten
 * pixels of x-height will always be a little different each time it looks. This
 * is the same every time, costs nothing, and cannot miss a word it can see.
 */

/** Font names that mean weight, and names that mean slant. */
const BOLD = /bold|black|heavy|semib|demi/i;
const ITALIC = /italic|oblique|kursiv/i;
/**
 * Any word a foundry uses to name a cut. This is not asked to decide anything -
 * it is asked whether the names on this page mean ANYTHING at all.
 *
 * pdf.js hands over the font's name and nothing else: there is no italic angle
 * and no weight flag on the text layer, with or without fontExtraProperties. So
 * where a producer wrote out "AntoniaText-Bold" this knows everything, and where
 * one wrote "F1" it knows nothing - and those two have to be told apart, because
 * silently reading no emphasis off a page full of it is worse than not trying.
 */
const NAMED = /bold|black|heavy|semi|demi|medium|regular|roman|book|light|thin|italic|oblique|kursiv|cond/i;
/** A subsetted font arrives as "VMGCYC+AntoniaText-Bold"; the tag is not a name. */
const SUBSET = /^[A-Z]{6}\+/;

/** Type this much larger than the body is a heading or a drop cap, not emphasis. */
const HEADING_SCALE = 1.5;
/** How much of the preceding text is kept, to tell one occurrence from another. */
const BEFORE = 24;
/**
 * A line further from the last one than this is a new paragraph or a new block,
 * and a run may not carry across it - or a subhead set in the same face as the
 * question below it comes out as one fragment, "VeiligJe bent je loopbaan...",
 * which is nowhere in the article.
 */
const LINE_GAP = 1.8;
/** A gap on the same line this wide is a new column, not a wide space. */
const COLUMN_GAP = 2.5;
/**
 * How close something has to be to count as standing NEXT to a fragment. A word
 * space is well under one em; a column gutter is two or more. The line between
 * them is what tells a bold lead-in, which the sentence carries straight on from,
 * from a subhead, which has its line to itself while another column runs beside it.
 */
const ABUTS = 1.2;
/**
 * Running heads and folios sit outside the text frame. They are set in the same
 * bold as things in the body - "Onze Taal" is both the magazine's name in the
 * corner of every page and a word inside the article - so a mark taken from the
 * margin would land on the body text instead.
 */
const MARGIN = 0.055;
/**
 * A font with its own encoding and no ToUnicode table gives back the glyph codes
 * rather than the characters: "Inspiring Investor Confidence" arrives as
 * ",QVSLULQJ ,QYHVWRU &RQfLGHQFH", every letter shifted by the same amount, with
 * the word spaces coming through as control characters. The text is unusable and
 * it is unusable in a way that shows, so it is dropped here rather than left to
 * be reported as a mark that matches nothing.
 */
const BROKEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

interface Piece {
  text: string;
  /**
   * The face it is set in, not just whether that face is bold. A subhead and the
   * question under it can both be bold and still be two different fonts -
   * DoverSansText-Bold above AntoniaText-Bold - and running them together makes
   * one fragment out of two marks, which then matches nothing at all.
   */
  font: string;
  style: InlineStyle[];
  size: number;
  /** Baseline position on the page, in PDF units. */
  x: number;
  y: number;
  width: number;
  /** This piece begins a new paragraph, block or column. */
  breaks: boolean;
  /** Another piece sits right beside this one, on the same line and in the same column. */
  leftward: boolean;
  rightward: boolean;
}

/**
 * `page` is a pdf.js PageProxy. The operator list is asked for first and thrown
 * away: building it is what makes pdf.js load the font objects, and without them
 * every run comes back with an unresolvable id instead of a name.
 */
/**
 * Why a page came back without typography. "none" is an answer; the other two are
 * the absence of one, and only they are a reason to go and look at the picture.
 */
export type TypographySource = 'read' | 'no-text-layer' | 'unnamed-fonts';

export interface Typography {
  fragments: StyleFragment[];
  source: TypographySource;
  /**
   * Every word on the page as the file spells it. The OCR reads the page from a
   * picture and can misread a diacritic - it made the Frisian "dûmny" into
   * "dümny" - where the file simply says which letter it is.
   */
  words: string[];
}

export async function readTypography(page: {
  getOperatorList: () => Promise<unknown>;
  getTextContent: () => Promise<{ items: unknown[] }>;
  getViewport: (opts: { scale: number }) => { height: number };
  commonObjs: { get: (id: string) => unknown };
}): Promise<Typography> {
  try {
    await page.getOperatorList();
  } catch {
    // Without the fonts there is nothing to read here; the page image run will
    // have to do the work instead.
    return { fragments: [], source: 'no-text-layer', words: [] };
  }

  const content = await page.getTextContent();
  const height = page.getViewport({ scale: 1 }).height;
  const names = new Map<string, string>();
  const fonts = new Set<string>();
  const pieces: Piece[] = [];
  let last: Piece | null = null;

  for (const raw of content.items) {
    const item = raw as { str?: string; fontName?: string; transform?: number[]; width?: number; height?: number };
    if (!item.str || !item.fontName) continue;

    let name = names.get(item.fontName);
    if (name === undefined) {
      name = nameOf(page, item.fontName);
      names.set(item.fontName, name);
    }
    if (!name) return { fragments: [], source: 'no-text-layer', words: [] };
    fonts.add(name);

    // The vertical scale of the text matrix is the size it is actually set at.
    const size = Math.abs(item.transform?.[3] ?? item.height ?? 0);
    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    // Page furniture, and not part of the article at all.
    if (height && (y > height * (1 - MARGIN) || y < height * MARGIN)) {
      last = null;
      continue;
    }

    const piece: Piece = {
      text: item.str,
      font: name,
      style: [],
      size,
      x,
      y,
      width: item.width ?? 0,
      breaks: apart(last, { size, x, y }),
      leftward: false,
      rightward: false
    };
    pieces.push(piece);
    last = piece;
  }

  if (!pieces.length) return { fragments: [], source: 'no-text-layer', words: [] };
  // Names that say nothing are not evidence that there is nothing to say. An
  // empty answer means "no emphasis on this page", and the pipeline believes it;
  // so where the names cannot carry that meaning, say so instead.
  if (![...fonts].some((name) => NAMED.test(name))) return { fragments: [], source: 'unnamed-fonts', words: wordsOf(pieces) };

  neighbours(pieces);
  const body = bodySize(pieces);
  const face = bodyFace(pieces, body);
  // Now that the body is known, every piece can be read against it.
  for (const piece of pieces) piece.style = styleOf(piece.font, face, piece.size);

  return { fragments: runsOf(pieces, body, familyOf(face?.font ?? '')), source: 'read', words: wordsOf(pieces) };
}

const WORD = /[\p{L}\p{N}]+/gu;
/** Dutch words that legitimately follow a dangling hyphen ("kunst- en cultuurbeleid"). */
const FOLLOWS = new Set(['en', 'of', 'noch', 'dan', 'tot', 'in', 'als']);

/**
 * The words on the page, spelt as the file spells them.
 *
 * Two things have to be right or the list is worse than none. Pieces that abut
 * are one word - "g", "áá" and "t" are three items and one word, and joining them
 * with spaces would turn "gáát" into three fragments and lose the accents. And a
 * word broken over a line has to be put back together, with the same rule the
 * cleanup step uses, or half of every hyphenated word looks like a word of its own.
 */
function wordsOf(pieces: Piece[]): string[] {
  let text = '';
  let last: Piece | null = null;

  for (const piece of pieces) {
    if (last) {
      const measure = Math.max(piece.size, last.size) || 1;
      const sameLine = Math.abs(last.y - piece.y) < measure * 0.5;
      const gap = piece.x - (last.x + last.width);
      text += !sameLine ? '\n' : gap > measure * 0.15 ? ' ' : '';
    }
    text += piece.text;
    last = piece;
  }

  // The hyphen is often an item of its own at the end of the line, so allow for a
  // space having been put in front of it.
  const mended = text.replace(/(\p{Ll})[ \t]*[-\u00ad][ \t]*\n\s*(\p{L}+)/gu, (_m, head: string, tail: string) =>
    FOLLOWS.has(tail.toLowerCase()) ? `${head}- ${tail}` : `${head}${tail}`
  );
  return mended.match(WORD) ?? [];
}

/** Is this piece somewhere else on the page than the one before it? */
function apart(last: Piece | null, next: { size: number; x: number; y: number }): boolean {
  if (!last) return true;
  const measure = Math.max(next.size, last.size) || 1;
  const drop = last.y - next.y;

  // Back up the page, or across to another column: a different block either way.
  if (drop < -measure * 0.5) return true;
  // Further down than one line of this type: a paragraph break or a new block.
  if (drop > measure * LINE_GAP) return true;
  // Still on the same line, but a long way along it.
  if (Math.abs(drop) < measure * 0.5 && next.x - (last.x + last.width) > measure * COLUMN_GAP) return true;
  return false;
}

function nameOf(page: { commonObjs: { get: (id: string) => unknown } }, id: string): string {
  try {
    const font = page.commonObjs.get(id) as { name?: string } | undefined;
    return (font?.name ?? '').replace(SUBSET, '');
  } catch {
    return '';
  }
}

/**
 * Where a cut sits on the foundry's own ladder. Tested from the most specific
 * name down, because "extralight" holds "light" and "semibold" holds "bold".
 */
function weightOf(name: string): number {
  if (/black|heavy|fat|ultra(?!light)/i.test(name)) return 90;
  if (/extrabold|ultrabold/i.test(name)) return 80;
  if (/semib|demib|semi|demi/i.test(name)) return 60;
  if (/bold/i.test(name)) return 70;
  if (/medium/i.test(name)) return 50;
  if (/book/i.test(name)) return 45;
  if (/extralight|ultralight/i.test(name)) return 20;
  if (/light/i.test(name)) return 30;
  if (/thin|hairline/i.test(name)) return 10;
  return 40; // regular, roman, or a name that says nothing about weight
}

const BOLD_AT = 70;

/**
 * What a cut means, read against the cut the page's own body is set in.
 *
 * A name is not enough on its own, because "bold" is not a property of a font -
 * it is a contrast with what surrounds it. A magazine that sets its columns in
 * PublicoHeadline-Light and its emphasis in PublicoHeadline-Roman has emphasis
 * that no name calls bold; against Light, Roman IS the heavy one. So a cut of the
 * body's own family, at the body's own size, counts as bold when it stands higher
 * on the ladder than the body does - however it happens to be named.
 *
 * The two conditions matter. Another family is another block's face, and another
 * size is a heading or a colophon; neither is emphasis inside a sentence.
 */
function styleOf(name: string, body: { font: string; size: number } | null, size: number): InlineStyle[] {
  const style: InlineStyle[] = [];
  const weight = weightOf(name);

  const heavierThanBody =
    body !== null &&
    familyOf(name) === familyOf(body.font) &&
    Math.abs(size - body.size) <= Math.max(0.5, body.size * 0.1) &&
    weight > weightOf(body.font);

  if (weight >= BOLD_AT || heavierThanBody) style.push('bold');
  if (ITALIC.test(name)) style.push('italic');
  return style;
}

/**
 * The size the body is set at: the one most of the page's characters are in.
 * Everything is measured against this rather than against a fixed number, because
 * a magazine sets its body at whatever it likes.
 */
function bodySize(pieces: Piece[]): number {
  const weight = new Map<number, number>();
  for (const piece of pieces) {
    const size = Math.round(piece.size * 2) / 2;
    if (size <= 0) continue;
    weight.set(size, (weight.get(size) ?? 0) + piece.text.trim().length);
  }
  let best = 0;
  let most = 0;
  for (const [size, chars] of weight) {
    if (chars > most) {
      most = chars;
      best = size;
    }
  }
  return best;
}

/**
 * Consecutive pieces set in the same face, in the same place, are one fragment.
 * What comes out is shaped exactly like what the page-image run reports, so both
 * go through the same placer: the words as the page prints them, and the words
 * just before them.
 */
function runsOf(pieces: Piece[], body: number, family: string): StyleFragment[] {
  const out: StyleFragment[] = [];
  let text = '';
  let before = '';
  let font = '';
  let style: InlineStyle[] = [];
  let size = 0;
  let opensLine = true;
  let closesLine = true;

  const flush = () => {
    const trimmed = text.trim();
    const readable = trimmed.length > 0 && !BROKEN.test(trimmed);
    const heading =
      style.length > 0 && opensLine && closesLine && (size > body || familyOf(font) !== family);

    if (style.length && readable && (!body || size < body * HEADING_SCALE)) {
      out.push({
        text: trimmed,
        // A window of the preceding text, cut back to a whole word. The window is
        // taken first and trimmed after, never the other way round: trimming and
        // then cutting to length puts a half word back at the front, and a
        // `before` that opens halfway through "georganiseerd" anchors nothing.
        before: tailWords(before, BEFORE),
        style: [...style],
        // Inline emphasis sits INSIDE running text. Type that has its line to
        // itself and is either bigger than the body or from another family is a
        // subhead or a streamer - "Doomscrollen" in the sans above a serif
        // column - and marking that inline would put a subhead's weight on
        // whichever paragraph happened to contain the same word. A whole bold
        // paragraph also has its lines to itself, which is why the face has to
        // differ too: it is set in the body's own family, at the body's size.
        kind: heading ? 'title' : 'text'
      });
    }
    // A heading closes what came before it. The words that follow open a new
    // block, so they are anchored by opening it rather than by the heading -
    // which lives in a block of its own and would anchor them nowhere.
    before = heading ? '' : (before + text).slice(-BEFORE * 3);
    text = '';
  };

  for (const piece of pieces) {
    // A change of face ends a run, and so does a change of place.
    if (piece.font !== font || piece.breaks) {
      flush();
      if (piece.breaks) before = '';
      font = piece.font;
      style = piece.style;
      size = piece.size;
      // Nothing abuts the start of this run; whether anything abuts its end is
      // only known once it is finished.
      opensLine = !piece.leftward;
    }
    text += piece.text;
    size = Math.max(size, piece.size);
    closesLine = !piece.rightward;
  }
  flush();

  return out;
}

/**
 * Marks, for every piece, whether anything stands right beside it on its own line.
 *
 * Not merely on the same baseline: a magazine sets three columns, so a subhead in
 * the first shares its baseline with running text in the second and third, and
 * asking "is this all there is on this line" answers no for every subhead on the
 * page. What matters is whether something abuts it - the body text that carries on
 * from a bold lead-in does, the column two inches to the right does not.
 */
function neighbours(pieces: Piece[]): void {
  const perLine = new Map<number, Piece[]>();
  for (const piece of pieces) {
    const line = baseline(piece.y);
    const row = perLine.get(line) ?? [];
    row.push(piece);
    perLine.set(line, row);
  }

  for (const row of perLine.values()) {
    row.sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const left = row[i - 1];
      const right = row[i];
      const gap = right.x - (left.x + left.width);
      if (gap > Math.max(left.size, right.size) * ABUTS) continue;
      left.rightward = true;
      right.leftward = true;
    }
  }
}

/** Baselines within half a point of each other are the same line. */
function baseline(y: number): number {
  return Math.round(y * 2) / 2;
}

/** The cut the running text is set in, which everything else is measured against. */
function bodyFace(pieces: Piece[], body: number): { font: string; size: number } | null {
  const weight = new Map<string, number>();
  for (const piece of pieces) {
    if (body && Math.abs(piece.size - body) > 0.6) continue;
    weight.set(piece.font, (weight.get(piece.font) ?? 0) + piece.text.trim().length);
  }
  let best = '';
  let most = 0;
  for (const [font, chars] of weight) {
    if (chars > most) {
      most = chars;
      best = font;
    }
  }
  return best ? { font: best, size: body } : null;
}

/** The family a font belongs to, without the cut: AntoniaText-Bold -> AntoniaText. */
function familyOf(name: string): string {
  return name.split('-')[0] ?? name;
}

/**
 * The last `max` characters, beginning on a whole word.
 *
 * Only a window that actually lands in the middle of a word is trimmed. Trimming
 * unconditionally would throw away the first word of every window - and where the
 * whole context is one word, "In ", it would throw away all of it.
 */
function tailWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(-max);
  const cutInside = /\S/.test(text[text.length - max - 1] ?? '') && /\S/.test(window[0] ?? '');
  if (!cutInside) return window;
  const at = window.search(/\s/);
  return at < 0 ? '' : window.slice(at + 1);
}
