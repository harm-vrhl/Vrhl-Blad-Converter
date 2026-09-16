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
    // Zonder keuze kent de interface alleen de aanbieder die schrijft; dan kan
    // geen terugvalregel in de browser alsnog de andere kiezen.
    providerChoice: env.providerChoice,
    articleConcurrency: env.articleConcurrency,
    // De browser regelt het tempo van een run, want alleen die ziet alle
    // verzoeken; de server is op Vercel elke keer een andere machine.
    concurrency: env.concurrency,
    mistralReqPerMinute: env.mistralReqPerMinute,
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
    ].filter((p) => env.providerChoice || p.id === env.provider),
    // Whether this installation can push to Sanity. The token itself stays here;
    // the interface only learns that one is present, and where it would write.
    sanity: {
      ready: sanityReady(),
      projectId: env.sanityProjectId || null,
      dataset: env.sanityDataset || null
    }
  });
}
