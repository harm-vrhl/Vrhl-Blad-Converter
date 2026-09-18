import { newOcrLedger, ocrPage } from '@/lib/llm/mistral';
import { Refusal, stepJson, usageOf } from '@/lib/server/run';
import { reconcile } from '@/lib/spelling';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface Input {
  page: number;
  /** De woorden zoals de PDF ze spelt; wat daarvan afwijkt in accenten, wint de PDF. */
  words?: string[];
}

/**
 * De woordindex begint hier: Mistral leest één pagina, als PDF van die pagina of
 * als render, en de spelling uit het bestand zet de accenten recht.
 */
export async function POST(request: Request) {
  return stepJson<Input>(request, async (run) => {
    const page = Number(run.input.page);
    const source = await run.file('bron');
    if (!Number.isInteger(page) || page < 1 || !source) throw new Refusal('pagina of bestand ontbreekt');

    const ledger = newOcrLedger();
    const ocr = await ocrPage(page, source.data, source.type, ledger);
    const words = Array.isArray(run.input.words) ? run.input.words.filter((w) => typeof w === 'string') : [];
    const { text, swaps } = reconcile(ocr.markdown, words);
    ocr.markdown = text;

    return {
      ocr,
      swaps: swaps.map((swap) => `p${page}: ${swap.from} → ${swap.to}${swap.count > 1 ? ` (${swap.count}×)` : ''}`),
      usage: usageOf([], ledger)
    };
  }, maxDuration);
}
