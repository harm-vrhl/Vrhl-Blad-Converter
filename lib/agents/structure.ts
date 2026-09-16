import { askText } from '../llm/chat';
import { parsePage } from '../pagemarkup';
import { promptFor } from '../prompts';
import type { Block, Continuity, ExtractedImage, IndexCheck } from '../types';
import { AgentCtx, pageImageUrl } from './common';

export interface StructureResult {
  blocks: Block[];
  continuity: Continuity;
  raw: string;
}

/**
 * The reading-order run. The only run that writes. It reads the page, decides
 * where the reader starts, and writes the whole page out in that order, inserts,
 * quotes, streamers and images in their place.
 *
 * It streams, because this is the output the user watches appear.
 */
export async function writeStructure(
  ctx: AgentCtx,
  page: number,
  image: string,
  ocr: string,
  available: ExtractedImage[],
  boxOnly: ExtractedImage[],
  previousTail: string,
  onDelta: (text: string) => void,
  /** Wat de woordindex van de vorige poging afkeurde, bij een herkansing. */
  previous?: IndexCheck
): Promise<StructureResult> {
  const prompt = promptFor('structure');

  const raw = await askText({
    agent: `structure p${page}`,
    ledger: ctx.ledger,
    onDelta,
    instructions: prompt.instructions,
    effort: prompt.effort,
    maxOutputTokens: prompt.maxOutputTokens,
    input: `${previous ? `${feedback(previous)}\n\n` : ''}Page ${page}.
${previousTail ? `The previous page ended with: "${previousTail}"` : 'This is the first page of the article.'}
${ctx.context ? `\nWhat is already known about this article:\n${ctx.context}` : ''}

Images on this page, ripped out of the PDF and already judged to belong to the
article. Refer to one by its id; place every one of them somewhere:
${available.map(listed).join('\n') || '  (none)'}
${
  boxOnly.length
    ? `
Images on this page that the image check set aside as an advert or as another
piece's. Place one ONLY inside a box you put in this article, and only when it is
printed inside that box's panel. Anywhere else, leave it out:
${boxOnly.map(listed).join('\n')}
`
    : ''
}
OCR of this page (the words that exist):
${ocr}`,
    images: [await pageImageUrl(ctx, image)]
  });

  return { ...parsePage(page, raw, available, boxOnly), raw };
}

/**
 * Wat de woordindex in de eerste poging ving, teruggegeven aan de tweede.
 *
 * Zonder dit is een herkansing twee keer dezelfde prompt en een hoop: het model
 * hoort nooit welke woorden het op de pagina zette die er niet staan. Nu wel, bij
 * naam, zodat de tweede poging iets te corrigeren heeft in plaats van opnieuw te
 * gokken. De woorden komen uit de index, niet uit een model.
 */
function feedback(previous: IndexCheck): string {
  const parts = ['THIS IS A SECOND ATTEMPT. Your first attempt did not keep to the words on the page.'];
  if (previous.unknown.length) {
    parts.push(
      '',
      'You wrote the words below and the OCR of this page holds none of them. You invented, corrected, translated or completed them. Do not write them again:',
      previous.unknown.map((word) => `  ${word}`).join('\n')
    );
  }
  if (previous.overused.length) {
    parts.push(
      '',
      'You used the words below more often than the page prints them, which means you wrote a passage of the page twice. Every part of the page goes in once:',
      previous.overused.map((o) => `  ${o.word}: you wrote it ${o.used}x, the page holds it ${o.available}x`).join('\n')
    );
  }
  parts.push('', 'Write the page out again, copying the words exactly as the OCR below gives them.');
  return parts.join('\n');
}

function listed(img: ExtractedImage): string {
  return (
    `  ${img.id} - printed ${img.placed.w}x${img.placed.h}pt at x=${img.placed.x} y=${img.placed.y}, ${img.areaPct}% of the page` +
    (img.nearby ? `; the text printed right next to it reads: "${img.nearby}"` : '')
  );
}
