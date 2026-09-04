import { cleanupText } from './cleanup';
import { pad2 } from './util';
import type { Block, Continuity, ExtractedImage } from './types';

/**
 * Run 1 writes the page as plain text with a handful of markers. Plain text
 * streams to the interface as it is written, and the markers are few enough that
 * the model rarely gets them wrong, anything it does get wrong falls through as
 * an ordinary paragraph rather than being lost.
 *
 *   ## a subheading
 *   > a pull quote
 *   ~ a streamer
 *   [image: crop-3-01 | caption | credit]
 *   [insert: Title] … [/insert]
 *   [continues-from-previous: ja] / [continues-on-next: nee]
 */
export function parsePage(
  page: number,
  raw: string,
  available: ExtractedImage[]
): { blocks: Block[]; continuity: Continuity } {
  const blocks: Block[] = [];
  let fromPrevious = false;
  let onNext = false;

  let paragraph: string[] = [];
  let insert: { title: string; lines: string[] } | null = null;
  let pending: Array<Omit<Block, 'id' | 'page'>> = [];

  const push = (block: Omit<Block, 'id' | 'page'>) => {
    blocks.push({ ...block, id: `p${page}-${pad2(blocks.length + 1)}`, page });
  };

  const flushParagraph = () => {
    const text = cleanupText(paragraph.join('\n'));
    paragraph = [];
    if (text) push({ type: 'paragraph', text });
  };

  const flushInsert = () => {
    if (!insert) return;
    const paragraphs = insert.lines
      .join('\n')
      .split(/\n\s*\n/)
      .map((chunk) => cleanupText(chunk))
      .filter(Boolean);
    const title = cleanupText(insert.title);
    insert = null;
    if (title || paragraphs.length) push({ type: 'insert', text: title, paragraphs });
    for (const image of pending) push(image);
    pending = [];
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();

    const flow = /^\[continues-(from-previous|on-next)\s*:\s*([^\]]*)\]$/i.exec(trimmed);
    if (flow) {
      const yes = /^(ja|yes|true|1)$/i.test(flow[2].trim());
      if (flow[1].toLowerCase() === 'from-previous') fromPrevious = yes;
      else onNext = yes;
      continue;
    }

    if (insert) {
      if (/^\[\/insert\]$/i.test(trimmed)) {
        flushInsert();
        continue;
      }
      // A box can hold a photo. The marker is not part of its text, so hold the
      // image and place it right after the box.
      const inside = /^\[image\s*:?\s*([^\]]*)\]$/i.exec(trimmed);
      if (inside) pending.push(imageBlock(inside[1], available));
      else insert.lines.push(trimmed);
      continue;
    }

    const open = /^\[insert\s*:?\s*([^\]]*)\]$/i.exec(trimmed);
    if (open) {
      flushParagraph();
      insert = { title: open[1].trim(), lines: [] };
      continue;
    }

    const image = /^\[image\s*:?\s*([^\]]*)\]$/i.exec(trimmed);
    if (image) {
      flushParagraph();
      push(imageBlock(image[1], available));
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    const marked = /^(##|>|~)\s+(.*)$/.exec(trimmed);
    if (marked) {
      flushParagraph();
      const text = cleanupText(marked[2]);
      if (text) push({ type: marked[1] === '##' ? 'subheading' : marked[1] === '>' ? 'quote' : 'streamer', text });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushInsert(); // an insert the model forgot to close still belongs to the page

  return { blocks, continuity: { continuesFromPrevious: fromPrevious, continuesOnNext: onNext } };
}

function imageBlock(body: string, available: ExtractedImage[]): Omit<Block, 'id' | 'page'> {
  const parts = body.split('|').map((part) => part.trim());
  let ref: string | null = null;
  if (parts[0] && available.some((c) => c.id === parts[0])) ref = parts.shift() as string;
  else if (/^(img-[\w-]+|crop-[\w-]+|-)?$/i.test(parts[0] ?? '')) parts.shift();

  const value = (raw: string | undefined) => {
    const text = (raw ?? '').trim();
    return text && text !== '-' ? cleanupText(text) : null;
  };

  return {
    type: 'image',
    text: value(parts[0]) ?? '',
    caption: value(parts[0]),
    credit: value(parts[1]),
    ref,
    file: available.find((c) => c.id === ref)?.file ?? null
  };
}

/** Everything run 1 actually put on the page, with the markers stripped off. */
export function textOf(blocks: Block[]): string {
  return blocks
    .flatMap((b) => [b.text, ...(b.paragraphs ?? []), b.caption ?? '', b.credit ?? ''])
    .filter(Boolean)
    .join('\n');
}
