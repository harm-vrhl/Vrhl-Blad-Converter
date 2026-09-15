import { askJson } from '../llm/chat';
import { promptFor } from '../prompts';
import type { BoundaryVerdict } from '../magazine/types';
import { AgentCtx, nullableStr, obj, pageImageUrl, str } from './common';

const VERDICTS: BoundaryVerdict[] = ['eindigt-ervoor', 'eindigt-op-beginpagina', 'loopt-verder', 'onduidelijk'];
const TEXT = 2500;

const schema = obj({
  verdict: {
    type: 'string',
    enum: VERDICTS,
    description:
      'eindigt-ervoor: the previous article is over before the new one starts. ' +
      'eindigt-op-beginpagina: its last text stands on the same page the new one opens on. ' +
      'loopt-verder: it continues on a later page. ' +
      'onduidelijk: you cannot tell from what you are given.'
  },
  continuesOn: nullableStr('Only for loopt-verder: the printed page number it continues on, if the page says so.'),
  reason: str('One or two sentences, in Dutch: what in the content decided it.')
});

export interface ArticleSide {
  title: string | null;
  rubric: string | null;
  /** What each of its pages is about, as the page scan saw it. */
  about: string[];
}

export interface BoundaryInput {
  previous: ArticleSide;
  next: ArticleSide;
  /** Page labels for the prompt, "PDF 14 (gedrukt 12)". */
  lastPageName: string;
  startPageName: string;
  lastImage: string;
  startImage: string;
  lastText: string;
  startText: string;
  /** True when the last page of the previous article and the start page are the same page. */
  samePage: boolean;
}

/**
 * Where does the previous article end? Asked once per transition, with both
 * articles described, because what decides it is the content: whether this
 * paragraph is still about the same people and the same story.
 */
export async function checkBoundary(
  ctx: AgentCtx,
  input: BoundaryInput
): Promise<{ verdict: BoundaryVerdict; continuesOn: string | null; reason: string }> {
  const prompt = promptFor('grenscontrole');

  const images = input.samePage ? [input.startImage] : [input.lastImage, input.startImage];
  const raw = await askJson<{ verdict: BoundaryVerdict; continuesOn: string | null; reason: string }>({
    agent: 'grenscontrole',
    ledger: ctx.ledger,
    instructions: prompt.instructions,
    effort: prompt.effort,
    maxOutputTokens: prompt.maxOutputTokens,
    input: [
      `PREVIOUS ARTICLE`,
      describe(input.previous),
      '',
      `NEW ARTICLE, starting on ${input.startPageName}`,
      describe(input.next),
      '',
      input.samePage
        ? `The page scan found both on ${input.startPageName}. The one image is that page.`
        : `Image 1 is ${input.lastPageName}, the last page found for the previous article. Image 2 is ${input.startPageName}.`,
      '',
      input.samePage ? '' : `Text of ${input.lastPageName}, the end of it:\n${tail(input.lastText, TEXT)}\n`,
      `Text of ${input.startPageName}:\n${clip(input.startText, TEXT)}`
    ].join('\n'),
    images: await Promise.all(images.map((image) => pageImageUrl(ctx, image))),
    schemaName: 'grenscontrole',
    schema
  });

  return {
    verdict: VERDICTS.includes(raw.verdict) ? raw.verdict : 'onduidelijk',
    continuesOn: (raw.continuesOn ?? '').trim() || null,
    reason: (raw.reason ?? '').trim()
  };
}

function describe(side: ArticleSide): string {
  return [
    `Title: ${side.title ?? '(none found)'}`,
    side.rubric ? `Rubric: ${side.rubric}` : '',
    side.about.length ? `What its pages are about:\n${side.about.map((a) => `- ${a}`).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t ? (t.length > max ? `${t.slice(0, max)}…` : t) : '(no text layer)';
}

function tail(text: string, max: number): string {
  const t = text.trim();
  return t ? (t.length > max ? `…${t.slice(-max)}` : t) : '(no text layer)';
}
