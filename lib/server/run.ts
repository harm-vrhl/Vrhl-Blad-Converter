import type { AgentCtx } from '../agents/common';
import { deadlineFor, LIMIT_HEADER, TimeUp, type Deadline } from '../deadline';
import { env, missingKeys, PROVIDERS, type Provider } from '../env';
import { aiCost, mistralLimit, newLedger, type Ledger, type ModelChoice } from '../llm/chat';
import { ocrCost, type OcrLedger } from '../llm/mistral';
import type { RunUsage } from '../types';
import { errorMessage } from '../util';

/**
 * Wat elke run-route deelt.
 *
 * Op Vercel onthoudt de server niets tussen twee verzoeken: elk verzoek kan op
 * een andere machine landen. Dus draagt het verzoek zelf alles wat de stap nodig
 * heeft: een JSON-veld `input` en de beelden als losse bestanden onder
 * `file:<naam>`, met dezelfde namen die de job ze geeft (`page-01.jpeg`,
 * `img-p01-01-thumb.jpeg`). Binair, niet als base64: dat scheelt een derde van de
 * 4,5 MB die een verzoek mag zijn.
 */

export interface RunRequest<T> {
  input: T;
  provider: Provider;
  /** Wanneer Vercel deze route afbreekt, als de route zijn `maxDuration` meegaf. */
  deadline?: Deadline;
  /** Een bestand uit het verzoek als data-URL, voor een agent die het wil zien. */
  image: (name: string) => Promise<string>;
  /** Een bestand uit het verzoek zoals het is, of null als het er niet in zit. */
  file: (name: string) => Promise<{ data: Buffer; type: string } | null>;
}

/**
 * `limit` is het `maxDuration` van de route. Geef het mee: de klok begint hier,
 * vóór het formulier met zijn beelden is gelezen, en elke modelaanroep in dit
 * verzoek stopt dan zelf voordat Vercel hem afbreekt.
 */
export async function readRun<T>(request: Request, limit?: number): Promise<RunRequest<T>> {
  const deadline = limit ? deadlineFor(limit) : undefined;
  const form = await request.formData();
  let input: T & { provider?: unknown };
  try {
    input = JSON.parse(String(form.get('input') ?? '{}'));
  } catch {
    throw new Refusal('het verzoek had geen leesbare invoer', 400);
  }
  const provider: Provider = PROVIDERS.includes(input.provider as Provider)
    ? (input.provider as Provider)
    : env.provider;

  const file = async (name: string) => {
    const entry = form.get(`file:${name}`);
    if (!(entry instanceof File)) return null;
    return { data: Buffer.from(await entry.arrayBuffer()), type: entry.type };
  };
  const image = async (name: string) => {
    const found = await file(name);
    if (!found) throw new Error(`beeld ${name} zat niet in het verzoek`);
    const mime = found.type || (name.endsWith('.png') ? 'image/png' : 'image/jpeg');
    return `data:${mime};base64,${found.data.toString('base64')}`;
  };
  return { input, provider, deadline, image, file };
}

/** Een fout die de browser moet zien zoals hij is, met zijn eigen status. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

/** Voordat er iets betaald wordt: zijn de sleutels voor deze aanbieder er? */
export function requireKeys(provider: Provider): void {
  const missing = missingKeys(provider);
  if (missing.length) throw new Refusal(`Ontbrekende sleutels: ${missing.join(', ')}`, 400);
}

export function agentCtx(run: RunRequest<unknown>, context = '', model?: ModelChoice): AgentCtx {
  const ledger = newLedger(run.provider, model);
  ledger.deadline = run.deadline;
  return { image: run.image, ledger, context };
}

/** Wat deze ene stap kostte, zodat de browser het totaal kan optellen. */
export function usageOf(ledgers: Ledger[], ocr?: OcrLedger): RunUsage {
  const ai = ledgers.reduce((sum, ledger) => sum + aiCost(ledger), 0);
  const ocrEuro = ocr ? ocrCost(ocr) : 0;
  return {
    calls: ledgers.reduce((n, l) => n + l.calls, 0) + (ocr?.calls ?? 0),
    tokens: ledgers.reduce((n, l) => n + l.inputTokens + l.outputTokens, 0),
    ocrPages: ocr?.pages ?? 0,
    ai,
    ocr: ocrEuro,
    currency: env.priceCurrency,
    mistralLimit: mistralLimit()
  };
}

/** Een JSON-route: het antwoord, of de fout als `{ error }` met een passende status. */
export async function json(work: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await work());
  } catch (err) {
    const status = err instanceof Refusal ? err.status : err instanceof TimeUp ? 504 : 500;
    return Response.json({ error: errorMessage(err) }, { status });
  }
}

/**
 * Een streamende route, als server-sent events over POST. Een fout onderweg komt
 * als `{ type: 'error' }` binnen, want de status is dan al verstuurd.
 *
 * Een stream die goed afloopt, eindigt met `{ type: 'end' }`. Breekt Vercel de
 * functie af, dan komt die nooit, en daaraan ziet de browser dat het antwoord niet
 * compleet is. De limiet gaat mee in een header, want headers zijn er al voordat
 * er iets mis kan gaan: zo kan de browser zeggen dat het de tijd van Vercel was
 * en niet het netwerk.
 */
export function sse(work: (send: (event: unknown) => void) => Promise<void>, limit?: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        await work(send);
        send({ type: 'end' });
      } catch (err) {
        send({ type: 'error', message: errorMessage(err) });
      } finally {
        controller.close();
      }
    }
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      ...(limit ? { [LIMIT_HEADER]: String(limit) } : {})
    }
  });
}
