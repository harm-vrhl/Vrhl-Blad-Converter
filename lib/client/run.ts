'use client';

import type { StyleFragment } from '../agents/styling';
import { blankFrontmatter, compileArticle } from '../compile';
import { obviouslyDecorative } from '../imagefilter';
import { textOf as textOfBlocks } from '../pagemarkup';
import { applyStyles } from '../patch';
import { placeFragments } from '../place';
import { strayLetters } from '../spelling';
import type {
  Block,
  Continuity,
  ExtractedImage,
  Frontmatter,
  ImageVerdict,
  IndexCheck,
  OcrPage,
  PageAsset,
  PageResult,
  RunEvent,
  RunUsage
} from '../types';
import { EventQueue, pad2 } from '../util';
import { buildIndex } from '../wordindex';
import { deleteData, getData, loadJob, needFile, putData, saveJob, type StoredJob, type Totals } from './db';
import { limiter, type Limiter } from './limiter';
import { BODY_LIMIT, postJson, postStream, runForm } from './post';

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

/** How far into the article the frontmatter agent keeps looking. */
const FRONTMATTER_REACH = 3;
/**
 * Where it starts looking when nobody said how the article opens. An opening is
 * often a spread: the headline on the left page and the intro on the right.
 */
const OPENING_DEFAULT = 2;
const TAIL = 300;
/** Een pagina-PDF groter dan dit gaat als render naar de OCR. */
const PDF_ROOM = BODY_LIMIT - 256 * 1024;

interface Settings {
  concurrency: number;
  mistralReqPerMinute: number;
}

let settings: Promise<Settings> | null = null;

function runSettings(): Promise<Settings> {
  settings ??= fetch('/api/settings')
    .then((res) => (res.ok ? res.json() : {}))
    .then((body: Partial<Settings>) => ({
      concurrency: body.concurrency ?? 4,
      mistralReqPerMinute: body.mistralReqPerMinute ?? 60
    }))
    .catch(() => ({ concurrency: 4, mistralReqPerMinute: 60 }));
  return settings;
}

/**
 * Gedeeld door elke run in dit tabblad. Een magazine zet drie artikelen tegelijk
 * om, en die moeten samen onder Mistrals limiet blijven, niet elk apart.
 */
let lanes: Promise<{ openai: Limiter; mistral: Limiter; ocr: Limiter }> | null = null;

function lanesFor() {
  lanes ??= runSettings().then(({ concurrency, mistralReqPerMinute }) => ({
    openai: limiter(concurrency),
    mistral: limiter(concurrency, mistralReqPerMinute),
    ocr: limiter(concurrency, mistralReqPerMinute)
  }));
  return lanes;
}

interface Bill {
  calls: number;
  tokens: number;
  ocrPages: number;
  ai: number;
  ocr: number;
  currency: string;
}

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

  try {
    yield* article(job, provider, started);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.status = 'error';
    job.error = message;
    await saveJob(job).catch(() => undefined);
    // A status without a page number is what the interface treats as the end of
    // the run, so a failure has to arrive in that shape to be seen at all.
    yield { type: 'status', run: 'fout', state: 'fail', detail: message };
  }
}

async function* article(job: StoredJob, provider: 'openai' | 'mistral', started: number): AsyncGenerator<RunEvent, void, void> {
  const id = job.id;
  const { openai, mistral, ocr: ocrLane } = await lanesFor();
  const chat = provider === 'mistral' ? mistral : openai;
  const assets = [...job.pages].sort((a, b) => a.page - b.page);
  const bill: Bill = { calls: 0, tokens: 0, ocrPages: 0, ai: 0, ocr: 0, currency: 'USD' };
  const add = (usage: RunUsage | undefined) => {
    if (!usage) return;
    bill.calls += usage.calls;
    bill.tokens += usage.tokens;
    bill.ocrPages += usage.ocrPages;
    bill.ai += usage.ai;
    bill.ocr += usage.ocr;
    bill.currency = usage.currency;
  };

  /** Een stap die maar één keer betaald hoeft te worden: bewaard, en bij hervatten gelezen. */
  const once = async <T extends { usage?: RunUsage }>(name: string, work: () => Promise<T>): Promise<T> => {
    const cached = await getData<T>(id, `run/${name}`);
    if (cached) {
      add(cached.usage);
      return cached;
    }
    const fresh = await work();
    await putData(id, `run/${name}`, fresh);
    add(fresh.usage);
    return fresh;
  };

  const files = async (names: string[]) =>
    Object.fromEntries(await Promise.all(names.map(async (name) => [name, await needFile(id, name)] as const)));

  // Before the OCR is paid for: may this key have Mistral write at all?
  await chat(() => postJson('/api/run/check', runForm({ provider })));

  // 1. Word index per page. Mistral decides which words exist; this is the
  //    yardstick every AI output is held against. Page by page, as a PDF of that
  //    one page: the whole file can be fifty megabytes.
  yield { type: 'status', run: 'woordindex', state: 'start', detail: "Mistral leest alle pagina's" };
  let pdf: Promise<import('pdf-lib').PDFDocument> | null = null;
  const pagePdf = async (page: number): Promise<Blob> => {
    const { PDFDocument } = await import('pdf-lib');
    pdf ??= needFile(id, 'source.pdf')
      .then((blob) => blob.arrayBuffer())
      .then((bytes) => PDFDocument.load(bytes, { ignoreEncryption: true }));
    const from = await pdf;
    const out = await PDFDocument.create();
    const [copied] = await out.copyPages(from, [page - 1]);
    out.addPage(copied);
    return new Blob([(await out.save()) as BlobPart], { type: 'application/pdf' });
  };

  const read = await Promise.all(
    assets.map((asset) =>
      once(`ocr-p${pad2(asset.page)}`, () =>
        ocrLane(async () => {
          let bron = await pagePdf(asset.page);
          // A page with one enormous photo on it does not fit in a request as a
          // PDF; its render does, and reads just as well.
          if (bron.size > PDF_ROOM) bron = await needFile(id, asset.image);
          return postJson<{ ocr: OcrPage; swaps: string[]; usage: RunUsage }>(
            '/api/run/ocr',
            runForm({ page: asset.page, words: asset.words ?? [] }, { bron }, `Pagina ${asset.page} voor de OCR`)
          );
        })
      )
    )
  );
  await putData(id, 'ocr.json', read.map((r) => r.ocr));
  const corrected = read.flatMap((r) => r.swaps);
  if (corrected.length) {
    yield { type: 'status', run: 'woordindex', state: 'ok', detail: `spelling uit de PDF: ${corrected.join(', ')}` };
  }
  const ocrByPage = new Map(read.map((r) => [r.ocr.page, r.ocr]));
  const words = read.reduce((n, r) => n + buildIndex(r.ocr.page, r.ocr.markdown).total, 0);
  yield { type: 'status', run: 'woordindex', state: 'ok', detail: `${read.length} pagina(s), ${words} woorden` };

  // 2. Frontmatter and image triage. Neither needs the other's answer, so they
  //    start together. Pages still wait for both: run 1 needs the approved ids and
  //    the frontmatter as context.
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
            runForm(
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
                runForm(
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
      // Without a verdict every candidate stays in; run 1 still decides placement.
      opening.push({
        type: 'status',
        run: 'beeldbeoordeling',
        state: 'fail',
        detail: err instanceof Error ? err.message : String(err)
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

  const context = describe(frontmatter);
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

  // 3 & 4. Two runs per page. Pages run side by side as far as the lanes allow;
  //    inside a page run 2 starts with run 1 and is placed once both are in.
  const queue = new EventQueue<RunEvent>();
  const work = Promise.all(
    assets.map(async (asset, i) => {
      const emit = (event: RunEvent) => queue.push(event);
      try {
        return await processPage({
          asset,
          ocr: ocrByPage.get(asset.page),
          images: approved.filter((image) => image.page === asset.page),
          previousTail: i > 0 ? (ocrByPage.get(assets[i - 1].page)?.markdown ?? '').slice(-TAIL) : '',
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
    })
  ).finally(() => queue.close());

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

  interface PageJob {
    asset: PageAsset;
    ocr: OcrPage | undefined;
    images: ExtractedImage[];
    previousTail: string;
    isFirst: boolean;
    isLast: boolean;
    emit: (event: RunEvent) => void;
  }

  /**
   * One page, two runs, side by side. Run 2 quotes the page instead of naming
   * run 1's blocks, so it needs nothing from run 1 and starts with it; what it
   * quotes is placed once both are in.
   */
  async function processPage(page: PageJob): Promise<PageResult> {
    const { asset, emit } = page;
    const n = asset.page;
    const stored = await getData<{ result: PageResult; usage: RunUsage[] }>(id, `run/page-p${pad2(n)}`);
    if (stored) {
      stored.usage.forEach(add);
      emit({ type: 'page', page: n, result: stored.result });
      return stored.result;
    }

    const usage: RunUsage[] = [];
    const warnings: string[] = [];
    const markdown = page.ocr?.markdown ?? '';

    // Where the PDF has a text layer, the typography is not a judgement at all:
    // the font each run of characters is set in is recorded in the file. The
    // looking is kept for the pages that leave nothing to read.
    const fromPdf = asset.styling ?? [];
    let styling: Promise<StyleFragment[]>;
    if (asset.typography === 'read') {
      emit({
        type: 'status',
        run: 'opmaak uit de PDF',
        state: 'ok',
        page: n,
        detail: fromPdf.length ? `${fromPdf.length} fragment(en) uit het fontregister` : 'geen opmaak op deze pagina'
      });
      emit({ type: 'styling', page: n, fragments: fromPdf });
      styling = Promise.resolve(fromPdf);
    } else {
      if (asset.typography === 'unnamed-fonts') {
        warnings.push('de fonts in deze PDF hebben geen bruikbare namen; de opmaak is van het beeld gelezen');
      }
      emit({
        type: 'status',
        run: 'run 2 opmaak',
        state: 'start',
        page: n,
        detail:
          asset.typography === 'unnamed-fonts'
            ? 'fonts zonder bruikbare naam'
            : asset.typography === 'no-text-layer'
              ? 'geen tekstlaag'
              : 'pagina van vóór het uitlezen van de PDF'
      });
      const names = asset.tiles?.length ? asset.tiles : [asset.image];
      styling = chat(async () =>
        postJson<{ fragments: StyleFragment[]; usage: RunUsage }>(
          '/api/run/styling',
          runForm({ provider, page: n, images: names }, await files(names), `De uitsneden van pagina ${n}`)
        )
      )
        .then(({ fragments, usage: spent }) => {
          usage.push(spent);
          emit({ type: 'styling', page: n, fragments });
          emit({ type: 'status', run: 'run 2 opmaak', state: 'ok', page: n, detail: `${fragments.length} fragment(en)` });
          return fragments;
        })
        .catch((err: unknown) => {
          // The page keeps its text; it just comes out unmarked.
          const message = err instanceof Error ? err.message : String(err);
          warnings.push(`run 2 opmaak: ${message}`);
          emit({ type: 'status', run: 'run 2 opmaak', state: 'fail', page: n, detail: message });
          return [];
        });
    }

    // AI run 1, reading order, with inserts, quotes and images in their place.
    emit({ type: 'status', run: 'run 1 leesvolgorde', state: 'start', page: n });
    let structure: { blocks: Block[]; continuity: Continuity; check: IndexCheck; usage: RunUsage } | null = null;
    await chat(async () =>
      postStream<RunEvent | { type: 'structure'; blocks: Block[]; continuity: Continuity; check: IndexCheck; usage: RunUsage }>(
        '/api/run/page',
        runForm(
          { provider, page: n, image: asset.image, markdown, images: page.images, previousTail: page.previousTail, context },
          await files([asset.image]),
          `Pagina ${n}`
        ),
        (event) => {
          if (event.type === 'structure') structure = event;
          else emit(event as RunEvent);
        }
      )
    );
    if (!structure) throw new Error('run 1 kwam niet terug');
    const { blocks, continuity, check, usage: written } = structure as {
      blocks: Block[];
      continuity: Continuity;
      check: IndexCheck;
      usage: RunUsage;
    };
    usage.push(written);
    emit({
      type: 'status',
      run: 'run 1 leesvolgorde',
      state: 'ok',
      page: n,
      detail: `${tally(blocks)}, ${Math.round(check.score * 100)}% woorddekking`
    });

    // The two meet here and nowhere else.
    const placed = placeFragments(blocks, await styling);
    for (const patch of placed.patches) emit({ type: 'patch', page: n, patch });
    for (const missed of placed.unplaced) {
      warnings.push(`opmaak: "${clip(missed.text)}" (${missed.style.join('+')}) staat nergens in de pagina zoals run 1 hem schreef`);
    }
    for (const stray of strayLetters(textOfBlocks(blocks))) {
      warnings.push(`losse letter, mogelijk een OCR-misser: "${stray}"`);
    }

    const applied = applyStyles(blocks, placed.patches);
    const result: PageResult = {
      page: n,
      typography: asset.typography,
      blocks,
      patches: placed.patches,
      dropped: applied.dropped,
      content: applied.content,
      continuity: {
        continuesFromPrevious: continuity.continuesFromPrevious && !page.isFirst,
        continuesOnNext: continuity.continuesOnNext && !page.isLast
      },
      check,
      warnings: [...warnings, ...applied.warnings]
    };
    usage.forEach(add);
    await putData(id, `run/page-p${pad2(n)}`, { result, usage });
    emit({ type: 'page', page: n, result });
    return result;
  }
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

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ');
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
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
