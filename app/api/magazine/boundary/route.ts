import { checkBoundary, type BoundaryInput } from '@/lib/agents/boundary';
import { env, magazineModelFor, strongModelFor } from '@/lib/env';
import { agentCtx, Refusal, stepJson, usageOf } from '@/lib/server/run';

export const runtime = 'nodejs';
export const maxDuration = 800;

interface Input extends BoundaryInput {
  /** De tweede blik: het eigen model van de aanbieder in plaats van het goedkope. */
  strong?: boolean;
}

/** Waar eindigt het vorige artikel? Eén overgang per verzoek. */
export async function POST(request: Request) {
  return stepJson<Input>(request, async (run) => {
    if (!(run.provider === 'mistral' ? env.mistralKey : env.openaiKey)) {
      throw new Refusal(`Ontbrekende sleutel: ${run.provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENAI_API_KEY'}`);
    }
    const model = run.input.strong ? strongModelFor(run.provider) : magazineModelFor(run.provider);
    const ctx = agentCtx(run, '', model);
    const answer = await checkBoundary(ctx, run.input);
    return { answer, model: model.model, usage: usageOf([ctx.ledger]) };
  }, maxDuration);
}
