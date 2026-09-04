import { askJson } from '../llm/openai';
import type { Frontmatter, FrontmatterField } from '../types';
import { promptFor } from '../prompts';
import { AgentCtx, nullableStr, obj, pageImageUrl, str, strArray } from './common';

const ITALIC_FIELDS: FrontmatterField[] = ['chapeau', 'title', 'subtitle', 'intro'];

const schema = obj({
  chapeau: nullableStr('Rubric or section label above the headline.'),
  title: nullableStr('The main headline.'),
  subtitle: nullableStr('Deck printed under the headline.'),
  authors: strArray('Writer names only, without labels such as "tekst:" or "door:".'),
  photographers: strArray('Photographer names only.'),
  illustrators: strArray('Illustrator names only.'),
  date: nullableStr('The printed date, verbatim, in its original format.'),
  intro: nullableStr('The intro/lead text if it is set apart from the body, else null.'),
  italics: {
    type: 'array',
    description:
      'Fragments of chapeau, title, subtitle or intro that are set in italic type. Empty if none are.',
    items: obj({
      field: { type: 'string', enum: ITALIC_FIELDS, description: 'Which of the four fields the fragment sits in.' },
      text: str('The italic fragment, copied character for character from that field.')
    })
  }
});

/**
 * Article level, runs once on the opening spread. A magazine article often opens
 * across two pages with a full-bleed photo on one half and every piece of
 * metadata on the other, so looking at page one alone finds nothing.
 */
export async function readFrontmatter(ctx: AgentCtx, images: string[], ocr: string): Promise<Frontmatter> {
  const prompt = promptFor('frontmatter');

  const raw = await askJson<Frontmatter>({
    agent: 'frontmaster',
    ledger: ctx.ledger,
    instructions: prompt.instructions,
    effort: prompt.effort,
    maxOutputTokens: prompt.maxOutputTokens,
    input: `OCR of the opening spread:\n\n${ocr}`,
    images: await Promise.all(images.map((image) => pageImageUrl(ctx.jobId, image))),
    schemaName: 'frontmatter',
    schema
  });

  return {
    chapeau: raw.chapeau ?? null,
    title: raw.title ?? null,
    subtitle: raw.subtitle ?? null,
    authors: raw.authors ?? [],
    photographers: raw.photographers ?? [],
    illustrators: raw.illustrators ?? [],
    date: raw.date ?? null,
    intro: raw.intro ?? null,
    italics: (raw.italics ?? [])
      .map((i) => ({ field: i.field, text: (i.text ?? '').trim() }))
      .filter((i): i is { field: FrontmatterField; text: string } => ITALIC_FIELDS.includes(i.field) && i.text.length > 1)
  };
}
