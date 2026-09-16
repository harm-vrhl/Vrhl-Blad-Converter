import { writeStructure } from '@/lib/agents/structure';
import { textOf } from '@/lib/pagemarkup';
import { agentCtx, readRun, requireKeys, sse, usageOf } from '@/lib/server/run';
import type { ExtractedImage } from '@/lib/types';
import { buildIndex, checkAgainstIndex } from '@/lib/wordindex';

export const runtime = 'nodejs';
// De leesvolgorde-run met een tweede poging past ruim in de 300 seconden van een gewone
// route, maar een traag model op een volle pagina niet altijd.
export const maxDuration = 800;

/** Meer woorden buiten de index dan dit, en de leesvolgorde-run krijgt één tweede poging. */
const UNKNOWN_LIMIT = 5;

interface Input {
  page: number;
  /** De render van de pagina, bij naam. */
  image: string;
  /** De OCR van deze pagina: de woorden die bestaan. */
  markdown: string;
  /** De beelden op deze pagina die bij het artikel horen. */
  images: ExtractedImage[];
  /** Door de beoordeling afgewezen beelden die alleen in een kader van het artikel mogen. */
  boxOnly: ExtractedImage[];
  previousTail: string;
  /** Wat de frontmatter al vastlegde, zodat de leesvolgorde-run het niet herhaalt. */
  context: string;
}

/**
 * De leesvolgorde-run op één pagina: de pagina in leesvolgorde uitgeschreven, gecontroleerd
 * tegen de woordindex. Streamt de tekst zoals hij geschreven wordt.
 */
export async function POST(request: Request) {
  const run = await readRun<Input>(request);
  return sse(async (send) => {
    requireKeys(run.provider);
    const { page, image, markdown = '', images = [], boxOnly = [], previousTail = '', context = '' } = run.input;
    const ctx = agentCtx(run, context);
    const index = buildIndex(page, markdown);

    let result = await writeStructure(ctx, page, image, markdown, images, boxOnly, previousTail, (text) =>
      send({ type: 'delta', page, text })
    );
    // Gecontroleerd op de blokken, niet op de ruwe uitvoer: de markers zijn van
    // ons, niet van de pagina.
    let check = checkAgainstIndex(index, textOf(result.blocks));

    if (check.unknown.length > UNKNOWN_LIMIT) {
      send({
        type: 'status',
        run: 'leesvolgorde',
        state: 'start',
        page,
        detail: `${check.unknown.length} woorden buiten de index, tweede poging`
      });
      const retry = await writeStructure(ctx, page, image, markdown, images, boxOnly, previousTail, () => undefined);
      const retryCheck = checkAgainstIndex(index, textOf(retry.blocks));
      if (retryCheck.unknown.length < check.unknown.length) {
        result = retry;
        check = retryCheck;
        send({ type: 'delta', page, text: '\f' }); // form feed: de interface begint opnieuw
        send({ type: 'delta', page, text: retry.raw });
      }
    }

    send({
      type: 'structure',
      page,
      blocks: result.blocks,
      continuity: result.continuity,
      check,
      usage: usageOf([ctx.ledger])
    });
  });
}
