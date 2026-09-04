import { readFrontmatter } from './agents/frontmaster';
import { triageImages } from './agents/imagetriage';
import { writeStructure } from './agents/structure';
import { detectStyling } from './agents/styling';
import type { AgentCtx } from './agents/common';
import { compileArticle } from './compile';
import { env } from './env';
import { newLedger } from './llm/openai';
import { ocrPdf } from './llm/mistral';
import { textOf } from './pagemarkup';
import { applyStyles } from './patch';
import { buildIndex, checkAgainstIndex } from './wordindex';
import { readArtifact, saveJob, writeArtifact } from './store';
import { obviouslyDecorative } from './imagefilter';
import type {
  Block,
  ExtractedImage,
  Frontmatter,
  ImageVerdict,
  Job,
  OcrPage,
  PageAsset,
  PageResult,
  Patch,
  RunEvent,
  WordIndex
} from './types';
import { EventQueue, pMap } from './util';

const TAIL = 300;
/** More unknown words than this and run 1 gets one second try. */
const UNKNOWN_LIMIT = 5;
/** How far into the article the frontmatter agent keeps looking. */
const FRONTMATTER_REACH = 3;

export async function* runPipeline(job: Job): AsyncGenerator<RunEvent, void, void> {
  const ledger = newLedger();
  const assets = [...job.pages].sort((a, b) => a.page - b.page);

  // 1. Word index per page. Mistral decides which words exist; this is the
  //    yardstick every AI output is held against.
  yield { type: 'status', run: 'woordindex', state: 'start', detail: 'Mistral leest alle pagina-images' };
  const pdf = await readArtifact(job.id, 'source.pdf');
  const ocrPages = await ocrPdf(job.id, pdf);
  await writeArtifact(job.id, 'ocr.json', JSON.stringify(ocrPages, null, 2));
  const ocrByPage = new Map(ocrPages.map((p) => [p.page, p]));
  const index = new Map(ocrPages.map((p) => [p.page, buildIndex(p.page, p.markdown)]));
  const words = [...index.values()].reduce((n, i) => n + i.total, 0);
  yield { type: 'status', run: 'woordindex', state: 'ok', detail: `${ocrPages.length} pagina(s), ${words} woorden` };

  // 2. Frontmatter. Walk the pages from the first one until it is found, an
  //    article opening on a full-bleed photo carries its title on page two.
  const ctx: AgentCtx = { jobId: job.id, ledger, context: '' };
  let frontmatter = blankFrontmatter();
  for (let reach = 1; reach <= Math.min(FRONTMATTER_REACH, assets.length); reach++) {
    const pages = assets.slice(0, reach);
    const at = pages[reach - 1].page;
    yield { type: 'status', run: 'frontmatter', state: 'start', page: at };
    frontmatter = await readFrontmatter(
      ctx,
      pages.map((a) => a.image),
      pages.map((a) => `--- PAGINA ${a.page} ---\n${ocrByPage.get(a.page)?.markdown ?? ''}`).join('\n\n')
    );
    if (frontmatter.title) break;
    yield { type: 'status', run: 'frontmatter', state: 'ok', page: at, detail: 'geen titel hier, verder kijken' };
  }
  ctx.context = describe(frontmatter);
  yield { type: 'frontmatter', frontmatter };
  yield { type: 'status', run: 'frontmatter', state: 'ok', detail: frontmatter.title ?? '(geen titel gevonden)' };

  // 2b. The bitmaps ripped out of the PDF. The obvious furniture is thrown out
  //     by rule; the rest is judged once, for the whole document, so the model
  //     can compare a photograph against the mark that returns on every page.
  yield { type: 'status', run: 'beeldbeoordeling', state: 'start', detail: `${job.images.length} bitmap(s) uit de PDF` };
  const rejected = new Map<string, string>();
  const candidates: ExtractedImage[] = [];
  for (const image of job.images) {
    const reason = obviouslyDecorative(image);
    if (reason) rejected.set(image.id, reason);
    else candidates.push(image);
  }
  let verdicts: ImageVerdict[] = [];
  try {
    verdicts = await triageImages(ctx, candidates);
  } catch (err) {
    // Without a verdict every candidate stays in; run 1 still decides placement.
    yield {
      type: 'status',
      run: 'beeldbeoordeling',
      state: 'fail',
      detail: err instanceof Error ? err.message : String(err)
    };
  }
  for (const verdict of verdicts) {
    if (!verdict.keep) rejected.set(verdict.id, `${verdict.kind}: ${verdict.reason}`);
  }
  const approved = job.images.filter((image) => !rejected.has(image.id));
  await writeArtifact(
    job.id,
    'images.json',
    JSON.stringify({ images: job.images, verdicts, rejected: Object.fromEntries(rejected) }, null, 2)
  );
  yield {
    type: 'images',
    verdicts: [...verdicts, ...[...rejected].filter(([id]) => !verdicts.some((v) => v.id === id)).map(([id, reason]) => ({ id, keep: false, kind: 'ornament' as const, reason }))]
  };
  yield {
    type: 'status',
    run: 'beeldbeoordeling',
    state: 'ok',
    detail: `${approved.length} bruikbaar, ${rejected.size} decoratief`
  };

  // 3 & 4. Two runs per page. Pages run in parallel; inside a page they do not.
  const queue = new EventQueue<RunEvent>();
  const work = pMap(assets, env.concurrency, async (asset, i) => {
    const emit = (event: RunEvent) => queue.push(event);
    try {
      return await processPage({
        ctx,
        asset,
        ocr: ocrByPage.get(asset.page),
        images: approved.filter((image) => image.page === asset.page),
        index: index.get(asset.page),
        previousTail: i > 0 ? tailOf(ocrByPage.get(assets[i - 1].page)) : '',
        isFirst: i === 0,
        isLast: i === assets.length - 1,
        emit
      });
    } catch (err) {
      // One page going wrong is not a reason to lose the others.
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'status', run: 'pagina', state: 'fail', page: asset.page, detail: message });
      const empty = emptyPage(asset.page, message, i === assets.length - 1);
      emit({ type: 'page', page: asset.page, result: empty });
      return empty;
    }
  }).finally(() => queue.close());

  for await (const event of queue.drain()) yield event;
  const results = await work;

  // String the pages together into one article.
  yield { type: 'status', run: 'compileren', state: 'start' };
  const { document, seams } = compileArticle(frontmatter, results, {
    file: job.filename,
    pages: assets.map((a) => a.page)
  });
  await writeArtifact(job.id, 'article.json', JSON.stringify(document, null, 2));
  await writeArtifact(job.id, 'pages.json', JSON.stringify(results, null, 2));
  job.document = document;
  job.status = 'done';
  await saveJob(job);
  yield {
    type: 'status',
    run: 'compileren',
    state: 'ok',
    detail: `${document.content.length} blokken, ${seams} paginanaad(en) geplakt`
  };

  yield {
    type: 'done',
    document,
    pages: results,
    runs: ledger.calls,
    tokens: ledger.inputTokens + ledger.outputTokens
  };
}

interface PageJob {
  ctx: AgentCtx;
  asset: PageAsset;
  ocr: OcrPage | undefined;
  images: ExtractedImage[];
  index: WordIndex | undefined;
  previousTail: string;
  isFirst: boolean;
  isLast: boolean;
  emit: (event: RunEvent) => void;
}

/**
 * One page, two runs, strictly in order.
 * Run 1 writes the page out. Only when that is finished does run 2 look at the
 * typography and replace the styled words in run 1's output.
 */
async function processPage(job: PageJob): Promise<PageResult> {
  const { ctx, asset, emit } = job;
  const page = asset.page;
  const markdown = job.ocr?.markdown ?? '';
  const index = job.index ?? buildIndex(page, markdown);
  const warnings: string[] = [];

  // AI run 1, reading order, with inserts, quotes and images in their place.
  emit({ type: 'status', run: 'run 1 leesvolgorde', state: 'start', page });
  let run1 = await writeStructure(ctx, page, asset.image, markdown, job.images, job.previousTail, (text) =>
    emit({ type: 'delta', page, text })
  );
  // Checked against the parsed blocks, not the raw output: the markers are mine,
  // not the page's, and counting them would flag every page as drifting.
  let check = checkAgainstIndex(index, textOf(run1.blocks));

  // The word index has the last word. Too many words the page never held means
  // the run drifted; it gets exactly one more try.
  if (check.unknown.length > UNKNOWN_LIMIT) {
    emit({
      type: 'status',
      run: 'run 1 leesvolgorde',
      state: 'start',
      page,
      detail: `${check.unknown.length} woorden buiten de index, tweede poging`
    });
    const retry = await writeStructure(ctx, page, asset.image, markdown, job.images, job.previousTail, () => undefined);
    const retryCheck = checkAgainstIndex(index, textOf(retry.blocks));
    if (retryCheck.unknown.length < check.unknown.length) {
      run1 = retry;
      check = retryCheck;
      emit({ type: 'delta', page, text: '\f' }); // form feed: the UI resets the pane
      emit({ type: 'delta', page, text: retry.raw });
    }
  }

  const blocks = run1.blocks;

  emit({
    type: 'status',
    run: 'run 1 leesvolgorde',
    state: 'ok',
    page,
    detail: `${tally(blocks)}, ${Math.round(check.score * 100)}% woorddekking`
  });

  // AI run 2, typography, and nothing else.
  emit({ type: 'status', run: 'run 2 styling', state: 'start', page });
  let patches: Patch[] = [];
  try {
    patches = await detectStyling(ctx, page, asset.image, blocks);
    for (const patch of patches) emit({ type: 'patch', page, patch });
    emit({ type: 'status', run: 'run 2 styling', state: 'ok', page, detail: `${patches.length} fragment(en)` });
  } catch (err) {
    // The page keeps its text; it just misses its italics.
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`styling: ${message}`);
    emit({ type: 'status', run: 'run 2 styling', state: 'fail', page, detail: message });
  }

  const applied = applyStyles(blocks, patches);
  const result: PageResult = {
    page,
    blocks,
    patches,
    dropped: applied.dropped,
    content: applied.content,
    continuity: {
      continuesFromPrevious: run1.continuity.continuesFromPrevious && !job.isFirst,
      continuesOnNext: run1.continuity.continuesOnNext && !job.isLast
    },
    check,
    warnings: [...warnings, ...applied.warnings]
  };
  emit({ type: 'page', page, result });
  return result;
}

const NAMES: Record<string, string> = {
  paragraph: 'alinea',
  subheading: 'tussenkop',
  quote: 'quote',
  streamer: 'streamer',
  image: 'afbeelding',
  insert: 'insert'
};

function tally(blocks: Block[]): string {
  const counts = new Map<string, number>();
  for (const block of blocks) counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
  const parts = [...counts].map(([type, n]) => `${n} ${NAMES[type] ?? type}${n === 1 ? '' : 's'}`);
  return parts.join(', ') || 'geen inhoud';
}

/** A page we could not process at all still has to take its place in the run. */
function emptyPage(page: number, message: string, isLast: boolean): PageResult {
  return {
    page,
    blocks: [],
    patches: [],
    dropped: [],
    content: [],
    continuity: { continuesFromPrevious: false, continuesOnNext: !isLast },
    check: { unknown: [], overused: [], score: 0 },
    warnings: [message]
  };
}

function tailOf(ocr: OcrPage | undefined): string {
  return (ocr?.markdown ?? '').slice(-TAIL);
}

function blankFrontmatter(): Frontmatter {
  return {
    chapeau: null,
    title: null,
    subtitle: null,
    authors: [],
    photographers: [],
    illustrators: [],
    date: null,
    intro: null,
    italics: []
  };
}

/** The context run 1 carries, so it does not repeat the frontmatter as body text. */
function describe(fm: Frontmatter): string {
  return [
    fm.chapeau ? `Chapeau: ${fm.chapeau}` : '',
    fm.title ? `Titel: ${fm.title}` : '',
    fm.subtitle ? `Ondertitel: ${fm.subtitle}` : '',
    fm.authors.length ? `Auteur(s): ${fm.authors.join(', ')}` : '',
    fm.date ? `Datum: ${fm.date}` : '',
    fm.intro ? `Intro (hoort bij de frontmatter, niet bij de hoofdtekst): ${fm.intro}` : ''
  ]
    .filter(Boolean)
    .join('\n');
}
