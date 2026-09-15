'use client';

import type { ArticleSide, BoundaryInput } from '../agents/boundary';
import type { PageScanInput } from '../agents/pagescan';
import { applyBoundary, folioOf, isSpread, stitch, transitions } from '../magazine/stitch';
import type {
  BoundaryCheck,
  BoundaryVerdict,
  Magazine,
  MagazineEvent,
  MagazineMap,
  MapArticle,
  PageScan
} from '../magazine/types';
import type { RunUsage } from '../types';
import { EventQueue } from '../util';
import { loadMagazine, needFile, putData, saveMagazine } from './db';
import { limiter, type Limiter } from './limiter';
import { postJson, runForm } from './post';

/**
 * A whole magazine to a list of articles, from the browser. Separate from the
 * article run and sharing nothing with it: this only finds out where the articles
 * are.
 *
 * 1. every page between its two neighbours, with a cheap model: what is on it,
 *    and which neighbour it faces
 * 2. rules put those pages in a row: offset, spreads, articles, table of contents
 * 3. every transition from one article to the next: where does the previous one
 *    really end? When the cheap model cannot tell, the provider's own model looks
 *    once more.
 *
 * Dit liep als één verzoek van een uur op de server. Nu is elke pagina en elke
 * overgang een eigen kort verzoek, en rijgt de browser ze aaneen.
 */

/** Wat van de tekstlaag meegaat; de scan knipt zelf ook, dit houdt het verzoek klein. */
const TEXT_LIMIT = 6000;
const NEIGHBOUR = 1200;
const BOUNDARY_TEXT = 5000;

let lanes: Promise<{ openai: Limiter; mistral: Limiter }> | null = null;

function lanesFor() {
  lanes ??= fetch('/api/settings')
    .then((res) => (res.ok ? res.json() : {}))
    .catch(() => ({}))
    .then((body: { concurrency?: number; mistralReqPerMinute?: number }) => ({
      openai: limiter(body.concurrency ?? 4),
      mistral: limiter(body.concurrency ?? 4, body.mistralReqPerMinute ?? 60)
    }));
  return lanes;
}

export async function* analyzeMagazine(
  magazineId: string,
  provider: 'openai' | 'mistral'
): AsyncGenerator<MagazineEvent, void, void> {
  const found = await loadMagazine(magazineId);
  if (!found) {
    yield { type: 'status', run: 'fout', state: 'fail', detail: 'dit magazine staat niet (meer) in de opslag van deze browser' };
    return;
  }
  const magazine: Magazine = found;
  if (magazine.pages.length < magazine.pageCount) {
    yield {
      type: 'status',
      run: 'upload',
      state: 'fail',
      detail: `${magazine.pages.length} van ${magazine.pageCount} pagina's zijn ingelezen`
    };
    return;
  }

  magazine.status = 'running';
  magazine.error = null;
  await saveMagazine(magazine);
  try {
    yield* analyze(magazine, provider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    magazine.status = 'error';
    magazine.error = message;
    await saveMagazine(magazine).catch(() => undefined);
    yield { type: 'status', run: 'fout', state: 'fail', detail: message };
  }
}

async function* analyze(magazine: Magazine, provider: 'openai' | 'mistral'): AsyncGenerator<MagazineEvent, void, void> {
  const started = Date.now();
  const { openai, mistral } = await lanesFor();
  const lane = provider === 'mistral' ? mistral : openai;
  const bill = { calls: 0, tokens: 0, cost: 0, currency: 'USD' };
  const add = (usage: RunUsage) => {
    bill.calls += usage.calls;
    bill.tokens += usage.tokens;
    bill.cost += usage.ai;
    bill.currency = usage.currency;
  };
  const files = async (names: string[]) =>
    Object.fromEntries(await Promise.all(names.map(async (name) => [name, await needFile(magazine.id, name)] as const)));

  const pages = [...magazine.pages].sort((a, b) => a.pdf - b.pdf);

  // 1. Page by page.
  yield { type: 'status', run: 'paginascan', state: 'start', detail: `${pages.length} pagina's` };
  const scanning = new EventQueue<MagazineEvent>();
  const work = Promise.all(
    pages.map(async (page, i): Promise<PageScan> => {
      try {
        return await lane(async () => {
          scanning.push({ type: 'status', run: 'paginascan', state: 'start', page: page.pdf });
          const input: PageScanInput = {
            pdf: page.pdf,
            total: pages.length,
            image: page.image,
            previousImage: pages[i - 1]?.image ?? null,
            nextImage: pages[i + 1]?.image ?? null,
            isSpread: isSpread(page),
            text: page.text.slice(0, TEXT_LIMIT),
            label: page.label,
            previousText: (pages[i - 1]?.text ?? '').slice(-NEIGHBOUR),
            nextText: (pages[i + 1]?.text ?? '').slice(0, NEIGHBOUR)
          };
          const names = [input.previousImage, input.image, input.nextImage].filter((n): n is string => !!n);
          const { scan, usage } = await postJson<{ scan: PageScan; usage: RunUsage }>(
            '/api/magazine/scan',
            runForm({ provider, ...input }, await files(names), `Pagina ${page.pdf} met zijn buren`)
          );
          add(usage);
          scanning.push({ type: 'scan', scan });
          scanning.push({ type: 'status', run: 'paginascan', state: 'ok', page: page.pdf, detail: describeScan(scan) });
          return scan;
        });
      } catch (err) {
        // One page that cannot be read does not lose the magazine; the stitching
        // marks the article it falls in.
        const message = err instanceof Error ? err.message : String(err);
        const scan: PageScan = { pdf: page.pdf, kind: 'overig', facing: 'geen', folio: null, pieces: [], toc: [], error: message };
        scanning.push({ type: 'scan', scan });
        scanning.push({ type: 'status', run: 'paginascan', state: 'fail', page: page.pdf, detail: message });
        return scan;
      }
    })
  ).finally(() => scanning.close());
  for await (const event of scanning.drain()) yield event;
  const scans = await work;
  await putData(magazine.id, 'scans.json', scans);
  const failed = scans.filter((s) => s.error).length;
  yield {
    type: 'status',
    run: 'paginascan',
    state: failed === scans.length ? 'fail' : 'ok',
    detail: failed ? `${scans.length - failed} bekeken, ${failed} mislukt` : `${scans.length} bekeken`
  };
  if (failed === scans.length) throw new Error('Geen enkele pagina kon worden bekeken.');

  // 2. In a row.
  yield { type: 'status', run: 'rijgen', state: 'start' };
  const map = stitch(scans, pages);
  yield { type: 'map', map };
  yield {
    type: 'status',
    run: 'rijgen',
    state: 'ok',
    detail: `${map.articles.length} artikel(en)${map.toc.length ? `, inhoudsopgave met ${map.toc.length} regels` : ''}`
  };

  // 3. The transitions. Every input is built before anything is applied, so one
  //    verdict moving a page cannot change what the next check is shown.
  const pairs = transitions(map);
  yield { type: 'status', run: 'grenscontrole', state: 'start', detail: `${pairs.length} overgang(en)` };
  const byPdf = new Map(pages.map((p) => [p.pdf, p]));
  const scanOf = new Map(scans.map((s) => [s.pdf, s]));
  const inputs = pairs.map(({ from, to }) => {
    const start = to.pages[0];
    const prior = from.pages.filter((p) => p < start);
    const last = prior.length ? prior[prior.length - 1] : start;
    const input: BoundaryInput = {
      previous: side(from, scanOf),
      next: side(to, scanOf),
      lastPageName: name(map, last),
      startPageName: name(map, start),
      lastImage: byPdf.get(last)?.image ?? '',
      startImage: byPdf.get(start)?.image ?? '',
      lastText: (byPdf.get(last)?.text ?? '').slice(-BOUNDARY_TEXT),
      startText: (byPdf.get(start)?.text ?? '').slice(0, BOUNDARY_TEXT),
      samePage: last === start
    };
    return { from, to, input };
  });

  const ask = (input: BoundaryInput, strong: boolean) =>
    lane(async () => {
      const names = input.samePage ? [input.startImage] : [input.lastImage, input.startImage];
      const result = await postJson<{
        answer: { verdict: BoundaryVerdict; continuesOn: string | null; reason: string };
        model: string;
        usage: RunUsage;
      }>('/api/magazine/boundary', runForm({ provider, strong, ...input }, await files(names), 'De grenscontrole'));
      add(result.usage);
      return result;
    });

  const checking = new EventQueue<MagazineEvent>();
  const checks = Promise.all(
    inputs.map(async ({ from, to, input }) => {
      const label = `${from.title ?? from.id} → ${to.title ?? to.id}`;
      checking.push({ type: 'status', run: 'grenscontrole', state: 'start', page: to.pages[0], detail: label });
      try {
        let { answer, model } = await ask(input, false);
        if (answer.verdict === 'onduidelijk') {
          checking.push({ type: 'status', run: 'grenscontrole', state: 'start', page: to.pages[0], detail: `${label}: tweede blik` });
          ({ answer, model } = await ask(input, true));
        }
        const check: BoundaryCheck = { from: from.id, to: to.id, ...answer, model };
        applyBoundary(map, check);
        checking.push({ type: 'boundary', check });
        checking.push({ type: 'map', map });
        checking.push({ type: 'status', run: 'grenscontrole', state: 'ok', page: to.pages[0], detail: `${label}: ${answer.verdict}` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        from.notes.push(`De grenscontrole met "${to.title ?? to.id}" mislukte: ${message}`);
        from.certain = false;
        checking.push({ type: 'status', run: 'grenscontrole', state: 'fail', page: to.pages[0], detail: `${label}: ${message}` });
      }
    })
  ).finally(() => checking.close());
  for await (const event of checking.drain()) yield event;
  await checks;
  yield { type: 'status', run: 'grenscontrole', state: 'ok', detail: `${map.boundaries.length} van ${pairs.length} gecontroleerd` };

  magazine.map = map;
  magazine.status = 'done';
  await saveMagazine(magazine);
  await putData(magazine.id, 'map.json', map);

  yield {
    type: 'done',
    map,
    runs: bill.calls,
    tokens: bill.tokens,
    cost: { total: bill.cost, currency: bill.currency },
    ms: Date.now() - started
  };
}

function side(article: MapArticle, scans: Map<number, PageScan>): ArticleSide {
  const about = article.pages
    .flatMap((pdf) => {
      const pieces = scans.get(pdf)?.pieces ?? [];
      // On a shared page, only the piece that is this article's: its own title
      // where it opens, the running piece where it does not.
      const own = pieces.filter((p) => (pdf === article.pages[0] ? p.starts : !p.starts));
      return (own.length ? own : pieces).slice(0, 1).map((p) => p.about);
    })
    .filter(Boolean);
  return { title: article.title, rubric: article.rubric, about };
}

function name(map: MagazineMap, pdf: number): string {
  const folio = folioOf(map.segments, pdf);
  return folio ? `PDF page ${pdf} (printed ${folio})` : `PDF page ${pdf}`;
}

function describeScan(scan: PageScan): string {
  const parts: string[] = [scan.kind];
  if (scan.folio) parts.push(`p. ${scan.folio}`);
  const starts = scan.pieces.filter((p) => p.starts);
  if (starts.length) parts.push(starts.map((p) => p.title ?? '(zonder kop)').join(' · '));
  if (scan.toc.length) parts.push(`${scan.toc.length} regels inhoud`);
  return parts.join(' · ');
}
