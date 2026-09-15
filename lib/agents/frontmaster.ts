import { cleanupText } from '../cleanup';
import { partialJson } from '../util';
import { askJson } from '../llm/chat';
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
 *
 * It streams, even though what it answers with is one object. Nothing can be
 * parsed until the last brace lands, but the finished half of that object can be
 * read as it comes - so the chapeau appears, then the headline, then the byline,
 * instead of the head of the article staying empty until the whole run is done.
 * `onPartial` is called with the article so far, and only ever with fields that
 * are complete.
 */
export async function readFrontmatter(
  ctx: AgentCtx,
  images: string[],
  ocr: string,
  /**
   * Every word the PDF's text layer holds for this spread. Not a second reading
   * of the page but the characters themselves - so a word that is missing from it
   * is not text at all, but something drawn. That is exactly where the OCR is
   * weakest, and exactly where a headline usually lives.
   */
  words: readonly string[],
  onPartial?: (frontmatter: Frontmatter) => void
): Promise<Frontmatter> {
  const prompt = promptFor('frontmatter');

  let seen = '';
  let shown = '';
  const raw = await askJson<Frontmatter>({
    agent: 'frontmaster',
    ledger: ctx.ledger,
    instructions: prompt.instructions,
    effort: prompt.effort,
    maxOutputTokens: prompt.maxOutputTokens,
    input: [
      `OCR of the opening spread:\n\n${ocr}`,
      words.length
        ? `\n\nThe words the PDF's text layer holds on this spread. Anything you read that is not here was drawn rather than typed:\n\n${[...new Set(words)].join(' ')}`
        : `\n\nThis spread has no text layer, so the OCR and the image are all there is. Read every field off the image and check it word by word.`
    ].join(''),
    images: await Promise.all(images.map((image) => pageImageUrl(ctx, image))),
    schemaName: 'frontmatter',
    schema,
    onDelta: onPartial
      ? (delta) => {
          seen += delta;
          const partial = partialJson<Partial<Frontmatter>>(seen);
          if (!partial) return;
          // Only when something actually changed: a delta that finishes no field
          // would otherwise redraw the head of the article on every token.
          const next = JSON.stringify(partial);
          if (next === shown) return;
          shown = next;
          onPartial(tidy(partial));
        }
      : undefined
  });

  return tidy(raw);
}

/**
 * The frontmatter is read off Mistral's markdown, so its emphasis markers can
 * travel with the words; cleanupText takes them off. The italic fragments get the
 * same treatment, or a cleaned fragment would no longer be found in its cleaned
 * field. Half an object gets the same tidying as a whole one, because the reader
 * should not see the markers flash past on the way.
 */
function tidy(raw: Partial<Frontmatter>): Frontmatter {
  const clean = (value: string | null | undefined): string | null => {
    const text = cleanupText(value ?? '');
    return text || null;
  };

  return {
    chapeau: clean(raw.chapeau),
    title: clean(raw.title),
    subtitle: clean(raw.subtitle),
    authors: (raw.authors ?? []).map((name) => cleanupText(name)).filter(Boolean),
    photographers: (raw.photographers ?? []).map((name) => cleanupText(name)).filter(Boolean),
    illustrators: (raw.illustrators ?? []).map((name) => cleanupText(name)).filter(Boolean),
    date: clean(raw.date),
    intro: clean(raw.intro),
    italics: (raw.italics ?? [])
      .map((i) => ({ field: i.field, text: cleanupText(i.text ?? '') }))
      .filter((i): i is { field: FrontmatterField; text: string } => ITALIC_FIELDS.includes(i.field) && i.text.length > 1)
  };
}
