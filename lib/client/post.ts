'use client';

import { activityStamp } from './activity';
import { LIMIT_HEADER } from '../deadline';

/**
 * Hoe de browser met de server praat, nu de server niets meer onthoudt.
 *
 * Elk verzoek is een formulier met een JSON-veld `input` en de bestanden die de
 * stap nodig heeft onder `file:<naam>`. Vercel neemt maximaal 4,5 MB per verzoek
 * aan; wat groter is, wordt hier al tegengehouden met een melding die zegt wat er
 * te groot was, in plaats van een kale 413 van Vercel.
 */

/** Net onder de 4,5 MB van Vercel, want het formulier zelf telt ook mee. */
export const BODY_LIMIT = Math.floor(4.4 * 1024 * 1024);

export class TooLarge extends Error {}

export function runForm(input: object, files: Record<string, Blob> = {}, what = 'dit verzoek', task?: string): FormData {
  const json = JSON.stringify(input);
  const size = new Blob([json]).size + Object.values(files).reduce((n, blob) => n + blob.size, 0);
  if (size > BODY_LIMIT) {
    throw new TooLarge(
      `${what} is ${(size / 1024 / 1024).toFixed(1).replace('.', ',')} MB, en de server neemt maximaal 4,5 MB per keer aan.`
    );
  }
  const form = new FormData();
  form.set('input', json);
  form.set('activity', JSON.stringify(activityStamp(task)));
  for (const [name, blob] of Object.entries(files)) form.set(`file:${name}`, blob, name);
  return form;
}

/**
 * Wat er te doen is als de tijd op was. Geen "kies de andere aanbieder": of die
 * keuze er is, weet alleen de server, en zijn eigen melding zegt het dan al.
 */
const RAAD = 'Probeer het opnieuw.';

async function failure(res: Response): Promise<Error> {
  if (res.status === 401) return new Error('Je bent niet (meer) ingelogd. Herlaad de pagina en log opnieuw in.');
  if (res.status === 413) return new TooLarge('Het verzoek was te groot voor de server (meer dan 4,5 MB).');
  const text = await res.text().catch(() => '');
  // Eerst de eigen melding van de route. Een route die zelf stopte omdat de tijd
  // op was, zegt hoe lang hij liep en waarom; dat is beter dan een kale 504.
  try {
    const body = JSON.parse(text) as { error?: string; detail?: unknown };
    if (body.error) {
      const detail = typeof body.detail === 'string' ? body.detail : body.detail ? JSON.stringify(body.detail) : '';
      return new Error(detail ? `${body.error} (${detail.slice(0, 300)})` : body.error);
    }
  } catch {
    /* geen JSON */
  }
  // Geen eigen melding: dan heeft Vercel de functie zelf afgebroken.
  if (res.headers.get('x-vercel-error') === 'FUNCTION_INVOCATION_TIMEOUT' || res.status === 504) {
    return new Error(
      `Tijd op: Vercel heeft deze stap afgebroken omdat hij langer duurde dan hij mag, en hij is niet afgemaakt. ${RAAD}`
    );
  }
  return new Error(`De server antwoordde met ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
}

export async function postJson<T>(url: string, body: FormData, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: 'POST', body, signal });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as T;
}

/**
 * Een streamend antwoord, gebeurtenis voor gebeurtenis. Een `{ type: 'error' }`
 * onderweg wordt een gewone fout, zodat de aanroeper maar één manier van falen
 * hoeft te kennen.
 *
 * Een stream die goed afloopt, eindigt met `{ type: 'end' }`. Komt die niet, dan
 * is het antwoord onvolledig, ook als de verbinding er netjes uitziet: zo breekt
 * Vercel een functie af. De route stuurt zijn limiet mee in een header, zodat hier
 * te zeggen is of het de tijd was of het netwerk. Een route zonder die header (een
 * tabblad met oude code tijdens een deploy) wordt behandeld zoals vroeger.
 */
export async function postStream<E extends { type: string }>(
  url: string,
  body: FormData,
  onEvent: (event: E) => void,
  signal?: AbortSignal
): Promise<void> {
  const started = Date.now();
  const res = await fetch(url, { method: 'POST', body, signal });
  if (!res.ok) throw await failure(res);
  if (!res.body) throw new Error('geen stream ontvangen');
  const limit = Number(res.headers.get(LIMIT_HEADER)) || 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  let broken: unknown = null;
  for (;;) {
    // Alleen het lezen zelf kan "de verbinding viel weg" zijn. Een fout verderop,
    // in het verwerken van een gebeurtenis, is gewoon een fout.
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch (err) {
      if (signal?.aborted) throw err;
      broken = err;
      break;
    }
    if (read.done) break;
    buffer += decoder.decode(read.value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      const line = chunk.replace(/^data: ?/, '').trim();
      if (!line) continue;
      const event = JSON.parse(line) as E & { message?: string };
      if (event.type === 'error') throw new Error(event.message ?? 'de server meldde een fout');
      if (event.type === 'end') {
        ended = true;
        continue;
      }
      onEvent(event);
    }
  }
  if (!limit) {
    if (broken) throw broken;
    return;
  }
  if (ended) return;
  throw new Error(streamCut(Date.now() - started, limit));
}

/** Waarom een stream zonder einde ophield: de tijd van Vercel, of de verbinding. */
export function streamCut(elapsedMs: number, limit: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds >= limit - 5) {
    return `Tijd op: Vercel heeft deze stap na ${limit} seconden afgebroken, voordat hij klaar was. ${RAAD}`;
  }
  return (
    `De verbinding met de server viel weg na ${seconds} ${seconds === 1 ? 'seconde' : 'seconden'}, voordat de stap klaar was. ` +
    'Controleer de internetverbinding en probeer het opnieuw.'
  );
}
