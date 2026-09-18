'use client';

import { blankFrontmatter } from '../../compile';
import { boxOnly, obviouslyDecorative } from '../../imagefilter';
import { strayLetters } from '../../spelling';
import type { ExtractedImage, Frontmatter, ImageVerdict, OcrPage, PageAsset, RunEvent, RunUsage } from '../../types';
import { errorMessage, EventQueue, pad2 } from '../../util';
import { putData } from '../db';
import { postJson, postStream } from '../post';
import type { RunContext } from './context';

/** How far into the article the frontmatter agent keeps looking. */
const FRONTMATTER_REACH = 3;
/**
 * Where it starts looking when nobody said how the article opens. An opening is
 * often a spread: the headline on the left page and the intro on the right.
 */
const OPENING_DEFAULT = 2;

/**
 * 2. Frontmatter and image triage. Neither needs the other's answer, so they
 *    start together. Pages still wait for both: the reading-order run needs the approved ids and
 *    the frontmatter as context.
 */
export async function* readOpening(
  ctx: RunContext,
  ocrByPage: Map<number, OcrPage>
): AsyncGenerator<RunEvent, { frontmatter: Frontmatter; approved: ExtractedImage[]; boxed: ExtractedImage[] }, void> {
  const { id, job, provider, chat, assets, once, files, form } = ctx;
  const rejected = new Map<string, string>();
  const candidates: ExtractedImage[] = [];
  for (const image of job.images) {
    const reason = obviouslyDecorative(image);
    if (reason) rejected.set(image.id, reason);
    else candidates.push(image);
  }

  const opening = new EventQueue<RunEvent>();

  const readingFrontmatter = (async () => {
    let frontmatter = blankFrontmatter();
    // A magazine scan knows whether this article opens on one page or two; a PDF
    // dropped in on its own does not, and gets the first two.
    const first = Math.max(1, Math.min(job.opening ?? OPENING_DEFAULT, assets.length));
    for (let reach = first; reach <= Math.min(Math.max(first, FRONTMATTER_REACH), assets.length); reach++) {
      const pages = assets.slice(0, reach);
      const at = pages[reach - 1].page;
      opening.push({ type: 'status', run: 'frontmatter', state: 'start', page: at });
      const result = await once(`frontmatter-${reach}`, () =>
        chat(async () => {
          let final: { frontmatter: Frontmatter; usage: RunUsage } | null = null;
          await postStream<{ type: string; frontmatter: Frontmatter; usage: RunUsage }>(
            '/api/run/frontmatter',
            form(
              {
                provider,
                images: pages.map((a) => a.image),
                ocr: pages.map((a) => `--- PAGINA ${a.page} ---\n${ocrByPage.get(a.page)?.markdown ?? ''}`).join('\n\n'),
                words: pages.flatMap((a) => a.words ?? [])
              },
              await files(pages.map((a) => a.image)),
              "De openingspagina's"
            ),
            (event) => {
              if (event.type === 'partial') opening.push({ type: 'frontmatter', frontmatter: event.frontmatter });
              if (event.type === 'frontmatter') final = { frontmatter: event.frontmatter, usage: event.usage };
            }
          );
          if (!final) throw new Error('de frontmatter kwam niet terug');
          return final as { frontmatter: Frontmatter; usage: RunUsage };
        })
      );
      frontmatter = result.frontmatter;
      if (frontmatter.title) break;
      opening.push({ type: 'status', run: 'frontmatter', state: 'ok', page: at, detail: 'geen titel hier, verder kijken' });
    }
    return frontmatter;
  })();

  let boxed: ExtractedImage[] = [];
  const judgingImages = (async () => {
    opening.push({ type: 'status', run: 'beeldbeoordeling', state: 'start', detail: `${job.images.length} bitmap(s) uit de PDF` });
    let verdicts: ImageVerdict[] = [];
    try {
      // Per page, with the page beside the images: a picture in an advert on the
      // same page looks just like one in the story until you see where it stands.
      const byPage = new Map<number, ExtractedImage[]>();
      for (const image of candidates) byPage.set(image.page, [...(byPage.get(image.page) ?? []), image]);
      const judged = await Promise.all(
        [...byPage].map(([page, images]) =>
          once(`images-p${pad2(page)}`, () =>
            chat(async () => {
              const asset = assets.find((a) => a.page === page);
              return postJson<{ verdicts: ImageVerdict[]; usage: RunUsage }>(
                '/api/run/images',
                form(
                  {
                    provider,
                    // What the judging needs of the page is where it is and how big;
                    // its words and typography only make the request heavier.
                    page: asset ? { ...asset, styling: [], words: [], tiles: [] } : null,
                    images,
                    context: job.context
                  },
                  await files([...(asset ? [asset.image] : []), ...images.map((img) => img.thumb)]),
                  `De beelden van pagina ${page}`
                )
              );
            })
          )
        )
      );
      verdicts = judged.flatMap((j) => j.verdicts);
    } catch (err) {
      // Without a verdict every candidate stays in; the reading-order run still decides placement.
      opening.push({
        type: 'status',
        run: 'beeldbeoordeling',
        state: 'fail',
        detail: errorMessage(err)
      });
    }
    for (const verdict of verdicts) {
      if (!verdict.keep) rejected.set(verdict.id, `${verdict.kind}: ${verdict.reason}`);
    }
    const kept = job.images.filter((image) => !rejected.has(image.id));
    await putData(id, 'images.json', { images: job.images, verdicts, rejected: Object.fromEntries(rejected) });
    const all: ImageVerdict[] = [
      ...verdicts,
      ...[...rejected]
        .filter(([imageId]) => !verdicts.some((v) => v.id === imageId))
        .map(([imageId, reason]) => ({ id: imageId, keep: false, kind: 'ornament' as const, reason }))
    ];
    job.verdicts = all;
    boxed = boxOnly(job.images, all);
    opening.push({ type: 'images', verdicts: all });
    opening.push({
      type: 'status',
      run: 'beeldbeoordeling',
      state: 'ok',
      detail: `${kept.length} bruikbaar, ${rejected.size} decoratief`
    });
    return kept;
  })();

  const openingWork = Promise.all([readingFrontmatter, judgingImages]).finally(() => opening.close());
  for await (const event of opening.drain()) yield event;
  const [frontmatter, approved] = await openingWork;
  return { frontmatter, approved, boxed };
}

/** Wat er aan de gelezen kop te zien is, en dan de frontmatter zelf. */
export async function* checkHeadline(assets: PageAsset[], frontmatter: Frontmatter): AsyncGenerator<RunEvent, void, void> {
  // Een kop staat in displayletter, vaak over een illustratie, en soms is hij
  // helemaal geen tekst maar onderdeel van het beeld. De tekstlaag houdt de
  // woorden die getypt zijn, dus een kop die daar niet in staat is getekend.
  const getypt = new Set(
    assets.slice(0, FRONTMATTER_REACH).flatMap((a) => (a.words ?? []).map((w) => w.toLowerCase()))
  );
  const getekend = (frontmatter.title ?? '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]{3,}/gu)
    ?.filter((w) => !getypt.has(w));
  if (getypt.size && getekend?.length) {
    yield {
      type: 'status',
      run: 'frontmatter',
      state: 'ok',
      detail: `de kop staat niet in de tekstlaag (${getekend.slice(0, 4).join(', ')}) en is van het beeld gelezen`
    };
  }
  for (const stray of strayLetters([frontmatter.chapeau, frontmatter.title, frontmatter.subtitle].filter(Boolean).join(' · '))) {
    yield { type: 'status', run: 'frontmatter', state: 'fail', detail: `losse letter in de kop: "${stray}"` };
  }
  yield { type: 'frontmatter', frontmatter };
  yield { type: 'status', run: 'frontmatter', state: 'ok', detail: frontmatter.title ?? '(geen titel gevonden)' };
}
