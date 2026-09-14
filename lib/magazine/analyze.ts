import { checkBoundary, type ArticleSide } from '../agents/boundary';
import type { AgentCtx } from '../agents/common';
import { scanPage } from '../agents/pagescan';
import { env, magazineModelFor, strongModelFor, type Provider } from '../env';
import { aiCost, checkMistral, newLedger } from '../llm/chat';
import { writeArtifact } from '../store';
import { EventQueue, pMap } from '../util';
import { saveMagazine } from './store';
import { applyBoundary, folioOf, isSpread, stitch, transitions } from './stitch';
import type { BoundaryCheck, Magazine, MagazineEvent, MagazineMap, MapArticle, PageScan } from './types';

/**
 * A whole magazine to a list of articles. Separate from the article run and
 * sharing nothing with it but the chat client: this only finds out where the
 * articles are.
 *
 * 1. every page between its two neighbours, in parallel, with a cheap model:
 *    what is on it, and which neighbour it faces
 * 2. rules put those pages in a row: offset, spreads, articles, table of contents
 * 3. every transition from one article to the next, in parallel: where does the
 *    previous one really end? When the cheap model cannot tell, the provider's
 *    own model looks once more.
 */
export async function* analyzeMagazine(
  magazine: Magazine,
  options: { provider?: Provider } = {}
): AsyncGenerator<MagazineEvent, void, void> {
  const started = Date.now();
  const provider = options.provider ?? env.provider;
  const cheap = magazineModelFor(provider);
  const strong = strongModelFor(provider);
  const quick = newLedger(provider, cheap);
  const careful = newLedger(provider, strong);
  if (provider === 'mistral') await checkMistral(careful);

  const pages = [...magazine.pages].sort((a, b) => a.pdf - b.pdf);
  const quickCtx: AgentCtx = { jobId: magazine.id, ledger: quick, context: '' };
  const carefulCtx: AgentCtx = { jobId: magazine.id, ledger: careful, context: '' };

  // 1. Page by page.
  yield { type: 'status', run: 'paginascan', state: 'start', detail: `${pages.length} pagina's met ${cheap.model}` };
  const scanning = new EventQueue<MagazineEvent>();
  const work = pMap(pages, env.concurrency, async (page, i): Promise<PageScan> => {
    scanning.push({ type: 'status', run: 'paginascan', state: 'start', page: page.pdf });
    try {
      const scan = await scanPage(quickCtx, {
        pdf: page.pdf,
        total: pages.length,
        image: page.image,
        previousImage: pages[i - 1]?.image ?? null,
        nextImage: pages[i + 1]?.image ?? null,
        isSpread: isSpread(page),
        text: page.text,
        label: page.label,
        previousText: pages[i - 1]?.text ?? '',
        nextText: pages[i + 1]?.text ?? ''
      });
      scanning.push({ type: 'scan', scan });
      scanning.push({ type: 'status', run: 'paginascan', state: 'ok', page: page.pdf, detail: describeScan(scan) });
      return scan;
    } catch (err) {
      // One page that cannot be read does not lose the magazine; the stitching
      // marks the article it falls in.
      const message = err instanceof Error ? err.message : String(err);
      const scan: PageScan = { pdf: page.pdf, kind: 'overig', facing: 'geen', folio: null, pieces: [], toc: [], error: message };
      scanning.push({ type: 'scan', scan });
      scanning.push({ type: 'status', run: 'paginascan', state: 'fail', page: page.pdf, detail: message });
      return scan;
    }
  }).finally(() => scanning.close());
  for await (const event of scanning.drain()) yield event;
  const scans = await work;
  await writeArtifact(magazine.id, 'scans.json', JSON.stringify(scans, null, 2));
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
    return {
      from,
      to,
      input: {
        previous: side(from, scanOf),
        next: side(to, scanOf),
        lastPageName: name(map, last),
        startPageName: name(map, start),
        lastImage: byPdf.get(last)?.image ?? '',
        startImage: byPdf.get(start)?.image ?? '',
        lastText: byPdf.get(last)?.text ?? '',
        startText: byPdf.get(start)?.text ?? '',
        samePage: last === start
      }
    };
  });

  const checking = new EventQueue<MagazineEvent>();
  const checks = pMap(inputs, env.concurrency, async ({ from, to, input }) => {
    const label = `${from.title ?? from.id} → ${to.title ?? to.id}`;
    checking.push({ type: 'status', run: 'grenscontrole', state: 'start', page: to.pages[0], detail: label });
    try {
      let answer = await checkBoundary(quickCtx, input);
      let model = cheap.model;
      if (answer.verdict === 'onduidelijk') {
        checking.push({ type: 'status', run: 'grenscontrole', state: 'start', page: to.pages[0], detail: `${label}: tweede blik met ${strong.model}` });
        answer = await checkBoundary(carefulCtx, input);
        model = strong.model;
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
  }).finally(() => checking.close());
  for await (const event of checking.drain()) yield event;
  await checks;
  yield { type: 'status', run: 'grenscontrole', state: 'ok', detail: `${map.boundaries.length} van ${pairs.length} gecontroleerd` };

  magazine.map = map;
  magazine.status = 'done';
  await saveMagazine(magazine);
  await writeArtifact(magazine.id, 'map.json', JSON.stringify(map, null, 2));

  yield {
    type: 'done',
    map,
    runs: quick.calls + careful.calls,
    tokens: quick.inputTokens + quick.outputTokens + careful.inputTokens + careful.outputTokens,
    cost: { total: aiCost(quick) + aiCost(careful), currency: env.priceCurrency },
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
