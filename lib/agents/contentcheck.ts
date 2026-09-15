import { askJson } from '../llm/chat';
import { promptFor } from '../prompts';
import type { ContentVerdict } from '../magazine/types';
import { AgentCtx, obj, pageImageUrl, str, strArray } from './common';

const VERDICTS: ContentVerdict[] = ['hoort-erbij', 'deels', 'hoort-er-niet-bij', 'onduidelijk'];
const TEXT = 5000;

const schema = obj({
  verdict: {
    type: 'string',
    enum: VERDICTS,
    description:
      'hoort-erbij: everything in question belongs to the article. ' +
      'deels: some of the pieces in question belong, some do not. ' +
      'hoort-er-niet-bij: none of the pieces in question belong to the article. ' +
      'onduidelijk: you cannot tell from what you are given.'
  },
  belonging: strArray('Only for deels: the titles, verbatim as given, of the pieces that DO belong to the article.'),
  reason: str('One or two sentences, in Dutch: what in the content decided it.')
});

export interface ContentInput {
  /** De regel uit de inhoudsopgave. */
  toc: { title: string; rubric: string | null; page: string };
  /** Het artikel zoals het er nu voor staat. */
  article: { title: string | null; rubric: string | null; about: string[] };
  pageName: string;
  image: string;
  text: string;
  /** De stukken op de pagina waar de twijfel over gaat. */
  pieces: Array<{ title: string | null; rubric: string | null; about: string; starts: boolean }>;
}

/**
 * Hoort dit bij het artikel uit de inhoudsopgave?
 *
 * De inhoudsopgave zegt welke artikelen er zijn en waar ze beginnen. Wat ertussen
 * staat, hoort in de regel bij het artikel ervoor, maar niet altijd: een kader van
 * een partner, een losse aankondiging, een stuk dat de inhoudsopgave overslaat.
 * Dit wordt alleen gevraagd voor een pagina met zo'n stuk, en beslist op inhoud.
 */
export async function checkContent(
  ctx: AgentCtx,
  input: ContentInput
): Promise<{ verdict: ContentVerdict; belonging: string[]; reason: string }> {
  const prompt = promptFor('inhoudscontrole');
  const raw = await askJson<{ verdict: ContentVerdict; belonging: string[]; reason: string }>({
    agent: 'inhoudscontrole',
    ledger: ctx.ledger,
    instructions: prompt.instructions,
    effort: prompt.effort,
    maxOutputTokens: prompt.maxOutputTokens,
    input: [
      'THE ARTICLE, as the table of contents lists it:',
      `Title: ${input.toc.title}`,
      input.toc.rubric ? `Listed under: ${input.toc.rubric}` : '',
      `Page: ${input.toc.page}`,
      input.article.title && input.article.title !== input.toc.title ? `Headline on its first page: ${input.article.title}` : '',
      input.article.rubric ? `Rubric on the page: ${input.article.rubric}` : '',
      input.article.about.length ? `What its pages are about:\n${input.article.about.map((a) => `- ${a}`).join('\n')}` : '',
      '',
      `THE PAGE IN QUESTION: ${input.pageName}. The image is that page.`,
      '',
      'The pieces on it that may not belong to the article:',
      input.pieces
        .map(
          (p) =>
            `- "${p.title ?? '(no headline)'}"${p.rubric ? `, rubric ${p.rubric}` : ''}, ${p.starts ? 'opens on this page' : 'runs on from before'}: ${p.about}`
        )
        .join('\n'),
      '',
      `Text layer of the page:\n${clip(input.text, TEXT)}`
    ]
      .filter((line) => line !== '')
      .join('\n'),
    images: [await pageImageUrl(ctx, input.image)],
    schemaName: 'inhoudscontrole',
    schema
  });

  return {
    verdict: VERDICTS.includes(raw.verdict) ? raw.verdict : 'onduidelijk',
    belonging: Array.isArray(raw.belonging) ? raw.belonging.filter((t) => typeof t === 'string') : [],
    reason: (raw.reason ?? '').trim()
  };
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t ? (t.length > max ? `${t.slice(0, max)}…` : t) : '(no text layer)';
}
