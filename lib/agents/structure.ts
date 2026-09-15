import { askText } from '../llm/chat';
import { parsePage } from '../pagemarkup';
import { promptFor } from '../prompts';
import type { Block, Continuity, ExtractedImage } from '../types';
import { AgentCtx, pageImageUrl } from './common';

export interface StructureResult {
  blocks: Block[];
  continuity: Continuity;
  raw: string;
}

/**
 * AI run 1. The only run that writes. It reads the page, decides where the
 * reader starts, and writes the whole page out in that order, inserts, quotes,
 * streamers and images in their place. Nothing else happens on this page until
 * it is finished.
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
  onDelta: (text: string) => void
): Promise<StructureResult> {
  const prompt = promptFor('structure');

  const raw = await askText({
    agent: `structure p${page}`,
    ledger: ctx.ledger,
    onDelta,
    instructions: prompt.instructions,
    effort: prompt.effort,
    maxOutputTokens: prompt.maxOutputTokens,
    input: `Page ${page}.
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

function listed(img: ExtractedImage): string {
  return (
    `  ${img.id} - printed ${img.placed.w}x${img.placed.h}pt at x=${img.placed.x} y=${img.placed.y}, ${img.areaPct}% of the page` +
    (img.nearby ? `; the text printed right next to it reads: "${img.nearby}"` : '')
  );
}
