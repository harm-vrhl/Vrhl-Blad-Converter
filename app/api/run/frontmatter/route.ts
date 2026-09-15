import { readFrontmatter } from '@/lib/agents/frontmaster';
import { agentCtx, readRun, requireKeys, sse, usageOf } from '@/lib/server/run';

export const runtime = 'nodejs';
export const maxDuration = 800;

interface Input {
  /** De renders van de openingspagina's, bij naam, in volgorde. */
  images: string[];
  /** De OCR van die pagina's, al met een kop per pagina. */
  ocr: string;
  words: string[];
}

/** Kop, auteurs en intro van de opening. Streamt, zodat de kop verschijnt terwijl hij geschreven wordt. */
export async function POST(request: Request) {
  const run = await readRun<Input>(request);
  return sse(async (send) => {
    requireKeys(run.provider);
    const ctx = agentCtx(run);
    const frontmatter = await readFrontmatter(
      ctx,
      run.input.images ?? [],
      run.input.ocr ?? '',
      run.input.words ?? [],
      (partial) => send({ type: 'partial', frontmatter: partial })
    );
    send({ type: 'frontmatter', frontmatter, usage: usageOf([ctx.ledger]) });
  });
}
