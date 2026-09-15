import { cleanupText } from './cleanup';
import { printedSize } from './imagefilter';
import { normalizeForCompare, pad2 } from './util';
import type { Block, Continuity, ExtractedImage, PageBlock } from './types';

/** A bullet: what a magazine sets in front of a list item. */
const BULLET = /^[-–•*]\s+(.*)$/;
/** A number: "1." or "2)" in front of a list item. */
const NUMBER = /^\d{1,2}[.)]\s+(.*)$/;

const IMAGE = /^\[image\s*:?\s*([^\]]*)\]$/i;
const BITMAP_ID = /^(img|crop)-[\w-]+$/i;
const INSERT_OPEN = /^\[insert\s*:?\s*([^\]]*)\]$/i;
const INSERT_CLOSE = /^\[\/insert\]$/i;
const FLOW = /^\[continues-(from-previous|on-next)\s*:\s*([^\]]*)\]$/i;

/**
 * Run 1 writes the page as plain text with a handful of markers. Plain text
 * streams to the interface as it is written, and the markers are few enough that
 * the model rarely gets them wrong, anything it does get wrong falls through as
 * an ordinary paragraph rather than being lost.
 *
 *   ## a subheading
 *   > a pull quote
 *   ~ a streamer
 *   - a list item          1. a numbered item
 *   [image: crop-3-01 | caption | credit]
 *   [insert: Title | #333333 | #F7F6F2] … [/insert]
 *   [continues-from-previous: ja] / [continues-on-next: nee]
 *
 * Inside a box the markers mean the same thing, so a box can hold a heading, a
 * list or a photo just as the page can. That is one reader, used twice.
 */
export function parsePage(
  page: number,
  raw: string,
  available: ExtractedImage[],
  /** Pictures that may only stand inside a box; see boxOnly. Named anywhere else, they are left out. */
  boxOnly: ExtractedImage[] = []
): { blocks: Block[]; continuity: Continuity } {
  const body = reader(available);
  let fromPrevious = false;
  let onNext = false;
  let box: { title: string; background: string | null; ink: string | null; inside: Reader } | null = null;

  const closeBox = () => {
    if (!box) return;
    const children = box.inside.done();
    const title = cleanupText(box.title);
    // Run 1 names the box in the marker. Where it wrote that same heading inside
    // the box as well, the box would carry it twice - and the word index would
    // see a word the page prints once being used twice.
    const first = children[0];
    if (title && first?.type === 'subheading' && normalizeForCompare(first.text) === normalizeForCompare(title)) {
      children.shift();
    }
    if (title || children.length) {
      body.push({ type: 'insert', text: title, children, background: box.background, ink: box.ink });
    }
    box = null;
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    const flow = FLOW.exec(trimmed);
    if (flow) {
      const yes = /^(ja|yes|true|1)$/i.test(flow[2].trim());
      if (flow[1].toLowerCase() === 'from-previous') fromPrevious = yes;
      else onNext = yes;
      continue;
    }

    if (box) {
      if (INSERT_CLOSE.test(trimmed)) closeBox();
      else box.inside.line(trimmed);
      continue;
    }

    const open = INSERT_OPEN.exec(trimmed);
    if (open) {
      // [insert: Titel | #333333 | #F7F6F2] — the title, the tint of the box and
      // the colour of the type on it. The colours are optional.
      const [title, background, ink] = open[1].split('|').map((part) => part.trim());
      body.flush();
      box = { title: title ?? '', background: hex(background), ink: hex(ink), inside: reader([...available, ...boxOnly]) };
      continue;
    }

    body.line(trimmed);
  }

  closeBox(); // a box the model forgot to close still belongs to the page

  const blocks = body.done().map((block, i) => ({ ...block, id: `p${page}-${pad2(i + 1)}`, page }));
  return { blocks, continuity: { continuesFromPrevious: fromPrevious, continuesOnNext: onNext } };
}

interface Reader {
  /** Feed one line of run 1's output. */
  line: (trimmed: string) => void;
  /** Close whatever is still open, without ending the run. */
  flush: () => void;
  /** Append a block that was built elsewhere. */
  push: (block: PageBlock) => void;
  done: () => PageBlock[];
}

/** Reads run 1's markers into blocks. One page, or one box on it. */
function reader(available: ExtractedImage[]): Reader {
  const blocks: PageBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item) => cleanupText(item)).filter(Boolean);
    const { ordered } = list;
    list = null;
    // One item is not a list; it is a paragraph that happens to open with a dash.
    if (items.length > 1) blocks.push({ type: 'list', text: items.join('\n'), items, ordered });
    else if (items.length === 1) blocks.push({ type: 'paragraph', text: items[0] });
  };

  const flushParagraph = () => {
    const text = cleanupText(paragraph.join('\n'));
    paragraph = [];
    if (text) blocks.push({ type: 'paragraph', text });
  };

  const flush = () => {
    flushList();
    flushParagraph();
  };

  return {
    flush,
    push: (block) => {
      flush();
      blocks.push(block);
    },
    done: () => {
      flush();
      return blocks;
    },
    line: (trimmed) => {
      const image = IMAGE.exec(trimmed);
      if (image) {
        flush();
        // An id this reader was not given is a picture the triage turned away, or
        // one that does not exist: leaving it out beats an empty frame.
        const id = image[1].split('|')[0].trim();
        if (!BITMAP_ID.test(id) || available.some((c) => c.id === id)) blocks.push(imageBlock(image[1], available));
        return;
      }

      if (!trimmed) {
        flush();
        return;
      }

      const marked = /^(##|>|~)\s+(.*)$/.exec(trimmed);
      if (marked) {
        flush();
        const text = cleanupText(marked[2]);
        if (text) {
          blocks.push({
            type: marked[1] === '##' ? 'subheading' : marked[1] === '>' ? 'quote' : 'streamer',
            text
          });
        }
        return;
      }

      // A run of bullets or numbers is one list. A different marker in the
      // middle of one closes it, so a bulleted list never swallows a numbered.
      const bullet = BULLET.exec(trimmed);
      const numbered = bullet ? null : NUMBER.exec(trimmed);
      if (bullet || numbered) {
        const ordered = Boolean(numbered);
        if (list && list.ordered !== ordered) flushList();
        if (!list) {
          flushParagraph();
          list = { ordered, items: [] };
        }
        list.items.push((bullet ?? numbered)![1]);
        return;
      }

      flushList(); // prose after a list means the list has ended
      paragraph.push(trimmed);
    }
  };
}

/** A colour the model read off the page, only in the form the reader accepts. */
function hex(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    const [r, g, b] = text.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return null;
}

/**
 * A caption or credit that is nothing but an embedded file's own name - a stray
 * "img-1.jpeg" the OCR handed back because the picture carried no real text near
 * it. That is not a caption anyone wrote, so it is dropped rather than printed.
 */
const FILENAME = /^[\w-]+\.(jpe?g|png|gif|tiff?|bmp|webp|heic|heif|svg|eps)$/i;

function imageBlock(body: string, available: ExtractedImage[]): PageBlock {
  const parts = body.split('|').map((part) => part.trim());
  let ref: string | null = null;
  if (parts[0] && available.some((c) => c.id === parts[0])) ref = parts.shift() as string;
  else if (parts[0] === '-' || !parts[0]) parts.shift();

  const value = (raw: string | undefined) => {
    const text = (raw ?? '').trim();
    if (!text || text === '-' || FILENAME.test(text)) return null;
    return cleanupText(text);
  };

  const bitmap = available.find((c) => c.id === ref);
  return {
    type: 'image',
    text: value(parts[0]) ?? '',
    caption: value(parts[0]),
    credit: value(parts[1]),
    ref,
    file: bitmap?.file ?? null,
    size: bitmap ? printedSize(bitmap) : 'normal'
  };
}

/** Everything run 1 actually put on the page, with the markers stripped off. */
export function textOf(blocks: PageBlock[]): string {
  return blocks
    .flatMap((b) => [b.text, b.caption ?? '', b.credit ?? '', textOf(b.children ?? [])])
    .filter(Boolean)
    .join('\n');
}
