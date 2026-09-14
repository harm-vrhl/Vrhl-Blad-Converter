import { env, modelFor, sanityReady } from '@/lib/env';
import { mistralLimit } from '@/lib/llm/chat';

export const runtime = 'nodejs';

/**
 * What the interface needs to know about how this installation is set up: which
 * way the switches stand by default, and what the optional work costs. The keys
 * themselves never leave the server; only whether one is there.
 */
export async function GET() {
  return Response.json({
    ocrPricePerPage: env.ocrPricePerPage,
    currency: env.priceCurrency,
    provider: env.provider,
    articleConcurrency: env.articleConcurrency,
    providers: [
      { id: 'openai', label: 'OpenAI', model: modelFor('openai').model, ready: Boolean(env.openaiKey), limit: null },
      {
        id: 'mistral',
        label: 'Mistral',
        model: modelFor('mistral').model,
        ready: Boolean(env.mistralKey),
        // Only known once Mistral has answered a chat call; null until then.
        limit: mistralLimit()
      }
    ],
    // Whether this installation can push to Sanity. The token itself stays here;
    // the interface only learns that one is present, and where it would write.
    sanity: {
      ready: sanityReady(),
      projectId: env.sanityProjectId || null,
      dataset: env.sanityDataset || null
    }
  });
}
