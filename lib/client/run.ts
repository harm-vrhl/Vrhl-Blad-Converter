'use client';

import { compileArticle } from '../compile';
import { rescueBoxed } from '../imagefilter';
import type { RunEvent } from '../types';
import { errorMessage } from '../util';
import { beginTaak, eindTaak } from './activity';
import { deleteData, loadJob, putData, saveJob, type StoredJob, type Totals } from './db';
import { postJson } from './post';
import { runContext } from './run/context';
import { checkHeadline, readOpening } from './run/opening';
import { describe, runPages } from './run/page';
import { readWords } from './run/words';

/**
 * Eén artikel omzetten, geregisseerd vanuit de browser.
 *
 * Dit was `lib/pipeline.ts` op de server: één lang verzoek dat een uur mocht
 * duren. Op Vercel duurt een verzoek hooguit een paar minuten en is het hooguit
 * 4,5 MB, dus is de run opgeknipt in korte stappen per pagina. De volgorde, wat
 * parallel loopt en wat op wat wacht, is dezelfde gebleven, en de gebeurtenissen
 * ook: de interface merkt het verschil niet.
 *
 * Elke stap wordt bewaard zodra hij klaar is. Een run die halverwege stopt
 * (tabblad dicht, netwerk weg) kan met `resume` verder, zonder de OCR en de runs
 * die er al waren opnieuw te betalen.
 */

export async function* runArticle(
  jobId: string,
  provider: 'openai' | 'mistral',
  options: { resume?: boolean } = {}
): AsyncGenerator<RunEvent, void, void> {
  const started = Date.now();
  const found = await loadJob(jobId);
  if (!found) {
    yield { type: 'status', run: 'fout', state: 'fail', detail: 'dit artikel staat niet (meer) in de opslag van deze browser' };
    return;
  }
  const job: StoredJob = found;

  if (!options.resume) {
    await deleteData(job.id, 'run');
    job.edited = null;
  }
  job.status = 'running';
  job.error = null;
  await saveJob(job);

  const task = beginTaak({
    taak: 'artikel.omzetten',
    titel: job.filename,
    pages: job.pageCount,
    job: job.id
  });
  try {
    yield* article(job, provider, started, task);
    eindTaak(task, 'ok', {
      taak: 'artikel.omzetten',
      titel: job.filename,
      pages: job.pageCount,
      job: job.id,
      error: job.error,
      ms: job.totals?.ms,
      usage: job.totals
        ? {
            calls: job.totals.runs,
            tokens: job.totals.tokens,
            cost: job.totals.cost?.total,
            currency: job.totals.cost?.currency
          }
        : undefined
    });
  } catch (err) {
    const message = errorMessage(err);
    job.status = 'error';
    job.error = message;
    await saveJob(job).catch(() => undefined);
    eindTaak(task, 'fail', {
      taak: 'artikel.omzetten',
      titel: job.filename,
      pages: job.pageCount,
      job: job.id,
      error: message
    });
    // A status without a page number is what the interface treats as the end of
    // the run, so a failure has to arrive in that shape to be seen at all.
    yield { type: 'status', run: 'fout', state: 'fail', detail: message };
  }
}

async function* article(job: StoredJob, provider: 'openai' | 'mistral', started: number, task: string): AsyncGenerator<RunEvent, void, void> {
  const ctx = await runContext(job, provider, task);
  const { id, chat, assets, bill, form } = ctx;

  // Before the OCR is paid for: may this key have Mistral write at all?
  await chat(() => postJson('/api/run/check', form({ provider })));

  const { read, ocrByPage } = yield* readWords(ctx);
  const { frontmatter, approved, boxed } = yield* readOpening(ctx, ocrByPage);

  const context = describe(frontmatter);
  yield* checkHeadline(assets, frontmatter);

  const results = yield* runPages(ctx, { ocrByPage, approved, boxed, context });

  const rescue = rescueBoxed(job.verdicts ?? [], results);
  if (rescue.rescued.length) {
    job.verdicts = rescue.verdicts;
    await putData(id, 'images.json', { images: job.images, verdicts: rescue.verdicts });
    yield { type: 'images', verdicts: rescue.verdicts };
    yield {
      type: 'status',
      run: 'beeldbeoordeling',
      state: 'ok',
      detail: `${rescue.rescued.join(', ')} toch geplaatst: staat in een kader van het artikel`
    };
  }

  // String the pages together into one article.
  yield { type: 'status', run: 'compileren', state: 'start' };
  const { document, seams } = compileArticle(
    frontmatter,
    results,
    { file: job.filename, pages: assets.map((a) => a.page) },
    approved
  );
  const totals: Totals = {
    runs: bill.calls,
    tokens: bill.tokens,
    ms: Date.now() - started,
    ocrPages: bill.ocrPages,
    cost: { ai: bill.ai, ocr: bill.ocr, total: bill.ai + bill.ocr, currency: bill.currency }
  };
  await putData(id, 'pages.json', results);
  job.document = document;
  job.status = 'done';
  job.totals = totals;
  await saveJob(job);
  yield { type: 'status', run: 'compileren', state: 'ok', detail: `${document.content.length} blokken, ${seams} paginanaad(en) geplakt` };

  yield {
    type: 'done',
    document,
    pages: results,
    runs: totals.runs,
    tokens: totals.tokens,
    ocr: { calls: read.length, pages: bill.ocrPages, euro: bill.ocr },
    cost: totals.cost!,
    ms: totals.ms
  };
}
