import { requireKeys, stepJson, usageOf } from '@/lib/server/run';
import { checkMistral, newLedger } from '@/lib/llm/chat';

export const runtime = 'nodejs';

/**
 * Vóór er iets betaald wordt: zijn de sleutels er, en mag deze Mistral-sleutel
 * het model wel gebruiken? Een run die daarop stukloopt, doet dat liever hier
 * dan na de OCR.
 */
export async function POST(request: Request) {
  return stepJson(request, async (run) => {
    requireKeys(run.provider);
    const ledger = newLedger(run.provider);
    if (run.provider === 'mistral') await checkMistral(ledger);
    return { ok: true, usage: usageOf([ledger]) };
  });
}
