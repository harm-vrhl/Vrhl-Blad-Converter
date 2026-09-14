import { readFrontmatter } from './agents/frontmaster';
import { triageImages } from './agents/imagetriage';
import { writeStructure } from './agents/structure';
import { detectStyling, type StyleFragment } from './agents/styling';
import type { AgentCtx } from './agents/common';
import { blankFrontmatter, compileArticle } from './compile';
import { env, type Provider } from './env';
import { aiCost, checkMistral, newLedger } from './llm/chat';
import { newOcrLedger, ocrCost, ocrPdf, type OcrLedger } from './llm/mistral';
import { textOf } from './pagemarkup';
import { reconcile, strayLetters } from './spelling';
import { placeFragments } from './place';
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

/**
 * `provider` says which model writes this run. Mistral reads every page either
 * way; this only chooses who does the rest.
 */
export async function* runPipeline(
  job: Job,
  options: { provider?: Provider } = {}
): AsyncGenerator<RunEvent, void, void> {
  const started = Date.now();
  const ledger = newLedger(options.provider ?? env.provider);
  // Before the OCR is paid for: may this key have Mistral write at all?
  if (ledger.provider === 'mistral') await checkMistral(ledger);
  const ocrLedger = newOcrLedger();
  const assets = [...job.pages].sort((a, b) => a.page - b.page);

  // 1. Word index per page. Mistral decides which words exist; this is the
  //    yardstick every AI output is held against.
  yield { type: 'status', run: 'woordindex', state: 'start', detail: 'Mistral leest alle pagina-images' };
  const pdf = await readArtifact(job.id, 'source.pdf');
  const ocrPages = await ocrPdf(job.id, pdf, ocrLedger);
  await writeArtifact(job.id, 'ocr.json', JSON.stringify(ocrPages, null, 2));
  // The OCR read the page from a picture and the file holds the characters, so
  // where the two disagree about a diacritic and about nothing else, the file
  // settles it - before the word index is built, because the index is what every
  // later run is held against and it should be held against the right spelling.
  const corrected: string[] = [];
  for (const ocr of ocrPages) {
    const asset = assets.find((a) => a.page === ocr.page);
    const { text, swaps } = reconcile(ocr.markdown, asset?.words ?? []);
    ocr.markdown = text;
    for (const swap of swaps) corrected.push(`p${ocr.page}: ${swap.from} → ${swap.to}${swap.count > 1 ? ` (${swap.count}×)` : ''}`);
  }
  if (corrected.length) {
    yield { type: 'status', run: 'woordindex', state: 'ok', detail: `spelling uit de PDF: ${corrected.join(', ')}` };
  }

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

    // The run hands its half-finished object to a callback and a generator cannot
    // yield from one, so the partials go through a queue that is drained while the
    // run is still going - the same way the page runs get their events out.
    const front = new EventQueue<RunEvent>();
    const reading = readFrontmatter(
      ctx,
      pages.map((a) => a.image),
      pages.map((a) => `--- PAGINA ${a.page} ---\n${ocrByPage.get(a.page)?.markdown ?? ''}`).join('\n\n'),
      pages.flatMap((a) => a.words ?? []),
      (partial) => front.push({ type: 'frontmatter', frontmatter: partial })
    ).finally(() => front.close());

    for await (const event of front.drain()) yield event;
    frontmatter = await reading;

    if (frontmatter.title) break;
    yield { type: 'status', run: 'frontmatter', state: 'ok', page: at, detail: 'geen titel hier, verder kijken' };
  }
  ctx.context = describe(frontmatter);
  // Een kop staat in displayletter, vaak over een illustratie, en soms is hij
  // helemaal geen tekst maar onderdeel van het beeld - precies waar de OCR een
  // letter laat vallen. "Mama, weet j mama" is wat daarvan overblijft.
  //
  // Of dat hier speelt is niet te raden maar te zien: de tekstlaag houdt de
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
  const { document, seams } = compileArticle(
    frontmatter,
    results,
    { file: job.filename, pages: assets.map((a) => a.page) },
    approved
  );
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
    tokens: ledger.inputTokens + ledger.outputTokens,
    ocr: { calls: ocrLedger.calls, pages: ocrLedger.pages, euro: ocrCost(ocrLedger) },
    cost: {
      ai: aiCost(ledger),
      ocr: ocrCost(ocrLedger),
      total: aiCost(ledger) + ocrCost(ocrLedger),
      currency: env.priceCurrency
    },
    ms: Date.now() - started
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
 * One page, two runs, side by side.
 *
 * They used to be in order, because run 2 was handed run 1's blocks to hang its
 * patches on. It no longer is: it quotes the page instead, and what it quotes is
 * placed afterwards. So it starts at the same moment run 1 does, and by the time
 * the text has finished streaming the typography is usually already in - which is
 * what lets the reader watch the page appear with its marks on rather than have
 * them dropped in afterwards.
 */
async function processPage(job: PageJob): Promise<PageResult> {
  const { ctx, asset, emit } = job;
  const page = asset.page;
  const markdown = job.ocr?.markdown ?? '';
  const index = job.index ?? buildIndex(page, markdown);
  const warnings: string[] = [];

  // Where the PDF has a text layer, the typography is not a judgement at all: the
  // font each run of characters is set in is recorded in the file, and its name
  // says whether it is the bold or the italic cut. That was read off when the page
  // was rasterised, so there is nothing to wait for and nothing to be unsure
  // about. A model looking at a picture of the page is right most of the time and
  // differently right each time it looks; this is simply what the page is.
  //
  // The looking is kept for the pages that leave nothing to read: a scan, or an
  // export that flattened its text into pixels.
  // What decides is whether the PDF could be READ, not how much it happened to
  // say. A page whose text layer is perfect and carries no emphasis has answered
  // the question - with "none" - and sending a run to look at it anyway costs a
  // call and invites it to find marks the file proves are not there.
  const fromPdf = asset.styling ?? [];
  let styling: Promise<StyleFragment[]>;

  if (asset.typography === 'read') {
    emit({
      type: 'status',
      run: 'opmaak uit de PDF',
      state: 'ok',
      page,
      detail: fromPdf.length ? `${fromPdf.length} fragment(en) uit het fontregister` : 'geen opmaak op deze pagina'
    });
    emit({ type: 'styling', page, fragments: fromPdf });
    styling = Promise.resolve(fromPdf);
  } else {
    // Why the PDF gave nothing decides whether that is an answer or a gap. Names
    // like "F1" carry no cut, and a page whose fonts are all named that way is
    // not a page without emphasis - it is a page whose typography nobody wrote
    // down. Worth saying out loud: if this never appears, the looking is dead
    // weight, and if it appears often the fonts themselves are worth judging
    // once per document instead of the page being read again and again.
    if (asset.typography === 'unnamed-fonts') {
      warnings.push('de fonts in deze PDF hebben geen bruikbare namen; de opmaak is van het beeld gelezen');
    }

    // Started first and awaited last: it needs nothing from run 1, so there is no
    // reason for the reader to wait for one before the other begins.
    emit({
      type: 'status',
      run: 'run 2 opmaak',
      state: 'start',
      page,
      detail:
        asset.typography === 'unnamed-fonts'
          ? 'fonts zonder bruikbare naam'
          : asset.typography === 'no-text-layer'
            ? 'geen tekstlaag'
            : 'pagina van vóór het uitlezen van de PDF'
    });
    styling = detectStyling(ctx, page, styleImages(asset))
      .then((fragments) => {
        // Sent the moment they arrive, so the interface can set the words as they
        // stream in rather than restyling the page once it is finished.
        emit({ type: 'styling', page, fragments });
        emit({ type: 'status', run: 'run 2 opmaak', state: 'ok', page, detail: `${fragments.length} fragment(en)` });
        return fragments;
      })
      .catch((err: unknown) => {
        // The page keeps its text; it just comes out unmarked.
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`run 2 opmaak: ${message}`);
        emit({ type: 'status', run: 'run 2 opmaak', state: 'fail', page, detail: message });
        return [];
      });
  }

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

  // The two meet here and nowhere else: what run 2 read off the page is matched
  // against what run 1 wrote, on the bare letters, and the words run 2 quoted as
  // coming before it decide which occurrence was meant.
  const placed = placeFragments(blocks, await styling);
  for (const patch of placed.patches) emit({ type: 'patch', page, patch });
  for (const missed of placed.unplaced) {
    warnings.push(`opmaak: "${clip(missed.text)}" (${missed.style.join('+')}) staat nergens in de pagina zoals run 1 hem schreef`);
  }

  for (const stray of strayLetters(textOf(blocks))) {
    warnings.push(`losse letter, mogelijk een OCR-misser: "${stray}"`);
  }

  const applied = applyStyles(blocks, placed.patches);
  const result: PageResult = {
    page,
    typography: asset.typography,
    blocks,
    patches: placed.patches,
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

/**
 * What the styling runs look at: the page in quarters where the render produced
 * them, and the whole page for a job that was uploaded before it did.
 */
function styleImages(asset: PageAsset): string[] {
  return asset.tiles?.length ? asset.tiles : [asset.image];
}

/** An amount, in the notation the interface uses everywhere else. */
export function money(amount: number): string {
  return `${env.priceCurrency} ${amount.toFixed(amount < 0.1 ? 4 : amount < 1 ? 3 : 2).replace('.', ',')}`;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ');
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

function tailOf(ocr: OcrPage | undefined): string {
  return (ocr?.markdown ?? '').slice(-TAIL);
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
