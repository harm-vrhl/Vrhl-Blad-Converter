import { askJson } from '../llm/chat';
import { promptFor } from '../prompts';
import type { ExtractedImage, ImageKind, ImageVerdict } from '../types';
import { AgentCtx, obj, pageImageUrl, str } from './common';

const KINDS: ImageKind[] = ['photo', 'illustration', 'portrait', 'chart', 'logo', 'ornament', 'rule', 'other'];

const schema = obj({
  verdicts: {
    type: 'array',
    items: obj({
      id: str('The id of the image being judged.'),
      keep: { type: 'boolean', description: 'True when it belongs in the article.' },
      kind: { type: 'string', enum: KINDS as unknown as string[] },
      reason: str('One short sentence, in Dutch.')
    })
  }
});

/** Sent in one go so the model can compare, but not so many that it loses track. */
const BATCH = 12;

/**
 * Judges every bitmap ripped out of the PDF: is this article content, or is it
 * furniture? Seeing them side by side is what makes it work, because a logo that
 * returns on every page only looks like a logo next to the photographs.
 */
export async function triageImages(ctx: AgentCtx, images: ExtractedImage[]): Promise<ImageVerdict[]> {
  if (!images.length) return [];
  const prompt = promptFor('imagetriage');
  const verdicts: ImageVerdict[] = [];

  for (let i = 0; i < images.length; i += BATCH) {
    const batch = images.slice(i, i + BATCH);
    const result = await askJson<{ verdicts: Array<{ id: string; keep: boolean; kind: ImageKind; reason: string }> }>({
      agent: `image-triage ${i / BATCH + 1}`,
      ledger: ctx.ledger,
      instructions: prompt.instructions,
      effort: prompt.effort,
      maxOutputTokens: prompt.maxOutputTokens,
      input: `The images follow in this order. Judge every one of them.

${batch
  .map(
    (img) =>
      `${img.id} - pagina ${img.page}, bitmap ${img.width}x${img.height}px at ${img.dpi} dpi, ` +
      `printed ${img.placed.w}x${img.placed.h}pt at x=${img.placed.x} y=${img.placed.y}, ` +
      `${img.areaPct}% of the page`
  )
  .join('\n')}`,
      images: await Promise.all(batch.map((img) => pageImageUrl(ctx.jobId, img.thumb))),
      schemaName: 'image_verdicts',
      schema
    });

    const byId = new Map((result.verdicts ?? []).map((v) => [v.id, v]));
    for (const img of batch) {
      const found = byId.get(img.id);
      verdicts.push({
        id: img.id,
        keep: found ? Boolean(found.keep) : true, // unjudged stays in; run 1 still has to place it
        kind: found && KINDS.includes(found.kind) ? found.kind : 'other',
        reason: found?.reason ?? 'niet beoordeeld'
      });
    }
  }

  return verdicts;
}
