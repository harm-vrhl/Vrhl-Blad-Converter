import { askJson } from '../llm/chat';
import { promptFor } from '../prompts';
import type { Facing, PageKind, PageScan, PagePiece, TocEntry } from '../magazine/types';
import { AgentCtx, nullableStr, obj, pageImageUrl, str } from './common';

const KINDS: PageKind[] = ['omslag', 'inhoudsopgave', 'artikel', 'advertentie', 'colofon', 'overig'];
const FACINGS: Facing[] = ['vorige', 'volgende', 'geen'];

/** How much of a page's text layer goes along. A dense page runs to 8000 characters. */
const TEXT_LIMIT = 6000;
/** How much of the neighbours: enough to tell whether a sentence carries on. */
const NEIGHBOUR = 400;

const schema = obj({
  kind: { type: 'string', enum: KINDS, description: 'What this page is, as a whole.' },
  facing: {
    type: 'string',
    enum: FACINGS,
    description:
      'Which neighbour this page faces in the printed magazine: vorige (this is a right-hand page), ' +
      'volgende (this is a left-hand page), geen (it stands alone, or is a two-page spread already).'
  },
  folio: nullableStr('The printed page number, verbatim. "24-25" on a spread. Null when none is printed.'),
  pieces: {
    type: 'array',
    description: 'Every editorial piece that has text on this page, top to bottom, left to right. Empty for an advert or a cover.',
    items: obj({
      starts: { type: 'boolean', description: 'True if the piece opens on this page (its headline is here).' },
      title: nullableStr('The headline, verbatim, if it is on this page.'),
      rubric: nullableStr('The section or rubric label, verbatim, if one is printed for this piece.'),
      about: str('One sentence, in Dutch, on what this piece is about as far as this page shows.'),
      continuesOn: nullableStr('A printed page number the text says it continues on, like "lees verder op pagina 64".'),
      continuedFrom: nullableStr('A printed page number the text says it continues from, like "vervolg van pagina 12".')
    })
  },
  toc: {
    type: 'array',
    description: 'Only on a table of contents page: every entry. Otherwise empty.',
    items: obj({
      title: str('The entry title, verbatim.'),
      rubric: nullableStr('The rubric the entry is listed under, verbatim.'),
      page: str('The printed page number of the entry, verbatim.')
    })
  }
});

export interface PageScanInput {
  pdf: number;
  total: number;
  image: string;
  /** The neighbours' images, so the run can see which one this page faces. */
  previousImage: string | null;
  nextImage: string | null;
  /** True when this PDF page is wider than tall: a spread on its own. */
  isSpread: boolean;
  text: string;
  label: string | null;
  previousText: string;
  nextText: string;
}

/**
 * One page of a whole magazine: what is on it. It does not decide where an
 * article ends; it says what it sees here, and the stitching and the boundary
 * check do the rest with every page in hand.
 *
 * It sees the page between its two neighbours, because a reader never sees a
 * page alone. A headline on the left and its intro on the right, or a photo on
 * the left and the headline on the right, only read as one opening side by side.
 */
export async function scanPage(ctx: AgentCtx, input: PageScanInput): Promise<PageScan> {
  const prompt = promptFor('paginascan');
  const text = input.text.trim();
  const images = [input.previousImage, input.image, input.nextImage].filter((i): i is string => Boolean(i));
  const order = [
    input.previousImage ? `the previous page (PDF ${input.pdf - 1})` : '',
    `THIS page (PDF ${input.pdf}), the one you report on`,
    input.nextImage ? `the next page (PDF ${input.pdf + 1})` : ''
  ].filter(Boolean);

  const raw = await askJson<Omit<PageScan, 'pdf'>>({
    agent: 'paginascan',
    ledger: ctx.ledger,
    instructions: prompt.instructions,
    effort: prompt.effort,
    maxOutputTokens: prompt.maxOutputTokens,
    input: [
      `PDF page ${input.pdf} of ${input.total}.`,
      `The images, in order: ${order.map((o, i) => `image ${i + 1} is ${o}`).join('; ')}. Report on THIS page only; the neighbours are there to see which one it faces and whether its content carries over.`,
      input.isSpread ? 'This PDF page is wider than tall: it is a two-page spread on its own, so it faces nothing.' : '',
      !input.previousImage ? 'There is no previous page: this page cannot face "vorige".' : '',
      !input.nextImage ? 'There is no next page: this page cannot face "volgende".' : '',
      input.label ? `The PDF labels this page "${input.label}". A label can simply count from 1; trust the printed number over it.` : '',
      '',
      text
        ? `The text layer of this page (in file order, which is not always reading order):\n\n${clip(text, TEXT_LIMIT)}`
        : 'This page has no text layer. Read it off the image.',
      '',
      input.previousText.trim() ? `End of the previous page's text:\n${tail(input.previousText, NEIGHBOUR)}` : 'There is no previous page, or it has no text.',
      '',
      input.nextText.trim() ? `Start of the next page's text:\n${clip(input.nextText, NEIGHBOUR)}` : 'There is no next page, or it has no text.'
    ].join('\n'),
    images: await Promise.all(images.map((image) => pageImageUrl(ctx.jobId, image))),
    schemaName: 'paginascan',
    schema
  });

  // What the run cannot have seen is not taken from it.
  let facing: Facing = FACINGS.includes(raw.facing) ? raw.facing : 'geen';
  if (input.isSpread || (facing === 'vorige' && !input.previousImage) || (facing === 'volgende' && !input.nextImage)) {
    facing = 'geen';
  }

  return {
    pdf: input.pdf,
    kind: KINDS.includes(raw.kind) ? raw.kind : 'overig',
    facing,
    folio: tidy(raw.folio),
    pieces: (raw.pieces ?? []).map(
      (p): PagePiece => ({
        starts: Boolean(p.starts),
        title: tidy(p.title),
        rubric: tidy(p.rubric),
        about: (p.about ?? '').trim(),
        continuesOn: tidy(p.continuesOn),
        continuedFrom: tidy(p.continuedFrom)
      })
    ),
    toc: (raw.toc ?? [])
      .map((t): TocEntry => ({ title: (t.title ?? '').trim(), rubric: tidy(t.rubric), page: (t.page ?? '').trim() }))
      .filter((t) => t.title && t.page)
  };
}

function tidy(value: string | null | undefined): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}
