'use client';

import { renderPdf, type RenderedPage, type RenderStep } from './render';
import { newId, putFile, saveJob, type StoredJob } from './db';
import { pad2 } from '../util';
import type { ArticleContext, ExtractedImage, PageAsset, RunEvent } from '../types';
import { runArticle } from './run';

export interface UploadCallbacks {
  /** How many pages the opening spans, when a magazine scan found out. */
  opening?: number;
  /** What the article is about, when a magazine scan said so. */
  context?: ArticleContext;
  /** The job exists: it is created as soon as the first page is rendered. */
  onJob?: (job: StoredJob) => void;
  /** A page has been rendered and stored. */
  onPage?: (page: RenderedPage, total: number) => void;
  onStep?: (page: number, total: number, step: RenderStep | 'opslaan') => void;
}

/**
 * One article PDF into a job: every page rendered, its bitmaps ripped and its
 * typography read in the browser, and stored page by page in this browser's own
 * storage. Knows nothing of the interface, so a single upload on screen and a row
 * of them from a magazine go through the same code.
 *
 * Vroeger ging elke pagina hier naar de server. Die onthoudt op Vercel niets, dus
 * blijft alles nu in de browser; de server krijgt per stap alleen wat die stap
 * nodig heeft.
 */
export async function uploadArticle(file: File, callbacks: UploadCallbacks = {}): Promise<StoredJob> {
  let job: StoredJob | null = null;

  await renderPdf(
    file,
    async (rendered, total) => {
      if (!job) {
        job = {
          id: newId(),
          filename: file.name,
          status: 'uploading',
          pageCount: total,
          pages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: null,
          images: [],
          document: null,
          edited: null,
          verdicts: [],
          totals: null,
          ...(callbacks.opening && callbacks.opening >= 1 && callbacks.opening <= 3 ? { opening: callbacks.opening } : {}),
          ...(callbacks.context ? { context: callbacks.context } : {})
        };
        await putFile(job.id, 'source.pdf', file);
        await saveJob(job);
        callbacks.onJob?.(job);
      }
      callbacks.onStep?.(rendered.page, total, 'opslaan');
      await storePage(job, rendered);
      callbacks.onPage?.(rendered, total);
    },
    (page, total, step) => callbacks.onStep?.(page, total, step)
  );
  if (!job) throw new Error('de PDF heeft geen pagina’s');
  return job;
}

/** Eén gerenderde pagina de opslag in, met dezelfde namen die de server vroeger gaf. */
async function storePage(job: StoredJob, rendered: RenderedPage): Promise<void> {
  const page = rendered.page;
  const id = job.id;
  const image = await putFile(id, `page-${pad2(page)}.jpeg`, rendered.image);
  const thumb = await putFile(id, `thumb-${pad2(page)}.jpeg`, rendered.thumb);
  const tiles: string[] = [];
  for (let i = 0; i < rendered.tiles.length; i++) {
    tiles.push(await putFile(id, `page-${pad2(page)}-t${i + 1}.jpeg`, rendered.tiles[i]));
  }

  const ripped: ExtractedImage[] = [];
  for (let i = 0; i < rendered.ripped.length; i++) {
    const rip = rendered.ripped[i];
    const extension = rip.mime === 'image/png' ? 'png' : 'jpeg';
    const name = `img-p${pad2(page)}-${pad2(i + 1)}`;
    ripped.push({
      id: `img-${page}-${pad2(i + 1)}`,
      page,
      file: await putFile(id, `${name}.${extension}`, rip.full),
      thumb: await putFile(id, `${name}-thumb.${extension}`, rip.thumb),
      width: rip.width,
      height: rip.height,
      placed: rip.placed,
      areaPct: rip.areaPct,
      dpi: rip.dpi,
      ...(rip.parts && rip.parts > 1 ? { parts: rip.parts } : {}),
      ...(rip.nearby ? { nearby: rip.nearby } : {}),
      // The render points at the merged picture by its place in the list; ids are
      // given here, by the same place.
      ...(rip.partOf === 'tekst'
        ? { partOf: 'tekst' }
        : Number.isInteger(rip.partOf) && Number(rip.partOf) >= 0 && Number(rip.partOf) < rendered.ripped.length
          ? { partOf: `img-${page}-${pad2(Number(rip.partOf) + 1)}` }
          : {})
    });
  }

  const asset: PageAsset = {
    page,
    width: rendered.width,
    height: rendered.height,
    points: rendered.points,
    image,
    thumb,
    tiles,
    styling: rendered.styling,
    typography: rendered.typography,
    words: rendered.words
  };
  job.pages = [...job.pages.filter((p) => p.page !== page), asset].sort((a, b) => a.page - b.page);
  job.images = [...job.images.filter((img) => img.page !== page), ...ripped].sort(
    (a, b) => a.page - b.page || a.id.localeCompare(b.id)
  );
  job.status = job.pages.length >= job.pageCount ? 'ready' : 'uploading';
  await saveJob(job);
}

/**
 * The run of one job, as the events it produces. Resolves when the run ends, with
 * whether it reached an article. `resume` keeps what earlier steps already
 * stored, so a run that was cut off does not pay for them twice.
 */
export async function streamRun(
  jobId: string,
  provider: 'openai' | 'mistral',
  onEvent: (event: RunEvent) => void,
  options: { resume?: boolean } = {}
): Promise<boolean> {
  let finished = false;
  for await (const event of runArticle(jobId, provider, options)) {
    if (event.type === 'done') finished = true;
    onEvent(event);
  }
  return finished;
}
