import { checkContent, type ContentInput } from '@/lib/agents/contentcheck';
import { env, magazineModelFor, strongModelFor } from '@/lib/env';
import { agentCtx, json, readRun, Refusal, usageOf } from '@/lib/server/run';

export const runtime = 'nodejs';
export const maxDuration = 800;

interface Input extends ContentInput {
  /** De tweede blik: het eigen model van de aanbieder in plaats van het goedkope. */
  strong?: boolean;
}

/** Hoort wat op deze pagina staat bij het artikel uit de inhoudsopgave? Eén pagina per verzoek. */
export async function POST(request: Request) {
  return json(async () => {
    const run = await readRun<Input>(request, maxDuration);
    if (!(run.provider === 'mistral' ? env.mistralKey : env.openaiKey)) {
      throw new Refusal(`Ontbrekende sleutel: ${run.provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENAI_API_KEY'}`);
    }
    const model = run.input.strong ? strongModelFor(run.provider) : magazineModelFor(run.provider);
    const ctx = agentCtx(run, '', model);
    const answer = await checkContent(ctx, run.input);
    return { answer, model: model.model, usage: usageOf([ctx.ledger]) };
  });
}
