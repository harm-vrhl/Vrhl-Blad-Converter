import { askJson } from '../llm/openai';
import type { InlineStyle } from '../types';
import { promptFor } from '../prompts';
import { AgentCtx, obj, pageImageUrl, str, strArray } from './common';

/**
 * AI run 2: the typography, in one look at the page and nothing else.
 *
 * It is deliberately told nothing about what run 1 is writing. Two things follow
 * from that, and both are the point. It can start the moment the page image
 * exists, alongside run 1 rather than behind it, so the reader watching the text
 * appear sees it appear already set. And it cannot name a block, which means it
 * has to quote the page instead - the words as printed, and the words just before
 * them. Those two together are what the placer needs to put the mark on the right
 * occurrence of a word that turns up twice on the page.
 */
export type FragmentKind = 'text' | 'title' | 'streamer';

/** One run of type the page sets apart, as the page itself shows it. */
export interface StyleFragment {
  /** The characters exactly as printed. */
  text: string;
  /** The two or three words printed before it, which is how it is found again. */
  before: string;
  style: InlineStyle[];
  /** A heading and a pull quote carry their weight through their role, not inline. */
  kind: FragmentKind;
}

const STYLES: InlineStyle[] = ['bold', 'italic', 'underline'];
const KINDS: FragmentKind[] = ['text', 'title', 'streamer'];

const schema = obj({
  fragments: {
    type: 'array',
    description: 'One entry per marked fragment. Empty when the page holds none.',
    items: obj({
      text: str('The characters exactly as printed, and nothing either side of them.'),
      before: str('The two or three words printed immediately before it. Empty if it opens its paragraph.'),
      styles: strArray('Only bold, italic or underline.'),
      kind: { type: 'string', enum: KINDS, description: 'Where it sits: running text, a heading, or a pull quote.' }
    })
  }
});

export async function detectStyling(
  ctx: AgentCtx,
  page: number,
  images: string[]
): Promise<StyleFragment[]> {
  if (!images.length) return [];

  const prompt = promptFor('styling');
  // The vision API fits every image to 768px on its short side. A whole page
  // spends that budget on the whole page, which leaves a magazine's body type
  // about five pixels of x-height - too little to read a slant or a stroke off.
  // So the page arrives in quarters, each with that budget to itself.
  const cut =
    images.length > 1
      ? `\n\nThe page comes in ${images.length} overlapping parts, in reading order; together they are this one page.`
      : '';

  const result = await askJson<{
    fragments: Array<{ text?: string; before?: string; styles?: string[]; kind?: string }>;
  }>({
    agent: `styling p${page}`,
    ledger: ctx.ledger,
    instructions: prompt.instructions,
    effort: prompt.effort,
    maxOutputTokens: prompt.maxOutputTokens,
    input: `Page ${page}.${cut}`,
    images: await Promise.all(images.map((file) => pageImageUrl(ctx.jobId, file))),
    schemaName: 'style_fragments',
    schema
  });

  return (result.fragments ?? [])
    .map((f) => ({
      text: (f.text ?? '').trim(),
      before: (f.before ?? '').trim(),
      // Anything the run invents outside the three marks is held to them here.
      style: (f.styles ?? []).filter((s): s is InlineStyle => STYLES.includes(s as InlineStyle)),
      kind: (KINDS.includes(f.kind as FragmentKind) ? f.kind : 'text') as FragmentKind
    }))
    .filter((f) => f.text.length > 1 && f.style.length > 0);
}
