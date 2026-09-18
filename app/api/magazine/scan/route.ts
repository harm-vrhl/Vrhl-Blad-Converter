import { scanPage, type PageScanInput } from '@/lib/agents/pagescan';
import { env, magazineModelFor } from '@/lib/env';
import { agentCtx, Refusal, stepJson, usageOf } from '@/lib/server/run';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Eén pagina van een magazine bekeken, tussen zijn twee buren, met het goedkope
 * model. De browser loopt het magazine pagina voor pagina door; hier gebeurt
 * alleen het kijken.
 */
export async function POST(request: Request) {
  return stepJson<PageScanInput>(request, async (run) => {
    // Geen OCR bij het in kaart brengen, dus alleen de sleutel van wie er kijkt.
    if (!(run.provider === 'mistral' ? env.mistralKey : env.openaiKey)) {
      throw new Refusal(`Ontbrekende sleutel: ${run.provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENAI_API_KEY'}`);
    }
    const cheap = magazineModelFor(run.provider);
    const ctx = agentCtx(run, '', cheap);
    const scan = await scanPage(ctx, run.input);
    return { scan, model: cheap.model, usage: usageOf([ctx.ledger]) };
  }, maxDuration);
}
