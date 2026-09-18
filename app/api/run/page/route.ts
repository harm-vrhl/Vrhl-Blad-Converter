import { writeStructure } from '@/lib/agents/structure';
import { timeLeft } from '@/lib/deadline';
import { textOf } from '@/lib/pagemarkup';
import { agentCtx, requireKeys, stepSse, usageOf } from '@/lib/server/run';
import type { ExtractedImage, IndexCheck } from '@/lib/types';
import { tokens } from '@/lib/util';
import { buildIndex, checkAgainstIndex } from '@/lib/wordindex';

export const runtime = 'nodejs';
// De leesvolgorde-run met een tweede poging past ruim in de 300 seconden van een gewone
// route, maar een traag model op een volle pagina niet altijd.
export const maxDuration = 800;

/** Meer woorden buiten de index dan dit, en de leesvolgorde-run krijgt één tweede poging. */
const UNKNOWN_LIMIT = 5;
/**
 * Zoveel van de eerste poging moet een herkansing minstens opschrijven om te
 * mogen winnen. Een tweede poging die de helft van de pagina weglaat haalt de
 * telling makkelijk, en is toch slechter: tekst kwijtraken is erger dan een
 * handvol vreemde woorden, want dat zie je in de controle niet terug.
 */
const KEEP_AT_LEAST = 0.9;

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
  return stepSse<Input>(request, async (run, send) => {
    requireKeys(run.provider);
    const { page, image, markdown = '', images = [], boxOnly = [], previousTail = '', context = '' } = run.input;
    const ctx = agentCtx(run, context);
    const index = buildIndex(page, markdown);

    const firstStarted = Date.now();
    let result = await writeStructure(ctx, page, image, markdown, images, boxOnly, previousTail, (text) =>
      send({ type: 'delta', page, text })
    );
    // Hoe lang de eerste poging duurde, is de beste schatting van de tweede.
    const firstTook = Date.now() - firstStarted;
    // Gecontroleerd op de blokken, niet op de ruwe uitvoer: de markers zijn van
    // ons, niet van de pagina.
    let check = checkAgainstIndex(index, textOf(result.blocks));

    // Een herkansing die niet meer binnen de tijd van Vercel past, wordt afgebroken
    // en is dan betaald zonder iets op te leveren. Dan blijft de eerste staan.
    const roomForRetry = !run.deadline || timeLeft(run.deadline) > firstTook * 1.25;
    if (check.unknown.length > UNKNOWN_LIMIT && !roomForRetry) {
      send({
        type: 'status',
        run: 'leesvolgorde',
        state: 'ok',
        page,
        detail:
          `${check.unknown.length} woorden buiten de index, maar geen tijd meer voor een tweede poging ` +
          `(Vercel geeft deze stap hooguit ${run.deadline?.limit} seconden); de eerste blijft staan`
      });
    }

    if (check.unknown.length > UNKNOWN_LIMIT && roomForRetry) {
      send({
        type: 'status',
        run: 'leesvolgorde',
        state: 'start',
        page,
        detail: `${check.unknown.length} woorden buiten de index, tweede poging`
      });
      // Met de afgekeurde woorden erbij, anders is dit dezelfde prompt nog een
      // keer en een hoop.
      const retry = await writeStructure(
        ctx,
        page,
        image,
        markdown,
        images,
        boxOnly,
        previousTail,
        () => undefined,
        check
      );
      const retryText = textOf(retry.blocks);
      const retryCheck = checkAgainstIndex(index, retryText);
      const won = better({ check: retryCheck, text: retryText }, { check, text: textOf(result.blocks) });
      if (won) {
        result = retry;
        check = retryCheck;
        send({ type: 'delta', page, text: '\f' }); // form feed: de interface begint opnieuw
        send({ type: 'delta', page, text: retry.raw });
      }
      send({
        type: 'status',
        run: 'leesvolgorde',
        state: 'ok',
        page,
        detail: won
          ? `tweede poging aangehouden: ${retryCheck.unknown.length} woorden buiten de index`
          : `tweede poging was niet beter (${retryCheck.unknown.length} buiten de index), de eerste blijft staan`
      });
    }

    send({
      type: 'structure',
      page,
      blocks: result.blocks,
      continuity: result.continuity,
      check,
      usage: usageOf([ctx.ledger])
    });
  }, maxDuration);
}

interface Attempt {
  check: IndexCheck;
  text: string;
}

/**
 * Wint de herkansing van de eerste poging?
 *
 * Minder verzonnen woorden wint. Bij een gelijk aantal wint de minste
 * dubbeling, want dat is de andere manier waarop een pagina misgaat. En een
 * poging die flink minder van de pagina opschrijft wint nooit, hoe schoon de
 * telling ook is.
 */
function better(retry: Attempt, first: Attempt): boolean {
  if (tokens(retry.text).length < tokens(first.text).length * KEEP_AT_LEAST) return false;
  if (retry.check.unknown.length !== first.check.unknown.length) {
    return retry.check.unknown.length < first.check.unknown.length;
  }
  return retry.check.overused.length < first.check.overused.length;
}
