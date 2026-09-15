import { askJson } from '../llm/chat';
import { promptFor } from '../prompts';
import { env } from '../env';
import { pMap } from '../util';
import type { ArticleContext, ExtractedImage, ImageKind, ImageVerdict, PageAsset } from '../types';
import { AgentCtx, obj, pageImageUrl, str } from './common';

const KINDS: ImageKind[] = ['photo', 'illustration', 'portrait', 'chart', 'logo', 'ornament', 'rule', 'advert', 'other'];

const schema = obj({
  verdicts: {
    type: 'array',
    items: obj({
      id: str('The id of the image being judged.'),
      keep: { type: 'boolean', description: 'True when it belongs in this article.' },
      kind: { type: 'string', enum: KINDS as unknown as string[] },
      reason: str('One short sentence, in Dutch.')
    })
  }
});

/** More images than this on one page and they are judged in several calls, each with the page. */
const PER_CALL = 12;

/**
 * Judges every bitmap ripped out of the PDF: does it belong in THIS article?
 *
 * A thumbnail on its own cannot say that. A photograph in an advert banner at the
 * foot of the page looks exactly like a photograph in the story above it; what
 * gives it away is where it stands: next to a logo, a slogan and a web address. So
 * the images are judged page by page, with the page itself alongside and where on
 * it each image sits, and with what the article is about when that is known.
 *
 * One call per page with images, in parallel. More than before, when the whole
 * document went in one or two calls without a page; the reason is that an advert's
 * picture turned up in the article.
 */
export async function triageImages(
  ctx: AgentCtx,
  images: ExtractedImage[],
  pages: PageAsset[],
  context?: ArticleContext
): Promise<ImageVerdict[]> {
  if (!images.length) return [];
  const prompt = promptFor('imagetriage');

  const calls: Array<{ page: PageAsset | undefined; batch: ExtractedImage[] }> = [];
  const byPage = new Map<number, ExtractedImage[]>();
  for (const image of images) byPage.set(image.page, [...(byPage.get(image.page) ?? []), image]);
  for (const [page, onPage] of [...byPage].sort((a, b) => a[0] - b[0])) {
    const asset = pages.find((p) => p.page === page);
    for (let i = 0; i < onPage.length; i += PER_CALL) calls.push({ page: asset, batch: onPage.slice(i, i + PER_CALL) });
  }

  const results = await pMap(calls, env.concurrency, async ({ page, batch }) => {
    const size = page ? pageSize(page, batch) : null;
    const pictures = await Promise.all(batch.map((img) => pageImageUrl(ctx, img.thumb)));
    const result = await askJson<{ verdicts: Array<{ id: string; keep: boolean; kind: ImageKind; reason: string }> }>({
      agent: `image-triage p${batch[0].page}`,
      ledger: ctx.ledger,
      instructions: prompt.instructions,
      effort: prompt.effort,
      maxOutputTokens: prompt.maxOutputTokens,
      input: [
        describeArticle(context),
        '',
        page
          ? `The FIRST image is the whole of page ${batch[0].page}. The images after it are the bitmaps taken from that page, in this order:`
          : `The images are the bitmaps taken from page ${batch[0].page}, in this order (the page itself is not available):`,
        '',
        batch
          .map(
            (img) =>
              `${img.id}: ${where(img, size)}, bitmap ${img.width}x${img.height}px at ${img.dpi} dpi, ${img.areaPct}% of the page` +
              (img.parts ? `, merged from ${img.parts} sliced pieces and rendered from the page` : '') +
              (img.nearby ? `; text printed right next to it: "${img.nearby}"` : '')
          )
          .join('\n'),
        '',
        'Find each one on the page and judge it where it stands. Judge every one of them.'
      ].join('\n'),
      images: page ? [await pageImageUrl(ctx, page.image), ...pictures] : pictures,
      schemaName: 'image_verdicts',
      schema
    });

    const byId = new Map((result.verdicts ?? []).map((v) => [v.id, v]));
    return batch.map((img): ImageVerdict => {
      const found = byId.get(img.id);
      return {
        id: img.id,
        keep: found ? Boolean(found.keep) : true, // unjudged stays in; run 1 still has to place it
        kind: found && KINDS.includes(found.kind) ? found.kind : 'other',
        reason: found?.reason ?? 'niet beoordeeld'
      };
    });
  });

  return results.flat();
}

function describeArticle(context: ArticleContext | undefined): string {
  if (!context) {
    return 'THE ARTICLE: not given. Work out from the page which piece is the article (the running story with its headline) and what else is on the page.';
  }
  return [
    'THE ARTICLE these images are judged for:',
    context.title ? `Title: ${context.title}` : '',
    context.rubric ? `Rubric: ${context.rubric}` : '',
    context.about ? `About: ${context.about}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}

/** Width over height of an A-series page, which most magazines are. */
const A_SERIES = 1 / Math.SQRT2;

/**
 * The page in points. Known for a job uploaded since it was recorded; for an older
 * one, worked out from the largest image, whose share of the page and whose place
 * in points are both known, and the aspect of the render. Some older jobs stored
 * the wrong height for the render; when the images then fall outside the page that
 * gives, the aspect of an A-series page is taken instead.
 */
export function pageSize(page: PageAsset, images: ExtractedImage[]): { w: number; h: number } | null {
  if (page.points) return page.points;
  const largest = [...images].sort((a, b) => b.areaPct - a.areaPct)[0];
  if (!largest || largest.areaPct <= 0) return null;
  const area = (100 * largest.placed.w * largest.placed.h) / largest.areaPct;
  const size = (aspect: number) => ({ w: Math.sqrt(area * aspect), h: Math.sqrt(area / aspect) });
  if (!page.width || !page.height) return size(A_SERIES);
  const guess = size(page.width / page.height);
  const right = Math.max(...images.map((i) => i.placed.x + i.placed.w));
  const bottom = Math.max(...images.map((i) => i.placed.y + i.placed.h));
  return right > guess.w * 1.05 || bottom > guess.h * 1.05 ? size(A_SERIES) : guess;
}

/** "left, bottom: from 5% to 45% across, 70% to 95% down" */
export function where(img: ExtractedImage, size: { w: number; h: number } | null): string {
  if (!size) return `placed at x=${img.placed.x} y=${img.placed.y}, ${img.placed.w}x${img.placed.h}pt`;
  const pct = (n: number, of: number) => Math.max(0, Math.min(100, Math.round((100 * n) / of)));
  const x0 = pct(img.placed.x, size.w);
  const x1 = pct(img.placed.x + img.placed.w, size.w);
  const y0 = pct(img.placed.y, size.h);
  const y1 = pct(img.placed.y + img.placed.h, size.h);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const across = cx < 34 ? 'left' : cx > 66 ? 'right' : 'centre';
  const down = cy < 34 ? 'top' : cy > 66 ? 'bottom' : 'middle';
  return `${down} ${across} of the page, ${x0}-${x1}% across and ${y0}-${y1}% down`;
}
