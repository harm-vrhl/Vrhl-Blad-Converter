import { detectStyling } from '@/lib/agents/styling';
import { agentCtx, json, readRun, requireKeys, usageOf } from '@/lib/server/run';

export const runtime = 'nodejs';
export const maxDuration = 800;

interface Input {
  page: number;
  /** De uitsneden van de pagina, bij naam. Zonder uitsneden de hele render. */
  images: string[];
}

/**
 * De opmaak-run: de opmaak, van het beeld gelezen. Alleen voor een pagina waarvan de PDF
 * zelf niet zegt wat vet en cursief is. Een eigen verzoek, los van de leesvolgorde-run, omdat
 * de render en de vier uitsneden samen tegen de 4,5 MB aan zitten.
 */
export async function POST(request: Request) {
  return json(async () => {
    const run = await readRun<Input>(request);
    requireKeys(run.provider);
    const ctx = agentCtx(run);
    const fragments = await detectStyling(ctx, Number(run.input.page), run.input.images ?? []);
    return { fragments, usage: usageOf([ctx.ledger]) };
  });
}
