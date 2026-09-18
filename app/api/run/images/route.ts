import { triageImages } from '@/lib/agents/imagetriage';
import { agentCtx, requireKeys, stepJson, usageOf } from '@/lib/server/run';
import type { ArticleContext, ExtractedImage, PageAsset } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 800;

interface Input {
  /** De pagina waar deze beelden op staan, of null als die er niet bij is. */
  page: PageAsset | null;
  images: ExtractedImage[];
  context?: ArticleContext;
}

/** De beelden van één pagina beoordeeld, met de pagina ernaast. */
export async function POST(request: Request) {
  return stepJson<Input>(request, async (run) => {
    requireKeys(run.provider);
    const ctx = agentCtx(run);
    const verdicts = await triageImages(
      ctx,
      run.input.images ?? [],
      run.input.page ? [run.input.page] : [],
      run.input.context
    );
    return { verdicts, usage: usageOf([ctx.ledger]) };
  }, maxDuration);
}
