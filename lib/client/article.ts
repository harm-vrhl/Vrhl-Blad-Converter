'use client';

import { renderPdf, type RenderedPage, type RenderStep } from './render';
import type { ArticleContext, Job, RunEvent } from '../types';

export interface UploadCallbacks {
  /** How many pages the opening spans, when a magazine scan found out. */
  opening?: number;
  /** What the article is about, when a magazine scan said so. */
  context?: ArticleContext;
  /** The job exists: it is created as soon as the first page is rendered. */
  onJob?: (job: Job, missingKeys: string[]) => void;
  /** A page has landed on the server. */
  onPage?: (page: RenderedPage, total: number) => void;
  onStep?: (page: number, total: number, step: RenderStep | 'uploaden') => void;
}

/**
 * One article PDF into a job: every page rendered, its bitmaps ripped and its
 * typography read in the browser, and sent to the server page by page. Knows
 * nothing of the interface, so a single upload on screen and a row of them from a
 * magazine go through the same code.
 */
export async function uploadArticle(file: File, callbacks: UploadCallbacks = {}): Promise<Job> {
  // The page count is only known once pdf.js opens the file, so the job is
  // created while the first page is being rendered.
  let current: Job | null = null;
  await renderPdf(
    file,
    async (rendered, total) => {
      if (!current) {
        const form = new FormData();
        form.set('file', file);
        form.set('pageCount', String(total));
        if (callbacks.opening) form.set('opening', String(callbacks.opening));
        if (callbacks.context) form.set('context', JSON.stringify(callbacks.context));
        const res = await fetch('/api/jobs', { method: 'POST', body: form });
        const body = (await res.json()) as { job: Job; missingKeys: string[]; error?: string };
        if (!res.ok) throw new Error(body.error ?? 'upload mislukt');
        current = body.job;
        callbacks.onJob?.(body.job, body.missingKeys);
      }
      callbacks.onStep?.(rendered.page, total, 'uploaden');
      const form = new FormData();
      form.set('page', String(rendered.page));
      form.set('width', String(rendered.width));
      form.set('height', String(rendered.height));
      form.set('image', rendered.image, `page-${rendered.page}.jpeg`);
      form.set('thumb', rendered.thumb, `thumb-${rendered.page}.jpeg`);
      // The bitmaps ripped out of this page travel with it.
      form.set(
        'ripped',
        JSON.stringify(
          rendered.ripped.map((r) => ({
            width: r.width,
            height: r.height,
            placed: r.placed,
            areaPct: r.areaPct,
            dpi: r.dpi,
            mime: r.mime,
            parts: r.parts,
            partOf: r.partOf
          }))
        )
      );
      // The PDF's own record of what is bold and what is italic.
      form.set('styling', JSON.stringify(rendered.styling));
      form.set('typography', rendered.typography);
      form.set('words', JSON.stringify(rendered.words));
      form.set('points', JSON.stringify(rendered.points));
      rendered.tiles.forEach((tile, i) => form.set(`tile${i}`, tile, `tile-${i}.jpeg`));
      rendered.ripped.forEach((r, i) => {
        const ext = r.mime === 'image/png' ? 'png' : 'jpeg';
        form.set(`rip${i}`, r.full, `rip-${i}.${ext}`);
        form.set(`ripThumb${i}`, r.thumb, `rip-${i}-thumb.${ext}`);
      });
      const res = await fetch(`/api/jobs/${current.id}/pages`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(120_000)
      });
      if (!res.ok) throw new Error(`pagina ${rendered.page} kon niet worden opgeslagen`);
      callbacks.onPage?.(rendered, total);
    },
    (page, total, step) => callbacks.onStep?.(page, total, step)
  );
  if (!current) throw new Error('de PDF heeft geen pagina’s');

  // The ripped bitmaps are added per page on the server, so pick the job up again
  // once every page has landed.
  const res = await fetch(`/api/jobs/${(current as Job).id}`);
  return res.ok ? ((await res.json()) as Job) : current;
}

/**
 * The run of one job, as the events it streams. Resolves when the stream ends,
 * with whether it reached an article.
 */
export async function streamRun(
  jobId: string,
  provider: 'openai' | 'mistral',
  onEvent: (event: RunEvent) => void
): Promise<boolean> {
  let finished = false;
  const res = await fetch(`/api/jobs/${jobId}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider })
  });
  if (!res.body) throw new Error('geen stream ontvangen');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.replace(/^data: ?/, '').trim();
      if (!line) continue;
      const event = JSON.parse(line) as RunEvent;
      if (event.type === 'done') finished = true;
      onEvent(event);
    }
  }
  return finished;
}
