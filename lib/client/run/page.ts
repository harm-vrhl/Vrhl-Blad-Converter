'use client';

import type { StyleFragment } from '../../agents/styling';
import { textOf as textOfBlocks } from '../../pagemarkup';
import { applyStyles } from '../../patch';
import { placeFragments } from '../../place';
import { strayLetters } from '../../spelling';
import type {
  Block,
  Continuity,
  ExtractedImage,
  Frontmatter,
  IndexCheck,
  OcrPage,
  PageAsset,
  PageResult,
  RunEvent,
  RunUsage
} from '../../types';
import { errorMessage, EventQueue, pad2 } from '../../util';
import { getData, putData } from '../db';
import { postJson, postStream, runForm } from '../post';
import type { RunContext } from './context';

const TAIL = 300;

/**
 * 3 & 4. Two runs per page. Pages run side by side as far as the lanes allow;
 *    inside a page run 2 starts with run 1 and is placed once both are in.
 */
export async function* runPages(
  ctx: RunContext,
  {
    ocrByPage,
    approved,
    boxed,
    context
  }: { ocrByPage: Map<number, OcrPage>; approved: ExtractedImage[]; boxed: ExtractedImage[]; context: string }
): AsyncGenerator<RunEvent, PageResult[], void> {
  const { assets } = ctx;
  const queue = new EventQueue<RunEvent>();
  const work = Promise.all(
    assets.map(async (asset, i) => {
      const emit = (event: RunEvent) => queue.push(event);
      try {
        return await processPage(ctx, context, {
          asset,
          ocr: ocrByPage.get(asset.page),
          images: approved.filter((image) => image.page === asset.page),
          boxOnly: boxed.filter((image) => image.page === asset.page),
          previousTail: i > 0 ? (ocrByPage.get(assets[i - 1].page)?.markdown ?? '').slice(-TAIL) : '',
          isFirst: i === 0,
          isLast: i === assets.length - 1,
          emit
        });
      } catch (err) {
        // One page going wrong is not a reason to lose the others.
        const message = errorMessage(err);
        emit({ type: 'status', run: 'pagina', state: 'fail', page: asset.page, detail: message });
        const empty = emptyPage(asset.page, message, i === assets.length - 1);
        emit({ type: 'page', page: asset.page, result: empty });
        return empty;
      }
    })
  ).finally(() => queue.close());

  for await (const event of queue.drain()) yield event;
  return await work;
}

interface PageJob {
  asset: PageAsset;
  ocr: OcrPage | undefined;
  images: ExtractedImage[];
  boxOnly: ExtractedImage[];
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
async function processPage(ctx: RunContext, context: string, page: PageJob): Promise<PageResult> {
  const { id, provider, chat, add, files } = ctx;
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
        const message = errorMessage(err);
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
        { provider, page: n, image: asset.image, markdown, images: page.images, boxOnly: page.boxOnly, previousTail: page.previousTail, context },
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
export function describe(fm: Frontmatter): string {
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
